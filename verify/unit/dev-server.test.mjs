import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { once } from 'node:events';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tempDir } from './tmp.mjs';
import { createDevServerManager } from '../../src/app/electron/dev-server.mjs';

const TMP = tempDir('dev-server-test');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function freePort() {
  const server = net.createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function waitFor(predicate, timeoutMs = 8_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await sleep(50);
  }
  return false;
}

async function makeProject(t, port) {
  await rm(TMP, { recursive: true, force: true });
  t.after(async () => { await rm(TMP, { recursive: true, force: true }); });
  const project = path.join(TMP, 'frontend');
  await mkdir(project, { recursive: true });
  await writeFile(path.join(project, 'package.json'), JSON.stringify({ scripts: { dev: 'node server.mjs' } }), 'utf8');
  await writeFile(path.join(project, 'server.mjs'), `
import http from 'node:http';
http.createServer((req, res) => { res.end('ok'); }).listen(${port}, '127.0.0.1', () => {
  console.log('frontend-ready');
});
`, 'utf8');
  return project;
}

const isReachable = async (url) => {
  try {
    await fetch(url, { signal: AbortSignal.timeout(400) });
    return true;
  } catch {
    return false;
  }
};

test('starts, probes, stops and restarts the frontend process', async (t) => {
  const port = await freePort();
  const project = await makeProject(t, port);
  const url = `http://127.0.0.1:${port}`;
  const events = [];
  const manager = createDevServerManager({
    getWorkspace: async () => ({
      frontendUrl: url,
      frontendProjectRoot: '.',
      frontendStartCommand: 'node server.mjs',
    }),
    rootDir: project,
    onEvent: (event) => events.push(event),
    readyTimeoutMs: 8_000,
    probeIntervalMs: 50,
    stopTimeoutMs: 3_000,
  });
  t.after(async () => { await manager.dispose(); });

  const started = await manager.start();
  assert.equal(started.status, 'starting');
  assert.ok(await waitFor(() => manager.snapshot().status === 'running'), 'should become ready');
  assert.equal((await fetch(url)).status, 200);
  assert.ok(await waitFor(() => events.some((event) => event.type === 'log' && event.line.includes('frontend-ready'))));

  const stopped = await manager.stop();
  assert.equal(stopped.status, 'stopped');
  assert.ok(await waitFor(async () => !(await isReachable(url))), 'should stop listening');

  const restarted = await manager.restart();
  assert.ok(['starting', 'running'].includes(restarted.status));
  assert.ok(await waitFor(() => manager.snapshot().status === 'running'), 'should restart');
  await manager.stop();
});

test('reports an external frontend instead of taking it over', async (t) => {
  await rm(TMP, { recursive: true, force: true });
  t.after(async () => { await rm(TMP, { recursive: true, force: true }); });
  const external = http.createServer((_req, res) => res.end('external'));
  external.listen(0, '127.0.0.1');
  await once(external, 'listening');
  const port = external.address().port;
  t.after(() => new Promise((resolve) => external.close(resolve)));

  const manager = createDevServerManager({
    getWorkspace: async () => ({ frontendUrl: `http://127.0.0.1:${port}` }),
    rootDir: TMP,
    probeIntervalMs: 50,
    readyTimeoutMs: 1_000,
  });
  const state = await manager.status();
  assert.equal(state.status, 'external');
  const started = await manager.start();
  assert.equal(started.status, 'external');
  assert.equal(manager.child, null);
  await manager.dispose();
});

test('surfaces a clear error when the launch cannot be resolved', async (t) => {
  await rm(TMP, { recursive: true, force: true });
  t.after(async () => { await rm(TMP, { recursive: true, force: true }); });
  await mkdir(TMP, { recursive: true });
  const manager = createDevServerManager({
    getWorkspace: async () => ({ frontendSourceRoot: 'missing/src' }),
    rootDir: TMP,
  });
  const state = await manager.start();
  assert.equal(state.status, 'error');
  assert.match(state.message, /package\.json/);
  await manager.dispose();
});
