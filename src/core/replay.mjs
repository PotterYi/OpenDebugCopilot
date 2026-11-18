import { createHash } from 'node:crypto';
import { redactSecrets } from './redact.mjs';

const SAFE_DEFAULT_METHODS = ['GET', 'HEAD', 'OPTIONS'];
const SENSITIVE_HEADER = /(?:authorization|cookie|token|secret|api[-_]?key|x-api-key)/i;
const SAFE_RESPONSE_HEADERS = new Set(['content-type']);

function normalizeOrigin(value) {
  try {
    return new URL(String(value ?? '')).origin;
  } catch {
    return null;
  }
}

export function replayConfig(workspace = {}) {
  const raw = workspace.replay ?? {};
  const methods = Array.isArray(raw.allowMethods) && raw.allowMethods.length > 0
    ? raw.allowMethods.map((method) => String(method).toUpperCase())
    : SAFE_DEFAULT_METHODS;
  return {
    enabled: raw.enabled === true,
    allowOrigins: [...new Set([
      normalizeOrigin(workspace.backendUrl),
      ...(Array.isArray(raw.allowOrigins) ? raw.allowOrigins.map(normalizeOrigin) : []),
    ].filter(Boolean))],
    allowMethods: [...new Set(methods)],
    timeoutMs: Math.max(500, Math.min(30000, Number(raw.timeoutMs ?? 5000) || 5000)),
  };
}

export function buildReplayFixture({ fired = null, workspace = {}, scenario = null } = {}) {
  const config = replayConfig(workspace);
  if (!config.enabled) return { ok: false, reason: 'replay-disabled' };
  const request = fired?.request;
  if (!request?.url) return { ok: false, reason: 'no-request' };
  const method = String(request.method ?? 'GET').toUpperCase();
  if (!config.allowMethods.includes(method)) return { ok: false, reason: 'method-not-allowed' };
  const origin = normalizeOrigin(request.url);
  if (!origin) return { ok: false, reason: 'invalid-url' };
  if (!config.allowOrigins.includes(origin)) return { ok: false, reason: 'origin-not-allowed' };
  const parsedUrl = new URL(String(request.url));
  if ([...parsedUrl.searchParams.keys()].some((key) => SENSITIVE_HEADER.test(key))) {
    return { ok: false, reason: 'sensitive-query' };
  }
  const headers = request.headers ?? {};
  if (Object.keys(headers).some((key) => SENSITIVE_HEADER.test(key))) {
    return { ok: false, reason: 'auth-required' };
  }
  const safeHeaders = {};
  for (const [key, value] of Object.entries(headers)) {
    if (SAFE_RESPONSE_HEADERS.has(String(key).toLowerCase())) safeHeaders[key] = String(value);
  }
  return {
    ok: true,
    fixture: {
      method,
      url: String(request.url),
      origin,
      headers: safeHeaders,
      body: ['GET', 'HEAD'].includes(method) ? null : (request.body ?? null),
      resourceType: scenario?.capture?.resourceType ?? null,
      ruleId: scenario?.capture?.ruleId ?? null,
    },
  };
}

export function responseSignature(response = {}) {
  const status = Number(response.status) || 0;
  let body = response.body;
  if (typeof body !== 'string') body = body === undefined ? '' : JSON.stringify(body);
  let data = null;
  try {
    data = JSON.parse(body);
  } catch {
    // Non-JSON responses still contribute status and error text.
  }
  const businessCode = data && typeof data.code === 'number' ? data.code : null;
  const businessError = businessCode !== null && businessCode !== 0 && businessCode !== 200;
  const message = data && (data.msg ?? data.message ?? data.error) ? String(data.msg ?? data.message ?? data.error) : null;
  return {
    httpStatus: status,
    businessCode,
    hasError: status >= 400 || businessError,
    errorMessage: message ? redactSecrets(message).slice(0, 300) : null,
    bodyHash: body ? createHash('sha1').update(body).digest('hex') : null,
  };
}

export function compareSymptom(before, after) {
  if (after.httpStatus === 401 || after.httpStatus === 403) {
    return { status: 'pending', reason: 'auth-required' };
  }
  if (!before.hasError) {
    return { status: 'pending', reason: 'no-baseline-symptom' };
  }
  if (!after.hasError) {
    return { status: 'passed', reason: 'error-signature-cleared' };
  }
  return { status: 'failed', reason: 'error-signature-still-present' };
}

export async function replayFixture(fixture, {
  fetchImpl = globalThis.fetch,
  timeoutMs = 5000,
} = {}) {
  if (typeof fetchImpl !== 'function') return { ok: false, reason: 'fetch-unavailable' };
  try {
    const response = await fetchImpl(fixture.url, {
      method: fixture.method,
      headers: fixture.headers,
      body: fixture.body === null || fixture.body === undefined
        ? undefined
        : (typeof fixture.body === 'string' ? fixture.body : JSON.stringify(fixture.body)),
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
    });
    const body = await response.text();
    return {
      ok: true,
      response: {
        status: response.status,
        statusText: response.statusText,
        body,
      },
    };
  } catch (error) {
    return {
      ok: false,
      reason: error?.name === 'TimeoutError' ? 'replay-timeout' : 'replay-unreachable',
      error: redactSecrets(error?.message ?? String(error)).slice(0, 300),
    };
  }
}
