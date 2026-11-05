import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeLevel,
  parseTimestamp,
  resolveParser,
  detectParserFromLines,
  detectParserDetailed,
} from '../../src/evidence/parsers.mjs';

test('normalizes level aliases', () => {
  assert.equal(normalizeLevel('info'), 'INFO');
  assert.equal(normalizeLevel('WARNING'), 'WARN');
  assert.equal(normalizeLevel('err'), 'ERROR');
  assert.equal(normalizeLevel('nope'), null);
});

test('parses common timestamp formats', () => {
  const local = new Date('2026-11-02T19:30:12.345').getTime();
  assert.equal(parseTimestamp('2026-11-02 19:30:12.345'), local);
  assert.equal(parseTimestamp('2026-11-02T19:30:12.345'), local);
  assert.equal(parseTimestamp(1762111812), 1762111812000);
  assert.equal(parseTimestamp(1762111812345), 1762111812345);
  assert.equal(parseTimestamp('not-a-time'), null);
});

test('custom regex parser reads named groups', () => {
  const pattern = String.raw`^(?<ts>\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3})\s+(?<level>\w+)\s+\[(?<thread>[^\]]+)\]\s+(?<message>.*)$`;
  const parser = resolveParser({ regex: pattern });
  const record = parser.parse('2026-11-02 19:30:00.000 INFO [main] hello');
  assert.equal(record.level, 'INFO');
  assert.equal(record.thread, 'main');
  assert.equal(record.message, 'hello');
  assert.equal(typeof record.ts, 'number');
});

test('auto detection requires >60% hits and no unparsed lines', () => {
  const logback = [
    '2026-11-02 19:30:00.000  INFO 1 --- [main] a.B : ok',
    '2026-11-02 19:30:01.000 ERROR 1 --- [main] a.B : bad',
    '\tat com.demo.X.y(X.java:1)',
  ];
  assert.equal(detectParserFromLines(logback), 'logback');

  const json = ['{"time":"2026-11-02 19:30:00.000","level":"INFO","message":"ok"}'];
  assert.equal(detectParserFromLines(json), 'json-lines');

  const springBoot = ['2026-11-02 19:30:00.000 [main] INFO  c.r.RuoYiApplication - [logStarting,53] - Starting RuoYiApplication'];
  assert.equal(detectParserFromLines(springBoot), 'spring-boot');
  const parsed = resolveParser({ preset: 'spring-boot' }).parse(springBoot[0]);
  assert.equal(parsed.level, 'INFO');
  assert.equal(parsed.thread, 'main');
  assert.match(parsed.message, /Starting RuoYiApplication/);

  const pipe = ['2026-11-02 19:30:00.000|INFO|main|com.demo.OrderService|create order | id=1'];
  assert.equal(detectParserFromLines(pipe), 'pipe');
  const pipeParsed = resolveParser({ preset: 'pipe' }).parse(pipe[0]);
  assert.equal(pipeParsed.level, 'INFO');
  assert.equal(pipeParsed.thread, 'main');
  assert.equal(pipeParsed.logger, 'com.demo.OrderService');
  assert.match(pipeParsed.message, /create order \| id=1/);

  const node = ['2026-11-02T19:30:00.000Z INFO [main] ok'];
  assert.equal(detectParserFromLines(node), 'node');

  const polluted = [...logback, 'random junk line'];
  assert.equal(detectParserFromLines(polluted), null);

  const detailed = detectParserDetailed(polluted);
  assert.equal(detailed.selected, 'logback');
  assert.equal(detailed.fallback, true);
  assert.equal(detailed.selectedCandidate.unparsed, 1);
  assert.equal(detailed.selectedCandidate.unparsedSamples.length, 1);
});
