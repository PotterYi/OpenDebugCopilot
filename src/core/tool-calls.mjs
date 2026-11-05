/**
 * Compact previous tool calls for the follow-up prompt.
 *
 * Re-fetching logs is expensive, so keep a truncated digest. Source reads/searches
 * are cheap to repeat, so keep only the arguments (and file:line hits), never bodies.
 */

const DEFAULT_MAX_CALLS = 20;
const DEFAULT_MAX_RECORDS = 10;
const DEFAULT_MAX_TEXT = 300;

function truncate(value, max = DEFAULT_MAX_TEXT) {
  const text = String(value ?? '');
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function normalizeResult(result) {
  if (result === null || result === undefined) return null;
  if (typeof result === 'object') return result;
  if (typeof result === 'string') {
    try {
      return JSON.parse(result);
    } catch {
      return { text: truncate(result, DEFAULT_MAX_TEXT * 2) };
    }
  }
  return { value: truncate(result, DEFAULT_MAX_TEXT) };
}

function spilled(result) {
  if (!result?.spilled) return null;
  return {
    spilled: true,
    file: result.file ?? null,
    bytes: result.bytes ?? null,
    preview: truncate(result.preview, 200),
  };
}

function compactLog(record) {
  return {
    ts: record?.ts ?? null,
    level: record?.level ?? null,
    thread: record?.thread ?? null,
    logger: record?.logger ?? null,
    message: truncate(record?.message, DEFAULT_MAX_TEXT),
  };
}

function summarizeCall(call) {
  if (!call || typeof call !== 'object') return null;
  const name = String(call.name ?? 'unknown');
  const args = call.args && typeof call.args === 'object' ? call.args : {};
  const base = { name, args };
  if (call.error) base.error = true;

  const result = normalizeResult(call.result);
  if (result?.error) {
    return { ...base, error: true, message: truncate(result.message, DEFAULT_MAX_TEXT) };
  }
  const spill = spilled(result);
  if (spill) return { ...base, ...spill };

  if (name === 'read_source' || name === 'read') {
    // Cheap to repeat: keep only the arguments.
    return base;
  }

  if (name === 'search_source') {
    return {
      ...base,
      hits: (result?.matches ?? []).slice(0, DEFAULT_MAX_RECORDS).map((match) => ({
        path: match?.path ?? null,
        line: match?.line ?? null,
      })),
      scanned: result?.scanned ?? null,
      truncated: Boolean(result?.truncated),
    };
  }

  if (name === 'get_logs' || name === 'search_log') {
    const records = result?.records ?? result?.matches ?? [];
    const kept = records.slice(-DEFAULT_MAX_RECORDS);
    return {
      ...base,
      count: records.length,
      omitted: Math.max(0, records.length - kept.length),
      parser: result?.parser ?? null,
      parserFallback: Boolean(result?.parserFallback),
      stats: result?.stats ?? null,
      truncated: Boolean(result?.truncated),
      records: kept.map(compactLog),
    };
  }

  if (name === 'list_threads') {
    return {
      ...base,
      total: result?.total ?? null,
      threads: (result?.threads ?? []).slice(0, DEFAULT_MAX_RECORDS),
    };
  }

  return base;
}

/**
 * @param {Array<{name: string, args: any, result: any, error?: boolean}>} calls
 * @param {{ maxCalls?: number }} [options]
 * @returns {{ calls: any[], omitted: number }}
 */
export function summarizeToolCalls(calls, { maxCalls = DEFAULT_MAX_CALLS } = {}) {
  if (!Array.isArray(calls) || calls.length === 0) return { calls: [], omitted: 0 };
  const kept = calls.length > maxCalls ? calls.slice(-maxCalls) : calls;
  return {
    calls: kept.map(summarizeCall).filter(Boolean),
    omitted: Math.max(0, calls.length - kept.length),
  };
}
