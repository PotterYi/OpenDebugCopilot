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

const ELEMENT_HIGHLIGHT_CONFIG = {
  showInfo: true,
  contentColor: { r: 245, g: 158, b: 11, a: 0.35 },
  paddingColor: { r: 245, g: 158, b: 11, a: 0.2 },
  borderColor: { r: 245, g: 158, b: 11, a: 0.9 },
  marginColor: { r: 245, g: 158, b: 11, a: 0.15 },
};
const withTimeout = (promise, ms, message = 'operation timed out') => Promise.race([
  promise,
  new Promise((_, reject) => setTimeout(() => reject(new Error(message)), ms)),
]);

/**
 * Extract a serializable snapshot of the inspected element. Runs inside the page
 * through Runtime.callFunctionOn, so it must not reference outer variables.
 */
function elementInfoExtractor() {
  const el = this;
  const win = el.ownerDocument?.defaultView || window;
  const escapeCss = (value) => (win.CSS && win.CSS.escape
    ? win.CSS.escape(String(value))
    : String(value).replace(/[^a-zA-Z0-9_-]/g, '\\$&'));

  const selectorFor = (node, depthLevel = 0) => {
    if (!node || node.nodeType !== 1) return '';
    if (node.id) return `#${escapeCss(node.id)}`;
    if (depthLevel > 6) return node.tagName.toLowerCase();
    const parts = [];
    let current = node;
    for (let depth = 0; current && current.nodeType === 1 && depth < 4; depth += 1) {
      let part = current.tagName.toLowerCase();
      const classes = [...current.classList]
        .filter((name) => !name.startsWith('data-v-'))
        .slice(0, 2);
      if (classes.length) part += `.${classes.map(escapeCss).join('.')}`;
      const parent = current.parentElement;
      if (parent) {
        const siblings = [...parent.children].filter((child) => child.tagName === current.tagName);
        if (siblings.length > 1) part += `:nth-of-type(${siblings.indexOf(current) + 1})`;
      }
      parts.unshift(part);
      if (!parent) {
        const root = current.getRootNode && current.getRootNode();
        if (root && root.host) {
          return `${selectorFor(root.host, depthLevel + 1)} >>> ${parts.join(' > ')}`;
        }
      }
      current = parent;
    }
    return parts.join(' > ');
  };

  const SENSITIVE_ATTR = /^(?:value|password|token|secret|authorization|cookie|set-cookie)$/i;
  const attributes = {};
  for (const attr of [...(el.attributes ?? [])].slice(0, 30)) {
    if (SENSITIVE_ATTR.test(attr.name)) continue;
    attributes[attr.name] = String(attr.value ?? '').slice(0, 200);
  }

  const tag = String(el.tagName || '').toLowerCase();
  const text = /^(?:input|textarea|select|option)$/.test(tag)
    ? String(el.getAttribute('placeholder') || el.getAttribute('aria-label') || el.getAttribute('name') || '').trim().slice(0, 300)
    : String(el.innerText || el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 300);

  const computed = win.getComputedStyle(el);
  const styleKeys = [
    'display', 'visibility', 'position', 'width', 'height', 'overflow', 'overflowX', 'overflowY',
    'color', 'backgroundColor', 'fontSize', 'fontWeight', 'lineHeight', 'margin', 'padding',
    'zIndex', 'opacity', 'flex', 'gridTemplateColumns', 'textAlign', 'whiteSpace',
  ];
  const styles = {};
  for (const key of styleKeys) styles[key] = computed[key];

  const ancestors = [];
  const nextAncestor = (node) => {
    if (!node) return null;
    if (node.parentElement) return node.parentElement;
    const root = node.getRootNode && node.getRootNode();
    return root?.host ?? null;
  };
  let parent = nextAncestor(el);
  for (let depth = 0; parent && depth < 5; depth += 1) {
    ancestors.push({
      tag: parent.tagName.toLowerCase(),
      id: parent.id || null,
      classes: [...parent.classList].slice(0, 4),
      selector: selectorFor(parent),
    });
    parent = nextAncestor(parent);
  }

  let frameworkNode = el;
  for (let probe = el; probe;) {
    const keys = Object.keys(probe);
    if (probe.__vueParentComponent || probe.__vue__
      || keys.some((key) => key.startsWith('__reactFiber$') || key.startsWith('__reactInternalInstance$'))
      || probe.__svelte_meta) {
      frameworkNode = probe;
      break;
    }
    probe = nextAncestor(probe);
  }

  let framework = null;
  try {
    const vue3 = frameworkNode.__vueParentComponent;
    if (vue3) {
      let current = vue3;
      let file = null;
      let name = null;
      const hierarchy = [];
      for (let depth = 0; current && depth < 10; depth += 1) {
        const type = current.type || {};
        const candidate = type.__name || type.name || type.__file || '?';
        hierarchy.push(candidate);
        if (!file && type.__file) file = type.__file;
        if (!name && (type.__name || type.name)) name = type.__name || type.name;
        current = current.parent;
      }
      framework = {
        name: 'vue3',
        componentName: name,
        componentFile: file,
        hierarchy,
        confidence: file ? 'high' : 'medium',
      };
    } else if (frameworkNode.__vue__) {
      const options = frameworkNode.__vue__.$options || {};
      framework = {
        name: 'vue2',
        componentName: options.name || frameworkNode.__vue__.$options?._componentTag || null,
        componentFile: options.__file || null,
        hierarchy: [options.name || options.__file || '?'].filter(Boolean),
        confidence: options.__file ? 'high' : 'medium',
      };
    }
    if (!framework) {
      const fiberKey = Object.keys(frameworkNode).find((key) => (
        key.startsWith('__reactFiber$') || key.startsWith('__reactInternalInstance$')
      ));
      let fiber = fiberKey ? frameworkNode[fiberKey] : null;
      for (let depth = 0; fiber && depth < 20; depth += 1) {
        const type = fiber.type;
        if (typeof type === 'function' || (type && typeof type === 'object' && type.displayName)) {
          const source = fiber._debugSource || null;
          framework = {
            name: 'react',
            componentName: type.displayName || type.name || null,
            componentFile: source?.fileName || null,
            line: source?.lineNumber || null,
            hierarchy: [],
            confidence: source?.fileName ? 'high' : 'medium',
          };
          break;
        }
        fiber = fiber.return;
      }
    }
    if (!framework && win.ng && typeof win.ng.getComponent === 'function') {
      const component = win.ng.getComponent(el);
      if (component) {
        framework = {
          name: 'angular',
          componentName: component.constructor?.name || null,
          componentFile: null,
          hierarchy: [component.constructor?.name].filter(Boolean),
          confidence: 'medium',
        };
      }
    }
    if (!framework && frameworkNode.__svelte_meta) {
      const loc = frameworkNode.__svelte_meta.loc || {};
      framework = {
        name: 'svelte',
        componentName: null,
        componentFile: loc.file || null,
        line: loc.line || loc.start?.line || null,
        hierarchy: [],
        confidence: loc.file ? 'high' : 'medium',
      };
    }
  } catch {
    framework = null;
  }

  const rawRect = el.getBoundingClientRect();
  let offsetX = 0;
  let offsetY = 0;
  let frameUrl = null;
  try {
    let frameWindow = win;
    while (frameWindow && frameWindow.frameElement) {
      const frameRect = frameWindow.frameElement.getBoundingClientRect();
      offsetX += frameRect.left;
      offsetY += frameRect.top;
      frameWindow = frameWindow.parent;
    }
    if (win !== window) frameUrl = win.location.href;
  } catch {
    // cross-origin frame; keep the local coordinates
  }
  let pageUrl = window.location.href;
  let route = `${window.location.pathname}${window.location.search}`;
  let title = document.title;
  try {
    pageUrl = win.location.href;
    route = `${win.location.pathname}${win.location.search}`;
    title = win.document.title || title;
  } catch {
    // keep parent values
  }
  return {
    page: {
      url: pageUrl,
      topUrl: window.location.href,
      frameUrl,
      title,
      route,
    },
    selector: selectorFor(el),
    tag,
    id: el.id || null,
    classes: [...el.classList].slice(0, 12),
    attributes,
    text,
    html: String(el.outerHTML || '').slice(0, 2000),
    rect: {
      x: Math.round(rawRect.x + offsetX), y: Math.round(rawRect.y + offsetY),
      width: Math.round(rawRect.width), height: Math.round(rawRect.height),
      top: Math.round(rawRect.top + offsetY), left: Math.round(rawRect.left + offsetX),
      bottom: Math.round(rawRect.bottom + offsetY), right: Math.round(rawRect.right + offsetX),
    },
    scroll: {
      x: Math.round(window.scrollX || 0),
      y: Math.round(window.scrollY || 0),
      innerWidth: Math.round(window.innerWidth || 0),
      innerHeight: Math.round(window.innerHeight || 0),
    },
    frame: { url: frameUrl, offsetX: Math.round(offsetX), offsetY: Math.round(offsetY) },
    styles,
    ancestors,
    framework,
    shadowHost: el.getRootNode && el.getRootNode().host ? selectorFor(el.getRootNode().host) : null,
  };
}

const ELEMENT_EXTRACT_SOURCE = elementInfoExtractor.toString();

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
    this.elementPicking = false;
    this.elementLastError = null;
    this.elementLastScreenshotError = null;
    this.elementScreenshots = new Map();

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
      if (this.elementPicking) {
        this.elementPicking = false;
        this.elementScreenshots.clear();
        this.emit({ type: 'element-pick-cancel' });
      }
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

  consumeElementScreenshot(id) {
    const key = String(id ?? '');
    const screenshot = this.elementScreenshots.get(key);
    if (screenshot) this.elementScreenshots.delete(key);
    return screenshot ?? null;
  }

  clearElementScreenshots() {
    this.elementScreenshots.clear();
  }

  async stopElementInspectMode() {
    // CDP requires highlightConfig even for mode:'none'. Omitting it makes the
    // command fail silently and leaves the page in inspect mode.
    await this.sendCdp('Overlay.setInspectMode', {
      mode: 'none',
      highlightConfig: ELEMENT_HIGHLIGHT_CONFIG,
    }).catch(() => {});
    await this.sendCdp('Overlay.disable').catch(() => {});
  }

  async startElementPick() {
    this.elementLastError = null;
    this.elementLastScreenshotError = null;
    await this.sendCdp('DOM.enable');
    await this.sendCdp('Overlay.enable');
    this.elementPicking = true;
    await this.sendCdp('Overlay.setInspectMode', {
      mode: 'searchForNode',
      highlightConfig: ELEMENT_HIGHLIGHT_CONFIG,
    });
    this.emit({ type: 'element-pick-start' });
  }

  async cancelElementPick() {
    this.elementPicking = false;
    this.elementScreenshots.clear();
    await this.stopElementInspectMode();
    this.emit({ type: 'element-pick-cancel' });
  }

  async toggleElementPick() {
    if (this.elementPicking) {
      await this.cancelElementPick();
      return { picking: false };
    }
    await this.startElementPick();
    return { picking: true };
  }

  async handleElementPicked(backendNodeId) {
    if (!this.elementPicking) return;
    this.elementPicking = false;
    await this.stopElementInspectMode();
    try {
      const resolved = await this.sendCdp('DOM.resolveNode', { backendNodeId });
      const objectId = resolved?.object?.objectId;
      if (!objectId) throw new Error('无法解析选中的元素');
      const extracted = await this.sendCdp('Runtime.callFunctionOn', {
        objectId,
        functionDeclaration: ELEMENT_EXTRACT_SOURCE,
        returnByValue: true,
      });
      const info = extracted?.result?.value;
      if (!info || typeof info !== 'object') throw new Error('元素信息提取失败');
      info.id = `element-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
      info.capturedAt = Date.now();
      info.nearbyRequests = this.list({ limit: 10 }).map((record) => ({
        method: record.method,
        url: record.url,
        status: record.status,
        durationMs: record.durationMs,
      }));
      try {
        const rect = info.rect ?? {};
        if (rect.width > 0 && rect.height > 0) {
          const padding = 24;
          const bounds = {
            x: Math.max(0, Math.round((rect.left ?? rect.x ?? 0) - padding)),
            y: Math.max(0, Math.round((rect.top ?? rect.y ?? 0) - padding)),
            width: Math.max(16, Math.round(rect.width + padding * 2)),
            height: Math.max(16, Math.round(rect.height + padding * 2)),
          };
          const scroll = info.scroll ?? {};
          const maxWidth = Math.max(80, scroll.innerWidth || 1200);
          const maxHeight = Math.max(80, scroll.innerHeight || 800);
          const clipBounds = {
            x: bounds.x,
            y: bounds.y,
            width: Math.min(bounds.width, maxWidth),
            height: Math.min(bounds.height, maxHeight),
          };
          let dataUrl = null;
          try {
            await withTimeout(this.sendCdp('Page.enable'), 500).catch(() => {});
            const shot = await withTimeout(this.sendCdp('Page.captureScreenshot', {
              format: 'png',
              fromSurface: true,
              clip: {
                x: clipBounds.x + (scroll.x ?? 0),
                y: clipBounds.y + (scroll.y ?? 0),
                width: clipBounds.width,
                height: clipBounds.height,
                scale: 1,
              },
            }), 2000, 'screenshot timeout');
            if (shot?.data) {
              const size = Buffer.from(shot.data, 'base64').length;
              if (size <= 2 * 1024 * 1024) {
                dataUrl = `data:image/png;base64,${shot.data}`;
              } else {
                this.elementLastScreenshotError = `screenshot too large: ${size}`;
              }
            }
          } catch (error) {
            this.elementLastScreenshotError = error?.message ?? String(error);
          }
          if (!dataUrl) {
            try {
              const image = await withTimeout(this.view.webContents.capturePage(clipBounds), 1500, 'capturePage timeout');
              if (!image.isEmpty()) {
                const png = image.toPNG();
                if (png.length <= 2 * 1024 * 1024) {
                  dataUrl = `data:image/png;base64,${png.toString('base64')}`;
                } else {
                  this.elementLastScreenshotError = `screenshot too large: ${png.length}`;
                }
              } else if (!this.elementLastScreenshotError) {
                this.elementLastScreenshotError = 'capturePage returned an empty image';
              }
            } catch (error) {
              if (!this.elementLastScreenshotError) {
                this.elementLastScreenshotError = error?.message ?? String(error);
              }
            }
          }
          if (dataUrl) {
            info.screenshotDataUrl = dataUrl;
            info.screenshotRect = bounds;
            this.elementLastScreenshotError = null;
          }
        } else {
          this.elementLastScreenshotError = 'selected element has no visible size';
        }
      } catch (error) {
        this.elementLastScreenshotError = error?.message ?? String(error);
        log.warn('[element] screenshot failed:', this.elementLastScreenshotError);
      }
      if (info.screenshotDataUrl) {
        this.elementScreenshots.set(info.id, {
          dataUrl: info.screenshotDataUrl,
          rect: info.screenshotRect ?? null,
        });
      }
      const picked = { ...info };
      delete picked.screenshotDataUrl;
      // The composer lives outside the inspected page, so the picker can never
      // swallow its clicks.
      this.emit({ type: 'element-picked', element: picked });
    } catch (error) {
      this.elementLastError = error?.message ?? String(error);
      log.warn('[element] extract failed:', this.elementLastError, error?.stack ?? '');
      this.emit({ type: 'element-error', message: this.elementLastError });
    }
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

    if (method === 'Overlay.inspectNodeRequested') {
      this.handleElementPicked(params.backendNodeId).catch((error) => {
        log.warn('[element] pick failed:', error?.message ?? error);
      });
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
