import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, readdir, rm, stat, symlink } from 'node:fs/promises';
import path from 'node:path';
import { AppError } from './errors.mjs';
import { detectCompileCommands } from './fix-validation.mjs';
import { runVerifyCommand } from '../app/electron/verify-command.mjs';

const IGNORED_DIRS = new Set([
  'node_modules', '.git', 'target', 'dist', 'build', 'out', 'coverage',
  '.next', '.nuxt', '.idea', '.vscode', 'vendor', 'logs', 'runs', '.tmp',
  '.ssh', '.aws', '.kube', '.docker',
]);
const SENSITIVE_FILE = /^(?:\.env(?:\..*)?|.*\.(?:pem|key|p12|pfx)|id_(?:rsa|dsa|ecdsa|ed25519).*|\.npmrc|\.pypirc|credentials|secrets?)$/i;
const MAX_FILES = 20_000;
const MAX_TOTAL_BYTES = 200 * 1024 * 1024;
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_EXTRACT_BYTES = 100 * 1024;
const COMMAND_OUTPUT_LIMIT = 12_000;

const SAFE_COMMAND = /^(?:(?:\.\/)?(?:mvnw|mvn)(?:\.cmd)?|(?:\.\/)?gradlew(?:\.bat)?|gradle|npm|pnpm|yarn|npx|python(?:3)?|pytest|go|dotnet|cargo)\b/i;
const SHELL_META = /[;&|<>`]|\$\(|\n|\r/;

export function sandboxPromptFor(sandbox) {
  const roots = (sandbox?.roots ?? []).map((entry) => {
    const label = entry.key === 'extra' ? `extra/${entry.extraRoot}` : entry.key;
    return `  - ${label}: ${entry.sandboxRoot}`;
  });
  return `${SANDBOX_SYSTEM_PROMPT}\n\n沙箱源码根：\n${roots.join('\n')}\nrun_command 的 cwd 可传这些目录或其子目录。`;
}

export const SANDBOX_SYSTEM_PROMPT = `

# 沙箱编辑模式
你现在运行在一个隔离沙箱中，真实项目不会被你的 Edit/Write 直接修改。
- 可以用 Read/Grep/Glob 浏览，用 Edit/Write 修改沙箱文件。
- 用 run_command 执行编译、测试或单个用例（如 mvn test、npm test、pytest path::test）。
- 请自己修改并运行测试，直到编译/测试通过为止；失败时读取输出继续修复。
- 不要把最终修改重复写进 fixes；系统会在你结束后从沙箱提取补丁，用户确认后才应用到真实项目。
- 沙箱内路径与真实项目相对路径一致；不要访问沙箱外路径。`;

async function pathKind(target) {
  try {
    const info = await stat(target);
    if (info.isDirectory()) return 'dir';
    if (info.isFile()) return 'file';
    return 'other';
  } catch {
    return null;
  }
}

async function copyTree(source, dest, state) {
  const entries = await readdir(source, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === 'node_modules') continue;
    if (entry.isDirectory() && IGNORED_DIRS.has(entry.name)) continue;
    const from = path.join(source, entry.name);
    const to = path.join(dest, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      await mkdir(to, { recursive: true });
      await copyTree(from, to, state);
      continue;
    }
    if (!entry.isFile()) continue;
    if (SENSITIVE_FILE.test(entry.name)) continue;
    const info = await stat(from);
    if (info.size > MAX_FILE_BYTES) continue;
    state.files += 1;
    state.bytes += info.size;
    if (state.files > MAX_FILES || state.bytes > MAX_TOTAL_BYTES) {
      throw new AppError('SANDBOX_TOO_LARGE', '源码目录过大，无法创建沙箱', { exitCode: 3 });
    }
    await copyFile(from, to);
  }
}

async function linkNodeModules(realRoot, sandboxRoot) {
  const source = path.join(realRoot, 'node_modules');
  if (await pathKind(source) !== 'dir') return;
  const dest = path.join(sandboxRoot, 'node_modules');
  try {
    await symlink(source, dest, process.platform === 'win32' ? 'junction' : 'dir');
  } catch {
    // Dependency linking is best-effort; the sandbox still works for backend builds.
  }
}

function rootDescriptor({ key, name, root, extraRoot = null }, sandboxDir) {
  return {
    key,
    name,
    extraRoot,
    realRoot: path.resolve(root),
    sandboxRoot: path.join(sandboxDir, name),
  };
}

/**
 * Create an isolated copy of the affected source roots. The model may edit
 * this copy freely; the real workspace is never touched.
 */
export async function createAgentSandbox({ runDir, roots = [] }) {
  const sandboxDir = path.join(runDir, 'sandbox');
  await rm(sandboxDir, { recursive: true, force: true });
  await mkdir(sandboxDir, { recursive: true });

  const descriptors = [];
  const sources = roots.filter((entry) => entry?.root);
  let index = 0;
  for (const entry of sources) {
    const name = entry.key === 'extra'
      ? `extra-${String(entry.extraRoot || ++index).replace(/[^\w.-]/g, '_')}`
      : entry.key;
    if (await pathKind(entry.root) !== 'dir') continue;
    descriptors.push(rootDescriptor({ ...entry, name }, sandboxDir));
  }
  if (descriptors.length === 0) {
    throw new AppError('SANDBOX_NO_ROOTS', '没有可用的源码目录，无法创建沙箱', { exitCode: 3 });
  }

  const state = { files: 0, bytes: 0 };
  for (const descriptor of descriptors) {
    await mkdir(descriptor.sandboxRoot, { recursive: true });
    await copyTree(descriptor.realRoot, descriptor.sandboxRoot, state);
    await linkNodeModules(descriptor.realRoot, descriptor.sandboxRoot);
    // Remember the snapshot hashes so extraction can detect user edits that
    // happened while the model was working in the sandbox.
    descriptor.baseHashes = new Map();
    for (const file of await walkFiles(descriptor.sandboxRoot)) {
      const relative = path.relative(descriptor.sandboxRoot, file);
      try {
        descriptor.baseHashes.set(relative, sha256(await readFile(file)));
      } catch {
        // unreadable copied file: conflict detection will treat it as unknown
      }
    }
  }
  return {
    dir: sandboxDir,
    roots: descriptors,
    fileCount: state.files,
    bytes: state.bytes,
  };
}

async function walkFiles(root, out = []) {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry.name === 'node_modules' || IGNORED_DIRS.has(entry.name)) continue;
    if (entry.isSymbolicLink()) continue;
    const absolute = path.join(root, entry.name);
    if (entry.isDirectory()) await walkFiles(absolute, out);
    else if (entry.isFile()) out.push(absolute);
  }
  return out;
}

function normalizeText(value) {
  return String(value).replace(/\r\n/g, '\n');
}

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

/**
 * Compare the sandbox against the real roots and turn every changed file into
 * a whole-file search/replace fix. Whole-file replacement keeps extraction
 * simple while the preview still shows a minimal line diff.
 */
export async function extractSandboxFixes(sandbox) {
  const fixes = [];
  const skipped = [];
  const changedFiles = [];

  for (const descriptor of sandbox.roots) {
    const files = await walkFiles(descriptor.sandboxRoot);
    for (const sandboxFile of files) {
      const relative = path.relative(descriptor.sandboxRoot, sandboxFile);
      const realFile = path.join(descriptor.realRoot, relative);
      const realKind = await pathKind(realFile);
      const file = relative.split(path.sep).join('/');
      if (realKind === null) {
        if (descriptor.baseHashes.has(relative)) {
          skipped.push({ file, reason: '文件在诊断期间被删除，存在冲突，请重新诊断' });
          continue;
        }
        // New file created inside the sandbox.
        let updatedBuffer;
        try {
          updatedBuffer = await readFile(sandboxFile);
        } catch (error) {
          skipped.push({ file, reason: `读取失败：${error?.message ?? error}` });
          continue;
        }
        if (updatedBuffer.includes(0)) {
          skipped.push({ file, reason: '二进制文件不生成代码修复' });
          continue;
        }
        const content = updatedBuffer.toString('utf8');
        if (content.length > MAX_EXTRACT_BYTES) {
          skipped.push({ file, reason: '文件超过 100KB，无法生成新建补丁' });
          continue;
        }
        fixes.push({
          summary: `沙箱新增：${file}`,
          kind: 'create',
          root: descriptor.key,
          extraRoot: descriptor.extraRoot,
          file,
          content,
          baseHash: null,
          risk: 'medium',
          verification: '沙箱内生成，应用前仍会执行编译自测',
          note: '由沙箱新建文件提取',
        });
        changedFiles.push(`${descriptor.key}/${file}`);
        continue;
      }
      if (realKind !== 'file') continue;

      let originalBuffer;
      let updatedRaw;
      try {
        const [original, updated] = await Promise.all([
          readFile(realFile),
          readFile(sandboxFile),
        ]);
        originalBuffer = original;
        if (original.includes(0) || updated.includes(0)) {
          skipped.push({ file, reason: '二进制文件不生成代码修复' });
          continue;
        }
        updatedRaw = updated.toString('utf8');
      } catch (error) {
        skipped.push({ file, reason: `读取失败：${error?.message ?? error}` });
        continue;
      }
      const expectedHash = descriptor.baseHashes.get(relative);
      const currentHash = sha256(originalBuffer);
      if (!expectedHash) {
        skipped.push({ file, reason: '文件在诊断期间被创建或替换，存在冲突，请重新诊断' });
        continue;
      }
      if (currentHash !== expectedHash) {
        skipped.push({ file, reason: '文件在诊断期间被修改，存在冲突，请重新诊断' });
        continue;
      }
      const originalRaw = originalBuffer.toString('utf8');
      const originalText = normalizeText(originalRaw);
      const updatedText = normalizeText(updatedRaw);
      if (originalText === updatedText) continue;
      if (originalText.length > MAX_EXTRACT_BYTES || updatedText.length > MAX_EXTRACT_BYTES) {
        skipped.push({ file, reason: '文件超过 100KB，无法生成整文件补丁' });
        continue;
      }
      fixes.push({
        summary: `沙箱修改：${file}`,
        kind: 'edit',
        root: descriptor.key,
        extraRoot: descriptor.extraRoot,
        file,
        search: originalText,
        replace: updatedText,
        baseHash: sha256(originalBuffer),
        risk: 'medium',
        verification: '沙箱内生成，应用前仍会执行编译自测',
        note: '由沙箱编辑提取',
      });
      changedFiles.push(`${descriptor.key}/${file}`);
    }

    const realFiles = await walkFiles(descriptor.realRoot);
    for (const realFile of realFiles) {
      const relative = path.relative(descriptor.realRoot, realFile);
      if (SENSITIVE_FILE.test(path.basename(realFile))) continue;
      const info = await stat(realFile).catch(() => null);
      if (!info || info.size > MAX_FILE_BYTES) continue;
      const sandboxFile = path.join(descriptor.sandboxRoot, relative);
      if (await pathKind(sandboxFile) !== 'file') {
        const expectedHash = descriptor.baseHashes.get(relative);
        if (!expectedHash) continue;
        let buffer;
        try {
          buffer = await readFile(realFile);
        } catch (error) {
          skipped.push({ file: relative, reason: `读取失败：${error?.message ?? error}` });
          continue;
        }
        if (buffer.includes(0)) {
          skipped.push({ file: relative, reason: '二进制文件不生成删除补丁' });
          continue;
        }
        if (sha256(buffer) !== expectedHash) {
          skipped.push({ file: relative, reason: '文件在诊断期间被修改，存在冲突，请重新诊断' });
          continue;
        }
        const file = relative.split(path.sep).join('/');
        fixes.push({
          summary: `沙箱删除：${file}`,
          kind: 'delete',
          root: descriptor.key,
          extraRoot: descriptor.extraRoot,
          file,
          baseHash: sha256(buffer),
          risk: 'high',
          verification: '沙箱内删除，应用前仍会执行编译自测',
          note: '由沙箱删除文件提取',
        });
        changedFiles.push(`${descriptor.key}/${file}`);
      }
    }
  }

  return { fixes, skipped, changedFiles };
}

function tail(text, max = COMMAND_OUTPUT_LIMIT) {
  const value = String(text ?? '');
  return value.length > max ? value.slice(value.length - max) : value;
}

/**
 * Build the agent-facing run_command runner. Commands are restricted to the
 * project's build/test toolchain and always execute inside the sandbox.
 */
export function createSandboxCommandRunner({
  sandbox,
  verifyCommand = '',
  workspace = {},
  timeoutMs = 180_000,
} = {}) {
  const backend = sandbox.roots.find((entry) => entry.key === 'backend');
  const frontend = sandbox.roots.find((entry) => entry.key === 'frontend');
  const extras = sandbox.roots.filter((entry) => entry.key === 'extra');
  const roots = {
    sourceRoot: backend?.sandboxRoot ?? null,
    frontendSourceRoot: frontend?.sandboxRoot ?? null,
    extraSourceRoots: extras.map((entry) => ({ id: entry.extraRoot, root: entry.sandboxRoot })),
  };
  let commandsPromise = null;
  const allowedCommands = () => {
    if (!commandsPromise) {
      commandsPromise = detectCompileCommands({
        roots,
        verifyCommand,
        workspace: {},
        projectRoot: sandbox.dir,
      }).catch(() => []);
    }
    return commandsPromise;
  };

  function assertInside(target) {
    const relative = path.relative(sandbox.dir, target);
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new AppError('COMMAND_CWD_DENIED', `命令目录不在沙箱内：${target}`, { exitCode: 2 });
    }
  }

  return async function runCommand({ command, cwd } = {}) {
    const text = String(command ?? '').trim();
    if (!text) throw new AppError('COMMAND_REQUIRED', 'command 不能为空', { exitCode: 2 });
    if (text.length > 500 || SHELL_META.test(text)) {
      throw new AppError('COMMAND_DENIED', '命令包含不允许的 shell 语法', { exitCode: 2 });
    }
    if (/\b(?:install|deploy|publish|push|release|login|logout)\b/i.test(text)
      || /^(?:npm|pnpm|yarn)\s+(?:run\s+)?(?:dev|serve|watch|start)\b/i.test(text)) {
      throw new AppError('COMMAND_DENIED', '该命令可能修改环境或长时间运行，已禁止', { exitCode: 2 });
    }

    const resolved = await allowedCommands();
    const exact = resolved.find((entry) => entry.command === text);
    if (!exact && !SAFE_COMMAND.test(text)) {
      throw new AppError('COMMAND_DENIED', '命令不在允许的编译/测试工具链内', { exitCode: 2 });
    }

    let workdir;
    if (cwd) {
      workdir = path.resolve(sandbox.dir, String(cwd));
      assertInside(workdir);
      if (await pathKind(workdir) !== 'dir') {
        throw new AppError('COMMAND_CWD_INVALID', `命令目录不存在：${workdir}`, { exitCode: 3 });
      }
    } else {
      const lower = text.toLowerCase();
      const backendTool = /^(?:mvn|mvnw|gradle|gradlew|go|dotnet|cargo)\b/.test(lower);
      const frontendTool = /^(?:npm|pnpm|yarn|npx)\b/.test(lower);
      if (backendTool && backend) workdir = backend.sandboxRoot;
      else if (frontendTool && frontend) workdir = frontend.sandboxRoot;
      else workdir = exact?.cwd ?? backend?.sandboxRoot ?? frontend?.sandboxRoot ?? sandbox.dir;
    }

    const result = await runVerifyCommand({
      command: text,
      cwd: workdir,
      timeoutMs,
    });
    return {
      command: text,
      cwd: workdir,
      ok: result.ok,
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      durationMs: result.durationMs,
      output: tail(result.output),
    };
  };
}

export async function cleanupAgentSandbox(sandbox) {
  if (!sandbox?.dir) return;
  await rm(sandbox.dir, { recursive: true, force: true }).catch(() => {});
}
