import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseScenario, loadScenario, resolveScenarioPaths } from '../../src/core/scenario.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.resolve(HERE, '../fixtures/scenarios');

const codeOf = (err) => err?.code;

test('browser scenario gets defaults and driverKind', async () => {
  const scenario = await loadScenario(path.join(FIXTURES, 'browser.json'));
  assert.equal(scenario.driverKind, 'browser');
  assert.equal(scenario.browser.path, '/order/create');
  assert.equal(scenario.browser.actions.length, 2);
  assert.deepEqual(scenario.parser, { preset: 'auto' });
  assert.deepEqual(scenario.marker, { mode: 'body', bodyField: 'traceNo', header: 'X-DC-Probe' });
  assert.deepEqual(scenario.window, { beforeMs: 1000, afterMs: 500 });
  assert.equal(Object.isFrozen(scenario), true);
});

test('http scenario normalizes method and body', async () => {
  const scenario = await loadScenario(path.join(FIXTURES, 'http.json'));
  assert.equal(scenario.driverKind, 'http');
  assert.equal(scenario.http.method, 'POST');
  assert.deepEqual(scenario.http.headers, { 'Content-Type': 'application/json' });
  assert.deepEqual(scenario.http.body, { qty: 2 });
  assert.deepEqual(scenario.marker, { mode: 'none', bodyField: undefined, header: 'X-DC-Probe' });
  assert.deepEqual(scenario.window, { beforeMs: 3000, afterMs: 2000 });
});

test('rejects scenarios declaring both driver kinds', async () => {
  await assert.rejects(
    loadScenario(path.join(FIXTURES, 'ambiguous.json')),
    (err) => codeOf(err) === 'SCENARIO_AMBIGUOUS_DRIVER',
  );
});

test('rejects scenarios without any driver', () => {
  assert.throws(
    () => parseScenario({ name: 'empty' }),
    (err) => codeOf(err) === 'SCENARIO_MISSING_DRIVER',
  );
});

test('rejects unsupported actions such as select', async () => {
  await assert.rejects(
    loadScenario(path.join(FIXTURES, 'invalid-action.json')),
    (err) => codeOf(err) === 'SCENARIO_UNKNOWN_KEY',
  );
});

test('rejects marker body mode without bodyField', async () => {
  await assert.rejects(
    loadScenario(path.join(FIXTURES, 'marker-without-field.json')),
    (err) => codeOf(err) === 'SCENARIO_INVALID_FIELD',
  );
});

test('rejects unknown top-level keys', () => {
  assert.throws(
    () => parseScenario({ name: 'x', method: 'GET', path: '/', typo: true }),
    (err) => codeOf(err) === 'SCENARIO_UNKNOWN_KEY',
  );
});

test('resolves logfiles and source root relative to the scenario file', async () => {
  const scenario = await loadScenario(path.join(FIXTURES, 'browser.json'));
  const paths = resolveScenarioPaths(scenario);
  assert.equal(paths.scenarioPath, path.join(FIXTURES, 'browser.json'));
  assert.deepEqual(paths.logfiles, [path.join(FIXTURES, 'logs/app.log')]);
  assert.equal(paths.sourceRoot, path.resolve(FIXTURES, '../../../..'));
});

test('parses log encoding option', () => {
  const scenario = parseScenario({
    name: 'encoding',
    method: 'GET',
    path: '/',
    logEncoding: 'GBK',
  });
  assert.equal(scenario.logEncoding, 'gbk');
  const defaulted = parseScenario({ name: 'default', method: 'GET', path: '/' });
  assert.equal(defaulted.logEncoding, 'auto');
  assert.throws(
    () => parseScenario({ name: 'bad', method: 'GET', path: '/', logEncoding: 'utf-16' }),
    (err) => err.code === 'SCENARIO_INVALID_FIELD',
  );
});
