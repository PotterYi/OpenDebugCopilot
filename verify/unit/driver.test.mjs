import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadScenario } from '../../src/core/scenario.mjs';
import { selectDriver } from '../../src/driver/index.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.resolve(HERE, '../fixtures/scenarios');

test('selects browser and http drivers', async () => {
  const browser = await loadScenario(path.join(FIXTURES, 'browser.json'));
  const http = await loadScenario(path.join(FIXTURES, 'http.json'));
  assert.equal(selectDriver(browser).kind, 'browser');
  assert.equal(selectDriver(http).kind, 'http');
});

test('rejects unknown driver kinds', () => {
  assert.throws(
    () => selectDriver({ driverKind: 'grpc' }),
    (err) => err.code === 'SCENARIO_UNKNOWN_DRIVER',
  );
});
