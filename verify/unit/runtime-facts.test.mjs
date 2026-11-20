import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { normalizeSelectors, runtimeFacts } from '../../src/evidence/runtime-facts.mjs';
import { listJavaProcesses } from '../../src/evidence/jvm.mjs';
import { createTools, toolSpecs } from '../../src/tools/index.mjs';
import { parseScenario } from '../../src/core/scenario.mjs';
import { tempDir } from './tmp.mjs';

const exec = promisify(execFile);

async function commandWorks(command, args) {
  try {
    await exec(command, args, { timeout: 8000, windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

async function delay(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

test('normalizes selectors and exposes runtime_facts', () => {
  assert.deepEqual(normalizeSelectors([' spring.* ', '', 'server.port\r\n']), ['spring.*', 'server.port']);
  assert.throws(() => normalizeSelectors('spring.*'), (error) => error.code === 'INVALID_SELECTORS');
  assert.ok(toolSpecs({}).some((spec) => spec.name === 'runtime_facts'));
});

test('reads selected system properties and redacts sensitive values', {
  skip: (await commandWorks('java', ['-version'])) && (await commandWorks('javac', ['-version'])) ? false : 'JDK is not available',
  timeout: 30_000,
}, async (t) => {
  const dir = tempDir('runtime-facts-test');
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'App.java'), 'public class App { public static void main(String[] args) throws Exception { Thread.sleep(60000); } }');
  await exec('javac', ['-d', '.', 'App.java'], { cwd: dir, timeout: 30000, windowsHide: true });
  await writeFile(path.join(dir, 'props.properties'), 'test.foo=three\n');
  const spawnApp = (value) => spawn('java', [
    `-Dtest.foo=${value}`,
    '-Ddb.password=secret-value',
    '-cp',
    '.',
    'App',
  ], { cwd: dir, stdio: 'ignore', windowsHide: true });
  const first = spawnApp('one');
  const second = spawnApp('two');
  t.after(async () => {
    if (first.exitCode === null && first.signalCode === null) first.kill();
    if (second.exitCode === null && second.signalCode === null) second.kill();
    await delay(300);
    await rm(dir, { recursive: true, force: true });
  });

  let listed = [];
  for (let attempt = 0; attempt < 30; attempt += 1) {
    listed = (await listJavaProcesses()).processes;
    if (listed.some((process) => process.pid === first.pid)
      && listed.some((process) => process.pid === second.pid)) break;
    await delay(250);
  }
  assert.ok(listed.some((process) => process.pid === first.pid), 'first java process visible');
  assert.ok(listed.some((process) => process.pid === second.pid), 'second java process visible');

  const selected = await runtimeFacts({
    pid: first.pid,
    view: 'system_properties',
    selectors: ['test.foo', 'db.password'],
  });
  const foo = selected.items.find((item) => item.key === 'test.foo');
  const password = selected.items.find((item) => item.key === 'db.password');
  assert.equal(foo.value, 'one');
  assert.equal(password.denied, true);
  assert.equal(password.value, undefined);
  assert.doesNotMatch(JSON.stringify(selected), /secret-value/);

  const summary = await runtimeFacts({ pid: first.pid, view: 'system_properties' });
  assert.ok(summary.totalKeys > 0);
  assert.deepEqual(summary.items, []);
  assert.ok(Array.isArray(summary.sampleKeys));
  assert.equal(summary.sampleKeys.includes('db.password'), false);
  assert.ok(summary.deniedCount >= 1);

  const wildcard = await runtimeFacts({
    pid: first.pid,
    view: 'system_properties',
    selectors: ['test.*'],
  });
  assert.equal(wildcard.valuesHidden, true);
  assert.equal(wildcard.items[0].value, '<redacted>');

  const customDeny = await runtimeFacts({
    pid: first.pid,
    view: 'system_properties',
    selectors: ['test.foo'],
    denyPrefixes: ['test.foo'],
  });
  assert.equal(customDeny.items[0].denied, true);
  assert.equal(customDeny.items[0].value, undefined);

  const compared = await runtimeFacts({
    pid: first.pid,
    comparePid: second.pid,
    view: 'system_properties',
    selectors: ['test.foo'],
  });
  assert.equal(compared.items.length, 1);
  assert.equal(compared.items[0].kind, 'different');
  assert.equal(compared.items[0].a, 'one');
  assert.equal(compared.items[0].b, 'two');

  const declared = await runtimeFacts({
    pid: first.pid,
    view: 'system_properties',
    selectors: ['test.foo'],
    declaredFile: 'props.properties',
    allowRoots: [dir],
    cwd: dir,
  });
  assert.equal(declared.items[0].kind, 'different');
  assert.equal(declared.items[0].a, 'one');
  assert.equal(declared.items[0].b, 'three');

  const classloaders = await runtimeFacts({ pid: first.pid, view: 'classloader' });
  assert.ok(classloaders.items.length > 0);
  assert.ok(classloaders.limitations.some((item) => /jar URL/.test(item)));

  const scenario = parseScenario({ name: 'runtime-facts', baseUrl: 'http://127.0.0.1:1', method: 'GET', path: '/' });
  const { tools } = createTools({ scenario, anchor: Date.now(), runDir: dir });
  const viaTool = await tools.runtime_facts({
    pid: first.pid,
    view: 'system_properties',
    selectors: ['test.foo'],
  });
  assert.equal(viaTool.items[0].value, 'one');
  assert.equal(viaTool.fields[0], 'items');
});
