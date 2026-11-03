import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createService } from '../../src/app/service.mjs';
import { startServer } from '../../src/app/server.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const TMP = path.resolve(HERE, `../../../.tmp/server-test-${process.pid}`);
const UI_DIR = path.join(ROOT, 'src/ui');

test('serves health, config, static page and runs', async (t) => {
  await rm(TMP, { recursive: true, force: true });
  await mkdir(TMP, { recursive: true });
  const service = createService({ root: TMP, configDir: path.join(TMP, 'configs'), runsDir: path.join(TMP, 'runs') });
  const server = await startServer({ service, uiDir: UI_DIR, port: 0 });
  t.after(async () => {
    await server.close();
    await rm(TMP, { recursive: true, force: true });
  });

  const health = await fetch(`${server.url}/api/health`).then((r) => r.json());
  assert.equal(health.ok, true);

  const config = await fetch(`${server.url}/api/config`).then((r) => r.json());
  assert.ok(config.workspace.frontendUrl);

  const saved = await fetch(`${server.url}/api/config`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      workspace: {
        frontendUrl: 'http://localhost:3000',
        backendUrl: 'http://127.0.0.1:9090',
        logfiles: ['logs/app.log'],
        sourceRoot: '../demo',
        window: { beforeMs: 1000, afterMs: 500 },
      },
      routing: { rules: [] },
    }),
  }).then((r) => r.json());
  assert.equal(saved.workspace.backendUrl, 'http://127.0.0.1:9090');

  const page = await fetch(`${server.url}/`).then((r) => r.text());
  assert.match(page, /DebugCopilot/);

  assert.equal((await fetch(`${server.url}/../package.json`)).status, 404);
  assert.equal((await fetch(`${server.url}/api/nope`)).status, 404);
});

test('lists and returns run artifacts', async (t) => {
  await rm(TMP, { recursive: true, force: true });
  const runDir = path.join(TMP, 'runs', '20261102-120000-abcdef');
  await mkdir(runDir, { recursive: true });
  await writeFile(path.join(runDir, 'meta.json'), JSON.stringify({
    scenario: 'demo', driver: 'http', agent: 'mock', mode: 'mock',
    startedAt: 1000, endedAt: 2000, durationMs: 1000, question: 'q',
  }), 'utf8');
  await writeFile(path.join(runDir, 'result.json'), JSON.stringify({ meta: { runId: 'x' } }), 'utf8');
  await writeFile(path.join(runDir, 'report.md'), '# report', 'utf8');

  const service = createService({ root: TMP, configDir: path.join(TMP, 'configs'), runsDir: path.join(TMP, 'runs') });
  const server = await startServer({ service, uiDir: UI_DIR, port: 0 });
  t.after(async () => {
    await server.close();
    await rm(TMP, { recursive: true, force: true });
  });

  const runs = await fetch(`${server.url}/api/runs`).then((r) => r.json());
  assert.equal(runs.runs.length, 1);
  assert.equal(runs.runs[0].scenario, 'demo');

  const run = await fetch(`${server.url}/api/runs/20261102-120000-abcdef`).then((r) => r.json());
  assert.equal(run.report, '# report');
  assert.equal((await fetch(`${server.url}/api/runs/missing`)).status, 404);
});
