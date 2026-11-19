import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import path from 'node:path';
import {
  buildRepairFailure,
  mergeUsage,
  planRepairBudget,
  shouldAutoRepair,
} from '../../src/core/auto-repair.mjs';
import { runCaptureDiagnosis } from '../../src/diagnose/run.mjs';
import { tempDir } from './tmp.mjs';

const exec = promisify(execFile);

async function initRepo(dir) {
  await exec('git', ['init', '-q'], { cwd: dir });
  await exec('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
  await exec('git', ['config', 'user.name', 'Test User'], { cwd: dir });
  await exec('git', ['add', '.'], { cwd: dir });
  await exec('git', ['commit', '-qm', 'init'], { cwd: dir });
}

test('classifies which failures should be retried', () => {
  const base = {
    status: 'failed',
    error: '编译/测试验证失败',
    output: 'OrderService.java:12: error: cannot find symbol',
    commands: [{ command: 'mvn compile', exitCode: 1, timedOut: false }],
  };
  assert.equal(shouldAutoRepair({ verification: base, changedFiles: ['backend/src/OrderService.java'] }).ok, true);
  assert.equal(shouldAutoRepair({ verification: base, changedFiles: [] }).reason, 'no-changed-files');
  assert.equal(shouldAutoRepair({ verification: base, changedFiles: ['backend/src/OrderService.java'], recheck: 3 }).reason, 'recheck');
  assert.equal(shouldAutoRepair({
    verification: { ...base, output: 'Could not resolve dependencies for project' },
    changedFiles: ['backend/src/OrderService.java'],
  }).reason, 'environment');
  assert.equal(shouldAutoRepair({
    verification: { ...base, commands: [{ command: 'mvn compile', timedOut: true }] },
    changedFiles: ['backend/src/OrderService.java'],
  }).reason, 'timeout');
  assert.equal(shouldAutoRepair({
    verification: { ...base, output: 'Other.java:1: error: boom' },
    changedFiles: ['backend/src/OrderService.java'],
  }).reason, 'unrelated-failure');
  assert.equal(shouldAutoRepair({
    verification: base,
    changedFiles: [],
    allowUnknownFiles: true,
  }).ok, true);
});

test('plans a bounded repair budget', () => {
  const enabled = planRepairBudget({
    workspace: { agent: { maxBudgetUsd: 2, repairRetry: { maxTurns: 4, maxBudgetUsd: 0.5, timeoutMs: 30000 } } },
    usage: { costUsd: 0.4 },
  });
  assert.equal(enabled.ok, true);
  assert.deepEqual(enabled.budget, { maxTurns: 4, maxBudgetUsd: 0.5, timeoutMs: 30000 });
  assert.equal(enabled.maxAttempts, 3);

  const exhausted = planRepairBudget({
    workspace: { agent: { maxBudgetUsd: 0.5, repairRetry: { maxBudgetUsd: 1 } } },
    usage: { costUsd: 0.5 },
  });
  assert.equal(exhausted.ok, false);
  assert.equal(exhausted.reason, 'budget');
  assert.equal(planRepairBudget({ workspace: { agent: { repairRetry: { enabled: false } } } }).reason, 'disabled');
});

test('builds a structured failure package without leaking secrets', () => {
  const failure = buildRepairFailure({
    verification: {
      status: 'failed',
      error: 'mvn compile failed',
      output: 'OrderService.java:12: error: boom\npassword=hunter2secret',
      commands: [{ command: 'mvn compile', exitCode: 1, timedOut: false, durationMs: 10 }],
    },
    phase: 'sandbox-self-check',
    changedFiles: ['backend/src/OrderService.java'],
    previousFixes: [{ summary: 'fix one' }],
  });
  assert.equal(failure.phase, 'sandbox-self-check');
  assert.equal(failure.errorLines.length, 1);
  assert.match(failure.outputTail, /password=<redacted>/);
  assert.deepEqual(failure.changedFiles, ['backend/src/OrderService.java']);
  assert.deepEqual(failure.previousFixSummaries, ['fix one']);
});

test('merges initial and repair usage', () => {
  const merged = mergeUsage(
    {
      numTurns: 2,
      costUsd: 0.1,
      inputTokens: 10,
      cacheReadInputTokens: 5,
      totalTokens: 20,
      perTurn: [{ id: 'a' }],
      costEstimated: false,
    },
    {
      numTurns: 1,
      costUsd: 0.2,
      inputTokens: 4,
      cacheReadInputTokens: 2,
      totalTokens: 8,
      perTurn: [{ id: 'b' }],
      costEstimated: true,
    },
  );
  assert.equal(merged.numTurns, 3);
  assert.equal(merged.inputTokens, 14);
  assert.equal(merged.cacheReadInputTokens, 7);
  assert.equal(merged.totalTokens, 28);
  assert.equal(merged.costEstimated, true);
  assert.deepEqual(merged.perTurn, [{ id: 'a' }, { id: 'b', attempt: 2 }]);
});

test('automatically retries a failing sandbox self-check up to configured attempts', async (t) => {
  const dir = tempDir('auto-repair-test');
  await rm(dir, { recursive: true, force: true });
  await mkdir(path.join(dir, 'src'), { recursive: true });
  await writeFile(path.join(dir, 'src/answer.txt'), 'initial\n');
  await writeFile(path.join(dir, 'check.mjs'), [
    "import { readFileSync } from 'node:fs';",
    "const value = readFileSync('src/answer.txt', 'utf8').trim();",
    "if (value !== 'good') { console.error('answer.txt is wrong: ' + value); process.exit(1); }",
  ].join('\n'));
  await initRepo(dir);
  t.after(async () => { await rm(dir, { recursive: true, force: true }); });

  let scope = null;
  let repairCalls = 0;
  const writeAnswer = async (value) => {
    const file = path.join(scope.cwd, 'src/answer.txt');
    await scope.onBeforeWrite?.({ toolName: 'Write', filePath: file });
    await writeFile(file, value);
    await scope.onAfterWrite?.({ toolName: 'Write', filePath: file });
  };
  const agent = {
    id: 'fake-repair-agent',
    configureScope(next) { scope = { cwd: dir, ...(scope ?? {}), ...next }; },
    async diagnose() {
      await writeAnswer('bad\n');
      return {
        conclusion: '尝试修复',
        evidenceRefs: [{ type: 'request', ref: 'request' }],
        confidence: 0.5,
        needsMoreInfo: [],
        fixes: [],
        usage: { numTurns: 1, costUsd: 0.01, inputTokens: 10, outputTokens: 2, totalTokens: 12 },
      };
    },
    async followUp({ purpose, failure }) {
      assert.equal(purpose, 'repair');
      assert.equal(failure.status, 'failed');
      assert.match(failure.outputTail, /answer\.txt is wrong/);
      repairCalls += 1;
      if (failure.attempt === 2) {
        assert.equal(failure.previousAttempts.length, 1);
        assert.ok(failure.previousAttempts[0].changedFiles.some((file) => file.includes('answer.txt')));
      }
      await writeAnswer(failure.attempt === 1 ? 'still-bad\n' : 'good\n');
      return {
        conclusion: '已修复',
        evidenceRefs: [{ type: 'request', ref: 'request' }],
        confidence: 0.8,
        needsMoreInfo: [],
        fixes: [],
        usage: { numTurns: 1, costUsd: 0.02, inputTokens: 5, outputTokens: 1, totalTokens: 6 },
      };
    },
  };

  const outcome = await runCaptureDiagnosis({
    request: { method: 'GET', url: 'http://localhost/api/order', headers: {}, startedAt: Date.now() },
    response: { status: 500, statusText: 'Error', ok: false, headers: {}, durationMs: 1 },
    firedAt: Date.now(),
  }, {
    workspace: {
      sourceRoot: dir,
      logfiles: [],
      verifyCommand: 'node check.mjs',
      window: { beforeMs: 1000, afterMs: 1000 },
      agent: { repairRetry: { maxTurns: 2, maxBudgetUsd: 0.1, timeoutMs: 30000 } },
    },
    root: dir,
    runsDir: path.join(dir, 'runs'),
    agent,
    verifyCommand: 'node check.mjs',
    sandbox: true,
    preflight: { ok: true, checks: [], databases: [] },
  });
  const { result } = outcome;

  assert.equal(repairCalls, 2);
  assert.equal(result.agent.repair.attempted, true);
  assert.equal(result.agent.repair.attempts, 2);
  assert.equal(result.agent.verification.status, 'passed');
  assert.equal(result.agent.verification.repair.finalStatus, 'passed');
  assert.equal(result.agent.usage.costUsd, 0.05);
  assert.equal(result.agent.usage.numTurns, 3);
  assert.ok(result.agent.fixes.some((fix) => /answer\.txt/.test(fix.file ?? fix.content ?? '')));
  if (outcome.workspaceSession) await outcome.workspaceSession.discard();
});

test('uses three attempts and a shared total budget by default', () => {
  const plan = planRepairBudget({ workspace: { agent: { repairRetry: {} } } });
  assert.equal(plan.ok, true);
  assert.equal(plan.maxAttempts, 3);
  assert.equal(plan.budget.maxTurns, 6);
  assert.equal(plan.budget.maxBudgetUsd, 3);
  assert.equal(plan.budget.timeoutMs, 300000);

  const remaining = planRepairBudget({
    workspace: { agent: { repairRetry: { maxBudgetUsd: 1, timeoutMs: 300000 } } },
    repairSpentUsd: 0.6,
    elapsedMs: 250000,
  });
  assert.equal(remaining.ok, true);
  assert.equal(remaining.budget.maxBudgetUsd, 0.4);
  assert.equal(remaining.budget.timeoutMs, 50000);
});
