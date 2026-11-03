import { WebContentsView } from 'electron';
import { normalizeLocalhost } from './routing.mjs';

const MAX_RECORDS = 500;
const MAX_BODY_BYTES = 1024 * 1024;
const BODY_TYPES = new Set(['XHR', 'Fetch']);

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
    this.order = [];
    this.seq = 0;
    this.attached = false;
    this.networkEnabled = false;
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
    contents.setWindowOpenHandler(() => ({ action: 'deny' }));
    contents.on('did-navigate', (_event, url) => this.emit({ type: 'navigation', url }));
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
      this.records.delete(id);
    }
  }

  handleCdp(method, params) {
    if (method === 'Network.requestWillBeSent') {
      const request = params.request ?? {};
      const startedAt = params.wallTime ? Math.round(params.wallTime * 1000) : Date.now();
      const existing = this.records.get(params.requestId);
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
      };
      this.records.set(record.id, record);
      this.order.push(record.id);
      this.trim();
      this.emit({ type: 'request', record: this.summary(record) });
      return;
    }

    const record = this.records.get(params.requestId);
    if (!record) return;

    if (method === 'Network.responseReceived') {
      record.status = params.response?.status ?? null;
      record.statusText = params.response?.statusText ?? '';
      record.responseHeaders = params.response?.headers ?? {};
      record.mimeType = params.response?.mimeType ?? '';
      this.emit({ type: 'update', record: this.summary(record) });
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
      this.emit({ type: 'update', record: this.summary(record) });
    }
  }

  async fetchBody(record) {
    try {
      const payload = await this.view.webContents.debugger.sendCommand('Network.getResponseBody', {
        requestId: record.requestId,
      });
      record.body = decodeBody(payload);
      this.emit({ type: 'update', record: this.summary(record) });
    } catch {
      // body is unavailable for redirects / evicted requests
    }
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
    this.view.webContents.loadURL(normalized);
  }

  reload() {
    this.view.webContents.reload();
  }

  back() {
    if (this.view.webContents.canGoBack()) this.view.webContents.goBack();
  }

  forward() {
    if (this.view.webContents.canGoForward()) this.view.webContents.goForward();
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
    this.order = [];
    this.emit({ type: 'clear' });
  }

  status() {
    const contents = this.view.webContents;
    return {
      url: contents.getURL(),
      canGoBack: contents.canGoBack(),
      canGoForward: contents.canGoForward(),
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
