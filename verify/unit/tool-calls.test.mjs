import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeToolCalls } from '../../src/core/tool-calls.mjs';

test('read_source keeps arguments only, never the source body', () => {
  const summary = summarizeToolCalls([{
    name: 'read_source',
    args: { target: 'com/demo/OrderService.java', root: 'backend', startLine: 1, endLine: 20 },
    result: { found: true, content: 'SECRET SOURCE BODY', relativePath: 'com/demo/OrderService.java' },
  }]);
  assert.deepEqual(summary.calls[0], {
    name: 'read_source',
    args: { target: 'com/demo/OrderService.java', root: 'backend', startLine: 1, endLine: 20 },
  });
  assert.equal(JSON.stringify(summary).includes('SECRET SOURCE BODY'), false);
});

test('search_source keeps path:line hits and drops match text', () => {
  const summary = summarizeToolCalls([{
    name: 'search_source',
    args: { keyword: 'IllegalArgumentException', root: 'backend' },
    result: {
      matches: [
        { path: 'com/demo/OrderService.java', line: 5, text: 'SECRET MATCH TEXT' },
        { path: 'com/demo/Other.java', line: 9, text: 'ANOTHER SECRET' },
      ],
      scanned: 2,
      truncated: false,
    },
  }]);
  assert.deepEqual(summary.calls[0].hits, [
    { path: 'com/demo/OrderService.java', line: 5 },
    { path: 'com/demo/Other.java', line: 9 },
  ]);
  assert.equal(JSON.stringify(summary).includes('SECRET'), false);
});

test('get_logs and search_log keep a truncated digest', () => {
  const longMessage = 'x'.repeat(500);
  const summary = summarizeToolCalls([
    {
      name: 'get_logs',
      args: { keyword: 'boom' },
      result: {
        records: Array.from({ length: 12 }, (_, index) => ({
          ts: index,
          level: 'ERROR',
          thread: 'main',
          logger: 'a.B',
          message: index === 11 ? longMessage : `line ${index}`,
          stack: ['SECRET STACK'],
        })),
        stats: { lines: 20, parsed: 12, unparsed: 0 },
        parser: 'logback',
        truncated: true,
      },
    },
    {
      name: 'search_log',
      args: { keyword: 'boom' },
      result: {
        matches: [{ ts: 1, level: 'ERROR', message: 'match', stack: ['SECRET STACK'] }],
        parser: 'logback',
      },
    },
  ]);
  const logs = summary.calls[0];
  assert.equal(logs.count, 12);
  assert.equal(logs.records.length, 10);
  assert.equal(logs.omitted, 2);
  assert.equal(logs.parser, 'logback');
  assert.deepEqual(logs.stats, { lines: 20, parsed: 12, unparsed: 0 });
  assert.ok(logs.records.some((record) => record.message.length === 301));
  assert.equal(JSON.stringify(summary).includes('SECRET STACK'), false);

  const search = summary.calls[1];
  assert.equal(search.name, 'search_log');
  assert.equal(search.records.length, 1);
  assert.equal(search.records[0].message, 'match');
});

test('spilled tool results keep only the pointer and preview', () => {
  const summary = summarizeToolCalls([{
    name: 'get_logs',
    args: {},
    result: { spilled: true, file: 'evidence/tool-001.json', bytes: 9000, preview: 'P'.repeat(500) },
  }]);
  assert.equal(summary.calls[0].spilled, true);
  assert.equal(summary.calls[0].file, 'evidence/tool-001.json');
  assert.equal(summary.calls[0].preview.length, 201);
  assert.equal(summary.calls[0].records, undefined);
});

test('caps the number of remembered calls', () => {
  const calls = Array.from({ length: 25 }, (_, index) => ({
    name: 'read_source',
    args: { target: `File${index}.java` },
    result: { content: 'body' },
  }));
  const summary = summarizeToolCalls(calls, { maxCalls: 20 });
  assert.equal(summary.calls.length, 20);
  assert.equal(summary.omitted, 5);
  assert.equal(summary.calls[0].args.target, 'File5.java');
});
