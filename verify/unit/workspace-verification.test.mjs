import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { access, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { runCaptureDiagnosis } from '../../src/diagnose/run.mjs';
import { runWorkspaceCheck } from '../../src/core/fix-validation.mjs';
import { tempDir } from './tmp.mjs';

const exec = promisify(execFile);
const TMP = tempDir('workspace-verification-test');

function captureInput() {
  return {
    request: {
      method: 'POST',
      url: 'http://localhost/api/order',
      headers: {},
      body: '{}',
      startedAt: Date.now(),
    },
    response: { status: 500, statusText: 'Error', ok: false, headers: {}, body: '{}', durationMs: 1 },
    firedAt: Date.now(),
  };
}

async function prepare(t) {
  await rm(TMP, { recursive: true, force: true });
  const sourceRoot = path.join(TMP, 'backend');
  const file = path.join(sourceRoot, 'OrderService.java');
  await mkdir(sourceRoot, { recursive: true });
  await writeFile(file, 'old\n', 'utf8');
  t.after(async () => { await rm(TMP, { recursive: true, force: true }); });
  return { sourceRoot, file };
}

test('runWorkspaceCheck runs the configured command and reports both outcomes', async (t) => {
  const { sourceRoot } = await prepare(t);

  const passed = await runWorkspaceCheck({
    roots: { sourceRoot },
    verifyCommand: 'node -e "process.exit(0)"',
    projectRoot: sourceRoot,
    runDir: path.join(TMP, 'run-pass'),
  });
  assert.equal(passed.status, 'passed');
  assert.equal(passed.ok, true);
  assert.equal(passed.commands.length, 1);
  assert.match(passed.commands[0].command, /process\.exit\(0\)/);

  const failed = await runWorkspaceCheck({
    roots: { sourceRoot },
    verifyCommand: 'node -e "process.exit(1)"',
    projectRoot: sourceRoot,
    runDir: path.join(TMP, 'run-fail'),
  });
  assert.equal(failed.status, 'failed');
  assert.equal(failed.ok, false);
  assert.match(failed.error, /编译\/测试验证失败/);
});

test('runWorkspaceCheck skips with an explicit reason when no command is detected', async (t) => {
  await prepare(t);
  const skipped = await runWorkspaceCheck({
    roots: {},
    projectRoot: TMP,
  });
  assert.equal(skipped.status, 'skipped');
  assert.match(skipped.reason, /未配置验证命令/);
});

test('full-permission diagnosis gates on a forced workspace compile check', async (t) => {
  const { sourceRoot, file } = await prepare(t);
  const agent = {
    id: 'full-agent',
    scope: null,
    configureScope(next) { this.scope = { ...(this.scope ?? {}), ...next }; },
    async diagnose() {
      await this.scope.onBeforeWrite({ filePath: file });
      await writeFile(file, 'new\n', 'utf8');
      await this.scope.onAfterWrite({ filePath: file });
      return {
        conclusion: '已直接修改工作区',
        evidenceRefs: [{ type: 'request', ref: 'request' }],
        confidence: 0.8,
        needsMoreInfo: [],
        fixes: [],
      };
    },
  };

  const { result } = await runCaptureDiagnosis(captureInput(), {
    workspace: {
      sourceRoot,
      logfiles: [],
      window: { beforeMs: 1000, afterMs: 1000 },
      agent: { toolMode: 'full' },
    },
    root: TMP,
    runsDir: path.join(TMP, 'runs'),
    agent,
    verifyCommand: 'node -e "process.exit(1)"',
    sandbox: false,
  });

  assert.equal(result.agent.verification.status, 'failed');
  assert.equal(result.agent.verification.mode, 'full');
  assert.match(result.agent.verification.error, /编译\/测试验证失败/);
  assert.equal(result.meta.verificationStatus, 'failed');
  assert.equal(result.gates.ok, false);
  assert.ok(result.gates.checks.some((check) => check.name === 'compile-self-check' && check.ok === false));
  assert.ok(result.agent.needsMoreInfo.some((item) => item.includes('未通过编译/测试')));
  assert.equal(await readFile(file, 'utf8'), 'new\n');
});

test('full-permission diagnosis skips the gate when nothing was written', async (t) => {
  const { sourceRoot } = await prepare(t);
  const agent = {
    id: 'full-agent',
    configureScope() {},
    async diagnose() {
      return {
        conclusion: '只做分析，没有修改',
        evidenceRefs: [{ type: 'request', ref: 'request' }],
        confidence: 0.8,
        needsMoreInfo: [],
        fixes: [],
      };
    },
  };

  const { result } = await runCaptureDiagnosis(captureInput(), {
    workspace: {
      sourceRoot,
      logfiles: [],
      window: { beforeMs: 1000, afterMs: 1000 },
      agent: { toolMode: 'full' },
    },
    root: TMP,
    runsDir: path.join(TMP, 'runs'),
    agent,
    verifyCommand: 'node -e "process.exit(1)"',
    sandbox: false,
  });

  assert.equal(result.agent.verification.status, 'skipped');
  assert.match(result.agent.verification.reason, /没有直接写入/);
  assert.equal(result.gates.ok, true);
});

test('in-place compile failure is surfaced as verification and turns gates red', async (t) => {
  await rm(TMP, { recursive: true, force: true });
  const repo = path.join(TMP, 'repo');
  const file = path.join(repo, 'OrderService.java');
  await mkdir(repo, { recursive: true });
  await exec('git', ['-C', repo, 'init', '-q']);
  await exec('git', ['-C', repo, 'config', 'user.email', 'test@example.com']);
  await exec('git', ['-C', repo, 'config', 'user.name', 'Test']);
  await writeFile(file, 'old\n', 'utf8');
  await exec('git', ['-C', repo, 'add', '.']);
  await exec('git', ['-C', repo, 'commit', '-q', '-m', 'base']);
  t.after(async () => { await rm(TMP, { recursive: true, force: true }); });

  const agent = {
    id: 'inplace-agent',
    scope: null,
    configureScope(next) { this.scope = { ...(this.scope ?? {}), ...next }; },
    async diagnose() {
      await this.scope.onBeforeWrite({ filePath: file });
      await writeFile(file, 'agent\n', 'utf8');
      await this.scope.onAfterWrite({ filePath: file });
      return {
        conclusion: '已修改工作区',
        evidenceRefs: [{ type: 'request', ref: 'request' }],
        confidence: 0.8,
        needsMoreInfo: [],
        fixes: [],
      };
    },
  };

  const outcome = await runCaptureDiagnosis(captureInput(), {
    workspace: {
      sourceRoot: repo,
      logfiles: [],
      window: { beforeMs: 1000, afterMs: 1000 },
      agent: { toolMode: 'sandbox' },
    },
    root: TMP,
    runsDir: path.join(TMP, 'runs'),
    agent,
    verifyCommand: 'node -e "process.exit(1)"',
    sandbox: true,
  });
  const { result } = outcome;

  assert.equal(result.agent.workspaceSession.selfCheck.status, 'failed');
  assert.equal(result.agent.verification.status, 'failed');
  assert.equal(result.agent.verification.mode, 'in-place');
  assert.equal(result.meta.verificationStatus, 'failed');
  assert.equal(result.gates.ok, false);
  assert.ok(result.gates.checks.some((check) => check.name === 'compile-self-check' && check.ok === false));

  await outcome.workspaceSession.discard();
  assert.equal(await readFile(file, 'utf8'), 'old\n');
});

test('sandbox checks cannot escape the sandbox project root', async (t) => {
  await rm(TMP, { recursive: true, force: true });
  const outside = path.join(TMP, 'outside');
  const sandbox = path.join(TMP, 'sandbox');
  await mkdir(outside, { recursive: true });
  await mkdir(sandbox, { recursive: true });
  t.after(async () => { await rm(TMP, { recursive: true, force: true }); });

  const result = await runWorkspaceCheck({
    roots: { sourceRoot: outside },
    verifyCommand: 'node -e "require(\'fs\').writeFileSync(\'ran\',\'x\')"',
    projectRoot: sandbox,
    restrictToProjectRoot: true,
  });
  assert.equal(result.status, 'passed');
  assert.equal(await readFile(path.join(sandbox, 'ran'), 'utf8'), 'x');
  await assert.rejects(access(path.join(outside, 'ran')));
});
