import { api } from './api.js';

const $ = (id) => document.getElementById(id);
const statusEl = $('status');
const form = $('config-form');
const messageEl = $('config-message');
const runsEl = $('runs');
const reportEl = $('report');
const requestsEl = $('requests');
const detailEl = $('request-detail');
const hintEl = $('capture-hint');
const browserUrlInput = $('browser-url');
const browserSlot = $('browser-slot');
const routingList = $('routing-list');
const routingMessage = $('routing-message');

let currentTab = 'browser';
let configCache = null;
let routingRules = [];
const captureState = new Map();
let renderQueued = false;

function setStatus(text, kind = '') {
  statusEl.textContent = text;
  statusEl.className = `status ${kind}`.trim();
}

function setMessage(text, kind = '') {
  messageEl.textContent = text;
  messageEl.className = `message ${kind}`.trim();
}

function fillForm(config) {
  const workspace = config.workspace ?? {};
  form.elements.frontendUrl.value = workspace.frontendUrl ?? '';
  form.elements.backendUrl.value = workspace.backendUrl ?? '';
  form.elements.logfiles.value = (workspace.logfiles ?? []).join('\n');
  form.elements.sourceRoot.value = workspace.sourceRoot ?? '';
  form.elements.beforeMs.value = workspace.window?.beforeMs ?? 3000;
  form.elements.afterMs.value = workspace.window?.afterMs ?? 2000;
  if (!browserUrlInput.value) browserUrlInput.value = workspace.frontendUrl ?? '';
}

function readForm() {
  return {
    workspace: {
      frontendUrl: form.elements.frontendUrl.value.trim(),
      backendUrl: form.elements.backendUrl.value.trim(),
      logfiles: form.elements.logfiles.value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean),
      sourceRoot: form.elements.sourceRoot.value.trim(),
      window: {
        beforeMs: Number(form.elements.beforeMs.value) || 0,
        afterMs: Number(form.elements.afterMs.value) || 0,
      },
    },
  };
}

async function loadConfig() {
  try {
    const config = await api.getConfig();
    configCache = config;
    routingRules = config.routing?.rules ?? [];
    fillForm(config);
    renderRouting();
    setStatus(api.isDesktop ? '桌面版已连接' : 'WebUI 已连接', 'ok');
    return config;
  } catch (err) {
    setStatus(`连接失败：${err.message}`, 'error');
    return null;
  }
}

async function loadRuns() {
  runsEl.textContent = '';
  try {
    const runs = await api.listRuns();
    if (!runs.length) {
      const li = document.createElement('li');
      li.className = 'muted';
      li.textContent = '暂无诊断记录';
      runsEl.append(li);
      return;
    }
    for (const run of runs) {
      const li = document.createElement('li');
      const title = document.createElement('span');
      title.textContent = run.scenario || run.runId;
      const meta = document.createElement('span');
      meta.className = 'meta';
      const when = run.startedAt ? new Date(run.startedAt).toLocaleString() : '';
      meta.textContent = `${run.agent ?? ''} ${run.mode ?? ''} · ${when}`.trim();
      li.append(title, meta);
      li.addEventListener('click', () => showRun(run.runId));
      runsEl.append(li);
    }
  } catch (err) {
    reportEl.textContent = `加载历史失败：${err.message}`;
  }
}

async function showRun(runId) {
  reportEl.textContent = '加载中…';
  try {
    const run = await api.getRun(runId);
    reportEl.textContent = run.report || JSON.stringify(run.result, null, 2);
  } catch (err) {
    reportEl.textContent = `加载失败：${err.message}`;
  }
}

function requestPath(url) {
  try {
    const parsed = new URL(url);
    return `${parsed.pathname}${parsed.search}`;
  } catch {
    return url;
  }
}

function scheduleRender() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    renderRequests();
  });
}

function renderRequests() {
  const errorsOnly = $('only-errors').checked;
  const items = [...captureState.values()].sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0));
  const filtered = items.filter((item) => !errorsOnly || item.error || (item.status ?? 0) >= 400);
  requestsEl.textContent = '';
  for (const item of filtered) {
    const li = document.createElement('li');
    const method = document.createElement('span');
    method.className = 'method';
    method.textContent = item.method ?? '';
    const url = document.createElement('span');
    url.className = 'url';
    url.textContent = requestPath(item.url);
    url.title = item.url;
    const status = document.createElement('span');
    status.className = `status ${item.error ? 'error' : (item.status ?? 0) >= 400 ? 'error' : 'ok'}`;
    status.textContent = item.error ? 'FAIL' : item.status ?? '…';
    const duration = document.createElement('span');
    duration.textContent = item.durationMs != null ? `${item.durationMs}ms` : '';
    const type = document.createElement('span');
    type.className = 'muted';
    type.textContent = item.resourceType ?? '';
    li.append(method, url, status, duration, type);
    li.addEventListener('click', () => showRequest(item.id));
    requestsEl.append(li);
  }
  hintEl.textContent = api.isDesktop
    ? `${items.length} 条（显示 ${filtered.length}）`
    : '内嵌浏览器仅在桌面版可用';
}

async function refreshRequests() {
  if (!api.isDesktop) {
    captureState.clear();
    renderRequests();
    return;
  }
  try {
    const { requests } = await api.capture('list');
    captureState.clear();
    for (const item of requests) captureState.set(item.id, item);
    renderRequests();
  } catch (err) {
    hintEl.textContent = `加载请求失败：${err.message}`;
  }
}

async function showRequest(id) {
  detailEl.textContent = '加载中…';
  try {
    const { request } = await api.capture('detail', { id });
    if (!request) {
      detailEl.textContent = '请求已被清空或不存在';
      return;
    }
    detailEl.textContent = JSON.stringify({
      method: request.method,
      url: request.url,
      status: request.status,
      statusText: request.statusText,
      resourceType: request.resourceType,
      durationMs: request.durationMs,
      error: request.error,
      requestHeaders: request.requestHeaders,
      postData: request.postData,
      responseHeaders: request.responseHeaders,
      mimeType: request.mimeType,
      body: request.body,
    }, null, 2);
  } catch (err) {
    detailEl.textContent = `加载失败：${err.message}`;
  }
}

function syncBounds() {
  if (!browserSlot) return;
  const rect = browserSlot.getBoundingClientRect();
  const visible = currentTab === 'browser' && rect.width > 4 && rect.height > 4;
  api.browser('setBounds', {
    x: rect.left,
    y: rect.top,
    width: rect.width,
    height: rect.height,
    visible,
  }).catch(() => {});
}

function setTab(name) {
  currentTab = name;
  for (const tab of document.querySelectorAll('.tab')) {
    tab.classList.toggle('active', tab.dataset.tab === name);
  }
  for (const pane of document.querySelectorAll('.tab-pane')) {
    pane.classList.toggle('active', pane.id === `tab-${name}`);
  }
  if (name === 'browser') {
    requestAnimationFrame(syncBounds);
  } else {
    api.browser('setBounds', { visible: false }).catch(() => {});
  }
  if (name === 'requests') refreshRequests();
  if (name === 'routing') renderRouting();
  if (name === 'history') loadRuns();
}

function renderRouting() {
  routingList.textContent = '';
  if (!routingRules.length) {
    const empty = document.createElement('p');
    empty.className = 'muted';
    empty.textContent = '暂无路由规则';
    routingList.append(empty);
    return;
  }
  for (const rule of routingRules) {
    const row = document.createElement('div');
    row.className = 'rule-row';
    row.dataset.id = rule.id;

    const enabled = document.createElement('input');
    enabled.type = 'checkbox';
    enabled.dataset.field = 'enabled';
    enabled.checked = rule.enabled !== false;

    const host = document.createElement('input');
    host.type = 'text';
    host.dataset.field = 'host';
    host.placeholder = 'api.example.com（空=任意）';
    host.value = rule.match?.host ?? '';

    const prefix = document.createElement('input');
    prefix.type = 'text';
    prefix.dataset.field = 'prefix';
    prefix.placeholder = '/api/order';
    prefix.value = rule.match?.prefix ?? '/';

    const kind = document.createElement('select');
    kind.dataset.field = 'kind';
    for (const [value, label] of [['local', '本地'], ['sit', 'SIT']]) {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = label;
      kind.append(option);
    }
    kind.value = rule.target?.kind ?? 'local';

    const baseUrl = document.createElement('input');
    baseUrl.type = 'text';
    baseUrl.dataset.field = 'baseUrl';
    baseUrl.placeholder = 'http://localhost:8080';
    baseUrl.value = rule.target?.baseUrl ?? '';

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'remove';
    remove.textContent = '×';
    remove.title = '删除规则';
    remove.addEventListener('click', () => {
      routingRules = routingRules.filter((item) => item.id !== rule.id);
      renderRouting();
    });

    row.append(enabled, host, prefix, kind, baseUrl, remove);
    routingList.append(row);
  }
}

function collectRules() {
  return [...routingList.querySelectorAll('.rule-row')].map((row) => ({
    id: row.dataset.id,
    enabled: row.querySelector('[data-field=enabled]').checked,
    match: {
      host: row.querySelector('[data-field=host]').value.trim(),
      prefix: row.querySelector('[data-field=prefix]').value.trim(),
    },
    target: {
      kind: row.querySelector('[data-field=kind]').value,
      baseUrl: row.querySelector('[data-field=baseUrl]').value.trim(),
    },
  }));
}

function addRule() {
  routingRules.push({
    id: `rule-${Date.now()}`,
    enabled: true,
    match: { host: '', prefix: '/api' },
    target: {
      kind: 'local',
      baseUrl: (configCache?.workspace?.backendUrl ?? 'http://localhost:8080').replace('127.0.0.1', 'localhost'),
    },
  });
  renderRouting();
}

async function saveRouting() {
  routingRules = collectRules();
  routingMessage.textContent = '保存中…';
  routingMessage.className = 'message';
  try {
    const saved = await api.saveConfig({ routing: { rules: routingRules } });
    routingRules = saved.routing?.rules ?? routingRules;
    renderRouting();
    routingMessage.textContent = '路由已保存';
    routingMessage.className = 'message ok';
  } catch (err) {
    routingMessage.textContent = `保存失败：${err.message}`;
    routingMessage.className = 'message error';
  }
}

async function openBrowser(url) {
  const target = (url ?? browserUrlInput.value ?? '').trim();
  try {
    await api.browser('open', { url: target || undefined });
    setStatus('页面加载中…', '');
  } catch (err) {
    setStatus(`打开失败：${err.message}`, 'error');
  }
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  setMessage('保存中…');
  try {
    const saved = await api.saveConfig(readForm());
    configCache = saved;
    setMessage('已保存', 'ok');
  } catch (err) {
    setMessage(`保存失败：${err.message}`, 'error');
  }
});

$('browser-open').addEventListener('click', () => openBrowser());
browserUrlInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    event.preventDefault();
    openBrowser();
  }
});
$('browser-reload').addEventListener('click', () => api.browser('reload').catch(() => {}));
$('browser-devtools').addEventListener('click', () => api.browser('devtools').catch(() => {}));
$('clear-requests').addEventListener('click', async () => {
  try {
    await api.capture('clear');
    captureState.clear();
    renderRequests();
  } catch (err) {
    hintEl.textContent = `清空失败：${err.message}`;
  }
});
$('only-errors').addEventListener('change', renderRequests);
$('refresh-runs').addEventListener('click', loadRuns);
$('add-rule').addEventListener('click', addRule);
$('save-routing').addEventListener('click', saveRouting);
for (const tab of document.querySelectorAll('.tab')) {
  tab.addEventListener('click', () => setTab(tab.dataset.tab));
}

api.onCapture((event) => {
  if (event.type === 'request' || event.type === 'update') {
    captureState.set(event.record.id, event.record);
    scheduleRender();
  } else if (event.type === 'clear') {
    captureState.clear();
    renderRequests();
  } else if (event.type === 'navigation') {
    browserUrlInput.value = event.url;
  } else if (event.type === 'routing') {
    routingMessage.textContent = `改道：${event.method} ${event.url} → ${event.target ?? 'OPTIONS（仅补 CORS）'}`;
    routingMessage.className = 'message ok';
  } else if (event.type === 'error') {
    setStatus(event.message, 'error');
  }
});

window.addEventListener('resize', () => requestAnimationFrame(syncBounds));
if (typeof ResizeObserver !== 'undefined') {
  new ResizeObserver(() => requestAnimationFrame(syncBounds)).observe(browserSlot);
}

const initialConfig = await loadConfig();
if (initialConfig?.workspace?.frontendUrl) browserUrlInput.value = initialConfig.workspace.frontendUrl;
await loadRuns();
setTab('browser');
requestAnimationFrame(syncBounds);
setTimeout(syncBounds, 300);
await refreshRequests();
