import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readdir, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createStore, DEFAULT_WORKSPACE } from '../../src/core/store.mjs';
import { tempDir } from './tmp.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TMP = tempDir('store-test');

test('returns defaults when config files are absent', async (t) => {
  await rm(TMP, { recursive: true, force: true });
  t.after(async () => { await rm(TMP, { recursive: true, force: true }); });
  const store = createStore({ configDir: TMP });
  const workspace = await store.getWorkspace();
  assert.equal(workspace.frontendUrl, DEFAULT_WORKSPACE.frontendUrl);
  assert.deepEqual(workspace.window, DEFAULT_WORKSPACE.window);
  const routing = await store.getRouting();
  assert.deepEqual(routing, { rules: [] });
});

test('saves workspace atomically and reads it back', async (t) => {
  await rm(TMP, { recursive: true, force: true });
  t.after(async () => { await rm(TMP, { recursive: true, force: true }); });
  const store = createStore({ configDir: TMP });
  const saved = await store.saveWorkspace({
    frontendUrl: 'http://localhost:3000',
    backendUrl: 'http://127.0.0.1:9090',
    logfiles: ['logs/app.log'],
    sourceRoot: '../demo',
    window: { beforeMs: 1000, afterMs: 500 },
  });
  assert.equal(saved.backendUrl, 'http://127.0.0.1:9090');
  const reloaded = await createStore({ configDir: TMP }).getWorkspace();
  assert.deepEqual(reloaded, saved);
  const files = await readdir(TMP);
  assert.equal(files.some((name) => name.includes('.tmp-')), false);
});

test('validates routing rules', async (t) => {
  await rm(TMP, { recursive: true, force: true });
  t.after(async () => { await rm(TMP, { recursive: true, force: true }); });
  const store = createStore({ configDir: TMP });
  const routing = await store.saveRouting({
    rules: [
      {
        id: 'local-order',
        enabled: true,
        match: { host: 'api.example.com', prefix: '/api/order' },
        target: { kind: 'local', baseUrl: 'http://127.0.0.1:8080' },
      },
    ],
  });
  assert.equal(routing.rules.length, 1);

  await assert.rejects(
    store.saveRouting({
      rules: [
        { id: 'dup', match: { prefix: '/a' }, target: { baseUrl: 'http://a' } },
        { id: 'dup', match: { prefix: '/b' }, target: { baseUrl: 'http://b' } },
      ],
    }),
    (err) => err.code === 'CONFIG_INVALID',
  );
  await assert.rejects(
    store.saveRouting({ rules: [{ id: 'bad', match: { prefix: 'nope' }, target: { baseUrl: 'http://a' } }] }),
    (err) => err.code === 'CONFIG_INVALID',
  );
});
