import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { mkdir, readFile, rm, writeFile, appendFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseScenario } from '../../src/core/scenario.mjs';
import { runDiagnosis } from '../../src/diagnose/run.mjs';
import { runPreflight } from '../../src/doctor/preflight.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.resolve(HERE, '../fixtures');
const TMP = path.resolve(HERE, `../../../.tmp/diagnose-test-${process.pid}`);
const LOG_FILE = path.join(TMP, 'app.log');
const RUNS = path.join(TMP, 'runs');

function logbackTimestamp() {
  const now = new Date();
  const pad = (value, width = 2) => String(value).padStart(width, '0');
  return [
    `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`,
    `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}.${pad(now.getMilliseconds(), 3)}`,
  ].join(' ');
}

async function startServer() {
  const server = http.createServer(async (req, res) => {
    if (req.url === '/api/order' && req.method === 'POST') {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const line = `${logbackTimestamp()} ERROR 1 --- [http-nio-8080-exec-1] c.e.demo.OrderService : create order failed traceNo=${body.traceNo}\n`;
      await appendFile(LOG_FILE, line, 'utf8');
      res.statusCode = 500;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ error: 'inventory not enough' }));
      return;
    }
    res.statusCode = 404;
    res.end('not found');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return { server, baseUrl: `http://127.0.0.1:${server.address().port}` };
}

test('runs the full diagnosis loop with mock agent', async (t) => {
  await mkdir(TMP, { recursive: true });
  await writeFile(LOG_FILE, '', 'utf8');
  t.after(async () => { await rm(TMP, { recursive: true, force: true }); });

  const { server, baseUrl } = await startServer();
  try {
    const scenario = parseScenario({
      name: 'order-create',
      baseUrl,
      method: 'POST',
      path: '/api/order',
      body: { qty: 2 },
      marker: { mode: 'body', bodyField: 'traceNo' },
      logfiles: [LOG_FILE],
      parser: { preset: 'logback' },
      source: { root: path.join(FIXTURES, 'source') },
      window: { beforeMs: 5000, afterMs: 5000 },
    }, { filePath: path.join(TMP, 'scenario.json') });

    const preflight = await runPreflight(scenario);
    assert.equal(preflight.ok, true, JSON.stringify(preflight.checks));

    const { result, runDir } = await runDiagnosis(scenario, {
      runsDir: RUNS,
      question: '下单失败了',
      recheck: 3,
      markerTimeoutMs: 1500,
      pollIntervalMs: 100,
      driverContext: { timeoutMs: 5000 },
    });

    assert.equal(result.meta.mode, 'mock');
    assert.equal(result.marker.injected, true);
    assert.equal(result.marker.targets.body, true);
    assert.equal(result.logs.markerMatched, true);
    assert.ok(result.logs.count >= 1);
    assert.match(result.agent.conclusion, /ERROR/);
    assert.equal(result.gates.ok, true, JSON.stringify(result.gates.checks));
    assert.equal(result.recheck.runs, 3);
    assert.equal(result.recheck.verdict, 'consistent');
    assert.ok(result.recheck.note.includes('一致不等于正确'));

    const persisted = JSON.parse(await readFile(path.join(runDir, 'result.json'), 'utf8'));
    assert.equal(persisted.meta.runId, result.meta.runId);
    const meta = JSON.parse(await readFile(path.join(runDir, 'meta.json'), 'utf8'));
    assert.equal(meta.preflight.ok, true);
  } finally {
    server.close();
  }
});

test('preflight rejects missing log files', async (t) => {
  await mkdir(TMP, { recursive: true });
  t.after(async () => { await rm(TMP, { recursive: true, force: true }); });
  const scenario = parseScenario({
    name: 'missing-log',
    baseUrl: 'http://127.0.0.1:1',
    method: 'GET',
    path: '/',
    logfiles: [path.join(TMP, 'missing.log')],
    parser: { preset: 'logback' },
  });
  await assert.rejects(
    runDiagnosis(scenario, { runsDir: RUNS }),
    (err) => err.code === 'PREFLIGHT_FAILED' && err.exitCode === 3,
  );
});
