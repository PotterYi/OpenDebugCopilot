import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveAgentAuth } from '../../src/core/agent-auth.mjs';

test('user mode keeps loading Claude Code settings', () => {
  const auth = resolveAgentAuth({ mode: 'user', token: 'ignored' }, {});
  assert.deepEqual(auth, { mode: 'user', env: {}, settingSources: ['user'] });
});

test('custom mode injects token/base URL and isolates user settings', () => {
  const auth = resolveAgentAuth({
    mode: 'custom',
    token: 'sk-ant-test-token',
    baseUrl: 'https://gateway.example.com',
  }, {});
  assert.deepEqual(auth.env, {
    ANTHROPIC_AUTH_TOKEN: 'sk-ant-test-token',
    ANTHROPIC_BASE_URL: 'https://gateway.example.com',
  });
  assert.deepEqual(auth.settingSources, []);
});

test('custom mode requires a token', () => {
  assert.throws(
    () => resolveAgentAuth({ mode: 'custom', baseUrl: 'https://gateway.example.com' }, {}),
    /自定义凭据需要填写 Token/,
  );
});

test('env mode resolves the configured variable', () => {
  const auth = resolveAgentAuth({
    mode: 'env',
    tokenEnv: 'MY_CLAUDE_TOKEN',
    baseUrl: 'https://gateway.example.com',
  }, { MY_CLAUDE_TOKEN: 'token-from-env' });
  assert.equal(auth.env.ANTHROPIC_AUTH_TOKEN, 'token-from-env');
  assert.equal(auth.env.ANTHROPIC_BASE_URL, 'https://gateway.example.com');
  assert.deepEqual(auth.settingSources, []);
});

test('env mode fails clearly when the variable is missing', () => {
  assert.throws(
    () => resolveAgentAuth({ mode: 'env', tokenEnv: 'MISSING_TOKEN' }, {}),
    /环境变量 MISSING_TOKEN 未设置/,
  );
  assert.throws(
    () => resolveAgentAuth({ mode: 'env', tokenEnv: '' }, {}),
    /需要填写 Token 环境变量名/,
  );
});

test('decryption failures are surfaced instead of falling back silently', () => {
  assert.throws(
    () => resolveAgentAuth({ mode: 'custom', token: '', secretError: 'Claude Token 解密失败' }, {}),
    /Claude Token 解密失败/,
  );
});
