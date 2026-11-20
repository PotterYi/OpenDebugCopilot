import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { parseScenario } from '../../src/core/scenario.mjs';
import { createTools } from '../../src/tools/index.mjs';
import { parseTimestamp } from '../../src/evidence/parsers.mjs';
import { AppError } from '../../src/core/errors.mjs';
import { tempDir } from './tmp.mjs';
import { MAX_TOOL_RESULT_BYTES } from '../../src/core/tool-limits.mjs';

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

test('source tools read config, paginate and redact secrets', async (t) => {
  t.after(async () => { await rm(RUN_DIR, { recursive: true, force: true }); });
  const { tools } = build();

  const pom = await tools.read_source({ target: 'pom.xml' });
  assert.equal(pom.found, true);
  assert.match(pom.content, /demo-parent/);

  const yml = await tools.read_source({ target: 'src/main/resources/application-prod.yml' });
  assert.equal(yml.found, true);
  assert.doesNotMatch(yml.content, /demo-secret/);
  assert.match(yml.content, /<redacted>/);

  const first = await tools.search_source({ keyword: 'class', limit: 1 });
  assert.equal(first.offset, 0);
  assert.equal(first.limit, 1);
  assert.equal(first.matches.length, 1);
  assert.ok(first.totalCount >= 3);
  assert.equal(first.nextOffset, 1);
  assert.equal(first.truncated, true);
  assert.equal(first.hasMore, true);
  assert.deepEqual(first.fields, ['matches']);
  assert.ok(first.file);

  const spilled = await tools.query_result({ file: first.file, field: 'matches', offset: 2, limit: 1 });
  assert.equal(spilled.offset, 2);
  assert.equal(spilled.items.length, 1);
  assert.ok(spilled.total >= 3);

  const second = await tools.search_source({ keyword: 'class', limit: 1, offset: 1 });
  assert.equal(second.offset, 1);
  assert.notDeepEqual(second.matches, first.matches);

  const regex = await tools.search_source({ keyword: 'Illegal[A-Za-z]+Exception', regex: true });
  assert.ok(regex.matches.length >= 1);

  const secret = await tools.search_source({ keyword: 'demo-secret' });
  assert.ok(secret.matches.length >= 1);
  assert.doesNotMatch(secret.matches[0].text, /demo-secret/);
  assert.match(secret.matches[0].text, /<redacted>/);

  const unsafe = await tools.search_source({ keyword: '(a+)+$', regex: true });
  assert.equal(unsafe.error, true);
  assert.equal(unsafe.code, 'SOURCE_REGEX_UNSAFE');
  assert.ok(unsafe.hint);
});

test('oversized tool results spill to disk and can be read back', async (t) => {
  t.after(async () => { await rm(RUN_DIR, { recursive: true, force: true }); });
  const { tools } = build(512);
  const spilled = await tools.get_logs({});
  assert.match(spilled.file, /^evidence\//);
  const saved = await readFile(path.join(RUN_DIR, spilled.file), 'utf8');
  assert.match(saved, /"records"/);
  assert.ok(saved.length > 0);

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

test('returns usage on boundary errors and escalates repeated failures', async (t) => {
  t.after(async () => { await rm(RUN_DIR, { recursive: true, force: true }); });
  let attempts = 0;
  const { tools, calls } = createTools({
    scenario,
    anchor,
    runDir: RUN_DIR,
    window,
    runCommand: async ({ command }) => {
      attempts += 1;
      if (attempts <= 2 || attempts >= 4) {
        throw new AppError('COMMAND_DENIED', '命令不在允许的编译/测试工具链内', {
          exitCode: 2,
          details: { reason: 'toolchain', examples: ['mvn -q -DskipTests compile'] },
        });
      }
      return { ok: true, command, output: 'ok' };
    },
  });

  const first = await tools.run_command({ command: 'print password=hunter2secret' });
  assert.equal(first.error, true);
  assert.ok(first.usage.includes('mvn -q -DskipTests compile'));
  assert.match(first.hint, /构建\/测试/);
  assert.equal(first.guardrail, undefined);

  const second = await tools.run_command({ command: 'echo again' });
  assert.equal(second.guardrail.repeated, 2);
  assert.ok(second.guardrail.usage.includes('mvn -q -DskipTests compile'));

  const ok = await tools.run_command({ command: 'mvn test' });
  assert.equal(ok.ok, true);

  const afterSuccess = await tools.run_command({ command: 'print once more' });
  assert.equal(afterSuccess.guardrail, undefined);
  assert.doesNotMatch(JSON.stringify(calls), /hunter2secret/);

  const readFirst = await tools.read({ file: '../outside.txt' });
  assert.ok(readFirst.usage.some((item) => item.includes('list_dir')));
  const readSecond = await tools.read({ file: '../outside-2.txt' });
  assert.equal(readSecond.guardrail.repeated, 2);
  assert.ok(readSecond.guardrail.usage.some((item) => item.includes('read_source')));
});

test('ensureSpill guarantees a file pointer for every oversized result', async (t) => {
  t.after(async () => { await rm(RUN_DIR, { recursive: true, force: true }); });
  const bundle = build(1_000_000);
  const small = await bundle.ensureSpill('test', { text: 'ok' });
  assert.equal(small.spilled, undefined);

  const ascii = await bundle.ensureSpill('test', { text: 'x'.repeat(MAX_TOOL_RESULT_BYTES) });
  assert.equal(ascii.spilled, true);
  assert.ok(ascii.bytes > MAX_TOOL_RESULT_BYTES);
  const file = path.join(RUN_DIR, ascii.file);
  const saved = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(saved.text.length, MAX_TOOL_RESULT_BYTES);

  const multibyte = await bundle.ensureSpill('test', { text: '中'.repeat(8000) });
  assert.equal(multibyte.spilled, true);
  assert.ok(multibyte.bytes > MAX_TOOL_RESULT_BYTES);
});
