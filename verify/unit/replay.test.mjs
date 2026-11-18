import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import path from 'node:path';
import {
  buildReplayFixture,
  compareSymptom,
  replayConfig,
  replayFixture,
  responseSignature,
} from '../../src/core/replay.mjs';
import { runCaptureDiagnosis } from '../../src/diagnose/run.mjs';
import { validateWorkspace } from '../../src/core/store.mjs';
import { tempDir } from './tmp.mjs';

const exec = promisify(execFile);

async function initRepo(dir) {
  await exec('git', ['init', '-q'], { cwd: dir });
  await exec('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
  await exec('git', ['config', 'user.name', 'Test User'], { cwd: dir });
  await exec('git', ['add', '.'], { cwd: dir });
  await exec('git', ['commit', '-qm', 'init'], { cwd: dir });
}

test('normalizes replay workspace defaults', () => {
  const defaults = validateWorkspace({});
  assert.equal(defaults.replay.enabled, false);
  assert.deepEqual(defaults.replay.allowMethods, ['GET', 'HEAD', 'OPTIONS']);
  const custom = validateWorkspace({
    backendUrl: 'http://127.0.0.1:8080',
    replay: { enabled: true, allowOrigins: ['http://127.0.0.1:8080'], allowMethods: ['get', 'head'], timeoutMs: 3000 },
  });
  assert.equal(custom.replay.enabled, true);
  assert.deepEqual(custom.replay.allowMethods, ['GET', 'HEAD']);
  assert.equal(custom.replay.timeoutMs, 3000);
});

test('only builds fixtures for allowed origins and safe methods', () => {
  const workspace = {
    backendUrl: 'http://127.0.0.1:8080',
    replay: { enabled: true, allowMethods: ['GET', 'HEAD'] },
  };
  const safe = buildReplayFixture({
    fired: { request: { method: 'GET', url: 'http://127.0.0.1:8080/system/user/list', headers: { accept: 'application/json' } } },
    workspace,
  });
  assert.equal(safe.ok, true);
  assert.equal(safe.fixture.method, 'GET');

  assert.equal(buildReplayFixture({
    fired: { request: { method: 'POST', url: 'http://127.0.0.1:8080/system/user' } },
    workspace,
  }).reason, 'method-not-allowed');
  assert.equal(buildReplayFixture({
    fired: { request: { method: 'GET', url: 'http://127.0.0.1:9090/other' } },
    workspace,
  }).reason, 'origin-not-allowed');
  assert.equal(buildReplayFixture({
    fired: { request: { method: 'GET', url: 'http://127.0.0.1:8080/private', headers: { Authorization: 'Bearer x' } } },
    workspace,
  }).reason, 'auth-required');
  assert.equal(buildReplayFixture({
    fired: { request: { method: 'GET', url: 'http://127.0.0.1:8080/x?token=secret' } },
    workspace,
  }).reason, 'sensitive-query');
  assert.equal(buildReplayFixture({
    fired: { request: { method: 'GET', url: 'http://127.0.0.1:8080/x' } },
    workspace: { ...workspace, replay: { enabled: false } },
  }).reason, 'replay-disabled');
});

test('compares symptom signatures using HTTP and business codes', () => {
  const before = responseSignature({ status: 200, body: '{"code":500,"msg":"boom"}' });
  assert.equal(before.hasError, true);
  assert.equal(before.businessCode, 500);

  const after = responseSignature({ status: 200, body: '{"code":200,"msg":"ok"}' });
  assert.equal(after.hasError, false);
  assert.equal(compareSymptom(before, after).status, 'passed');
  assert.equal(compareSymptom(before, responseSignature({ status: 500, body: '{"code":500}' })).status, 'failed');
  assert.equal(compareSymptom(before, responseSignature({ status: 401, body: 'unauthorized' })).status, 'pending');
  assert.equal(compareSymptom(responseSignature({ status: 200, body: '{"code":200}' }), after).reason, 'no-baseline-symptom');
});

test('replays a fixture through an injected fetch', async () => {
  let received = null;
  const result = await replayFixture({
    method: 'GET',
    url: 'http://127.0.0.1:8080/x',
    headers: { accept: 'application/json' },
    body: null,
  }, {
    fetchImpl: async (url, init) => {
      received = { url, init };
      return { status: 200, statusText: 'OK', text: async () => '{"code":200}' };
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.response.status, 200);
  assert.equal(received.url, 'http://127.0.0.1:8080/x');
  assert.equal(received.init.method, 'GET');
});

test('marks the symptom passed after replaying a safe captured request', async (t) => {
  const dir = tempDir('symptom-replay-test');
  await rm(dir, { recursive: true, force: true });
  await mkdir(path.join(dir, 'src'), { recursive: true });
  await writeFile(path.join(dir, 'src/app.js'), 'export const value = 1;\n');
  await initRepo(dir);
  t.after(async () => { await rm(dir, { recursive: true, force: true }); });

  let scope = null;
  const agent = {
    id: 'replay-agent',
    configureScope(next) { scope = { cwd: dir, ...(scope ?? {}), ...next }; },
    async diagnose() {
      const file = path.join(scope.cwd, 'src/app.js');
      await scope.onBeforeWrite?.({ toolName: 'Write', filePath: file });
      await writeFile(file, 'export const value = 2;\n');
      await scope.onAfterWrite?.({ toolName: 'Write', filePath: file });
      return {
        conclusion: '已修复',
        evidenceRefs: [{ type: 'request', ref: 'request' }],
        confidence: 0.8,
        needsMoreInfo: [],
        fixes: [],
      };
    },
  };

  const outcome = await runCaptureDiagnosis({
    request: { method: 'GET', url: 'http://127.0.0.1:8080/system/user/list', headers: { accept: 'application/json' }, startedAt: Date.now() },
    response: { status: 500, statusText: 'Error', ok: false, headers: {}, body: '{"code":500,"msg":"boom"}', durationMs: 5 },
    firedAt: Date.now(),
  }, {
    workspace: {
      sourceRoot: dir,
      backendUrl: 'http://127.0.0.1:8080',
      logfiles: [],
      window: { beforeMs: 1000, afterMs: 1000 },
      replay: { enabled: true, allowMethods: ['GET'] },
      agent: { toolMode: 'sandbox' },
    },
    root: dir,
    runsDir: path.join(dir, 'runs'),
    agent,
    sandbox: true,
    preflight: { ok: true, checks: [], databases: [] },
    replayFetch: async (url, init) => {
      assert.equal(url, 'http://127.0.0.1:8080/system/user/list');
      assert.equal(init.method, 'GET');
      return { status: 200, statusText: 'OK', text: async () => '{"code":200,"msg":"ok"}' };
    },
  });

  assert.equal(outcome.result.symptomCheck.status, 'passed');
  assert.equal(outcome.result.symptomCheck.method, 'replay');
  assert.equal(outcome.result.symptomCheck.reason, 'error-signature-cleared');
  assert.equal(outcome.result.gates.level, 'symptom-verified');
  assert.equal(outcome.result.replayFixture.method, 'GET');
  if (outcome.workspaceSession) await outcome.workspaceSession.discard();
});
