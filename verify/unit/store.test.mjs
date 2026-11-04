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
  assert.deepEqual(routing, { rules: [], warnings: [] });
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

test('SIT rules do not require a target URL', async (t) => {
  await rm(TMP, { recursive: true, force: true });
  t.after(async () => { await rm(TMP, { recursive: true, force: true }); });
  const store = createStore({ configDir: TMP });
  const routing = await store.saveRouting({
    rules: [{ id: 'sit-passthrough', match: { prefix: '/user' }, target: { kind: 'sit' } }],
  });
  assert.equal(routing.rules[0].target.kind, 'sit');
  assert.equal(routing.rules[0].target.baseUrl, '');

  await assert.rejects(
    store.saveRouting({ rules: [{ id: 'bad-local', match: { prefix: '/x' }, target: { kind: 'local' } }] }),
    (err) => err.code === 'CONFIG_INVALID',
  );
});

test('warns when a passthrough rule declares a target address', async (t) => {
  await rm(TMP, { recursive: true, force: true });
  t.after(async () => { await rm(TMP, { recursive: true, force: true }); });
  const store = createStore({ configDir: TMP });
  const routing = await store.saveRouting({
    rules: [{
      id: 'sit-with-target',
      match: { prefix: '/api' },
      target: { kind: 'sit', baseUrl: 'http://localhost:8096' },
    }],
  });
  assert.equal(routing.rules[0].target.kind, 'sit');
  assert.equal(routing.rules[0].target.baseUrl, '');
  assert.equal(routing.warnings.length, 1);
  assert.equal(routing.warnings[0].code, 'SIT_TARGET_IGNORED');
  assert.equal(routing.warnings[0].baseUrl, 'http://localhost:8096');

  // Warnings are derived, not persisted: the normalized file reloads clean.
  const reloaded = await store.getRouting();
  assert.equal(reloaded.rules[0].target.baseUrl, '');
  assert.deepEqual(reloaded.warnings, []);
});

test('warns and falls back to local for an unknown target kind', async (t) => {
  await rm(TMP, { recursive: true, force: true });
  t.after(async () => { await rm(TMP, { recursive: true, force: true }); });
  const store = createStore({ configDir: TMP });
  const routing = await store.saveRouting({
    rules: [{
      id: 'typo-kind',
      match: { prefix: '/api' },
      target: { kind: 'SIT', baseUrl: 'http://localhost:8080' },
    }],
  });
  assert.equal(routing.rules[0].target.kind, 'local');
  assert.equal(routing.warnings[0].code, 'UNKNOWN_TARGET_KIND');
});
