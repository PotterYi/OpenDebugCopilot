import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import http from 'node:http';
import { once } from 'node:events';
import { mkdir, readFile, rm, writeFile, appendFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const CLI = path.join(ROOT, 'src/app/cli.mjs');
const FIXTURES = path.join(ROOT, 'verify/fixtures/scenarios');
const TMP = path.resolve(HERE, `../../../.tmp/cli-test-${process.pid}`);

function runCli(args) {
  return spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' });
}

function runCliAsync(args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args]);
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

function logbackTimestamp() {
  const now = new Date();
  const pad = (value, width = 2) => String(value).padStart(width, '0');
  return [
    `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`,
    `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}.${pad(now.getMilliseconds(), 3)}`,
  ].join(' ');
}

test('check mode validates a browser scenario and prints JSON', () => {
  const result = runCli(['run', path.join(FIXTURES, 'browser.json'), '--check', '--json']);
  assert.equal(result.status, 0, result.stderr);
  const summary = JSON.parse(result.stdout);
  assert.equal(summary.name, 'order-create');
  assert.equal(summary.driver, 'browser');
  assert.equal(summary.mode, 'check');
  assert.equal(summary.status, 'validated');
});

test('mock run executes the full loop through the CLI', async (t) => {
  await mkdir(TMP, { recursive: true });
  t.after(async () => { await rm(TMP, { recursive: true, force: true }); });
  const logFile = path.join(TMP, 'app.log');
  await writeFile(logFile, '', 'utf8');

  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    await appendFile(
      logFile,
      `${logbackTimestamp()} ERROR 1 --- [main] c.e.demo.OrderService : failed traceNo=${body.traceNo}\n`,
      'utf8',
    );
    res.statusCode = 500;
    res.setHeader('Content-Type', 'application/json');
    res.end('{"error":"boom"}');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  try {
    const scenarioPath = path.join(TMP, 'scenario.json');
    await writeFile(scenarioPath, JSON.stringify({
      name: 'cli-loop',
      baseUrl,
      method: 'POST',
      path: '/api/order',
      body: { qty: 1 },
      marker: { mode: 'body', bodyField: 'traceNo' },
      logfiles: [logFile],
      parser: { preset: 'logback' },
      window: { beforeMs: 5000, afterMs: 5000 },
    }), 'utf8');

    const result = await runCliAsync(['run', scenarioPath, '--mock', '--json', '-q', '下单失败', '--runs-dir', path.join(TMP, 'runs')]);
    assert.equal(result.status, 0, result.stderr);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.meta.mode, 'mock');
    assert.equal(parsed.marker.injected, true);
    assert.equal(parsed.gates.ok, true);
    assert.ok(parsed.logs.count >= 1);
    const reportPath = path.join(TMP, 'runs', parsed.meta.runId, 'report.md');
    const report = await readFile(reportPath, 'utf8');
    assert.match(report, /# DebugCopilot 诊断报告/);
    assert.match(report, /## 结论/);
  } finally {
    server.close();
  }
});

test('mock run fails preflight on missing logfiles with exit code 3', async (t) => {
  await mkdir(TMP, { recursive: true });
  t.after(async () => { await rm(TMP, { recursive: true, force: true }); });
  const scenarioPath = path.join(TMP, 'missing.json');
  await writeFile(scenarioPath, JSON.stringify({
    name: 'missing-log',
    baseUrl: 'http://127.0.0.1:1',
    method: 'GET',
    path: '/',
    logfiles: [path.join(TMP, 'missing.log')],
  }), 'utf8');
  const result = runCli(['run', scenarioPath, '--mock']);
  assert.equal(result.status, 3);
  assert.match(result.stderr, /PREFLIGHT_FAILED/);
});

test('scenario errors exit with code 3', () => {
  const result = runCli(['run', path.join(FIXTURES, 'ambiguous.json'), '--check']);
  assert.equal(result.status, 3);
  assert.match(result.stderr, /SCENARIO_AMBIGUOUS_DRIVER/);
});

test('unknown command exits with usage code 2', () => {
  const result = runCli(['diagnose']);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /USAGE/);
});

test('missing scenario path exits with usage code 2', () => {
  const result = runCli(['run']);
  assert.equal(result.status, 2);
});

test('version command prints package version', () => {
  const result = runCli(['--version']);
  assert.equal(result.status, 0);
  assert.match(result.stdout.trim(), /^\d+\.\d+\.\d+/);
});
