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
  assert.equal(workspace.agent.maxTurns, 60);
  assert.equal(workspace.agent.timeoutMs, 600000);
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
    extraSourceRoots: ['../other-backend', '  ../third-backend  ', ''],
    logParser: 'logback',
    agent: { model: 'claude-sonnet-5', maxTurns: 0, maxBudgetUsd: 1.5, timeoutMs: 60000 },
    window: { beforeMs: 1000, afterMs: 500 },
  });
  assert.equal(saved.backendUrl, 'http://127.0.0.1:9090');
  assert.deepEqual(saved.extraSourceRoots, ['../other-backend', '../third-backend']);
  assert.equal(saved.logParser, 'logback');
  assert.deepEqual(saved.agent, {
    model: 'claude-sonnet-5',
    maxTurns: null,
    maxBudgetUsd: 1.5,
    timeoutMs: 60000,
  });
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

test('manages multiple workspace profiles', async (t) => {
  await rm(TMP, { recursive: true, force: true });
  t.after(async () => { await rm(TMP, { recursive: true, force: true }); });
  const store = createStore({ configDir: TMP });
  const workspaceA = {
    frontendUrl: 'http://localhost:5173',
    backendUrl: 'http://127.0.0.1:8080',
    logfiles: ['logs/a.log'],
    window: { beforeMs: 3000, afterMs: 2000 },
  };
  const workspaceB = {
    frontendUrl: 'http://localhost:6000',
    backendUrl: 'http://127.0.0.1:9090',
    logfiles: ['logs/b.log'],
    window: { beforeMs: 4000, afterMs: 1000 },
  };
  const ruleA = { id: 'rule-a', match: { prefix: '/a' }, target: { kind: 'local', baseUrl: 'http://localhost:8080' } };
  const ruleB = { id: 'rule-b', match: { prefix: '/b' }, target: { kind: 'sit' } };

  const createdA = await store.createProfile('A', {
    workspace: workspaceA,
    routing: { rules: [ruleA] },
  });
  const profileA = createdA.profiles.find((profile) => profile.name === 'A');
  assert.equal(createdA.activeId, profileA.id);

  const createdB = await store.createProfile('B', {
    workspace: workspaceB,
    routing: { rules: [ruleB] },
  });
  const profileB = createdB.profiles.find((profile) => profile.name === 'B');
  assert.equal(createdB.activeId, profileB.id);

  await store.saveWorkspace({ ...workspaceB, frontendUrl: 'http://localhost:6001' });
  const switchedA = await store.switchProfile(profileA.id);
  assert.equal(switchedA.workspace.frontendUrl, 'http://localhost:5173');
  assert.equal(switchedA.routing.rules[0].id, 'rule-a');

  await store.saveWorkspace({ ...workspaceA, frontendUrl: 'http://localhost:5174' });
  const switchedB = await store.switchProfile(profileB.id);
  assert.equal(switchedB.workspace.frontendUrl, 'http://localhost:6001');
  assert.equal(switchedB.routing.rules[0].id, 'rule-b');

  const switchedBack = await store.switchProfile(profileA.id);
  assert.equal(switchedBack.workspace.frontendUrl, 'http://localhost:5174');
  assert.equal(switchedBack.routing.rules[0].id, 'rule-a');

  await store.renameProfile(profileA.id, 'A renamed');
  const renamed = await store.listProfiles();
  assert.equal(renamed.profiles.find((profile) => profile.id === profileA.id).name, 'A renamed');

  const deletedA = await store.deleteProfile(profileA.id);
  assert.equal(deletedA.activeId, profileB.id);
  const afterDelete = await store.getWorkspace();
  assert.equal(afterDelete.frontendUrl, 'http://localhost:6001');

  const deletedB = await store.deleteProfile(profileB.id);
  assert.equal(deletedB.activeId, null);
  assert.deepEqual(deletedB.profiles, []);
});

test('saving a profile with an existing name overwrites it', async (t) => {
  await rm(TMP, { recursive: true, force: true });
  t.after(async () => { await rm(TMP, { recursive: true, force: true }); });
  const store = createStore({ configDir: TMP });
  const first = {
    frontendUrl: 'http://localhost:5173',
    backendUrl: 'http://127.0.0.1:8080',
    logfiles: [],
    window: { beforeMs: 3000, afterMs: 2000 },
  };
  const second = { ...first, frontendUrl: 'http://localhost:6000' };

  const created = await store.createProfile('Same name', {
    workspace: first,
    routing: { rules: [] },
  });
  const originalId = created.activeId;
  const overwritten = await store.createProfile('Same name', {
    workspace: second,
    routing: { rules: [] },
  });

  assert.equal(overwritten.profiles.length, 1);
  assert.equal(overwritten.activeId, originalId);
  assert.equal(overwritten.profiles[0].name, 'Same name');
  assert.equal(overwritten.profiles[0].frontendUrl, 'http://localhost:6000');
  assert.equal((await store.getWorkspace()).frontendUrl, 'http://localhost:6000');
});
