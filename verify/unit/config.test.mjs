import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, DEFAULT_CONFIG } from '../../src/core/config.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.resolve(HERE, '../fixtures');

test('missing config falls back to defaults', async () => {
  const config = await loadConfig(path.join(FIXTURES, 'does-not-exist.json'));
  assert.deepEqual(config, DEFAULT_CONFIG);
  assert.notEqual(config, DEFAULT_CONFIG);
});

test('valid config merges over defaults', async () => {
  const config = await loadConfig(path.resolve(HERE, '../../configs/default.json'));
  assert.equal(config.window.beforeMs, 3000);
  assert.equal(config.marker.header, 'X-DC-Probe');
  assert.equal(config.runsDir, 'runs');
});

test('invalid JSON config reports a stable code', async () => {
  await assert.rejects(
    loadConfig(path.join(FIXTURES, 'config-invalid.json')),
    (err) => err.code === 'CONFIG_PARSE_FAILED',
  );
});
