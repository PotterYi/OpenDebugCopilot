import { WebContentsView } from 'electron';
import { normalizeLocalhost } from './routing.mjs';
import { log } from '../../core/logger.mjs';

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
 * Embedded browser host: WebContentsView + CDP capture.
 * Routing (S4) is intentionally not part of this module.
 */
export class BrowserHost {
  /**
   * @param {{ window: import('electron').BrowserWindow, onEvent?: (event: any) => void }} options
   */
  constructor({ window, onEvent = () => {} }) {
    this.window = window;
    this.onEvent = onEvent;
    this.records = new Map();
    this.byRequestId = new Map();
    this.order = [];
    this.seq = 0;
    this.attached = false;
    this.networkEnabled = false;
    this.pendingUrl = null;
    this.loading = false;
    this.consoleEvents = [];
    this.headersByPath = new Map();
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
    });
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
    this.consoleEvents.push(event);
    if (this.consoleEvents.length > 200) this.consoleEvents.shift();
    this.emit({ type: 'console', event });
  }

  findRequestHeadersByPath(pathAndQuery) {
    return this.headersByPath.get(pathAndQuery) ?? null;
  }

  listConsole({ limit = 50 } = {}) {
    return this.consoleEvents.slice(-limit);
  }

  clearConsole() {
    this.consoleEvents = [];
    this.headersByPath = new Map();
    this.emit({ type: 'console-clear' });
  }

  handleCdp(method, params) {
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
          if (this.headersByPath.size > 300) {
            const oldest = this.headersByPath.keys().next().value;
            this.headersByPath.delete(oldest);
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
      .filter((record) => (errorsOnly ? Boolean(record.error) || (record.status ?? 0) >= 400 : true));
    return records.slice(-limit).map((record) => this.summary(record)).reverse();
  }

  detail(id) {
    const record = this.records.get(String(id));
    return record ? { ...record } : null;
  }

  clear() {
    this.records.clear();
    this.byRequestId.clear();
    this.order = [];
    this.consoleEvents = [];
    this.headersByPath = new Map();
    this.emit({ type: 'clear' });
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
