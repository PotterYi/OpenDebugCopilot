import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFile, rm } from 'node:fs/promises';
import { createAgentAuthStore } from '../../src/core/agent-auth-store.mjs';
import { tempDir } from './tmp.mjs';

const TMP = tempDir('agent-auth-store-test');

const codec = {
  scheme: 'test',
  encrypt(value) {
    return Buffer.from(`enc:${value}`, 'utf8').toString('base64');
  },
  decrypt(data) {
    const text = Buffer.from(String(data), 'base64').toString('utf8');
    if (!text.startsWith('enc:')) throw new Error('bad ciphertext');
    return text.slice(4);
  },
};

async function fixture(t) {
  await rm(TMP, { recursive: true, force: true });
  t.after(async () => { await rm(TMP, { recursive: true, force: true }); });
  return createAgentAuthStore({ configDir: path.join(TMP, 'configs'), secretCodec: codec });
}

test('defaults to following Claude Code settings', async (t) => {
  const store = await fixture(t);
  assert.deepEqual(await store.getPublic(), {
    mode: 'user',
    baseUrl: '',
    tokenEnv: '',
    hasToken: false,
  });
});

test('encrypts custom tokens and never returns them to the renderer', async (t) => {
  const store = await fixture(t);
  const publicState = await store.save({
    mode: 'custom',
    baseUrl: 'https://gateway.example.com/',
    token: 'sk-ant-super-secret',
  });
  assert.deepEqual(publicState, {
    mode: 'custom',
    baseUrl: 'https://gateway.example.com',
    tokenEnv: '',
    hasToken: true,
  });
  assert.equal(publicState.token, undefined);

  const raw = await readFile(store.file, 'utf8');
  assert.doesNotMatch(raw, /super-secret/);
  const disk = JSON.parse(raw);
  assert.equal(disk.token.scheme, 'test');
  assert.ok(disk.token.data);

  const runtime = await store.getRuntime();
  assert.equal(runtime.token, 'sk-ant-super-secret');
  assert.equal(runtime.secretError, null);

  await store.save({ mode: 'custom', baseUrl: 'https://changed.example.com' });
  const kept = await store.getRuntime();
  assert.equal(kept.token, 'sk-ant-super-secret');
  assert.equal(kept.baseUrl, 'https://changed.example.com');
});

test('clearing and env mode remove the stored token', async (t) => {
  const store = await fixture(t);
  await store.save({ mode: 'custom', token: 'sk-ant-super-secret' });

  await store.save({ mode: 'user', clearToken: true });
  assert.equal((await store.getPublic()).hasToken, false);

  await store.save({ mode: 'custom', token: 'second-token' });
  await store.save({ mode: 'env', tokenEnv: 'MY_CLAUDE_TOKEN' });
  const state = await store.getPublic();
  assert.equal(state.mode, 'env');
  assert.equal(state.tokenEnv, 'MY_CLAUDE_TOKEN');
  assert.equal(state.hasToken, false);
});

test('validates base URLs and mode requirements', async (t) => {
  const store = await fixture(t);
  await assert.rejects(store.save({ mode: 'custom', token: 'x', baseUrl: 'ftp://bad' }), /仅支持 http\/https/);
  await assert.rejects(store.save({ mode: 'custom', token: 'x', baseUrl: 'not a url' }), /不是合法地址/);
  await assert.rejects(store.save({ mode: 'custom' }), /需要填写 Token/);
  await assert.rejects(store.save({ mode: 'env' }), /需要填写 Token 环境变量名/);
});

test('rejects plaintext tokens when no secret codec is available', async (t) => {
  await rm(TMP, { recursive: true, force: true });
  t.after(async () => { await rm(TMP, { recursive: true, force: true }); });
  const store = createAgentAuthStore({ configDir: path.join(TMP, 'configs'), secretCodec: null });
  await assert.rejects(
    store.save({ mode: 'custom', token: 'sk-ant-super-secret' }),
    /无法加密 Claude Token/,
  );
});
