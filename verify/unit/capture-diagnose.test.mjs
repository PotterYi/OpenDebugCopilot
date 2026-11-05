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
    consoleErrors: [{
      kind: 'exception',
      message: 'Uncaught Error: inventory ui boom',
      url: 'http://localhost:5173/src/App.vue',
      line: 7,
      stack: ['at submit (http://localhost:5173/src/App.vue:7:9)'],
    }],
  };

  const progress = [];
  const { result, runDir } = await runCaptureDiagnosis(observation, {
    onProgress: (event) => progress.push(event),
    workspace: {
      logfiles: [logFile],
      sourceRoot: path.join(ROOT, 'verify/fixtures/source'),
      extraSourceRoots: [path.join(ROOT, 'verify/fixtures')],
      logParser: 'logback',
      frontendProjectRoot: path.join(ROOT, 'verify/fixtures/frontend'),
      window: { beforeMs: 5000, afterMs: 5000 },
    },
    root: ROOT,
    runsDir: path.join(TMP, 'runs'),
    question: '下单失败',
    recheck: 1,
    allowExtraSources: true,
  });

  assert.equal(result.meta.driver, 'capture');
  assert.equal(result.target.driver, 'capture');
  assert.equal(result.marker.injected, false);
  assert.equal(result.logs.parser, 'logback');
  assert.equal(result.logs.correlation.strategy, 'business-id');
  assert.equal(result.logs.correlation.matchedId, 'ORD999');
  assert.equal(result.logs.count, 2);
  assert.equal(result.gates.ok, true, JSON.stringify(result.gates.checks));
  assert.ok(result.logs.records.every((record) => record.thread));
  assert.equal(result.frontend.errors.length, 1);
  assert.equal(result.frontend.files.length, 1);
  assert.equal(result.frontend.files[0].path, 'src/App.vue');
  assert.match(result.frontend.files[0].content, /inventory ui boom/);
  assert.equal(
    result.meta.fixRoots.frontendSourceRoot,
    path.join(ROOT, 'verify/fixtures/frontend'),
  );
  for (const id of ['prepare', 'logs', 'source', 'agent', 'preview', 'done']) {
    assert.ok(progress.some((event) => event.id === id), `missing progress step ${id}`);
  }
  assert.ok(progress.some((event) => event.id === 'agent' && event.status === 'done'));
  assert.equal(result.extraSources.authorized, true);
  assert.equal(result.meta.fixRoots.extraSourceRoots.length, 1);
  assert.equal(result.meta.fixRoots.extraSourceRoots[0].id, 'extra-1');

  const persisted = JSON.parse(await readFile(path.join(runDir, 'result.json'), 'utf8'));
  assert.equal(persisted.meta.driver, 'capture');
  const report = await readFile(path.join(runDir, 'report.md'), 'utf8');
  assert.match(report, /DebugCopilot 诊断报告/);
  assert.match(report, /前端错误：1 条/);
  const runLog = await readFile(path.join(runDir, 'run.log'), 'utf8');
  assert.match(runLog, /start scenario=/);
  assert.match(runLog, /logs strategy=/);
  assert.match(runLog, /gates=/);
  assert.match(runLog, /done durationMs=/);
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
    workspace: {
      logfiles: [],
      sourceRoot: '',
      extraSourceRoots: [path.join(ROOT, 'verify/fixtures')],
      window: { beforeMs: 3000, afterMs: 2000 },
    },
    root: ROOT,
    runsDir: path.join(TMP, 'runs'),
    question: '',
  });

  assert.equal(result.logs.correlation.strategy, 'none');
  assert.equal(result.gates.ok, true, JSON.stringify(result.gates.checks));
  assert.equal(result.extraSources.authorized, false);
  assert.deepEqual(result.meta.fixRoots.extraSourceRoots, []);
});

test('persists an incomplete agent result with evidence', async (t) => {
  await rm(TMP, { recursive: true, force: true });
  await mkdir(TMP, { recursive: true });
  t.after(async () => { await rm(TMP, { recursive: true, force: true }); });
  const agent = {
    id: 'mock',
    async diagnose() {
      return {
        conclusion: '已定位到部分线索，但未给出最终结论',
        evidenceRefs: [{ type: 'request', ref: 'request' }],
        confidence: 0.3,
        needsMoreInfo: ['诊断未完成：达到最大轮次'],
        fixes: [],
        toolCalls: [],
        incomplete: true,
        incompleteReason: 'error_max_turns',
      };
    },
  };

  const { result, runDir } = await runCaptureDiagnosis({
    request: { method: 'GET', url: 'http://localhost:8080/api/ping', headers: {}, body: null, startedAt: Date.now() },
    response: { status: 200, statusText: 'OK', ok: true, headers: {}, body: '{"ok":true}', durationMs: 3 },
    firedAt: Date.now(),
    resourceType: 'xhr',
  }, {
    workspace: { logfiles: [], sourceRoot: '', window: { beforeMs: 3000, afterMs: 2000 } },
    root: ROOT,
    runsDir: path.join(TMP, 'runs'),
    question: '',
    agent,
  });

  assert.equal(result.meta.incomplete, true);
  assert.equal(result.meta.incompleteReason, 'error_max_turns');
  assert.equal(result.agent.incomplete, true);
  assert.match(result.agent.conclusion, /部分线索/);
  const persisted = JSON.parse(await readFile(path.join(runDir, 'result.json'), 'utf8'));
  assert.equal(persisted.meta.incomplete, true);
});
