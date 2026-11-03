/**
 * Pure routing helpers (no Electron dependency) so they can be unit tested.
 * Routing rules are matched by host + URL prefix; local targets are normalized to localhost.
 */

import { log } from '../../core/logger.mjs';

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

export function isLocalHostname(hostname) {
  return LOCAL_HOSTS.has(String(hostname ?? '').toLowerCase());
}

/**
 * Embedded Chromium hits ERR_ABORTED for 127.0.0.1; use localhost instead.
 *
 * @param {string} url
 * @returns {string}
 */
export function normalizeLocalhost(url) {
  try {
    const parsed = new URL(url);
    if (isLocalHostname(parsed.hostname)) parsed.hostname = 'localhost';
    return parsed.toString();
  } catch {
    return url;
  }
}

function joinPath(basePath, requestPath) {
  const left = (basePath ?? '').replace(/\/+$/, '');
  const right = (requestPath ?? '').replace(/^\/+/, '');
  if (!left && !right) return '/';
  if (!left) return `/${right}`;
  if (!right) return left;
  return `${left}/${right}`;
}

/**
 * @param {Array<any>} rules
 * @param {string} url
 * @returns {any | null}
 */
export function matchRule(rules, url, resourceType = null) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  for (const rule of rules ?? []) {
    if (rule.enabled === false) continue;
    if (rule.match?.host && rule.match.host.toLowerCase() !== parsed.hostname.toLowerCase()) continue;
    if (!parsed.pathname.startsWith(rule.match?.prefix ?? '')) continue;
    // Never rewrite document/script/stylesheet requests: only XHR/Fetch by default.
    if (resourceType !== null) {
      const allowed = rule.match?.resourceTypes ?? ['xhr'];
      if (!allowed.includes(resourceType)) continue;
    }
    return rule;
  }
  return null;
}

/**
 * @param {any} rule
 * @param {string} requestUrl
 * @returns {string}
 */
export function buildRedirectUrl(rule, requestUrl, proxyBaseUrl = null) {
  const source = new URL(requestUrl);
  if (rule.target?.kind === 'local' && proxyBaseUrl) {
    const proxy = new URL('/__dcproxy', proxyBaseUrl);
    proxy.searchParams.set('target', rule.target.baseUrl);
    proxy.searchParams.set('url', `${source.pathname}${source.search}`);
    return proxy.toString();
  }
  const target = new URL(rule.target.baseUrl);
  if (isLocalHostname(target.hostname)) target.hostname = 'localhost';
  target.pathname = joinPath(target.pathname, source.pathname);
  target.search = source.search;
  return target.toString();
}

/**
 * True when a URL points at any enabled local routing target.
 * Redirected requests may get a new webRequest id, so headersReceived cannot rely on the pending map alone.
 *
 * @param {Array<any>} rules
 * @param {string} url
 */
export function isLocalTargetUrl(rules, url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  return (rules ?? []).some((rule) => {
    if (rule.enabled === false || rule.target?.kind !== 'local') return false;
    try {
      const target = new URL(rule.target.baseUrl);
      const sameHost = isLocalHostname(target.hostname) && isLocalHostname(parsed.hostname)
        ? true
        : target.hostname.toLowerCase() === parsed.hostname.toLowerCase();
      return sameHost && (target.port || '80') === (parsed.port || '80');
    } catch {
      return false;
    }
  });
}

function deleteHeaderCaseInsensitive(headers, name) {
  const lower = name.toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === lower) delete headers[key];
  }
}

/**
 * Add permissive CORS headers to an Electron responseHeaders object
 * (values are arrays). Existing CORS headers are replaced.
 *
 * @param {Record<string, string[]>} responseHeaders
 * @param {{ origin?: string | null, requestHeaders?: Record<string, string[]> }} [options]
 * @returns {Record<string, string[]>}
 */
export function applyCorsHeaders(responseHeaders = {}, { origin = null, requestHeaders = {} } = {}) {
  const headers = { ...responseHeaders };
  const allowOrigin = origin || '*';
  const requestedMethod = requestHeaders['access-control-request-method']?.[0];
  const requestedHeaders = requestHeaders['access-control-request-headers']?.[0];

  const values = {
    'Access-Control-Allow-Origin': allowOrigin,
    'Access-Control-Allow-Methods': requestedMethod || 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': requestedHeaders || 'Content-Type,Authorization,X-Requested-With,X-DC-Probe',
    'Access-Control-Expose-Headers': '*',
    Vary: 'Origin',
  };
  if (allowOrigin !== '*') values['Access-Control-Allow-Credentials'] = 'true';
  // Preflight caching makes failures look green later; never cache in dev.
  values['Access-Control-Max-Age'] = '0';

  for (const [name, value] of Object.entries(values)) {
    deleteHeaderCaseInsensitive(headers, name);
    headers[name] = [value];
  }
  return headers;
}

/**
 * Electron session webRequest router: 3 hooks.
 * - onBeforeRequest: redirect matched requests to the target (OPTIONS is not redirected)
 * - onBeforeSendHeaders: capture preflight headers, force Origin to the page origin
 * - onHeadersReceived: add CORS headers for local-target responses and preflight responses
 */
export class Router {
  /**
   * @param {{
   *   session: import('electron').Session,
   *   getRules: () => Array<any>,
   *   getPageOrigin?: () => string | null,
   *   onHit?: (event: any) => void
   * }} options
   */
  constructor({ session, getRules, getPageOrigin = () => null, onHit = () => {}, onMiss = () => {}, proxyBaseUrl = null }) {
    this.session = session;
    this.getRules = getRules;
    this.getPageOrigin = getPageOrigin;
    this.onHit = onHit;
    this.onMiss = onMiss;
    this.proxyBaseUrl = proxyBaseUrl;
    this.pending = new Map();
    this.filter = { urls: ['<all_urls>'] };

    this.beforeRequest = this.beforeRequest.bind(this);
    this.beforeSendHeaders = this.beforeSendHeaders.bind(this);
    this.headersReceived = this.headersReceived.bind(this);
    this.completed = this.completed.bind(this);

    session.webRequest.onBeforeRequest(this.filter, this.beforeRequest);
    session.webRequest.onBeforeSendHeaders(this.filter, this.beforeSendHeaders);
    session.webRequest.onHeadersReceived(this.filter, this.headersReceived);
    session.webRequest.onCompleted(this.filter, this.completed);
    session.webRequest.onErrorOccurred(this.filter, this.completed);
  }

  beforeRequest(details, callback) {
    const rule = details.method === 'OPTIONS'
      ? matchRule(this.getRules(), details.url, null)
      : matchRule(this.getRules(), details.url, details.resourceType ?? null);
    if (!rule) {
      if (details.resourceType === 'xhr' || details.resourceType === 'fetch') {
        log.info('[routing miss]', details.method, details.url);
        this.onMiss({ url: details.url, method: details.method, resourceType: details.resourceType });
      } else {
        log.debug('[routing miss]', details.resourceType ?? '-', details.method, details.url);
      }
      callback({});
      return;
    }

    // CORS preflight redirects are rejected by Chromium; let OPTIONS go to the
    // original host and fix its response headers instead.
    if (details.method === 'OPTIONS') {
      this.pending.set(details.id, { rule, originalUrl: details.url, targetUrl: null, options: true });
      this.onHit({ type: 'routing', rule: rule.id, method: 'OPTIONS', url: details.url, target: null });
      callback({});
      return;
    }

    const redirectURL = buildRedirectUrl(rule, details.url, this.proxyBaseUrl);
    if (redirectURL === details.url) {
      callback({});
      return;
    }
    this.pending.set(details.id, { rule, originalUrl: details.url, targetUrl: redirectURL });
    this.onHit({ type: 'routing', rule: rule.id, method: details.method, url: details.url, target: redirectURL });
    callback({ redirectURL });
  }

  beforeSendHeaders(details, callback) {
    const hit = this.pending.get(details.id);
    const requestHeaders = { ...(details.requestHeaders ?? {}) };
    if (hit) {
      hit.requestHeaders = { ...requestHeaders };
      const origin = this.getPageOrigin();
      if (origin) {
        const existing = Object.keys(requestHeaders).find((key) => key.toLowerCase() === 'origin');
        if (existing) requestHeaders[existing] = origin;
        else requestHeaders.Origin = origin;
      }
    }
    callback({ requestHeaders });
  }

  headersReceived(details, callback) {
    const hit = this.pending.get(details.id);
    const localTarget = hit?.rule?.target?.kind === 'local'
      || (!hit && isLocalTargetUrl(this.getRules(), details.url));
    if (!hit && !localTarget) {
      callback({ responseHeaders: details.responseHeaders });
      return;
    }
    const isPreflight = Boolean(hit?.options) || details.method === 'OPTIONS';
    const statusCode = details.statusCode ?? 200;
    if (!localTarget && !isPreflight) {
      callback({ responseHeaders: details.responseHeaders });
      return;
    }

    const responseHeaders = applyCorsHeaders(details.responseHeaders, {
      origin: this.getPageOrigin(),
      requestHeaders: hit?.requestHeaders ?? {},
    });

    // Demo fallback: a preflight must be 2xx or the browser blocks the request.
    // Rewrite the status line instead of only warning.
    if (isPreflight && (statusCode < 200 || statusCode >= 300)) {
      this.onHit({
        type: 'cors-warning',
        repaired: true,
        message: 'Preflight status rewritten to 200 OK',
        url: details.url,
        status: statusCode,
      });
      callback({ responseHeaders, statusLine: 'HTTP/1.1 200 OK' });
      return;
    }

    callback({ responseHeaders });
  }

  completed(details) {
    this.pending.delete(details.id);
  }

  /** Rules are read dynamically; clear cached preflights so old results cannot mask changes. */
  apply() {
    this.session.clearCache().catch(() => {});
  }


  dispose() {
    this.session.webRequest.onBeforeRequest(null);
    this.session.webRequest.onBeforeSendHeaders(null);
    this.session.webRequest.onHeadersReceived(null);
    this.session.webRequest.onCompleted(null);
    this.session.webRequest.onErrorOccurred(null);
    this.pending.clear();
  }
}
