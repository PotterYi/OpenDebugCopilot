import { AppError } from '../core/errors.mjs';
import { discoverLogFiles, readLines, sampleLines } from './logfiles.mjs';
import { detectParserFromLines, isContinuationLine, levelRank, resolveParser } from './parsers.mjs';

const DEFAULT_MAX_BYTES = 32 * 1024 * 1024;
const SAMPLE_LINES = 2000;
const EARLY_STOP_SLACK_MS = 5000;

function normalizeRecord(parsed) {
  return {
    ts: parsed.ts ?? null,
    level: parsed.level ?? null,
    thread: parsed.thread ?? null,
    logger: parsed.logger ?? null,
    message: parsed.message ?? '',
    stack: Array.isArray(parsed.stack) ? [...parsed.stack] : [],
  };
}

/**
 * Resolve files and parser. Auto-detection samples the head of the files and
 * requires >60% hits with zero unparseable non-continuation lines.
 *
 * @param {{ logfiles?: string[], parser?: any, encoding?: string, maxBytesPerFile?: number }} options
 */
export async function resolveLogParser({ logfiles = [], parser = { preset: 'auto' }, encoding = 'auto', maxBytesPerFile = DEFAULT_MAX_BYTES } = {}) {
  const files = await discoverLogFiles(logfiles);
  if (files.length === 0) {
    return { files, parserName: 'none', parser: null };
  }

  const spec = resolveParser(parser);
  if (spec.name !== 'auto') {
    return { files, parserName: spec.name, parser: spec };
  }

  const perFile = Math.max(50, Math.ceil(SAMPLE_LINES / files.length));
  const samples = [];
  for (const file of files) {
    samples.push(...(await sampleLines(file.path, perFile, { encoding, maxBytes: maxBytesPerFile })));
    if (samples.length >= SAMPLE_LINES) break;
  }
  const detected = detectParserFromLines(samples);
  if (!detected) {
    throw new AppError(
      'LOG_PARSER_DETECT_FAILED',
      'Cannot auto-detect log format: no preset exceeds 60% hit rate with all lines parseable',
      { exitCode: 3, details: { files: files.map((f) => f.path), presets: ['json-lines', 'logback', 'node'] } },
    );
  }
  return { files, parserName: detected, parser: resolveParser({ preset: detected }) };
}

/**
 * Create a scanner over all files. Records aggregate continuation lines
 * (stack traces) into the preceding entry.
 *
 * @param {{ logfiles?: string[], parser?: any, encoding?: string, maxBytesPerFile?: number }} [options]
 */
export async function createLogScanner(options = {}) {
  const { files, parserName, parser } = await resolveLogParser(options);
  const { encoding = 'auto', maxBytesPerFile = DEFAULT_MAX_BYTES } = options;
  const stats = { files: files.length, lines: 0, parsed: 0, continuations: 0, unparsed: 0 };

  async function* iterate() {
    if (!parser) return;
    for (const file of files) {
      let current = null;
      for await (const { line, lineNo } of readLines(file.path, { encoding, maxBytes: maxBytesPerFile })) {
        stats.lines += 1;
        if (!line.trim()) continue;
        const parsed = parser.parse(line);
        if (parsed) {
          if (current) yield current;
          current = {
            ...normalizeRecord(parsed),
            file: file.path,
            lineNo,
            endLineNo: lineNo,
            raw: line,
          };
          stats.parsed += 1;
        } else if (isContinuationLine(line, current !== null)) {
          if (current) {
            current.stack.push(line);
            current.raw += `\n${line}`;
            current.endLineNo = lineNo;
            stats.continuations += 1;
          }
        } else {
          stats.unparsed += 1;
        }
      }
      if (current) yield current;
    }
  }

  return { files, parserName, stats, records: iterate() };
}

function inWindow(ts, anchor, window) {
  if (!window) return true;
  if (ts === null) return true; // timestamp unknown: keep, caller can flag
  return ts >= anchor - window.beforeMs && ts <= anchor + window.afterMs;
}

function matchesRecord(record, { marker, keyword, level, minLevel, thread }) {
  if (marker && !record.raw.includes(marker)) return false;
  if (keyword && !record.raw.toLowerCase().includes(keyword.toLowerCase())) return false;
  if (level && record.level !== level) return false;
  if (minLevel && levelRank(record.level) < levelRank(minLevel)) return false;
  if (thread && record.thread !== thread) return false;
  return true;
}

/**
 * Query logs inside a time window.
 *
 * @param {{
 *   logfiles?: string[], parser?: any, encoding?: string,
 *   anchor?: number, window?: { beforeMs: number, afterMs: number },
 *   marker?: string, keyword?: string, level?: string, minLevel?: string,
 *   thread?: string, limit?: number, maxBytesPerFile?: number, earlyStop?: boolean
 * }} [options]
 */
export async function readLogs(options = {}) {
  const {
    anchor = Date.now(),
    window,
    limit = 200,
    earlyStop = true,
  } = options;
  const scanner = await createLogScanner(options);
  const records = [];
  let truncated = false;
  let stoppedEarly = false;
  const windowEnd = window ? anchor + window.afterMs : null;

  for await (const record of scanner.records) {
    if (earlyStop && windowEnd !== null && record.ts !== null && record.ts > windowEnd + EARLY_STOP_SLACK_MS) {
      stoppedEarly = true;
      break;
    }
    if (!inWindow(record.ts, anchor, window)) continue;
    if (!matchesRecord(record, options)) continue;
    records.push(record);
    if (records.length >= limit) {
      truncated = true;
      break;
    }
  }

  return {
    records,
    parser: scanner.parserName,
    files: scanner.files.map((f) => f.path),
    stats: scanner.stats,
    truncated,
    stoppedEarly,
  };
}

/**
 * Thread histogram for a time window.
 *
 * @param {Parameters<typeof readLogs>[0]} [options]
 */
export async function listThreads(options = {}) {
  const { anchor = Date.now(), window, maxRecords = 200000 } = options;
  const scanner = await createLogScanner(options);
  const counts = new Map();
  let scanned = 0;
  let stoppedEarly = false;
  const windowEnd = window ? anchor + window.afterMs : null;

  for await (const record of scanner.records) {
    if (windowEnd !== null && record.ts !== null && record.ts > windowEnd + EARLY_STOP_SLACK_MS) {
      stoppedEarly = true;
      break;
    }
    if (!inWindow(record.ts, anchor, window)) continue;
    const key = record.thread ?? '(unknown)';
    counts.set(key, (counts.get(key) ?? 0) + 1);
    scanned += 1;
    if (scanned >= maxRecords) break;
  }

  const threads = [...counts.entries()]
    .map(([thread, count]) => ({ thread, count }))
    .sort((a, b) => b.count - a.count || a.thread.localeCompare(b.thread));

  return {
    threads,
    total: scanned,
    parser: scanner.parserName,
    files: scanner.files.map((f) => f.path),
    stats: scanner.stats,
    stoppedEarly,
  };
}

/**
 * Full-text search across all declared logs, ignoring the time window.
 * Intended for "logged only once" hints (e.g. a single degradation warning).
 *
 * @param {Parameters<typeof readLogs>[0]} [options]
 */
export async function searchAll(options = {}) {
  const { keyword, limit = 200 } = options;
  if (!keyword || typeof keyword !== 'string') {
    throw new AppError('LOG_KEYWORD_REQUIRED', 'searchAll requires a non-empty keyword', { exitCode: 2 });
  }
  const scanner = await createLogScanner(options);
  const matches = [];
  for await (const record of scanner.records) {
    if (!matchesRecord(record, { keyword })) continue;
    matches.push(record);
    if (matches.length >= limit) break;
  }
  return {
    matches,
    keyword,
    truncated: matches.length >= limit,
    parser: scanner.parserName,
    files: scanner.files.map((f) => f.path),
    stats: scanner.stats,
  };
}
