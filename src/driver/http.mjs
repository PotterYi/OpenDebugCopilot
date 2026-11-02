import { AppError } from '../core/errors.mjs';
import { applyMarker } from './marker.mjs';

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_BODY_BYTES = 1024 * 1024;

function setHeader(headers, name, value) {
  const lower = name.toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === lower) delete headers[key];
  }
  headers[name] = value;
}

async function readResponseBody(response, maxBytes) {
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length > maxBytes) {
    return { body: buffer.subarray(0, maxBytes).toString('utf8'), truncated: true, bytes: buffer.length };
  }
  return { body: buffer.toString('utf8'), truncated: false, bytes: buffer.length };
}

/**
 * HTTP driver: fire one request described by method/path, optionally injecting a marker.
 *
 * @param {Readonly<Record<string, any>>} scenario
 * @param {{ timeoutMs?: number, maxBodyBytes?: number }} [ctx]
 * @returns {Promise<{ request: any, response: any, firedAt: number, marker: any }>}
 */
export async function fire(scenario, ctx = {}) {
  const { http, baseUrl } = scenario;
  if (!http) {
    throw new AppError('SCENARIO_DRIVER_MISMATCH', 'HTTP driver requires method/path fields', { exitCode: 3 });
  }
  if (!baseUrl) {
    throw new AppError('SCENARIO_BASE_URL_REQUIRED', 'HTTP driver requires "baseUrl"', { exitCode: 3 });
  }

  const url = new URL(http.path, baseUrl).toString();
  const headers = { ...(http.headers ?? {}) };
  let body = http.body;
  if (body !== undefined && typeof body !== 'string') body = JSON.stringify(body);
  if (body !== undefined && !Object.keys(headers).some((k) => k.toLowerCase() === 'content-type')) {
    headers['Content-Type'] = 'application/json';
  }

  const applied = applyMarker({
    marker: scenario.marker,
    headers,
    body,
    contentType: headers['Content-Type'] ?? null,
  });
  const finalHeaders = { ...applied.headers };
  if (applied.contentType) setHeader(finalHeaders, 'Content-Type', applied.contentType);
  const finalBody = applied.body === undefined ? undefined
    : typeof applied.body === 'string' ? applied.body : JSON.stringify(applied.body);

  const timeoutMs = ctx.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBodyBytes = ctx.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  const startedAt = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('timeout')), timeoutMs);

  try {
    const response = await fetch(url, {
      method: http.method,
      headers: finalHeaders,
      body: http.method === 'GET' || http.method === 'HEAD' ? undefined : finalBody,
      signal: controller.signal,
      redirect: 'follow',
    });
    const bodyInfo = await readResponseBody(response, maxBodyBytes);
    return {
      request: {
        method: http.method,
        url,
        headers: finalHeaders,
        body: finalBody ?? null,
        startedAt,
      },
      response: {
        status: response.status,
        statusText: response.statusText,
        ok: response.ok,
        headers: Object.fromEntries(response.headers.entries()),
        body: bodyInfo.body,
        truncated: bodyInfo.truncated,
        bytes: bodyInfo.bytes,
        durationMs: Date.now() - startedAt,
      },
      firedAt: startedAt,
      marker: applied,
    };
  } catch (err) {
    const reason = err?.name === 'AbortError' ? `timeout after ${timeoutMs}ms` : err?.message ?? String(err);
    throw new AppError('HTTP_REQUEST_FAILED', `HTTP request failed: ${url} (${reason})`, {
      exitCode: 3,
      cause: err,
    });
  } finally {
    clearTimeout(timer);
  }
}
