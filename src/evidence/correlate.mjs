import { readLogs, searchAll } from './logs.mjs';

const BUSINESS_ID_KEY = /(orderid|userid|traceid|bizid|requestid|idempotent|orderno|bizno|serialno|trace_?no|.+id|.+no)$/i;

function addId(ids, value) {
  if (typeof value !== 'string' && typeof value !== 'number') return;
  const text = String(value).trim();
  if (text.length < 4 || text.length > 64) return;
  if (/^\d{1,3}$/.test(text)) return;
  ids.add(text);
}

function scanObject(value, ids) {
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    if (child && typeof child === 'object') {
      scanObject(child, ids);
      continue;
    }
    if (BUSINESS_ID_KEY.test(key)) addId(ids, child);
  }
}

/**
 * Extract candidate business ids from request/response bodies and query string.
 * These are used for cross-thread correlation when a request marker is unavailable.
 *
 * @param {{ request?: any, response?: any }} [input]
 * @returns {string[]}
 */
export function extractBusinessIds({ request, response } = {}) {
  const ids = new Set();
  for (const body of [request?.body, response?.body]) {
    if (typeof body === 'string' && body.trim().startsWith('{')) {
      try {
        scanObject(JSON.parse(body), ids);
      } catch {
        // ignore non-JSON bodies
      }
    } else if (body && typeof body === 'object') {
      scanObject(body, ids);
    }
  }
  try {
    const url = new URL(request?.url);
    for (const [key, value] of url.searchParams) {
      if (BUSINESS_ID_KEY.test(key)) addId(ids, value);
    }
  } catch {
    // ignore invalid URLs
  }
  return [...ids].slice(0, 5);
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
