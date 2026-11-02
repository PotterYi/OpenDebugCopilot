import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readLogs, listThreads, searchAll } from '../../src/evidence/logs.mjs';
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

test('auto detection failure reports a stable code', async () => {
  await assert.rejects(
    readLogs({ logfiles: [garbage] }),
    (err) => err.code === 'LOG_PARSER_DETECT_FAILED' && err.exitCode === 3,
  );
});

test('no logfiles yields an empty result', async () => {
  const result = await readLogs({ logfiles: [] });
  assert.equal(result.parser, 'none');
  assert.equal(result.records.length, 0);
  assert.equal(result.files.length, 0);
});
