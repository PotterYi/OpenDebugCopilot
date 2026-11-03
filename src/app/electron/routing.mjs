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
  if (proxyBaseUrl && (rule.target?.kind === 'local' || rule.target?.kind === 'sit')) {
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
 * True when a URL points at any enabled routing target (local or SIT).
 * Redirected requests may get a new webRequest id, so headersReceived cannot rely on the pending map alone.
 *
 * @param {Array<any>} rules
 * @param {string} url
 */
export function isTargetUrl(rules, url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  const portOf = (value) => value.port || (value.protocol === 'https:' ? '443' : '80');
  return (rules ?? []).some((rule) => {
    if (rule.enabled === false) return false;
    try {
      const target = new URL(rule.target.baseUrl);
      const sameHost = isLocalHostname(target.hostname) && isLocalHostname(parsed.hostname)
        ? true
        : target.hostname.toLowerCase() === parsed.hostname.toLowerCase();
      return sameHost && portOf(target) === portOf(parsed);
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
  constructor({ session, getRules, getPageOrigin = () => null, onHit = () => {}, onMiss = () => {}, proxyBaseUrl = null, getOriginalHeaders = () => null }) {
    this.session = session;
    this.getRules = getRules;
    this.getPageOrigin = getPageOrigin;
    this.onHit = onHit;
    this.onMiss = onMiss;
    this.proxyBaseUrl = proxyBaseUrl;
    this.getOriginalHeaders = getOriginalHeaders;
    this.originByUrl = new Map();
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
    try {
      if (new URL(details.url).pathname === '/__dcproxy') {
        callback({});
        return;
      }
    } catch {
      // fall through to rule matching
    }
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
    let hasAuth = Object.keys(requestHeaders).some((key) => key.toLowerCase() === 'authorization');
    if (!hasAuth) {
      try {
        const proxied = new URL(details.url);
        if (proxied.pathname === '/__dcproxy') {
          const pathAndQuery = proxied.searchParams.get('url');
          const original = this.getOriginalHeaders(pathAndQuery) ?? {};
          const authKey = Object.keys(original).find((key) => key.toLowerCase() === 'authorization');
          if (authKey) {
            requestHeaders.Authorization = original[authKey];
            hasAuth = true;
          }
        }
      } catch {
        // ignore malformed proxy URLs
      }
    }
    log.debug('[routing headers]', details.url, hasAuth ? 'auth' : 'no-auth');
    const originKey = Object.keys(requestHeaders).find((key) => key.toLowerCase() === 'origin');
    const origin = originKey ? requestHeaders[originKey] : null;
    if (origin) {
      if (hit) hit.origin = origin;
      if (details.url) {
        this.originByUrl.set(details.url, origin);
        if (this.originByUrl.size > 200) {
          const oldest = this.originByUrl.keys().next().value;
          this.originByUrl.delete(oldest);
        }
      }
    }
    if (hit) hit.requestHeaders = { ...requestHeaders };
    callback({ requestHeaders });
  }

  headersReceived(details, callback) {
    const hit = this.pending.get(details.id);
    const related = Boolean(hit) || isTargetUrl(this.getRules(), details.url);
    if (!related) {
      callback({ responseHeaders: details.responseHeaders });
      return;
    }

    const isPreflight = Boolean(hit?.options) || details.method === 'OPTIONS';
    const statusCode = details.statusCode ?? 200;
    const origin = hit?.origin
      ?? (details.url ? this.originByUrl.get(details.url) : null)
      ?? this.getPageOrigin()
      ?? null;
    const responseHeaders = applyCorsHeaders(details.responseHeaders, {
      origin,
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
    this.originByUrl.clear();
  }
}
