import { WebContentsView } from 'electron';
import { buildPreflightResponse, isLocalHostname, normalizeLocalhost } from './routing.mjs';
import { log } from '../../core/logger.mjs';
import { detectBusinessError } from '../../evidence/business.mjs';

const MAX_RECORDS = 500;
const MAX_BODY_BYTES = 1024 * 1024;
const BODY_TYPES = new Set(['XHR', 'Fetch', 'Document']);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function decodeBody(payload) {
  if (!payload) return null;
  const buffer = payload.base64Encoded
    ? Buffer.from(payload.body, 'base64')
    : Buffer.from(payload.body, 'utf8');
  const truncated = buffer.length > MAX_BODY_BYTES;
  return {
    text: (truncated ? buffer.subarray(0, MAX_BODY_BYTES) : buffer).toString('utf8'),
    truncated,
    bytes: buffer.length,
  };
}

/**
 * CDP Fetch patterns for local routing targets. Loopback hosts are duplicated so a
 * target declared as localhost also catches requests made to 127.0.0.1 (and vice versa).
 */
function localTargetPatterns(rules) {
  const patterns = new Set();
  for (const rule of rules ?? []) {
    if (rule.enabled === false) continue;
    if (rule.target?.kind !== 'local' || !rule.target?.baseUrl) continue;
    let target;
    try {
      target = new URL(rule.target.baseUrl);
    } catch {
      continue;
    }
    const port = target.port ? `:${target.port}` : '';
    patterns.add(`${target.origin}/*`);
    if (isLocalHostname(target.hostname)) {
      patterns.add(`${target.protocol}//localhost${port}/*`);
      patterns.add(`${target.protocol}//127.0.0.1${port}/*`);
    }
  }
  return [...patterns];
}

/**
 * Embedded browser host: WebContentsView + CDP capture.
 * Routing redirects live in routing.mjs; this module only answers local CORS preflights
 * via CDP Fetch so they never reach the real backend.
 */
export class BrowserHost {
  /**
   * @param {{
   *   window: import('electron').BrowserWindow,
   *   onEvent?: (event: any) => void,
   *   getRoutingRules?: () => Array<any>
   * }} options
   */
  constructor({ window, onEvent = () => {}, getRoutingRules = () => [] }) {
    this.window = window;
    this.onEvent = onEvent;
    this.getRoutingRules = getRoutingRules;
    this.records = new Map();
    this.byRequestId = new Map();
    this.order = [];
    this.seq = 0;
    this.attached = false;
    this.networkEnabled = false;
    this.preflightEnabled = false;
    this.preflightPatternsKey = '';
    this.pendingUrl = null;
    this.loading = false;
    this.consoleEvents = [];
    this.consoleSeq = 0;
    this.headersByPath = new Map();
    this.headersByUrl = new Map();
    this.visible = false;
    this.bounds = { x: 0, y: 0, width: 0, height: 0 };

    this.view = new WebContentsView({
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true,
        partition: 'persist:dc-browser',
      },
    });
    this.view.setBackgroundColor('#ffffff');
    window.contentView.addChildView(this.view);
    this.view.setBounds({ x: 0, y: 0, width: 0, height: 0 });
    if (typeof this.view.setVisible === 'function') this.view.setVisible(false);

    const contents = this.view.webContents;
    this.loading = contents.isLoading();
    contents.setWindowOpenHandler(() => ({ action: 'deny' }));
    contents.on('did-start-loading', () => {
      this.loading = true;
      this.emit({ type: 'loading', isLoading: true, url: contents.getURL(), pendingUrl: this.pendingUrl });
    });
    contents.on('did-stop-loading', () => {
      this.loading = false;
      this.pendingUrl = null;
      this.emit({ type: 'loading', isLoading: false, url: contents.getURL(), pendingUrl: null });
    });
    contents.on('console-message', (_event, details) => {
      const level = details?.level ?? 0;
      const message = details?.message ?? '';
      const line = details?.lineNumber ?? 0;
      const sourceId = details?.sourceId ?? '';
      if (level >= 2) log.warn('[browser console]', `${message} (${sourceId}:${line})`);
    });
    contents.on('did-fail-load', (_event, code, description, url) => {
      this.loading = contents.isLoading();
      log.warn('[browser load failed]', `${code} ${description} ${url}`);
      this.emit({ type: 'load-failed', code, description, url });
    });
    contents.on('did-navigate', (_event, url) => {
      this.pendingUrl = null;
      this.emit({ type: 'navigation', url });
    });
    contents.on('did-navigate-in-page', (_event, url) => this.emit({ type: 'navigation', url }));

    this.attachCdp();
  }

  attachCdp() {
    const contents = this.view.webContents;
    try {
      if (!contents.debugger.isAttached()) contents.debugger.attach('1.3');
      this.attached = true;
    } catch (error) {
      this.attached = false;
      this.emit({ type: 'error', message: `CDP attach failed: ${error.message}` });
      return;
    }
    // Fetch.enable works before the first navigation (unlike Network.enable), so local
    // preflights can be answered even for the very first page load.
    this.syncPreflightInterception();
    const enableNetwork = () => {
      if (this.networkEnabled) return;
      this.networkEnabled = true;
      contents.debugger.sendCommand('Network.enable').catch(() => {});
      contents.debugger.sendCommand('Runtime.enable').catch(() => {});
    };
    // WebContentsView has no renderer target before the first navigation;
    // calling Network.enable that early can hang the CDP session.
    if (contents.getURL() && contents.getURL() !== 'about:blank' && !contents.isLoading()) {
      enableNetwork();
    } else {
      contents.once('dom-ready', enableNetwork);
    }
    contents.on('dom-ready', enableNetwork);
    contents.debugger.on('message', (_event, method, params) => this.handleCdp(method, params));
    contents.debugger.on('detach', () => {
      this.attached = false;
      this.networkEnabled = false;
      this.preflightEnabled = false;
      this.preflightPatternsKey = '';
    });
  }

  /** Re-enable CDP Fetch with patterns derived from the current local routing targets. */
  syncPreflightInterception() {
    if (!this.attached) return;
    const patterns = localTargetPatterns(this.getRoutingRules());
    const key = patterns.slice().sort().join('\n');
    if (key === this.preflightPatternsKey) return;
    const debuggerApi = this.view.webContents.debugger;
    if (patterns.length === 0) {
      this.preflightPatternsKey = key;
      if (this.preflightEnabled) {
        this.preflightEnabled = false;
        debuggerApi.sendCommand('Fetch.disable').catch(() => {});
      }
      return;
    }
    debuggerApi
      .sendCommand('Fetch.enable', { patterns: patterns.map((urlPattern) => ({ urlPattern })) })
      .then(() => {
        this.preflightEnabled = true;
        this.preflightPatternsKey = key;
      })
      .catch((error) => log.warn('[preflight] Fetch.enable failed:', error?.message ?? error));
  }

  sendCdp(method, params = {}) {
    const debuggerApi = this.view.webContents.debugger;
    if (!this.attached || !debuggerApi.isAttached()) {
      return Promise.reject(new Error('CDP is not attached'));
    }
    return debuggerApi.sendCommand(method, params);
  }

  /**
   * CDP paused a request to a local target: answer CORS preflights ourselves so the
   * backend never sees OPTIONS (avoiding e.g. DefaultOptionsMethodException); continue
   * everything else untouched.
   */
  async handlePreflightRequest({ requestId, request }) {
    try {
      const response = buildPreflightResponse(
        request?.url,
        request?.method,
        request?.headers ?? {},
        this.getRoutingRules(),
      );
      if (!response) {
        await this.sendCdp('Fetch.continueRequest', { requestId });
        return;
      }
      await this.sendCdp('Fetch.fulfillRequest', {
        requestId,
        responseCode: response.statusCode,
        responseHeaders: Object.entries(response.headers).map(([name, value]) => ({
          name,
          // applyCorsHeaders stores header values as arrays; CDP expects a string.
          value: Array.isArray(value) ? value[0] : String(value),
        })),
      });
      log.debug('[preflight] answered locally', request?.method, request?.url);
    } catch (error) {
      log.warn('[preflight] local answer failed:', error?.message ?? error);
      this.sendCdp('Fetch.continueRequest', { requestId }).catch(() => {});
    }
  }

  emit(event) {
    if (!this.window.isDestroyed()) this.onEvent(event);
  }

  summary(record) {
    return {
      id: record.id,
      url: record.url,
      method: record.method,
      resourceType: record.resourceType,
      status: record.status,
      durationMs: record.durationMs,
      error: record.error,
      startedAt: record.startedAt,
      finished: record.finished,
      businessError: record.businessError,
      businessCode: record.businessCode,
      businessMessage: record.businessMessage,
    };
  }

  trim() {
    while (this.order.length > MAX_RECORDS) {
      const id = this.order.shift();
      const record = this.records.get(id);
      if (record) this.byRequestId.delete(record.requestId);
      this.records.delete(id);
    }
  }

  pushConsole(event) {
    event.id = String(++this.consoleSeq);
    this.consoleEvents.push(event);
    if (this.consoleEvents.length > 200) this.consoleEvents.shift();
    this.emit({ type: 'console', event });
  }

  findRequestHeadersByPath(pathAndQuery) {
    return this.headersByPath.get(pathAndQuery) ?? null;
  }

  findRequestHeaders(url) {
    return this.headersByUrl.get(url) ?? null;
  }

  listConsole({ limit = 50 } = {}) {
    return this.consoleEvents.slice(-limit);
  }

  clearConsole({ exceptIds = [] } = {}) {
    const keep = new Set((exceptIds ?? []).map(String));
    if (keep.size === 0) {
      this.consoleEvents = [];
      this.consoleSeq = 0;
    } else {
      this.consoleEvents = this.consoleEvents.filter((event) => keep.has(String(event.id)));
    }
    this.headersByPath = new Map();
    this.headersByUrl = new Map();
    this.emit({ type: 'console-clear', keepIds: [...keep] });
  }

  handleCdp(method, params) {
    if (method === 'Fetch.requestPaused') {
      this.handlePreflightRequest(params);
      return;
    }

    if (method === 'Runtime.exceptionThrown') {
      const details = params.exceptionDetails ?? {};
      const frames = (details.stackTrace?.callFrames ?? []).map(
        (frame) => `at ${frame.functionName || '<anonymous>'} (${frame.url || '<anonymous>'}:${(frame.lineNumber ?? 0) + 1}:${(frame.columnNumber ?? 0) + 1})`,
      );
      this.pushConsole({
        kind: 'exception',
        ts: Date.now(),
        message: details.exception?.description || details.text || 'Uncaught exception',
        url: details.url,
        line: (details.lineNumber ?? 0) + 1,
        column: (details.columnNumber ?? 0) + 1,
        stack: frames,
      });
      return;
    }

    if (method === 'Runtime.consoleAPICalled') {
      if (params.type !== 'error' && params.type !== 'assert') return;
      const message = (params.args ?? [])
        .map((arg) => arg.value ?? arg.description ?? arg.type ?? '')
        .join(' ');
      const frames = (params.stackTrace?.callFrames ?? []).map(
        (frame) => `at ${frame.functionName || '<anonymous>'} (${frame.url || '<anonymous>'}:${(frame.lineNumber ?? 0) + 1}:${(frame.columnNumber ?? 0) + 1})`,
      );
      this.pushConsole({
        kind: 'console-error',
        ts: Date.now(),
        message,
        url: params.stackTrace?.callFrames?.[0]?.url,
        line: (params.stackTrace?.callFrames?.[0]?.lineNumber ?? 0) + 1,
        column: (params.stackTrace?.callFrames?.[0]?.columnNumber ?? 0) + 1,
        stack: frames,
      });
      return;
    }

    if (method === 'Network.requestWillBeSent') {
      const request = params.request ?? {};
      if (request.url) {
        try {
          const parsed = new URL(request.url);
          this.headersByPath.set(`${parsed.pathname}${parsed.search}`, request.headers ?? {});
          this.headersByUrl.set(request.url, request.headers ?? {});
          while (this.headersByPath.size > 300) {
            const oldest = this.headersByPath.keys().next().value;
            this.headersByPath.delete(oldest);
          }
          while (this.headersByUrl.size > 300) {
            const oldest = this.headersByUrl.keys().next().value;
            this.headersByUrl.delete(oldest);
          }
        } catch {
          // ignore invalid URLs
        }
      }
      const startedAt = params.wallTime ? Math.round(params.wallTime * 1000) : Date.now();
      const existing = this.byRequestId.get(params.requestId);
      if (existing) {
        existing.url = request.url ?? existing.url;
        existing.method = request.method ?? existing.method;
        existing.startedAt = startedAt;
        this.emit({ type: 'update', record: this.summary(existing) });
        return;
      }
      const record = {
        id: `${++this.seq}`,
        requestId: params.requestId,
        url: request.url ?? '',
        method: request.method ?? 'GET',
        resourceType: params.type ?? 'Other',
        requestHeaders: request.headers ?? {},
        postData: request.postData ?? null,
        startedAt,
        status: null,
        statusText: '',
        responseHeaders: {},
        mimeType: '',
        durationMs: null,
        error: null,
        finished: false,
        body: null,
        bodyError: null,
        businessError: null,
        businessCode: null,
        businessMessage: null,
      };
      this.records.set(record.id, record);
      this.byRequestId.set(params.requestId, record);
      this.order.push(record.id);
      this.trim();
      this.emit({ type: 'request', record: this.summary(record) });
      return;
    }

    const record = this.byRequestId.get(params.requestId);
    if (!record) return;

    if (method === 'Network.responseReceived') {
      record.status = params.response?.status ?? null;
      record.statusText = params.response?.statusText ?? '';
      record.responseHeaders = params.response?.headers ?? {};
      record.mimeType = params.response?.mimeType ?? '';
      this.emit({ type: 'update', record: this.summary(record) });
      if (record.method === 'OPTIONS' && (record.status ?? 0) >= 400) {
        this.emit({
          type: 'cors-warning',
          url: record.url,
          status: record.status,
          message: 'Preflight (OPTIONS) returned a non-2xx status; the browser will block the request',
        });
      }
      return;
    }

    if (method === 'Network.loadingFinished') {
      record.finished = true;
      record.durationMs = record.startedAt ? Date.now() - record.startedAt : null;
      this.emit({ type: 'update', record: this.summary(record) });
      if (BODY_TYPES.has(record.resourceType)) this.fetchBody(record);
      return;
    }

    if (method === 'Network.loadingFailed') {
      record.finished = true;
      record.error = params.errorText ?? 'request failed';
      record.durationMs = record.startedAt ? Date.now() - record.startedAt : null;
      log.warn('[browser request failed]', `${record.method} ${record.url} ${record.error}`);
      this.emit({ type: 'update', record: this.summary(record) });
    }
  }

  async fetchBody(record) {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const payload = await this.view.webContents.debugger.sendCommand('Network.getResponseBody', {
          requestId: record.requestId,
        });
        record.body = decodeBody(payload);
        record.bodyError = null;
        this.emit({ type: 'update', record: this.summary(record) });
        return;
      } catch (error) {
        if (attempt < 2) {
          await sleep(100);
          continue;
        }
        record.bodyError = error?.message ?? String(error);
        this.emit({ type: 'update', record: this.summary(record) });
      }
    }
  }

  async loadBody(id) {
    const record = this.records.get(String(id));
    if (!record) return null;
    if (!record.body) {
      record.bodyError = null;
      await this.fetchBody(record);
    }
    return { ...record };
  }

  get session() {
    return this.view.webContents.session;
  }

  open(url) {
    if (!url) throw new Error('open requires a URL');
    // Chromium returns ERR_ABORTED for 127.0.0.1 in the embedded view.
    const normalized = normalizeLocalhost(url);
    const parsed = new URL(normalized);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error('Only http/https URLs are allowed');
    }
    const contents = this.view.webContents;
    this.pendingUrl = normalized;
    this.loading = true;
    this.emit({ type: 'loading', isLoading: true, url: contents.getURL(), pendingUrl: normalized });
    // loadURL() resolves when navigation starts, not when it commits.
    // Readiness must be checked with webContents.isLoading().
    contents.loadURL(normalized).catch((error) => {
      if (!String(error?.message ?? '').includes('ERR_ABORTED')) {
        this.emit({ type: 'load-failed', code: null, description: error?.message ?? String(error), url: normalized });
      }
    });
    return { url: normalized, pendingUrl: normalized };
  }

  reload() {
    this.view.webContents.reload();
  }

  back() {
    const history = this.view.webContents.navigationHistory;
    if (history.canGoBack()) history.goBack();
  }

  forward() {
    const history = this.view.webContents.navigationHistory;
    if (history.canGoForward()) history.goForward();
  }

  devtools() {
    this.view.webContents.openDevTools({ mode: 'detach' });
  }

  setBounds(bounds = {}) {
    const visible = bounds.visible !== false;
    this.bounds = {
      x: Math.max(0, Math.round(bounds.x ?? 0)),
      y: Math.max(0, Math.round(bounds.y ?? 0)),
      width: Math.max(0, Math.round(bounds.width ?? 0)),
      height: Math.max(0, Math.round(bounds.height ?? 0)),
    };
    this.visible = visible && this.bounds.width > 0 && this.bounds.height > 0;
    this.view.setBounds(this.bounds);
    if (typeof this.view.setVisible === 'function') this.view.setVisible(this.visible);
  }

  list({ resourceType, errorsOnly, limit = 200 } = {}) {
    const records = this.order
      .map((id) => this.records.get(id))
      .filter(Boolean)
      .filter((record) => (resourceType ? record.resourceType === resourceType : true))
      .filter((record) => (errorsOnly
        ? Boolean(record.error) || (record.status ?? 0) >= 400 || Boolean(record.businessError)
        : true));
    return records.slice(-limit).map((record) => this.summary(record)).reverse();
  }

  detail(id) {
    const record = this.records.get(String(id));
    return record ? { ...record } : null;
  }

  /**
   * Clear captured data while keeping the records that are still being
   * diagnosed. Kept request/console ids survive a partial clear.
   */
  clear({ exceptIds = [], exceptConsoleIds = [] } = {}) {
    const keepRequests = new Set((exceptIds ?? []).map(String));
    const keepConsoles = new Set((exceptConsoleIds ?? []).map(String));

    if (keepRequests.size === 0) {
      this.records.clear();
      this.byRequestId.clear();
      this.order = [];
    } else {
      for (const id of [...this.records.keys()]) {
        if (!keepRequests.has(String(id))) this.records.delete(id);
      }
      this.order = this.order.filter((id) => this.records.has(id));
      this.byRequestId = new Map();
      for (const record of this.records.values()) {
        if (record.requestId) this.byRequestId.set(record.requestId, record);
      }
    }

    if (keepConsoles.size === 0) {
      this.consoleEvents = [];
      this.consoleSeq = 0;
    } else {
      this.consoleEvents = this.consoleEvents.filter((event) => keepConsoles.has(String(event.id)));
      const maxKept = this.consoleEvents.reduce((max, event) => Math.max(max, Number(event.id) || 0), 0);
      this.consoleSeq = Math.max(this.consoleSeq, maxKept);
    }

    this.headersByPath = new Map();
    this.headersByUrl = new Map();
    this.emit({
      type: 'clear',
      keepRequestIds: [...keepRequests],
      keepConsoleIds: [...keepConsoles],
    });
  }

  status() {
    const contents = this.view.webContents;
    return {
      url: contents.getURL(),
      pendingUrl: this.pendingUrl,
      isLoading: contents.isLoading(),
      canGoBack: contents.navigationHistory.canGoBack(),
      canGoForward: contents.navigationHistory.canGoForward(),
      attached: this.attached,
      count: this.order.length,
      visible: this.visible,
    };
  }

  destroy() {
    try {
      if (this.attached) this.view.webContents.debugger.detach();
    } catch {
      // ignore
    }
    try {
      this.window.contentView.removeChildView(this.view);
    } catch {
      // ignore
    }
    try {
      this.view.webContents.close();
    } catch {
      // ignore
    }
  }
}
