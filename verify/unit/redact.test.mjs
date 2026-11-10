import test from 'node:test';
import assert from 'node:assert/strict';
import { redactSecrets, redactValue } from '../../src/core/redact.mjs';

test('redacts credential patterns while keeping key names and context', () => {
  const cases = [
    ['sk-ant-api03-abcdefghijklmnopqrstuvwxyz', 'sk-ant-<redacted>'],
    ['ghp_abcdefghijklmnopqrstuvwxyz012345', 'ghp_<redacted>'],
    ['AKIAABCDEFGHIJKLMNOP', 'AKIA<redacted>'],
    ['Authorization: Bearer abcdefghijklmnopqrstuvwxyz', 'Authorization: Bearer <redacted>'],
    ['password="hunter2secret"', 'password="<redacted>"'],
    ['db_token=abcdef123456', 'db_token=<redacted>'],
    ['mysql://root:s3cretpass@localhost/db', 'mysql://root:<redacted>@localhost/db'],
  ];
  for (const [input, expected] of cases) {
    assert.equal(redactSecrets(input), expected);
  }

  const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';
  assert.match(redactSecrets(`token ${jwt}`), /<redacted-jwt>/);
  assert.doesNotMatch(redactSecrets(`token ${jwt}`), /eyJhbGci/);

  const pem = '-----BEGIN RSA PRIVATE KEY-----\nMIIEow\n-----END RSA PRIVATE KEY-----';
  assert.match(redactSecrets(pem), /<redacted>/);
  assert.doesNotMatch(redactSecrets(pem), /MIIEow/);
});

test('keeps ordinary identifiers that merely contain sensitive words', () => {
  const text = 'const tokenCount = 42; const passwordPolicy = "strict"; sk-learn is not a key.';
  assert.equal(redactSecrets(text), text);
});

test('redacts nested values, sensitive keys and never mutates the input', () => {
  const input = {
    auth: { token: 'opaque-token-value' },
    row: { id: 7, password: 'hunter2secret', note: 'keep me' },
    list: ['Bearer abcdefghijklmnopqrstuvwxyz'],
    tokenCount: 3,
    ok: true,
    nil: null,
  };
  const out = redactValue(input);
  assert.equal(out.auth.token, '<redacted>');
  assert.equal(out.row.password, '<redacted>');
  assert.equal(out.row.note, 'keep me');
  assert.equal(out.row.id, 7);
  assert.equal(out.list[0], 'Bearer <redacted>');
  assert.equal(out.tokenCount, 3);
  assert.equal(out.ok, true);
  assert.equal(out.nil, null);
  assert.equal(input.auth.token, 'opaque-token-value');
  assert.equal(input.row.password, 'hunter2secret');
});

test('redaction is idempotent and depth-limited', () => {
  const sample = 'password="hunter2secret" Bearer abcdefghijklmnopqrstuvwxyz';
  const once = redactSecrets(sample);
  assert.equal(redactSecrets(once), once);

  let deep = 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz';
  for (let i = 0; i < 10; i += 1) deep = { child: deep };
  assert.doesNotMatch(JSON.stringify(redactValue(deep)), /abcdefghijklmnopqrstuvwxyz/);
});
