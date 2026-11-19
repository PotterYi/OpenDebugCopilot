import { access, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { resolveFrontendProjectRoot } from './frontend-service.mjs';
import { runVerifyCommand } from '../app/electron/verify-command.mjs';

const DEFAULT_TIMEOUT_MS = 180_000;
const MAX_RESULT_OUTPUT = 12_000;

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

const TEST_SKIP_DIRS = new Set([
  'node_modules', '.git', 'target', 'dist', 'build', 'out', 'coverage',
  '.next', '.nuxt', '.idea', '.vscode', 'vendor', '.tmp', 'runs',
]);

async function hasTestTree(root, depth = 2) {
  if (await exists(path.join(root, 'src', 'test'))) return true;
  if (depth <= 0) return false;
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return false;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || TEST_SKIP_DIRS.has(entry.name) || entry.name.startsWith('.')) continue;
    if (await hasTestTree(path.join(root, entry.name), depth - 1)) return true;
  }
  return false;
}

async function hasFileSuffix(root, suffix, { depth = 4, limit = 5000 } = {}) {
  const queue = [{ dir: root, depth }];
  let seen = 0;
  while (queue.length > 0 && seen < limit) {
    const { dir, depth: current } = queue.shift();
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      seen += 1;
      if (seen > limit) break;
      if (entry.isFile() && entry.name.endsWith(suffix)) return true;
      if (entry.isDirectory() && current > 0
        && !TEST_SKIP_DIRS.has(entry.name) && !entry.name.startsWith('.')) {
        queue.push({ dir: path.join(dir, entry.name), depth: current - 1 });
      }
    }
  }
  return false;
}

async function readIfExists(file) {
  try {
    return await readFile(file, 'utf8');
  } catch {
    return '';
  }
}

async function hasPytestConfig(root) {
  if (await exists(path.join(root, 'pytest.ini'))) return true;
  const pyproject = await readIfExists(path.join(root, 'pyproject.toml'));
  if (/\[tool\.pytest/i.test(pyproject)) return true;
  const setup = await readIfExists(path.join(root, 'setup.cfg'));
  if (/\[tool:pytest\]/i.test(setup)) return true;
  const tox = await readIfExists(path.join(root, 'tox.ini'));
  return /\[pytest\]/i.test(tox);
}

async function hasPythonTests(root) {
  if (await hasPytestConfig(root)) return true;
  if (await exists(path.join(root, 'tests')) || await exists(path.join(root, 'test'))) return true;
  return hasFileSuffix(root, 'test_.py', { depth: 3, limit: 3000 })
    || hasFileSuffix(root, '_test.py', { depth: 3, limit: 3000 });
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

async function packageTestHint(projectRoot) {
  try {
    const pkg = JSON.parse(await readFile(path.join(projectRoot, 'package.json'), 'utf8'));
    const test = pkg?.scripts?.test;
    if (typeof test !== 'string' || !test.trim()) return null;
    if (/no test specified|exit 1/i.test(test)) return null;
    return {
      phase: 'test',
      command: 'npm test',
      cwd: projectRoot,
      reason: '前端测试脚本只提示，不自动执行；需要时请写入验证命令列表',
    };
  } catch {
    return null;
  }
}

async function backendPlan(startRoots) {
  const commands = [];
  for (const start of startRoots.filter(Boolean)) {
    const maven = await findUp(start, ['pom.xml']);
    if (maven) {
      commands.push({ phase: 'build', required: true, source: 'auto', command: 'mvn -q -DskipTests compile', cwd: maven.dir });
      if (await hasTestTree(maven.dir)) {
        commands.push({ phase: 'test', required: false, source: 'auto', command: 'mvn -q test', cwd: maven.dir });
      }
      continue;
    }
    const gradle = await findUp(start, ['gradlew', 'gradlew.bat', 'build.gradle', 'build.gradle.kts']);
    if (gradle) {
      const wrapper = process.platform === 'win32'
        ? path.join(gradle.dir, 'gradlew.bat')
        : path.join(gradle.dir, 'gradlew');
      const prefix = await exists(wrapper)
        ? (process.platform === 'win32' ? 'gradlew.bat' : './gradlew')
        : 'gradle';
      commands.push({ phase: 'build', required: true, source: 'auto', command: `${prefix} compileJava -x test`, cwd: gradle.dir });
      if (await hasTestTree(gradle.dir)) {
        commands.push({ phase: 'test', required: false, source: 'auto', command: `${prefix} test`, cwd: gradle.dir });
      }
      continue;
    }
    const go = await findUp(start, ['go.mod']);
    if (go) {
      commands.push({ phase: 'build', required: true, source: 'auto', command: 'go build ./...', cwd: go.dir });
      if (await hasFileSuffix(go.dir, '_test.go')) {
        commands.push({ phase: 'test', required: false, source: 'auto', command: 'go test ./...', cwd: go.dir });
      }
    }
  }
  return commands;
}

async function frontendPlan(startRoots) {
  const commands = [];
  const hints = [];
  for (const start of startRoots.filter(Boolean)) {
    const pkg = await findUp(start, ['package.json']);
    if (!pkg) continue;
    const script = await packageScript(pkg.dir);
    if (script) {
      commands.push({ phase: 'build', required: true, source: 'auto', command: `npm run ${script}`, cwd: pkg.dir });
    } else if (await exists(path.join(pkg.dir, 'tsconfig.json'))) {
      commands.push({ phase: 'build', required: true, source: 'auto', command: 'npx tsc --noEmit', cwd: pkg.dir });
    }
    const hint = await packageTestHint(pkg.dir);
    if (hint) hints.push(hint);
  }
  return { commands, hints };
}

async function pythonPlan(startRoots) {
  const commands = [];
  for (const start of startRoots.filter(Boolean)) {
    const project = await findUp(start, ['pyproject.toml', 'setup.py', 'requirements.txt']);
    if (!project) continue;
    commands.push({ phase: 'build', required: true, source: 'auto', command: 'python -m compileall -q .', cwd: project.dir });
    if (await hasPythonTests(project.dir)) {
      commands.push({ phase: 'test', required: false, source: 'auto', command: 'python -m pytest -q', cwd: project.dir });
    }
  }
  return commands;
}

function inferPhase(command) {
  const text = String(command ?? '').toLowerCase();
  if (/-dskiptests|--exclude-task\s+test|-x\s+test|compilejava|npm run build|pnpm run build|yarn build|vite build|tsc|compileall|go build/.test(text)) {
    return 'build';
  }
  if (/\b(?:mvn|mvnw)\b.*\b(?:test|verify)\b/.test(text)
    || /\b(?:npm|pnpm|yarn)\s+(?:run\s+)?test\b/.test(text)
    || /\b(?:pytest|py\.test|unittest|jest|vitest)\b/.test(text)
    || /\bgo\s+test\b/.test(text)
    || /\bgradlew?\b.*\btest\b/.test(text)) {
    return 'test';
  }
  return 'build';
}

async function resolveNestedDir(root) {
  if (!root) return null;
  const nested = await findUp(root, ['pom.xml', 'build.gradle', 'build.gradle.kts', 'go.mod', 'package.json']);
  return nested?.dir ?? root;
}

async function configuredCwd(entry, { roots = {}, workspace = {}, projectRoot = process.cwd() } = {}) {
  if (entry.root === 'frontend') {
    const resolved = await resolveFrontendProjectRoot(workspace, { rootDir: projectRoot });
    return path.resolve(resolved.ok ? resolved.cwd : (roots.frontendSourceRoot || projectRoot));
  }
  if (entry.root === 'backend') {
    return path.resolve(await resolveNestedDir(roots.sourceRoot) || projectRoot);
  }
  if (entry.root === 'extra') {
    const extra = (roots.extraSourceRoots ?? []).find((item) => item.id === entry.extraRoot);
    return path.resolve(await resolveNestedDir(extra?.root) || projectRoot);
  }
  return path.resolve(roots.sourceRoot || roots.frontendSourceRoot || projectRoot);
}

async function legacyCwd({ roots = {}, workspace = {}, projectRoot = process.cwd(), frontendRoots = [], backendRoots = [] } = {}) {
  if (frontendRoots.some(Boolean)) {
    const resolved = await resolveFrontendProjectRoot(workspace, { rootDir: projectRoot });
    if (resolved.ok) return resolved.cwd;
  }
  const backend = backendRoots.find(Boolean);
  const nested = backend
    ? await findUp(backend, ['pom.xml', 'build.gradle', 'build.gradle.kts', 'go.mod'])
    : null;
  return path.resolve(nested?.dir ?? backend ?? frontendRoots.find(Boolean) ?? projectRoot);
}

function normalizeConfiguredCommands(verifyCommands, verifyCommand) {
  if (Array.isArray(verifyCommands) && verifyCommands.length > 0) {
    return verifyCommands
      .map((entry) => {
        const command = String(entry?.command ?? '').trim();
        if (!command) return null;
        const phase = entry?.phase === 'test' ? 'test' : (entry?.phase === 'build' ? 'build' : inferPhase(command));
        return {
          command,
          phase,
          required: entry?.required === undefined ? phase === 'build' : entry.required === true,
          root: entry?.root,
          extraRoot: entry?.extraRoot,
          source: 'config',
        };
      })
      .filter(Boolean);
  }
  const command = String(verifyCommand ?? '').trim();
  if (!command) return [];
  const phase = inferPhase(command);
  return [{ command, phase, required: true, source: 'config' }];
}

async function resolveValidationPlan({
  fixes = [],
  roots = {},
  verifyCommands = undefined,
  verifyCommand = '',
  verifyRunTests = undefined,
  workspace = {},
  projectRoot = process.cwd(),
} = {}) {
  const editFixes = fixes.filter((fix) => ['edit', 'create', 'delete'].includes(fix?.kind) && fix?.preview?.status === 'ready');
  if (editFixes.length === 0) return { commands: [], hints: [], testsAvailable: false };

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

  const configuredCommands = verifyCommands !== undefined ? verifyCommands : (workspace.verifyCommands ?? []);
  const runTests = verifyRunTests !== undefined ? verifyRunTests : workspace.verifyRunTests !== false;
  const configured = normalizeConfiguredCommands(configuredCommands, verifyCommand);
  if (configured.length > 0) {
    const commands = [];
    for (const entry of configured) {
      const cwd = entry.source === 'config' && !entry.root && verifyCommand && !(configuredCommands?.length)
        ? await legacyCwd({ roots, workspace, projectRoot, frontendRoots, backendRoots })
        : await configuredCwd(entry, { roots, workspace, projectRoot });
      commands.push({ ...entry, cwd });
    }
    return {
      commands,
      hints: [],
      testsAvailable: commands.some((entry) => entry.phase === 'test'),
    };
  }

  const frontend = await frontendPlan(frontendRoots.filter(Boolean));
  const commands = [
    ...await backendPlan(backendRoots.filter(Boolean)),
    ...frontend.commands,
    ...await pythonPlan(pythonRoots.filter(Boolean)),
  ];
  const seen = new Set();
  const deduped = commands.filter((entry) => {
    const key = `${entry.cwd}\0${entry.command}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).filter((entry) => runTests || entry.phase !== 'test');
  const hintSeen = new Set();
  const hints = frontend.hints.filter((entry) => {
    const key = `${entry.cwd}\0${entry.command}`;
    if (hintSeen.has(key)) return false;
    hintSeen.add(key);
    return true;
  }).map((entry) => ({
    ...entry,
    reason: runTests === false
      ? '自动测试已关闭；前端测试脚本仅提示'
      : entry.reason,
  }));
  return {
    commands: deduped.map((entry) => ({ ...entry, cwd: path.resolve(entry.cwd) })),
    hints,
    testsAvailable: deduped.some((entry) => entry.phase === 'test') || hints.length > 0,
  };
}

/**
 * Resolve the ordered commands used to self-check generated fixes. Explicit
 * verifyCommands/verifyCommand win; otherwise common project layouts are
 * detected, with build first and tests second.
 */
export async function resolveValidationCommands(options = {}) {
  return (await resolveValidationPlan(options)).commands;
}

export async function detectValidationPlan({
  roots = {},
  verifyCommands = undefined,
  verifyCommand = '',
  verifyRunTests = undefined,
  workspace = {},
  projectRoot = process.cwd(),
} = {}) {
  const fixes = [];
  if (roots.sourceRoot) {
    fixes.push({ kind: 'edit', preview: { status: 'ready' }, root: 'backend', file: 'placeholder' });
  }
  if (roots.frontendSourceRoot || workspace.frontendProjectRoot) {
    fixes.push({ kind: 'edit', preview: { status: 'ready' }, root: 'frontend', file: 'placeholder' });
  }
  for (const entry of roots.extraSourceRoots ?? []) {
    fixes.push({ kind: 'edit', preview: { status: 'ready' }, root: 'extra', extraRoot: entry.id, file: 'placeholder' });
  }
  if (fixes.length === 0) return { commands: [], hints: [], testsAvailable: false };
  return resolveValidationPlan({
    fixes,
    roots,
    verifyCommands,
    verifyCommand,
    verifyRunTests,
    workspace,
    projectRoot,
  });
}

/** Detect all commands (build + tests + explicit) for the configured roots. */
export async function detectCompileCommands(options = {}) {
  return (await detectValidationPlan(options)).commands;
}


function tail(text, max = MAX_RESULT_OUTPUT) {
  const value = String(text ?? '');
  return value.length > max ? value.slice(value.length - max) : value;
}

/**
 * Compile/test the current workspace as-is. Used after modes that write real
 * files directly (in-place Git sessions, full-permission edits), where there
 * is no patch to apply and revert.
 */
export async function runWorkspaceCheck({
  roots = {},
  verifyCommands = undefined,
  verifyCommand = '',
  verifyRunTests = undefined,
  workspace = {},
  projectRoot = process.cwd(),
  runDir = null,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  restrictToProjectRoot = false,
} = {}) {
  let plan;
  try {
    plan = await detectValidationPlan({
      roots,
      verifyCommands,
      verifyCommand,
      verifyRunTests,
      workspace,
      projectRoot,
    });
  } catch (error) {
    return {
      status: 'skipped',
      ok: false,
      buildStatus: 'skipped',
      testStatus: 'skipped',
      reason: `构建/测试命令探测失败：${error?.message ?? error}`,
      detectionError: true,
      commands: [],
      buildCommands: [],
      testCommands: [],
      testHints: [],
      testsAvailable: false,
      durationMs: 0,
      output: '',
    };
  }
  let commands = plan.commands;
  if (restrictToProjectRoot) {
    const root = path.resolve(projectRoot);
    commands = commands.map((entry) => {
      const cwd = path.resolve(entry.cwd ?? root);
      const relative = path.relative(root, cwd);
      const outside = relative.startsWith('..') || path.isAbsolute(relative);
      return outside ? { ...entry, cwd: root } : entry;
    });
  }
  if (commands.length === 0) {
    return {
      status: 'skipped',
      ok: true,
      buildStatus: 'skipped',
      testStatus: 'skipped',
      reason: plan.hints.length > 0
        ? '未检测到可自动执行的构建/测试命令；找到的前端测试脚本仅提示'
        : '未配置验证命令，且未识别到可用的构建/测试命令',
      commands: [],
      buildCommands: [],
      testCommands: [],
      testHints: plan.hints,
      testsAvailable: plan.testsAvailable,
      durationMs: 0,
      output: '',
    };
  }

  const results = [];
  const logParts = [];
  for (const target of commands) {
    const result = await runVerifyCommand({
      command: target.command,
      cwd: target.cwd,
      timeoutMs,
      phase: target.phase,
    });
    results.push({
      ...result,
      phase: target.phase,
      required: target.required !== false,
      source: target.source ?? 'auto',
    });
    logParts.push(`[${target.phase}] $ ${result.command}\n(cwd: ${result.cwd})\n${result.output ?? ''}`);
    if (!result.ok && (target.phase === 'build' || target.required !== false)) break;
  }

  const suspicions = results.flatMap((entry) => (entry.suspicions ?? []).map((item) => ({
    ...item,
    phase: entry.phase,
    command: entry.command,
  })));
  const testSummary = results
    .map((entry) => entry.testSummary)
    .filter(Boolean)
    .sort((a, b) => (b.tests ?? 0) - (a.tests ?? 0))[0] ?? null;
  const buildResults = results.filter((entry) => entry.phase === 'build');
  const testResults = results.filter((entry) => entry.phase === 'test');
  const buildFailure = buildResults.find((entry) => !entry.ok) ?? null;
  const testFailure = testResults.find((entry) => !entry.ok) ?? null;
  const requiredTestFailure = testResults.find((entry) => !entry.ok && entry.required) ?? null;
  const testRequired = testResults.some((entry) => entry.required);
  const buildStatus = buildFailure ? 'failed'
    : buildResults.length > 0 ? 'passed' : 'skipped';
  const testStatus = testFailure ? 'failed'
    : testResults.length > 0 ? 'passed' : 'skipped';
  const blockingError = buildFailure
    ? (buildFailure.timedOut ? `构建验证超时：${buildFailure.command}` : `构建验证失败：${buildFailure.command}`)
    : (requiredTestFailure
      ? (requiredTestFailure.timedOut ? `测试验证超时：${requiredTestFailure.command}` : `测试验证失败：${requiredTestFailure.command}`)
      : null);
  const testError = testFailure
    ? (testFailure.timedOut ? `测试验证超时：${testFailure.command}` : `测试验证失败：${testFailure.command}`)
    : null;
  const status = blockingError
    ? 'failed'
    : (buildStatus === 'passed' || testStatus === 'passed' ? 'passed' : 'skipped');
  const testReason = testStatus === 'failed'
    ? (testRequired ? '测试失败（已阻断）' : '测试失败（未阻断，需人工确认）')
    : (testStatus === 'skipped'
      ? (plan.hints.length > 0
        ? '检测到前端测试脚本，但仅提示、不自动执行'
        : (buildStatus === 'failed' ? '构建失败，未执行测试' : '未检测到可自动运行的测试命令'))
      : null);

  if (runDir) {
    await writeFile(
      path.join(runDir, 'self-check.log'),
      `overall=${status} build=${buildStatus} test=${testStatus}\n\n${logParts.join('\n\n')}`,
      'utf8',
    ).catch(() => {});
  }

  const serialize = (entry) => ({
    command: entry.command,
    cwd: entry.cwd,
    ok: entry.ok,
    exitCode: entry.exitCode,
    timedOut: entry.timedOut,
    durationMs: entry.durationMs,
    phase: entry.phase,
    required: entry.required,
    source: entry.source,
  });
  return {
    status,
    ok: status !== 'failed',
    buildStatus,
    testStatus,
    testOk: testStatus === 'failed' ? false : (testStatus === 'passed' ? true : null),
    testRequired,
    testBlocking: Boolean(requiredTestFailure),
    error: blockingError,
    testError,
    testReason,
    suspicions,
    testSummary,
    outputTruncated: results.some((entry) => entry.outputTruncated),
    reason: status === 'skipped'
      ? (buildStatus === 'skipped' && testStatus === 'skipped'
        ? '未检测到可自动执行的构建/测试命令'
        : null)
      : (buildStatus === 'skipped' && testStatus === 'passed' ? '未检测到构建命令，仅运行测试' : null),
    commands: results.map(serialize),
    buildCommands: buildResults.map(serialize),
    testCommands: testResults.map(serialize),
    testHints: plan.hints,
    testsAvailable: plan.testsAvailable,
    durationMs: results.reduce((sum, result) => sum + (result.durationMs ?? 0), 0),
    buildDurationMs: buildResults.reduce((sum, result) => sum + (result.durationMs ?? 0), 0),
    testDurationMs: testResults.reduce((sum, result) => sum + (result.durationMs ?? 0), 0),
    output: tail(logParts.join('\n\n')),
  };
}

/**
 * Add a real compile/test failure to the existing evidence gates so that the
 * result header, CLI status and report self-check section cannot stay green.
 */
export function applyVerificationGate(gates, verification, { name = 'compile-self-check', testName = null } = {}) {
  if (!gates || !verification) return gates;
  const buildStatus = verification.buildStatus ?? verification.status ?? 'skipped';
  const testStatus = verification.testStatus ?? 'skipped';
  const buildCommands = (verification.buildCommands ?? verification.commands ?? [])
    .map((entry) => entry.command).filter(Boolean);
  const testCommands = (verification.testCommands ?? [])
    .map((entry) => entry.command).filter(Boolean);
  const buildCheck = {
    name,
    ok: buildStatus !== 'failed',
    ...(buildStatus === 'skipped' ? { severity: 'warn' } : {}),
    detail: buildStatus === 'failed'
      ? (verification.error ?? 'build failed')
      : `build=${buildStatus}${buildCommands.length ? `；${buildCommands.join('；')}` : ''}`,
  };
  const derivedTestName = testName ?? (name.includes('compile') ? name.replace('compile', 'test') : 'test-self-check');
  const testDetail = [
    `tests=${testStatus}`,
    verification.testRequired ? 'required' : 'advisory',
    testCommands.length ? testCommands.join('；') : null,
    verification.testReason ?? null,
    verification.testHints?.length ? `hint: ${verification.testHints.map((hint) => hint.command).join('；')}` : null,
    verification.testError ?? null,
  ].filter(Boolean).join('；');
  const testCheck = {
    name: derivedTestName,
    ok: testStatus === 'passed',
    ...(testStatus === 'passed' ? {} : { severity: verification.testBlocking ? 'error' : 'warn' }),
    detail: testDetail || 'tests=skipped',
  };
  const suspicionName = name.includes('followup') ? 'output-suspicion-followup' : 'output-suspicion';
  const suspicions = Array.isArray(verification.suspicions) ? verification.suspicions : [];
  const suspicionCheck = suspicions.length > 0
    ? {
        name: suspicionName,
        ok: false,
        severity: 'warn',
        detail: `${suspicions.length} 条输出疑点；${suspicions.slice(0, 3).map((item) => `[${item.phase}] ${item.line}`).join('；')}`,
      }
    : null;
  gates.checks = (Array.isArray(gates.checks) ? gates.checks : [])
    .filter((item) => item?.name !== name && item?.name !== derivedTestName && item?.name !== suspicionName);
  gates.checks.push(buildCheck, testCheck);
  if (suspicionCheck) gates.checks.push(suspicionCheck);
  gates.ok = gates.checks.every((item) => item.ok !== false || item.severity === 'warn');
  return gates;
}
