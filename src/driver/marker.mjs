import { randomBytes } from 'node:crypto';
import { AppError } from '../core/errors.mjs';

/**
 * Marker used to correlate a fired request with log lines.
 * Format follows the verified DEMO: dcprobe + random hex.
 *
 * @param {string} [prefix]
 * @returns {string}
 */
export function createMarker(prefix = 'dcprobe') {
  return `${prefix}${randomBytes(8).toString('hex')}`;
}

/**
 * Inject a marker into a JSON object body.
 *
 * @param {unknown} body
 * @param {string} field
 * @param {string} value
 * @returns {{ ok: true, body: any, serialized: boolean } | { ok: false, reason: string }}
 */
export function injectBodyField(body, field, value) {
  if (body === undefined || body === null || body === '') {
    return { ok: false, reason: 'no-body' };
  }
  if (typeof body === 'object' && !Array.isArray(body)) {
    return { ok: true, body: { ...body, [field]: value }, serialized: false };
  }
  if (typeof body === 'string') {
    try {
      const parsed = JSON.parse(body);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return { ok: true, body: { ...parsed, [field]: value }, serialized: true };
      }
    } catch {
      // fall through
    }
    return { ok: false, reason: 'body-not-json-object' };
  }
  return { ok: false, reason: 'unsupported-body' };
}

/**
 * Apply scenario marker config to headers/body.
 *
 * @param {{
 *   marker: { mode: 'none' | 'body' | 'header' | 'both', bodyField?: string, header?: string },
 *   headers?: Record<string, string>,
 *   body?: unknown,
 *   contentType?: string | null,
 *   value?: string
 * }} input
 */
export function applyMarker({ marker, headers = {}, body, contentType = null, value: providedValue }) {
  const mode = marker?.mode ?? 'none';
  const nextHeaders = { ...headers };
  let nextBody = body;
  let contentTypeNext = contentType;
  const targets = { header: false, body: false };
  const reasons = [];

  if (mode === 'none') {
    return {
      value: null,
      mode,
      injected: false,
      targets,
      headers: nextHeaders,
      body: nextBody,
      contentType: contentTypeNext,
    };
  }

  const value = providedValue ?? createMarker();

  if (mode === 'header' || mode === 'both') {
    if (!marker.header) {
      throw new AppError('MARKER_HEADER_MISSING', 'marker.header is required for header injection', {
        exitCode: 3,
      });
    }
    nextHeaders[marker.header] = value;
    targets.header = true;
  }

  if (mode === 'body' || mode === 'both') {
    const injection = injectBodyField(nextBody, marker.bodyField, value);
    if (injection.ok) {
      nextBody = injection.serialized ? JSON.stringify(injection.body) : injection.body;
      if (!contentTypeNext) contentTypeNext = 'application/json';
      targets.body = true;
    } else {
      reasons.push(injection.reason);
    }
  }

  return {
    value,
    mode,
    injected: targets.header || targets.body,
    targets,
    headers: nextHeaders,
    body: nextBody,
    contentType: contentTypeNext,
    ...(reasons.length ? { reason: reasons.join(',') } : {}),
  };
}
