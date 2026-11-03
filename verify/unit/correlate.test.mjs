import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { correlateLogs, extractBusinessIds, extractTraceId } from '../../src/evidence/correlate.mjs';
import { parseTimestamp } from '../../src/evidence/parsers.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LOGS = path.resolve(HERE, '../fixtures/logs');
const logback = path.join(LOGS, 'logback.log');
const business = path.join(LOGS, 'business.log');
const anchor = parseTimestamp('2026-11-02 19:30:01.000');
const window = { beforeMs: 5000, afterMs: 5000 };

test('extracts business ids from bodies and query strings', () => {
  const ids = extractBusinessIds({
    request: { url: 'http://localhost:8080/api/order?requestId=REQ-778899', body: '{"orderId":"ORD123456","qty":2}' },
    response: { body: '{"traceNo":"TRACE-1234"}' },
  });
  assert.ok(ids.includes('ORD123456'));
  assert.ok(ids.includes('REQ-778899'));
  assert.ok(ids.includes('TRACE-1234'));
  assert.equal(ids.includes('2'), false);
});

test('extracts trace ids only from headers that carry them', () => {
  assert.equal(extractTraceId({}, {}), null);
  assert.equal(extractTraceId({ 'X-Trace-Id': 'abc' }, {}), 'abc');
  assert.equal(extractTraceId({}, { traceparent: '00-abc-def-01' }), '00-abc-def-01');
});

test('layer 1: marker wins when present', async () => {
  const result = await correlateLogs({
    logfiles: [logback],
    parser: { preset: 'logback' },
    anchor,
    window,
    marker: 'dcprobeaaa111',
  });
  assert.equal(result.strategy, 'marker');
  assert.equal(result.result.records.length, 1);
});

test('layer 2: time window + thread', async () => {
  const result = await correlateLogs({
    logfiles: [logback],
    parser: { preset: 'logback' },
    anchor,
    window,
    thread: 'http-nio-8080-exec-1',
  });
  assert.equal(result.strategy, 'window-thread');
  assert.ok(result.result.records.every((record) => record.thread === 'http-nio-8080-exec-1'));
});

test('layer 3: business id correlates across threads', async () => {
  const result = await correlateLogs({
    logfiles: [business],
    parser: { preset: 'logback' },
    anchor,
    window,
    businessIds: ['ORD123456'],
  });
  assert.equal(result.strategy, 'business-id');
  assert.equal(result.matchedId, 'ORD123456');
  assert.deepEqual(
    result.result.records.map((record) => record.thread).sort(),
    ['thread-a', 'thread-b'],
  );
});

test('trace id is a fallback, not the primary path', async () => {
  const result = await correlateLogs({
    logfiles: [business],
    parser: { preset: 'logback' },
    anchor,
    window,
    businessIds: [],
    traceId: 'trace-abc-123',
  });
  assert.equal(result.strategy, 'trace-id');
  assert.equal(result.matchedId, 'trace-abc-123');
});

test('falls back to time window and reports none when empty', async () => {
  const windowed = await correlateLogs({
    logfiles: [logback],
    parser: { preset: 'logback' },
    anchor,
    window,
  });
  assert.equal(windowed.strategy, 'time-window');
  assert.ok(windowed.result.records.length > 0);

  const empty = await correlateLogs({
    logfiles: [],
    parser: { preset: 'logback' },
    anchor,
    window,
  });
  assert.equal(empty.strategy, 'none');
  assert.equal(empty.result.records.length, 0);
});
