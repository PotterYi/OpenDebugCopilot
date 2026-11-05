import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createService } from '../../src/app/service.mjs';
import { startServer } from '../../src/app/server.mjs';
import { tempDir } from './tmp.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const TMP = tempDir('server-test');
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
  assert.match(saved.meta.configDir, /configs$/);

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

  const deleted = await fetch(`${server.url}/api/runs/20261102-120000-abcdef`, { method: 'DELETE' })
    .then((r) => r.json());
  assert.equal(deleted.deleted, true);
  assert.equal((await fetch(`${server.url}/api/runs/20261102-120000-abcdef`)).status, 404);
  await assert.rejects(readFile(path.join(runDir, 'result.json'), 'utf8'));
  assert.equal((await fetch(`${server.url}/api/runs/..%2Fescape`, { method: 'DELETE' })).status, 400);
});

test('reports EADDRINUSE when the port is already taken', async (t) => {
  await rm(TMP, { recursive: true, force: true });
  const service = createService({ root: TMP, configDir: path.join(TMP, 'configs'), runsDir: path.join(TMP, 'runs') });
  const first = await startServer({ service, uiDir: UI_DIR, port: 0 });
  t.after(async () => {
    await first.close();
    await rm(TMP, { recursive: true, force: true });
  });

  await assert.rejects(
    startServer({ service, uiDir: UI_DIR, port: first.port }),
    (err) => err.code === 'EADDRINUSE',
  );
});

test('manages workspace profiles over HTTP', async (t) => {
  const DIR = path.join(TMP, 'profiles');
  await rm(DIR, { recursive: true, force: true });
  await mkdir(DIR, { recursive: true });
  t.after(async () => { await rm(DIR, { recursive: true, force: true }); });
  const service = createService({ root: DIR, configDir: path.join(DIR, 'configs'), runsDir: path.join(DIR, 'runs') });
  const server = await startServer({ service, uiDir: UI_DIR, port: 0 });
  t.after(async () => { await server.close(); });

  const workspace = (port) => ({
    frontendUrl: `http://localhost:${port}`,
    backendUrl: 'http://127.0.0.1:8080',
    logfiles: [],
    window: { beforeMs: 3000, afterMs: 2000 },
  });
  const create = (name, port) => fetch(`${server.url}/api/profiles`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, workspace: workspace(port), routing: { rules: [] } }),
  }).then((r) => r.json());

  const a = await create('A', 5173);
  const b = await create('B', 6000);
  assert.equal(a.profiles.profiles.length, 1);
  assert.equal(b.profiles.profiles.length, 2);
  const profileA = b.profiles.profiles.find((profile) => profile.name === 'A');
  const profileB = b.profiles.profiles.find((profile) => profile.name === 'B');
  assert.equal(b.profiles.activeId, profileB.id);

  const activated = await fetch(`${server.url}/api/profiles/${profileA.id}/activate`, { method: 'POST' })
    .then((r) => r.json());
  assert.equal(activated.config.workspace.frontendUrl, 'http://localhost:5173');

  const renamed = await fetch(`${server.url}/api/profiles/${profileA.id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'A renamed' }),
  }).then((r) => r.json());
  assert.equal(renamed.profiles.profiles.find((profile) => profile.id === profileA.id).name, 'A renamed');

  const deletedB = await fetch(`${server.url}/api/profiles/${profileB.id}`, { method: 'DELETE' })
    .then((r) => r.json());
  assert.equal(deletedB.profiles.profiles.length, 1);

  const deletedA = await fetch(`${server.url}/api/profiles/${profileA.id}`, { method: 'DELETE' })
    .then((r) => r.json());
  assert.equal(deletedA.profiles.activeId, null);
  assert.deepEqual(deletedA.profiles.profiles, []);
});
