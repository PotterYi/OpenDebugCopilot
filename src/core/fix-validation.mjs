import { access, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { applyFix, revertFix } from './fix-apply.mjs';
import { resolveFrontendProjectRoot } from './frontend-service.mjs';
import { runVerifyCommand } from '../app/electron/verify-command.mjs';

const DEFAULT_TIMEOUT_MS = 180_000;
const MAX_RESULT_OUTPUT = 12_000;

let validationQueue = Promise.resolve();

async function exists(target) {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

async function findUp(start, names) {
  let current = path.resolve(start);
  for (;;) {
    for (const name of names) {
      const candidate = path.join(current, name);
      if (await exists(candidate)) return { dir: current, file: candidate };
    }
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

async function packageScript(projectRoot) {
  try {
    const pkg = JSON.parse(await readFile(path.join(projectRoot, 'package.json'), 'utf8'));
    const scripts = pkg?.scripts ?? {};
    for (const name of ['build', 'compile', 'typecheck']) {
      if (typeof scripts[name] === 'string' && scripts[name].trim()) return name;
    }
  } catch {
    // not a package project
  }
  return null;
}

async function backendCommands(startRoots) {
  const commands = [];
  for (const start of startRoots.filter(Boolean)) {
    const maven = await findUp(start, ['pom.xml']);
    if (maven) {
      commands.push({ command: 'mvn -q -DskipTests compile', cwd: maven.dir });
      continue;
    }
    const gradle = await findUp(start, ['gradlew', 'gradlew.bat', 'build.gradle', 'build.gradle.kts']);
    if (gradle) {
      const wrapper = process.platform === 'win32'
        ? path.join(gradle.dir, 'gradlew.bat')
        : path.join(gradle.dir, 'gradlew');
      const command = await exists(wrapper)
        ? `${process.platform === 'win32' ? 'gradlew.bat' : './gradlew'} compileJava -x test`
        : 'gradle compileJava -x test';
      commands.push({ command, cwd: gradle.dir });
      continue;
    }
    const go = await findUp(start, ['go.mod']);
    if (go) commands.push({ command: 'go build ./...', cwd: go.dir });
  }
  return commands;
}

async function frontendCommands(startRoots) {
  const commands = [];
  for (const start of startRoots.filter(Boolean)) {
    const pkg = await findUp(start, ['package.json']);
    if (!pkg) continue;
    const script = await packageScript(pkg.dir);
    if (script) {
      commands.push({ command: `npm run ${script}`, cwd: pkg.dir });
      continue;
    }
    if (await exists(path.join(pkg.dir, 'tsconfig.json'))) {
      commands.push({ command: 'npx tsc --noEmit', cwd: pkg.dir });
    }
  }
  return commands;
}

async function pythonCommands(startRoots) {
  const commands = [];
  for (const start of startRoots.filter(Boolean)) {
    const project = await findUp(start, ['pyproject.toml', 'setup.py', 'requirements.txt']);
    if (project) commands.push({ command: 'python -m compileall -q .', cwd: project.dir });
  }
  return commands;
}

/**
 * Resolve the commands used to self-check generated fixes. An explicit
 * workspace.verifyCommand wins; otherwise common Maven/Gradle/npm/Python/Go
 * project layouts are detected from the affected roots.
 */
export async function resolveValidationCommands({
  fixes = [],
  roots = {},
  verifyCommand = '',
  workspace = {},
  projectRoot = process.cwd(),
} = {}) {
  const editFixes = fixes.filter((fix) => fix?.kind === 'edit' && fix?.preview?.status === 'ready');
  if (editFixes.length === 0) return [];

  const backendRoots = [];
  const frontendRoots = [];
  const pythonRoots = [];
  for (const fix of editFixes) {
    const file = String(fix.file ?? '').toLowerCase();
    if (fix.root === 'frontend') {
      frontendRoots.push(roots.frontendSourceRoot || workspace.frontendProjectRoot);
    } else if (fix.root === 'extra') {
      const extra = (roots.extraSourceRoots ?? []).find((entry) => entry.id === fix.extraRoot);
      if (extra?.root) backendRoots.push(extra.root);
    } else {
      backendRoots.push(roots.sourceRoot);
    }
    if (file.endsWith('.py')) pythonRoots.push(roots.sourceRoot);
  }

  const command = String(verifyCommand ?? '').trim();
  if (command) {
    let cwd = null;
    if (frontendRoots.some(Boolean)) {
      const resolved = await resolveFrontendProjectRoot(workspace, { rootDir: projectRoot });
      if (resolved.ok) cwd = resolved.cwd;
    }
    if (!cwd) {
      const backend = backendRoots.find(Boolean);
      const nested = backend
        ? await findUp(backend, ['pom.xml', 'build.gradle', 'build.gradle.kts', 'go.mod'])
        : null;
      cwd = nested?.dir ?? backend ?? frontendRoots.find(Boolean) ?? projectRoot;
    }
    return [{ command, cwd: path.resolve(cwd) }];
  }

  const commands = [
    ...await backendCommands(backendRoots.filter(Boolean)),
    ...await frontendCommands(frontendRoots.filter(Boolean)),
    ...await pythonCommands(pythonRoots.filter(Boolean)),
  ];
  const seen = new Set();
  return commands
    .filter((entry) => {
      const key = `${entry.cwd}\0${entry.command}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .map((entry) => ({ ...entry, cwd: path.resolve(entry.cwd) }));
}

function tail(text, max = MAX_RESULT_OUTPUT) {
  const value = String(text ?? '');
  return value.length > max ? value.slice(value.length - max) : value;
}

async function runValidation(options) {
  const {
    fixes = [],
    roots = {},
    verifyCommand = '',
    workspace = {},
    projectRoot = process.cwd(),
    runDir = null,
    timeoutMs = DEFAULT_TIMEOUT_MS,
  } = options;

  const editFixes = fixes.filter((fix) => fix?.kind === 'edit' && fix?.preview?.status === 'ready');
  if (editFixes.length === 0) {
    return { status: 'skipped', ok: true, reason: '没有可应用的代码修改', commands: [], applied: 0 };
  }
  const commands = await resolveValidationCommands({
    fixes: editFixes,
    roots,
    verifyCommand,
    workspace,
    projectRoot,
  });
  if (commands.length === 0) {
    return {
      status: 'skipped',
      ok: true,
      reason: '未配置验证命令，且未识别到可用的编译命令',
      commands: [],
      applied: 0,
    };
  }

  const baseDir = runDir ?? path.resolve('.tmp');
  const backupDir = path.join(baseDir, `self-check-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`);
  const applied = [];
  const results = [];
  const logParts = [];
  let applyError = null;
  let revertError = null;

  try {
    await mkdir(backupDir, { recursive: true });
    for (let index = 0; index < editFixes.length; index += 1) {
      const backup = path.join(backupDir, `fix-${index}.orig`);
      try {
        await applyFix({ fix: editFixes[index], roots, backupPath: backup });
        applied.push({ fix: editFixes[index], backup });
      } catch (error) {
        applyError = `应用修改失败：${error?.message ?? error}`;
        break;
      }
    }

    if (!applyError) {
      for (const target of commands) {
        const result = await runVerifyCommand({
          command: target.command,
          cwd: target.cwd,
          timeoutMs,
        });
        results.push(result);
        logParts.push(`$ ${result.command}\n(cwd: ${target.cwd})\n${result.output}`);
        if (!result.ok) break;
      }
    } else {
      logParts.push(applyError);
    }
  } finally {
    for (const item of [...applied].reverse()) {
      try {
        await revertFix({ fix: item.fix, roots, backupPath: item.backup });
      } catch (error) {
        revertError = `回滚修改失败：${error?.message ?? error}`;
      }
    }
    if (revertError) {
      logParts.push(`${revertError}；原文件备份保留在 ${backupDir}`);
    } else {
      await rm(backupDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  const failedRun = results.find((result) => !result.ok) ?? null;
  const error = applyError
    ?? revertError
    ?? (failedRun
      ? (failedRun.timedOut ? `编译自测超时：${failedRun.command}` : `编译自测失败：${failedRun.command}`)
      : null);
  const status = error ? 'failed' : 'passed';
  const output = tail(logParts.join('\n\n'));
  if (runDir) {
    await writeFile(path.join(runDir, 'self-check.log'), `${status}\n\n${logParts.join('\n\n')}`, 'utf8')
      .catch(() => {});
  }

  return {
    status,
    ok: !error,
    error,
    applied: applied.length,
    commands: results.map((result) => ({
      command: result.command,
      cwd: result.cwd,
      ok: result.ok,
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      durationMs: result.durationMs,
    })),
    durationMs: results.reduce((sum, result) => sum + (result.durationMs ?? 0), 0),
    output,
  };
}

/**
 * Apply all ready fixes, run the project self-check, then always restore the
 * original files. Validations are serialized so concurrent diagnoses cannot
 * mutate the same working tree at the same time.
 */
export function validateFixes(options = {}) {
  const run = () => runValidation(options);
  const next = validationQueue.then(run, run);
  validationQueue = next.catch(() => {});
  return next;
}
