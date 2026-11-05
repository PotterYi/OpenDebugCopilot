import { readLogs, searchAll } from './logs.mjs';

const IGNORED_ID_KEY = /^(code|status|statuscode|httpcode|errorcode|resultcode|retcode|msg|message|page|pagenum|pageno|pagesize|total|totalnum|count|index|type|level)$/i;
const SENSITIVE_HEADER = /^(authorization|cookie|set-cookie|x-api-key|proxy-authorization|x-auth-token)$/i;

/** Higher score = more likely to be a stable business identifier. */
function keyScore(key) {
  const normalized = String(key ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
  if (!normalized || normalized === 'id' || normalized === 'no' || normalized === 'num') return 0;
  if (IGNORED_ID_KEY.test(normalized)) return 0;
  if (/(id|uuid|guid|sn)$/.test(normalized)) return 3;
  if (/(no|num)$/.test(normalized)) return 2;
  if (/code$/.test(normalized)) return 1;
  return 0;
}

function addId(candidates, value, score = 1) {
  const values = Array.isArray(value) ? value : [value];
  for (const item of values) {
    if (typeof item !== 'string' && typeof item !== 'number') continue;
    const text = String(item).trim();
    if (text.length < 4 || text.length > 64) continue;
    if (/^\d{1,3}$/.test(text)) continue;
    const existing = candidates.get(text);
    if (!existing || score > existing.score) {
      candidates.set(text, { value: text, score, order: existing?.order ?? candidates.size });
    }
  }
}

function scanObject(value, candidates) {
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    if (child && typeof child === 'object') {
      scanObject(child, candidates);
      continue;
    }
    const score = keyScore(key);
    if (score > 0) addId(candidates, child, score);
  }
}

function scanHeaders(headers, candidates) {
  for (const [key, value] of Object.entries(headers ?? {})) {
    if (SENSITIVE_HEADER.test(key)) continue;
    const score = keyScore(key);
    if (score > 0) addId(candidates, value, score);
  }
}

function pathSegmentValue(segment) {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

function looksLikePathId(segment) {
  if (segment.length < 4 || segment.length > 64) return false;
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(segment)) return true;
  if (/[A-Za-z]/.test(segment) && /\d/.test(segment)) return true;
  return /^\d{6,}$/.test(segment);
}

function scanPath(url, candidates) {
  const segments = url.pathname.split('/').filter(Boolean).map(pathSegmentValue);
  for (const [index, segment] of segments.entries()) {
    if (looksLikePathId(segment)) addId(candidates, segment, 2);
    if (index === 0) continue;
    const score = keyScore(segments[index - 1]);
    if (score > 0) addId(candidates, segment, score);
  }
}

/**
 * Extract candidate business ids from request/response headers, bodies, query and path.
 * These are used for cross-thread correlation when a request marker is unavailable.
 *
 * @param {{ request?: any, response?: any }} [input]
 * @returns {string[]}
 */
export function extractBusinessIds({ request, response } = {}) {
  /** @type {Map<string, {value: string, score: number, order: number}>} */
  const candidates = new Map();
  scanHeaders(request?.headers, candidates);
  scanHeaders(response?.headers, candidates);
  for (const body of [request?.body, response?.body]) {
    if (typeof body === 'string' && body.trim().startsWith('{')) {
      try {
        scanObject(JSON.parse(body), candidates);
      } catch {
        // ignore non-JSON bodies
      }
    } else if (body && typeof body === 'object') {
      scanObject(body, candidates);
    }
  }
  try {
    const url = new URL(request?.url);
    for (const [key, value] of url.searchParams) {
      const score = keyScore(key);
      if (score > 0) addId(candidates, value, score);
    }
    scanPath(url, candidates);
  } catch {
    // ignore invalid URLs
  }
  return [...candidates.values()]
    .sort((a, b) => b.score - a.score || a.order - b.order)
    .slice(0, 5)
    .map((candidate) => candidate.value);
}

/**
 * Trace ids are only used when the target actually writes one.
 *
 * @param {Record<string, any>} [requestHeaders]
 * @param {Record<string, any>} [responseHeaders]
 * @returns {string | null}
 */
export function extractTraceId(requestHeaders = {}, responseHeaders = {}) {
  const names = new Set(['x-trace-id', 'traceparent', 'trace-id', 'x-request-id', 'uber-trace-id']);
  for (const headers of [responseHeaders, requestHeaders]) {
    for (const [key, value] of Object.entries(headers ?? {})) {
      if (!names.has(key.toLowerCase())) continue;
      const text = Array.isArray(value) ? value[0] : value;
      if (text) return String(text);
    }
  }
  return null;
}

function inWindow(ts, anchor, window) {
  if (ts === null || ts === undefined || !window) return true;
  return ts >= anchor - window.beforeMs && ts <= anchor + window.afterMs;
}

/**
 * Three-layer correlation:
 *   1. marker (parameter marker)
 *   2. time window + thread
 *   3. business id (cross-thread)
 *   trace id is only used when the target wrote one, and never as the primary path.
 *
 * @param {{
 *   logfiles: string[], parser?: any, encoding?: string,
 *   anchor: number, window?: { beforeMs: number, afterMs: number },
 *   marker?: string | null, thread?: string | null,
 *   businessIds?: string[], traceId?: string | null, limit?: number
 * }} options
 */
export async function correlateLogs({
  logfiles,
  parser,
  encoding,
  anchor,
  window,
  marker = null,
  thread = null,
  businessIds = [],
  traceId = null,
  limit = 200,
}) {
  const base = { logfiles, parser, encoding, anchor, window, limit };

  if (marker) {
    const result = await readLogs({ ...base, marker });
    if (result.records.length > 0) {
      return { strategy: 'marker', matchedId: marker, result };
    }
  }

  const windowResult = await readLogs({ ...base, thread: thread ?? undefined });
  if (thread && windowResult.records.length > 0) {
    return { strategy: 'window-thread', matchedId: thread, result: windowResult };
  }

  for (const id of businessIds) {
    const result = await searchAll({ logfiles, parser, encoding, keyword: id, limit });
    const records = result.matches.filter((record) => inWindow(record.ts, anchor, window));
    if (records.length > 0) {
      return {
        strategy: 'business-id',
        matchedId: id,
        result: { ...result, records, matches: records },
      };
    }
  }

  if (traceId) {
    const result = await searchAll({ logfiles, parser, encoding, keyword: traceId, limit });
    const records = result.matches.filter((record) => inWindow(record.ts, anchor, window));
    if (records.length > 0) {
      return {
        strategy: 'trace-id',
        matchedId: traceId,
        result: { ...result, records, matches: records },
      };
    }
  }

  return {
    strategy: windowResult.records.length > 0 ? 'time-window' : 'none',
    matchedId: null,
    result: windowResult,
  };
}
