import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import { acquireWorkspaceLocks } from './workspace-lock.mjs';
import { runWorkspaceCheck } from './fix-validation.mjs';
import { previewFixFromTexts } from './fixes.mjs';
import { createSandboxCommandRunner } from './agent-sandbox.mjs';

const execFileAsync = promisify(execFile);
const MAX_FILE_BYTES = 2 * 1024 * 1024;

async function git(repo, args, { allowFail = false } = {}) {
  try {
    const { stdout } = await execFileAsync('git', ['-C', repo, ...args], {
      windowsHide: true,
      maxBuffer: 16 * 1024 * 1024,
      encoding: 'utf8',
    });
    return stdout;
  } catch (error) {
    if (allowFail) return null;
    throw error;
  }
}

export async function detectGitRepo(root) {
  const inside = await git(root, ['rev-parse', '--is-inside-work-tree'], { allowFail: true });
  if (String(inside ?? '').trim() !== 'true') return null;
  const top = await git(root, ['rev-parse', '--show-toplevel'], { allowFail: true });
  return top ? path.resolve(String(top).trim()) : null;
}

function hashBuffer(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

function normalizeText(value) {
  return String(value).replace(/\r\n/g, '\n');
}

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

async function readTextFile(target) {
  const kind = await pathKind(target);
  if (kind !== 'file') return { exists: false, buffer: null, text: null, hash: null };
  const info = await stat(target);
  if (info.size > MAX_FILE_BYTES) return { exists: true, tooLarge: true, buffer: null, text: null, hash: null };
  const buffer = await readFile(target);
  if (buffer.includes(0)) return { exists: true, binary: true, buffer, text: null, hash: hashBuffer(buffer) };
  return {
    exists: true,
    buffer,
    text: normalizeText(buffer.toString('utf8')),
    hash: hashBuffer(buffer),
  };
}

async function writeBackup(target, dest) {
  await mkdir(path.dirname(dest), { recursive: true });
  if (target.exists) {
    await writeFile(dest, target.buffer);
  }
}

function inside(root, target) {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

async function writeJsonAtomic(file, value) {
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await rename(tmp, file);
}

function createBaseline({ runDir, roots, onChange = null }) {
  const baselineDir = path.join(runDir, 'baseline');
  const touched = new Map();

  const rootFor = (absPath) => roots.find((entry) => inside(entry.root, absPath)) ?? null;

  function backupPath(kind, repo, relative) {
    const repoKey = createHash('sha256').update(path.resolve(repo)).digest('hex').slice(0, 12);
    return path.join(baselineDir, kind, repoKey, relative);
  }

  async function snapshotBeforeWrite(filePath) {
    const absPath = await realpath(String(filePath ?? '')).catch(() => path.resolve(String(filePath ?? '')));
    const descriptor = rootFor(absPath);
    if (!descriptor) {
      throw new Error('目标文件不在可写源码目录内');
    }
    if (touched.has(absPath)) return;
    const current = await readTextFile(absPath);
    if (current.tooLarge) throw new Error('文件过大，无法保存修改前快照');
    const relative = path.relative(descriptor.repo, absPath);
    const backup = backupPath('prewrite', descriptor.repo, relative);
    if (current.exists) await writeBackup(current, backup);
    touched.set(absPath, {
      descriptor,
      repo: descriptor.repo,
      relative,
      backup: current.exists ? backup : null,
      exists: current.exists,
      preHash: current.hash,
      lastHash: current.hash,
      lastExists: current.exists,
    });
    await onChange?.();
  }

  async function recordAfterWrite(filePath) {
    const absPath = await realpath(String(filePath ?? '')).catch(() => path.resolve(String(filePath ?? '')));
    const entry = touched.get(absPath);
    if (!entry) return;
    const current = await readTextFile(absPath);
    entry.lastHash = current.hash;
    entry.lastExists = current.exists;
    await onChange?.();
  }

  async function extract() {
    const fixes = [];
    const skipped = [];
    const conflicts = [];
    const changedFiles = [];
    for (const [absPath, entry] of touched) {
      const current = await readTextFile(absPath);
      if (current.tooLarge) {
        skipped.push({ file: entry.relative, reason: '文件超过预览上限' });
        continue;
      }
      if (current.binary) {
        skipped.push({ file: entry.relative, reason: '二进制文件不生成代码修复' });
        continue;
      }
      if (entry.lastHash && current.exists && current.hash !== entry.lastHash) {
        const file = path.relative(entry.descriptor.root, absPath).split(path.sep).join('/');
        conflicts.push({ file, reason: '文件在诊断期间被外部修改' });
        continue;
      }
      if (!entry.exists && !current.exists) continue;
      let originalText = null;
      if (entry.exists) {
        const backup = await readTextFile(entry.backup);
        if (backup.tooLarge || backup.binary) {
          skipped.push({ file: entry.relative, reason: '基线内容不可用' });
          continue;
        }
        originalText = backup.text ?? '';
      }
      const file = path.relative(entry.descriptor.root, absPath).split(path.sep).join('/');
      let fix = null;
      if (!entry.exists && current.exists) {
        fix = {
          summary: `新增文件：${file}`,
          kind: 'create',
          root: entry.descriptor.key,
          extraRoot: entry.descriptor.extraRoot ?? null,
          file,
          content: current.text,
        };
      } else if (entry.exists && !current.exists) {
        fix = {
          summary: `删除文件：${file}`,
          kind: 'delete',
          root: entry.descriptor.key,
          extraRoot: entry.descriptor.extraRoot ?? null,
          file,
          baseHash: entry.preHash,
        };
      } else {
        if (originalText === current.text) continue;
        fix = {
          summary: `修改文件：${file}`,
          kind: 'edit',
          root: entry.descriptor.key,
          extraRoot: entry.descriptor.extraRoot ?? null,
          file,
          search: originalText,
          replace: current.text,
          baseHash: entry.preHash,
        };
      }
      fixes.push(previewFixFromTexts(fix, originalText, current.text));
      changedFiles.push(`${entry.descriptor.key}/${file}`);
    }
    return { fixes, skipped, conflicts, changedFiles };
  }

  async function discard() {
    const restored = [];
    const conflicts = [];
    for (const [absPath, entry] of touched) {
      const current = await readTextFile(absPath);
      if (entry.lastHash && current.exists && current.hash !== entry.lastHash) {
        conflicts.push({
          file: path.relative(entry.descriptor.root, absPath).split(path.sep).join('/'),
          reason: '文件在诊断期间被外部修改，拒绝回滚',
        });
        continue;
      }
      if (entry.exists) {
        const backup = await readFile(entry.backup);
        await mkdir(path.dirname(absPath), { recursive: true });
        await writeFile(absPath, backup);
      } else {
        await rm(absPath, { force: true });
      }
      restored.push(path.relative(entry.descriptor.root, absPath).split(path.sep).join('/'));
    }
    return { restored, conflicts };
  }

  return {
    baselineDir,
    touched,
    snapshotBeforeWrite,
    recordAfterWrite,
    extract,
    discard,
  };
}

const INPLACE_PROMPT = `

# 原地工作区模式
你正在真实工程中工作，修改会直接写入用户工作区；诊断结束后用户可以选择保留或丢弃。
- 只能修改后端源码根、前端源码根；其他后端源码目录只读。
- 禁止 Edit/Write：target、dist、build、out、node_modules、.git、logs、runs、.tmp 等目录。
- 可以用 run_command 编译/测试；修改后请自己运行验证。
- 不要把最终修改重复写进 fixes；系统会从工作区提取补丁，并由用户决定保留或丢弃。`;

/**
 * In-place workspace session for Git projects. The agent edits real files;
 * every write is snapshotted first, and keep/discard is left to the user.
 */
export async function createInPlaceSession({
  runDir,
  roots = [],
  readOnlyRoots = [],
  runId = '',
  workspace = {},
  verifyCommand = '',
  projectRoot = process.cwd(),
} = {}) {
  if (roots.length === 0) return { ok: false, reason: 'no-roots' };
  const detected = [];
  for (const entry of roots) {
    const repo = await detectGitRepo(entry.root);
    if (!repo) return { ok: false, reason: 'not-git' };
    detected.push({ ...entry, repo });
  }
  const repos = [...new Set(detected.map((entry) => entry.repo))];
  const locks = await acquireWorkspaceLocks(repos, { runId });
  if (!locks.ok) {
    return { ok: false, reason: 'busy', busyRepo: locks.busyRepo, owner: locks.owner };
  }

  let baseline = null;
  const journalPath = path.join(runDir, 'workspace-journal.json');
  const journal = {
    version: 1,
    runId,
    mode: 'in-place',
    status: 'editing',
    pid: process.pid,
    startedAt: Date.now(),
    repos,
    roots: detected.map((entry) => ({
      key: entry.key,
      extraRoot: entry.extraRoot ?? null,
      root: entry.root,
      repo: entry.repo,
    })),
    touched: [],
    changedFiles: [],
    skipped: [],
    conflicts: [],
    selfCheck: null,
  };
  async function flushJournal() {
    if (!baseline) return;
    journal.touched = [...baseline.touched.entries()].map(([file, entry]) => ({
      file,
      key: entry.descriptor.key,
      extraRoot: entry.descriptor.extraRoot ?? null,
      root: entry.descriptor.root,
      repo: entry.repo,
      relative: entry.relative,
      backup: entry.backup,
      existsBefore: entry.exists,
      preHash: entry.preHash,
      lastHash: entry.lastHash,
      lastExists: entry.lastExists,
    }));
    await writeJsonAtomic(journalPath, journal);
  }
  try {
    baseline = createBaseline({
      runDir,
      roots: detected,
      onChange: () => flushJournal(),
    });
    await flushJournal();
  } catch (error) {
    await locks.release();
    return { ok: false, reason: 'baseline-error', error };
  }

  const cwd = detected[0].root;
  const allowedRoots = [
    ...detected.map((entry) => entry.root),
    ...readOnlyRoots.map((entry) => entry.root),
  ];
  const writeRoots = detected.map((entry) => entry.root);
  const commandRoots = {
    dir: cwd,
    roots: detected.map((entry) => ({
      key: entry.key,
      extraRoot: entry.extraRoot ?? null,
      realRoot: entry.root,
      sandboxRoot: entry.root,
    })),
  };
  const runCommand = createSandboxCommandRunner({
    sandbox: commandRoots,
    verifyCommand,
    workspace,
  });

  async function runSelfCheck() {
    const validationRoots = {
      sourceRoot: detected.find((entry) => entry.key === 'backend')?.root ?? null,
      frontendSourceRoot: detected.find((entry) => entry.key === 'frontend')?.root ?? null,
      extraSourceRoots: [],
    };
    const validation = await runWorkspaceCheck({
      roots: validationRoots,
      verifyCommand,
      workspace,
      projectRoot: cwd,
      runDir,
    });
    journal.selfCheck = validation;
    await flushJournal();
    return validation;
  }

  async function extract() {
    const result = await baseline.extract();
    journal.changedFiles = result.changedFiles;
    journal.skipped = result.skipped;
    journal.conflicts = result.conflicts;
    journal.status = 'pending';
    await flushJournal();
    return result;
  }

  async function cleanupBaseline() {
    if (!baseline) return;
    await rm(baseline.baselineDir, { recursive: true, force: true }).catch(() => {});
  }

  return {
    ok: true,
    mode: 'in-place',
    cwd,
    allowedRoots,
    writeRoots,
    readOnlyRoots: readOnlyRoots.map((entry) => entry.root),
    repos,
    baselineDir: baseline.baselineDir,
    journalPath,
    systemPromptSuffix: INPLACE_PROMPT,
    onBeforeWrite: (input) => baseline.snapshotBeforeWrite(input.filePath),
    onAfterWrite: (input) => baseline.recordAfterWrite(input.filePath),
    runCommand,
    extract,
    runSelfCheck,
    async discard() {
      const result = await baseline.discard();
      journal.status = result.conflicts?.length ? 'pending' : 'discarded';
      await flushJournal();
      if (!result.conflicts?.length) await cleanupBaseline();
      await locks.release();
      return result;
    },
    async keep() {
      journal.status = 'kept';
      await flushJournal();
      await cleanupBaseline();
      await locks.release();
      return { ok: true };
    },
    async release() {
      await locks.release();
    },
  };
}

/**
 * Scan run directories for unfinished workspace journals. Called on startup so
 * the UI can warn the user about half-applied in-place edits.
 */
export async function listPendingWorkspaceJournals(runsRoot) {
  const root = path.resolve(runsRoot);
  let names = [];
  try {
    names = await readdir(root);
  } catch {
    return [];
  }
  const pending = [];
  for (const name of names) {
    const journalPath = path.join(root, name, 'workspace-journal.json');
    try {
      const journal = JSON.parse(await readFile(journalPath, 'utf8'));
      if (!['editing', 'pending'].includes(journal.status)) continue;
      const files = (journal.touched ?? [])
        .map((entry) => (entry?.relative ? (entry.key ? `${entry.key}/${entry.relative}` : entry.relative) : null))
        .filter(Boolean);
      pending.push({
        runId: journal.runId ?? name,
        status: journal.status,
        startedAt: journal.startedAt ?? null,
        repoCount: (journal.repos ?? []).length,
        changedFiles: (journal.changedFiles ?? []).length,
        touchedFiles: (journal.touched ?? []).length,
        files: files.slice(0, 20),
        selfCheckStatus: journal.selfCheck?.status ?? null,
        selfCheckError: journal.selfCheck?.error ?? null,
        journalPath,
      });
    } catch {
      // no journal or unreadable
    }
  }
  return pending.sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0));
}

/**
 * Finalize a journal that lost its in-memory session (app restart/crash).
 * Never overwrites files whose current hash no longer matches the last agent write.
 */
export async function finalizeWorkspaceJournal(journalPath, action) {
  let journal;
  try {
    journal = JSON.parse(await readFile(journalPath, 'utf8'));
  } catch (error) {
    return { ok: false, error: `读取工作区 journal 失败：${error?.message ?? error}` };
  }
  if (!['keep', 'discard'].includes(action)) {
    return { ok: false, error: `未知操作：${action}` };
  }
  const baselineDir = path.join(path.dirname(journalPath), 'baseline');
  const cleanupBaseline = () => rm(baselineDir, { recursive: true, force: true }).catch(() => {});
  // A kept/discarded journal must never be re-applied: discard after keep would
  // silently roll back modifications the user explicitly kept.
  if (journal.status === 'kept' || journal.status === 'discarded') {
    await cleanupBaseline();
    return {
      ok: true,
      status: journal.status,
      restored: [],
      conflicts: journal.conflicts ?? [],
      alreadyFinalized: true,
    };
  }
  const repos = Array.isArray(journal.repos) ? journal.repos : [];
  const locks = await acquireWorkspaceLocks(repos, { runId: `recover-${journal.runId ?? 'unknown'}` });
  if (!locks.ok) {
    return { ok: false, error: '工作区仍被其他诊断占用，暂时无法处理', busyRepo: locks.busyRepo };
  }
  try {
    if (action === 'keep') {
      journal.status = 'kept';
      journal.finishedAt = Date.now();
      await writeJsonAtomic(journalPath, journal);
      await cleanupBaseline();
      return { ok: true, status: 'kept', restored: [], conflicts: [] };
    }
    const restored = [];
    const conflicts = [];
    for (const entry of journal.touched ?? []) {
      const file = entry.file;
      if (!file) continue;
      const current = await readTextFile(file);
      if (entry.lastHash && current.exists && current.hash !== entry.lastHash) {
        conflicts.push({
          file: entry.relative ?? file,
          reason: '文件在诊断期间被外部修改，拒绝回滚',
        });
        continue;
      }
      if (entry.existsBefore) {
        if (!entry.backup) {
          conflicts.push({ file: entry.relative ?? file, reason: '缺少修改前快照' });
          continue;
        }
        const backup = await readFile(entry.backup);
        await mkdir(path.dirname(file), { recursive: true });
        await writeFile(file, backup);
      } else {
        await rm(file, { force: true });
      }
      restored.push(entry.relative ?? file);
    }
    journal.status = conflicts.length > 0 ? 'pending' : 'discarded';
    journal.finishedAt = conflicts.length > 0 ? null : Date.now();
    journal.conflicts = conflicts;
    await writeJsonAtomic(journalPath, journal);
    if (conflicts.length === 0) await cleanupBaseline();
    return { ok: true, status: journal.status, restored, conflicts };
  } finally {
    await locks.release();
  }
}
