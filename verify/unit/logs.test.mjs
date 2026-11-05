import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readLogs, listThreads, searchAll } from '../../src/evidence/logs.mjs';
import { discoverLogFiles, sampleLines } from '../../src/evidence/logfiles.mjs';
import { mkdir, rm, utimes, writeFile } from 'node:fs/promises';
import { tempDir } from './tmp.mjs';
import { parseTimestamp } from '../../src/evidence/parsers.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LOGS = path.resolve(HERE, '../fixtures/logs');
const logback = path.join(LOGS, 'logback.log');
const jsonLog = path.join(LOGS, 'json.log');
const nodeLog = path.join(LOGS, 'node.log');
const gbkLog = path.join(LOGS, 'gbk.log');
const garbage = path.join(LOGS, 'garbage.log');
const rotated = path.join(LOGS, 'rotated/app.log');

test('auto-detects logback and aggregates stack lines', async () => {
  const result = await readLogs({ logfiles: [logback], limit: 10 });
  assert.equal(result.parser, 'logback');
  assert.equal(result.records.length, 4);
  const error = result.records.find((r) => r.level === 'ERROR');
  assert.equal(error.thread, 'http-nio-8080-exec-1');
  assert.equal(error.stack.length, 5);
  assert.match(error.stack[0], /IllegalStateException/);
  assert.match(error.stack[3], /Caused by/);
  assert.match(error.raw, /Caused by/);
});

test('filters by time window', async () => {
  const anchor = parseTimestamp('2026-11-02 19:30:02.000');
  const result = await readLogs({
    logfiles: [logback],
    anchor,
    window: { beforeMs: 3000, afterMs: 1000 },
  });
  assert.equal(result.records.length, 2);
  assert.deepEqual(result.records.map((r) => r.level), ['INFO', 'ERROR']);
});

test('filters by level, thread, marker and minLevel', async () => {
  const byLevel = await readLogs({ logfiles: [logback], level: 'ERROR' });
  assert.equal(byLevel.records.length, 1);

  const byThread = await readLogs({ logfiles: [logback], thread: 'http-nio-8080-exec-1' });
  assert.equal(byThread.records.length, 2);

  const byMarker = await readLogs({ logfiles: [logback], marker: 'dcprobeaaa111' });
  assert.equal(byMarker.records.length, 1);

  const byMinLevel = await readLogs({ logfiles: [logback], minLevel: 'WARN' });
  assert.deepEqual(byMinLevel.records.map((r) => r.level).sort(), ['ERROR', 'WARN']);
});

test('thread histogram counts records in window', async () => {
  const result = await listThreads({ logfiles: [logback] });
  assert.equal(result.total, 4);
  assert.deepEqual(result.threads, [
    { thread: 'http-nio-8080-exec-1', count: 2 },
    { thread: 'http-nio-8080-exec-2', count: 1 },
    { thread: 'scheduling-1', count: 1 },
  ]);
});

test('full-text search ignores time window and is case-insensitive', async () => {
  const result = await searchAll({ logfiles: [logback], keyword: 'DEGRADED' });
  assert.equal(result.matches.length, 1);
  assert.match(result.matches[0].message, /fallback to legacy path/);
});

test('discovers rotated sibling files and scans oldest first', async () => {
  const result = await readLogs({ logfiles: [rotated], parser: { preset: 'logback' } });
  assert.equal(result.files.length, 2);
  assert.equal(result.records.length, 2);
  assert.match(result.records[0].message, /degrade log seen only once/);
  assert.match(result.records[1].message, /new file/);
});

test('decodes GBK logs with iconv-lite', async () => {
  const result = await readLogs({ logfiles: [gbkLog], limit: 10 });
  assert.equal(result.parser, 'logback');
  assert.equal(result.records.length, 2);
  assert.match(result.records[0].message, /订单创建成功/);
  assert.equal(result.records[0].thread, '主线程');
  assert.match(result.records[1].stack[0], /Service\.create/);
});

test('explicit JSON-lines preset parses stack field', async () => {
  const result = await readLogs({ logfiles: [jsonLog], parser: { preset: 'json-lines' } });
  assert.equal(result.records.length, 3);
  const error = result.records.find((r) => r.level === 'ERROR');
  assert.equal(error.stack.length, 3);
  assert.equal(error.thread, 'http-1');
});

test('explicit node preset tolerates missing thread', async () => {
  const result = await readLogs({ logfiles: [nodeLog], parser: { preset: 'node' } });
  assert.equal(result.records.length, 3);
  assert.equal(result.records[2].thread, null);
  assert.match(result.records[2].message, /single warning/);
});

test('auto detection falls back to raw text instead of failing', async () => {
  const result = await readLogs({ logfiles: [garbage] });
  assert.equal(result.parser, 'raw');
  assert.equal(result.parserFallback, true);
  assert.match(result.parserWarning, /原始文本/);
  assert.equal(result.records.length, 2);
  assert.match(result.records[0].message, /hello world/);
});

test('auto detection ignores a partial last line in small files', async (t) => {
  const dir = tempDir('partial-log');
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  t.after(async () => { await rm(dir, { recursive: true, force: true }); });
  const file = path.join(dir, 'app.log');
  const content = [
    '2026-11-02 19:30:00.000  INFO 1 --- [main] a.B : first',
    '2026-11-02 19:30:01.000 ERROR 1 --- [main] a.B : second',
    'half-written-line-without-newline',
  ].join('\n');
  await writeFile(file, content, 'utf8');

  const result = await readLogs({ logfiles: [file] });
  assert.equal(result.parser, 'logback');
  assert.equal(result.parserFallback, false);
  assert.equal(result.records.length, 2);
});

test('auto detection keeps the best effort preset when one line is unparseable', async (t) => {
  const dir = tempDir('fallback-log');
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  t.after(async () => { await rm(dir, { recursive: true, force: true }); });
  const file = path.join(dir, 'app.log');
  await writeFile(file, [
    '2026-11-02 19:30:00.000  INFO 1 --- [main] a.B : first',
    'random junk line',
    '2026-11-02 19:30:01.000 ERROR 1 --- [main] a.B : second',
    '2026-11-02 19:30:02.000  WARN 1 --- [main] a.B : third',
    '',
  ].join('\n'), 'utf8');

  const result = await readLogs({ logfiles: [file] });
  assert.equal(result.parser, 'logback');
  assert.equal(result.parserFallback, true);
  assert.match(result.parserWarning, /降级/);
  assert.equal(result.parserDetection.selectedCandidate.unparsed, 1);
});

test('sampleLines drops an unterminated last line', async (t) => {
  const dir = tempDir('sample-lines');
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  t.after(async () => { await rm(dir, { recursive: true, force: true }); });
  const file = path.join(dir, 'sample.log');
  await writeFile(file, 'a\nb\npartial', 'utf8');
  assert.deepEqual(await sampleLines(file, 2000), ['a', 'b']);
  assert.deepEqual(await sampleLines(file, 2), ['a', 'b']);
});

test('no logfiles yields an empty result', async () => {
  const result = await readLogs({ logfiles: [] });
  assert.equal(result.parser, 'none');
  assert.equal(result.records.length, 0);
  assert.equal(result.files.length, 0);
});

test('orders rotated files by modification time', async (t) => {
  const dir = tempDir('rotated-mtime');
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  t.after(async () => { await rm(dir, { recursive: true, force: true }); });

  const older = path.join(dir, 'app.log.1');
  const newer = path.join(dir, 'app.log');
  const nl = String.fromCharCode(10);
  await writeFile(older, '2026-11-02 19:30:00.000  INFO 1 --- [t] a.B : older-file' + nl, 'utf8');
  await writeFile(newer, '2026-11-02 19:30:05.000  INFO 1 --- [t] a.B : newer-file' + nl, 'utf8');

  const base = Date.now() - 60_000;
  await utimes(older, new Date(base), new Date(base));
  await utimes(newer, new Date(base + 30_000), new Date(base + 30_000));

  const files = await discoverLogFiles([newer]);
  assert.deepEqual(files.map((file) => path.basename(file.path)), ['app.log.1', 'app.log']);

  const result = await readLogs({ logfiles: [newer], parser: { preset: 'logback' } });
  assert.deepEqual(result.records.map((record) => record.message), ['older-file', 'newer-file']);
});

test('tail mode returns the most recent records instead of the oldest', async () => {
  const tailed = await readLogs({ logfiles: [logback], parser: { preset: 'logback' }, tail: true, limit: 2 });
  assert.equal(tailed.records.length, 2);
  assert.deepEqual(tailed.records.map((record) => record.level), ['WARN', 'INFO']);
  assert.match(tailed.records[1].message, /tick/);
  assert.equal(tailed.truncated, true);

  const head = await readLogs({ logfiles: [logback], parser: { preset: 'logback' }, limit: 2 });
  assert.deepEqual(head.records.map((record) => record.level), ['INFO', 'ERROR']);
});
