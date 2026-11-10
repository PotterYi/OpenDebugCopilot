import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { parseScenario } from '../../src/core/scenario.mjs';
import { createTools } from '../../src/tools/index.mjs';
import { parseTimestamp } from '../../src/evidence/parsers.mjs';
import { tempDir } from './tmp.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.resolve(HERE, '../fixtures');
const LOGS = path.join(FIXTURES, 'logs');
const SOURCE = path.join(FIXTURES, 'source');
const RUN_DIR = tempDir('tools-test');

const scenario = parseScenario({
  name: 'tools-test',
  baseUrl: 'http://127.0.0.1:1',
  method: 'GET',
  path: '/',
  logfiles: [path.join(LOGS, 'logback.log')],
  parser: { preset: 'logback' },
  source: { root: SOURCE },
});
const anchor = parseTimestamp('2026-11-02 19:30:02.000');
const window = { beforeMs: 5000, afterMs: 5000 };

function build(limitBytes) {
  return createTools({ scenario, anchor, runDir: RUN_DIR, window, limitBytes });
}

test('tools query logs, threads, source and search', async (t) => {
  t.after(async () => { await rm(RUN_DIR, { recursive: true, force: true }); });
  const { tools } = build();
  const logs = await tools.get_logs({});
  assert.equal(logs.parser, 'logback');
  assert.ok(logs.records.length >= 2);

  const errors = await tools.get_logs({ level: 'ERROR' });
  assert.equal(errors.records.length, 1);

  const threads = await tools.list_threads({});
  assert.ok(threads.threads.length >= 2);

  const searched = await tools.search_log({ keyword: 'degraded' });
  assert.equal(searched.matches.length, 1);

  const source = await tools.read_source({ target: 'com.demo.OrderService' });
  assert.equal(source.found, true);
  assert.match(source.content, /IllegalArgumentException/);

  const found = await tools.search_source({ keyword: 'IllegalArgumentException' });
  assert.ok(found.matches.length >= 1);
});

test('oversized tool results spill to disk and can be read back', async (t) => {
  t.after(async () => { await rm(RUN_DIR, { recursive: true, force: true }); });
  const { tools } = build(80);
  const spilled = await tools.get_logs({});
  assert.equal(spilled.spilled, true);
  assert.match(spilled.file, /^evidence\//);
  const slice = await tools.read({ file: spilled.file });
  assert.match(slice.content, /"records"/);
  assert.ok(slice.totalLines > 0);

  const denied = await tools.read({ file: '../../etc/passwd' });
  assert.equal(denied.error, true);
  assert.equal(denied.code, 'READ_OUT_OF_SCOPE');
});

test('reads and searches frontend source with root=frontend', async (t) => {
  t.after(async () => { await rm(RUN_DIR, { recursive: true, force: true }); });
  const frontendSourceRoot = path.join(FIXTURES, 'frontend');
  const calls = [];
  const { tools } = createTools({
    scenario,
    anchor,
    runDir: RUN_DIR,
    window,
    frontendSourceRoot,
    onCall: (event) => calls.push(event),
  });

  const source = await tools.read_source({ root: 'frontend', target: 'src/App.vue' });
  assert.equal(source.found, true);
  assert.match(source.content, /inventory ui boom/);

  const found = await tools.search_source({ root: 'frontend', keyword: 'inventory ui boom' });
  assert.ok(found.matches.length >= 1);
  assert.equal(calls[0].stage, 'start');
  assert.equal(calls[0].name, 'read_source');
  assert.ok(calls.some((call) => call.stage === 'done' && call.name === 'read_source'));
});

test('reads additional backend roots only when authorized', async (t) => {
  t.after(async () => { await rm(RUN_DIR, { recursive: true, force: true }); });
  const { tools } = createTools({
    scenario,
    anchor,
    runDir: RUN_DIR,
    window,
    extraSourceRoots: [{ id: 'extra-1', root: SOURCE }],
  });

  const source = await tools.read_source({
    root: 'extra',
    extraRoot: 'extra-1',
    target: 'com/demo/OrderService.java',
  });
  assert.equal(source.found, true);
  assert.match(source.content, /IllegalArgumentException/);

  const denied = await tools.read_source({
    root: 'extra',
    extraRoot: 'missing',
    target: 'com/demo/OrderService.java',
  });
  assert.equal(denied.error, true);
  assert.equal(denied.code, 'EXTRA_SOURCE_ROOT_REQUIRED');
});

test('redacts secrets from tool results, spilled records and call summaries', async (t) => {
  t.after(async () => { await rm(RUN_DIR, { recursive: true, force: true }); });
  const secret = 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz';
  const { tools, calls } = createTools({
    scenario,
    anchor,
    runDir: RUN_DIR,
    window,
    runCommand: async () => ({
      ok: true,
      output: `ANTHROPIC_AUTH_TOKEN=${secret}\nDB_PASSWORD=hunter2secret`,
    }),
  });

  const ran = await tools.run_command({ command: 'npm test' });
  assert.match(ran.output, /ANTHROPIC_AUTH_TOKEN=<redacted>/);
  assert.match(ran.output, /DB_PASSWORD=<redacted>/);
  assert.doesNotMatch(ran.output, /abcdefghijklmnopqrstuvwxyz|hunter2secret/);

  const callText = JSON.stringify(calls);
  assert.doesNotMatch(callText, /abcdefghijklmnopqrstuvwxyz|hunter2secret/);
  assert.match(callText, /ANTHROPIC_AUTH_TOKEN=<redacted>/);
});
