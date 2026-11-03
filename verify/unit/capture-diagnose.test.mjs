import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { runCaptureDiagnosis } from '../../src/diagnose/run.mjs';
import { tempDir } from './tmp.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const TMP = tempDir('capture-diagnose');

function localTimestamp() {
  const now = new Date();
  const pad = (value, width = 2) => String(value).padStart(width, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}.${pad(now.getMilliseconds(), 3)}`;
}

test('diagnoses a captured request without replay and correlates by business id', async (t) => {
  await rm(TMP, { recursive: true, force: true });
  await mkdir(TMP, { recursive: true });
  t.after(async () => { await rm(TMP, { recursive: true, force: true }); });

  const logFile = path.join(TMP, 'app.log');
  await writeFile(logFile, [
    `${localTimestamp()} ERROR 1 --- [thread-a] c.e.demo.OrderService : create failed orderId=ORD999`,
    `${localTimestamp()} WARN 1 --- [thread-b] c.e.demo.AsyncWorker : rollback orderId=ORD999`,
    '',
  ].join('\n'), 'utf8');

  const observation = {
    request: {
      method: 'POST',
      url: 'http://localhost:8080/api/order',
      headers: { 'Content-Type': 'application/json' },
      body: '{"orderId":"ORD999","qty":2}',
      startedAt: Date.now(),
    },
    response: {
      status: 500,
      statusText: 'Internal Server Error',
      ok: false,
      headers: { 'Content-Type': 'application/json' },
      body: '{"error":"inventory"}',
      durationMs: 20,
    },
    firedAt: Date.now(),
    resourceType: 'xhr',
  };

  const { result, runDir } = await runCaptureDiagnosis(observation, {
    workspace: {
      logfiles: [logFile],
      sourceRoot: path.join(ROOT, 'verify/fixtures/source'),
      window: { beforeMs: 5000, afterMs: 5000 },
    },
    root: ROOT,
    runsDir: path.join(TMP, 'runs'),
    question: '下单失败',
    recheck: 1,
  });

  assert.equal(result.meta.driver, 'capture');
  assert.equal(result.target.driver, 'capture');
  assert.equal(result.marker.injected, false);
  assert.equal(result.logs.correlation.strategy, 'business-id');
  assert.equal(result.logs.correlation.matchedId, 'ORD999');
  assert.equal(result.logs.count, 2);
  assert.equal(result.gates.ok, true, JSON.stringify(result.gates.checks));
  assert.ok(result.logs.records.every((record) => record.thread));

  const persisted = JSON.parse(await readFile(path.join(runDir, 'result.json'), 'utf8'));
  assert.equal(persisted.meta.driver, 'capture');
  const report = await readFile(path.join(runDir, 'report.md'), 'utf8');
  assert.match(report, /DebugCopilot 诊断报告/);
});

test('capture diagnosis works without log evidence', async (t) => {
  await rm(TMP, { recursive: true, force: true });
  await mkdir(TMP, { recursive: true });
  t.after(async () => { await rm(TMP, { recursive: true, force: true }); });

  const { result } = await runCaptureDiagnosis({
    request: { method: 'GET', url: 'http://localhost:8080/api/ping', headers: {}, body: null, startedAt: Date.now() },
    response: { status: 200, statusText: 'OK', ok: true, headers: {}, body: '{"ok":true}', durationMs: 3 },
    firedAt: Date.now(),
    resourceType: 'xhr',
  }, {
    workspace: { logfiles: [], sourceRoot: '', window: { beforeMs: 3000, afterMs: 2000 } },
    root: ROOT,
    runsDir: path.join(TMP, 'runs'),
    question: '',
  });

  assert.equal(result.logs.correlation.strategy, 'none');
  assert.equal(result.gates.ok, true, JSON.stringify(result.gates.checks));
});
