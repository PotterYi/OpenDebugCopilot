/**
 * Log line parsers.
 * A parser turns one line into a record skeleton:
 *   { ts, level, thread, logger, message, stack }
 * Unknown/irrelevant fields stay null. Continuation lines are handled by the scanner.
 */

const LEVELS = ['TRACE', 'DEBUG', 'INFO', 'WARN', 'ERROR', 'FATAL'];
const LEVEL_RANK = Object.freeze(Object.fromEntries(LEVELS.map((l, i) => [l, i])));

const LEVEL_ALIASES = Object.freeze({
  WARNING: 'WARN',
  ERR: 'ERROR',
  CRITICAL: 'FATAL',
  CRIT: 'FATAL',
});

/** @param {unknown} value */
export function normalizeLevel(value) {
  if (value === undefined || value === null) return null;
  const upper = String(value).trim().toUpperCase();
  const normalized = LEVEL_ALIASES[upper] ?? upper;
  return normalized in LEVEL_RANK ? normalized : null;
}

/** @param {string | null} level */
export function levelRank(level) {
  return level && level in LEVEL_RANK ? LEVEL_RANK[level] : -1;
}

/**
 * Parse common timestamp formats into epoch milliseconds.
 * Supports epoch seconds/millis, ISO strings, and "YYYY-MM-DD HH:mm:ss.SSS" local time.
 *
 * @param {unknown} value
 * @returns {number | null}
 */
export function parseTimestamp(value) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value < 1e12 ? Math.round(value * 1000) : Math.round(value);
  }
  const raw = String(value).trim();
  if (/^\d{10}$/.test(raw)) return Number(raw) * 1000;
  if (/^\d{13}$/.test(raw)) return Number(raw);
  const normalized = raw.replace(',', '.');
  const local = normalized.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2}(?:\.\d+)?)$/);
  if (local) {
    return new Date(`${local[1]}T${local[2]}`).getTime();
  }
  const parsed = Date.parse(normalized);
  return Number.isNaN(parsed) ? null : parsed;
}

/**
 * Heuristic used while aggregating multi-line entries.
 *
 * @param {string} line
 * @param {boolean} hasCurrent
 */
const EXCEPTION_HEADER = /^(?:[A-Za-z_$][\w.$]*\.)*[A-Za-z_$][\w$]*(?:Exception|Error)(?::|\b)/;

export function isContinuationLine(line, hasCurrent) {
  if (!hasCurrent) return false;
  if (/^\s/.test(line)) return true;
  if (/^Caused by:/.test(line)) return true;
  if (/^\.\.\.\s*\d+\s+more/.test(line)) return true;
  if (EXCEPTION_HEADER.test(line)) return true;
  return false;
}

function pick(object, keys) {
  for (const key of keys) {
    if (object[key] !== undefined && object[key] !== null) return object[key];
  }
  return undefined;
}

function toStack(value) {
  if (value === undefined || value === null) return [];
  if (Array.isArray(value)) return value.map(String);
  return String(value).split(/\r?\n/);
}

/**
 * JSON-lines parser. Only lines that are objects starting with "{" are accepted.
 *
 * @param {string} line
 */
export function parseJsonLine(line) {
  const trimmed = line.trim();
  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) return null;
  let object;
  try {
    object = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (object === null || typeof object !== 'object' || Array.isArray(object)) return null;
  return {
    ts: parseTimestamp(pick(object, ['@timestamp', 'timestamp', 'time', 'ts', 'date'])),
    level: normalizeLevel(pick(object, ['level', 'severity', 'lvl', 'loglevel'])),
    thread: pick(object, ['thread', 'threadName', 'thread_name']) ?? null,
    logger: pick(object, ['logger', 'logger_name', 'name', 'module', 'source']) ?? null,
    message: String(pick(object, ['message', 'msg', 'text']) ?? trimmed),
    stack: toStack(pick(object, ['stack', 'stack_trace', 'stacktrace', 'exception', 'err'])),
  };
}

const LOGBACK_REGEX =
  /^(?<ts>\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:[.,]\d{1,6})?)\s+(?<level>TRACE|DEBUG|INFO|WARN|WARNING|ERROR|FATAL)\s+(?:\d+\s+)?---\s+\[(?<thread>[^\]]*)\]\s+(?<logger>\S+)\s*:\s?(?<message>.*)$/;

const NODE_REGEX =
  /^\[?(?<ts>\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:[.,]\d{1,6})?(?:Z|[+-]\d{2}:?\d{2})?)\]?\s+(?<level>TRACE|DEBUG|INFO|WARN|WARNING|ERROR|FATAL)\b\s*(?:\[(?<thread>[^\]]*)\])?\s*(?<message>.*)$/;

/**
 * Build a parser from a regex with optional named groups:
 * ts, level, thread, logger, message.
 *
 * @param {string} pattern
 * @param {string} name
 */
function regexParser(pattern, name) {
  const regex = new RegExp(pattern);
  return {
    name,
    parse(line) {
      const match = line.match(regex);
      if (!match) return null;
      const groups = match.groups ?? {};
      return {
        ts: parseTimestamp(groups.ts),
        level: normalizeLevel(groups.level),
        thread: groups.thread ?? null,
        logger: groups.logger ?? null,
        message: groups.message ?? line,
        stack: [],
      };
    },
  };
}

/** @type {Record<string, { name: string, parse: (line: string) => any }>} */
export const PRESETS = Object.freeze({
  'json-lines': { name: 'json-lines', parse: parseJsonLine },
  logback: regexParser(LOGBACK_REGEX, 'logback'),
  node: regexParser(NODE_REGEX, 'node'),
});

/**
 * Resolve a parser spec ({ preset } | { regex } | 'auto' | preset name).
 *
 * @param {{ preset?: string, regex?: string } | string | undefined} spec
 * @returns {{ name: string, parse: (line: string) => any } | { name: 'auto' }}
 */
export function resolveParser(spec) {
  if (spec === undefined || spec === null) return { name: 'auto' };
  if (typeof spec === 'string') {
    if (spec === 'auto') return { name: 'auto' };
    if (spec in PRESETS) return PRESETS[spec];
    throw new Error(`Unknown log parser preset: ${spec}`);
  }
  if (spec.regex) return regexParser(spec.regex, 'custom');
  if (spec.preset && spec.preset !== 'auto') {
    if (!(spec.preset in PRESETS)) throw new Error(`Unknown log parser preset: ${spec.preset}`);
    return PRESETS[spec.preset];
  }
  return { name: 'auto' };
}

/**
 * Pick a preset for a sample of lines.
 * Criterion (from the verified DEMO): hit rate > 60% AND every non-continuation line parses.
 *
 * @param {string[]} lines
 * @returns {string | null} preset name
 */
export function detectParserFromLines(lines) {
  const candidates = [];
  for (const [name, preset] of Object.entries(PRESETS)) {
    let startLines = 0;
    let matched = 0;
    let unparsed = 0;
    let hasCurrent = false;
    for (const line of lines) {
      if (!line.trim()) continue;
      const record = preset.parse(line);
      if (record) {
        startLines += 1;
        matched += 1;
        hasCurrent = true;
        continue;
      }
      if (isContinuationLine(line, hasCurrent)) continue;
      startLines += 1;
      unparsed += 1;
    }
    const hitRate = startLines === 0 ? 0 : matched / startLines;
    if (hitRate > 0.6 && unparsed === 0) {
      candidates.push({ name, hitRate, matched });
    }
  }
  candidates.sort((a, b) => b.hitRate - a.hitRate || b.matched - a.matched);
  return candidates[0]?.name ?? null;
}
