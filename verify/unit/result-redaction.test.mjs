import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFile, rm } from 'node:fs/promises';
import { runCaptureDiagnosis } from '../../src/diagnose/run.mjs';
import { createMockAgent } from '../../src/agent/mock.mjs';
import { tempDir } from './tmp.mjs';

const TMP = tempDir('result-redaction-test');

test('redacts credential headers before writing result.json', async (t) => {
  await rm(TMP, { recursive: true, force: true });
  t.after(async () => { await rm(TMP, { recursive: true, force: true }); });

  const outcome = await runCaptureDiagnosis({
    request: {
      method: 'GET',
      url: 'http://localhost/api/orders',
      headers: {
        Authorization: 'Bearer sk-ant-super-secret-token',
        Cookie: 'sid=session-secret',
        'X-Api-Key': 'api-key-secret',
        'Content-Type': 'application/json',
        'X-Request-Id': 'req-123',
      },
      body: null,
      startedAt: Date.now(),
    },
    response: {
      status: 200,
      statusText: 'OK',
      ok: true,
      headers: {
        'Set-Cookie': 'sid=response-session-secret',
        'Content-Type': 'application/json',
      },
      body: '{"ok":true}',
      durationMs: 1,
    },
    firedAt: Date.now(),
  }, {
    workspace: { logfiles: [], window: { beforeMs: 1000, afterMs: 1000 } },
    root: TMP,
    runsDir: path.join(TMP, 'runs'),
    agent: createMockAgent(),
  });

  const raw = await readFile(path.join(outcome.runDir, 'result.json'), 'utf8');
  assert.doesNotMatch(raw, /super-secret-token|session-secret|api-key-secret/);
  assert.equal(outcome.result.request.headers.Authorization, '<redacted>');
  assert.equal(outcome.result.request.headers.Cookie, '<redacted>');
  assert.equal(outcome.result.request.headers['X-Api-Key'], '<redacted>');
  assert.equal(outcome.result.request.headers['Content-Type'], 'application/json');
  assert.equal(outcome.result.request.headers['X-Request-Id'], 'req-123');
  assert.equal(outcome.result.response.headers['Set-Cookie'], '<redacted>');
  assert.equal(outcome.result.response.headers['Content-Type'], 'application/json');
});
