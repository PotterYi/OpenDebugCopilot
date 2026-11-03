import { api } from './api.js';
import { deriveCandidateRules } from './routing-assist.mjs';

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
const requestTitle = $('request-title');
const requestMeta = $('request-meta');
const configPath = $('config-path');
const splitter = $('splitter');
const routingWarning = $('routing-warning');
const routingStatus = $('routing-status');
const makeRuleButton = $('make-rule');
const routingList = $('routing-list');
const routingMessage = $('routing-message');
const diagnoseQuestion = $('diagnose-question');
const diagnoseMessage = $('diagnose-message');
const diagnoseResult = $('diagnose-result');

let currentTab = 'browser';
let configCache = null;
let routingRules = [];
let routingHits = 0;
let currentRequest = null;
let currentRequestId = null;
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
  form.elements.backendUrl.value = workspace.backendUrl ?? '';
  form.elements.logfiles.value = (workspace.logfiles ?? []).join('\n');
  form.elements.sourceRoot.value = workspace.sourceRoot ?? '';
  form.elements.frontendSourceRoot.value = workspace.frontendSourceRoot ?? '';
  form.elements.beforeMs.value = workspace.window?.beforeMs ?? 3000;
  form.elements.afterMs.value = workspace.window?.afterMs ?? 2000;
  if (!browserUrlInput.value && workspace.frontendUrl) browserUrlInput.value = workspace.frontendUrl;
}

function readForm() {
  return {
    workspace: {
      frontendUrl: configCache?.workspace?.frontendUrl ?? browserUrlInput.value.trim(),
      backendUrl: form.elements.backendUrl.value.trim(),
      logfiles: form.elements.logfiles.value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean),
      sourceRoot: form.elements.sourceRoot.value.trim(),
      frontendSourceRoot: form.elements.frontendSourceRoot.value.trim(),
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
    if (config.meta?.configDir) {
      const dir = config.meta.configDir;
      const sep = String.fromCharCode(92);
      const isTemp = dir.includes(`${sep}.tmp${sep}`) || dir.includes('/.tmp/') || dir.includes(`${sep}.tmp/`) || dir.includes(`/.tmp${sep}`);
      configPath.textContent = `配置目录：${dir}${isTemp ? '（harness 临时配置，关闭后清理；正式使用请 npm run desktop）' : ''}`;
      configPath.className = `muted small${isTemp ? ' error' : ''}`;
    }
    if (!api.isDesktop) {
      routingWarning.hidden = false;
      routingWarning.textContent = '当前是 WebUI：路由与内嵌浏览器只在桌面版生效。';
    }
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

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function section(title, ...children) {
  const block = el('section', 'card-section');
  block.append(el('h4', 'card-title', title), ...children);
  return block;
}

function kv(pairs) {
  const grid = el('div', 'kv');
  for (const [key, value] of pairs) {
    grid.append(el('span', 'kv-key', key), el('span', 'kv-value', String(value ?? '—')));
  }
  return grid;
}

function preBlock(text) {
  return el('pre', 'code-block', String(text ?? ''));
}

function buildBodySection(request) {
  const block = section('响应体');
  if (request.body && typeof request.body.text === 'string') {
    block.append(
      el('div', 'muted small', `${request.body.bytes ?? request.body.text.length} bytes${request.body.truncated ? '，已截断' : ''}`),
      preBlock(request.body.text),
    );
    return block;
  }
  const reason = request.bodyError
    ? `获取失败：${request.bodyError}`
    : request.error
      ? `请求失败：${request.error}`
      : `无响应体${request.mimeType ? `（${request.mimeType}）` : ''}`;
  const row = el('div', 'toolbar');
  row.append(el('span', 'muted', reason));
  const retry = el('button', 'secondary', '重新获取');
  retry.type = 'button';
  retry.addEventListener('click', async () => {
    retry.disabled = true;
    try {
      await api.capture('body', { id: request.id });
      await showRequest(request.id);
    } catch {
      retry.disabled = false;
    }
  });
  row.append(retry);
  block.append(row);
  return block;
}

function renderDiagnosis(response) {
  const result = response.result ?? {};
  const correlation = result.logs?.correlation;
  diagnoseResult.hidden = false;
  diagnoseResult.textContent = '';
  const head = el('div', 'card-head');
  head.append(
    el('strong', null, `Run ${response.runId ?? result.meta?.runId ?? '-'}`),
    el('span', `badge ${result.gates?.ok ? 'ok' : 'error'}`, result.gates?.ok ? 'Gates ok' : 'Gates failed'),
    el('span', 'badge', `${result.meta?.agent ?? '-'} / ${result.meta?.mode ?? '-'}`),
  );
  diagnoseResult.append(head);
  diagnoseResult.append(section('结论', el('p', 'conclusion', result.agent?.conclusion ?? '(无结论)')));
  diagnoseResult.append(section('上下文', kv([
    ['关联方式', correlation ? `${correlation.strategy}${correlation.matchedId ? ` (${correlation.matchedId})` : ''}` : 'n/a'],
    ['日志', `${result.logs?.count ?? 0} 条`],
    ['线程', String(result.threads?.total ?? 0)],
    ['工具调用', String(result.agent?.toolCalls?.length ?? 0)],
    ['耗时', `${result.meta?.durationMs ?? 0} ms`],
  ])));

  const refs = Array.isArray(result.agent?.evidenceRefs) ? result.agent.evidenceRefs : [];
  if (refs.length) {
    const list = el('ul', 'evidence-list');
    for (const ref of refs) {
      const item = el('li', null, `[${ref.type}] ${ref.ref}`);
      if (ref.note) item.append(el('span', 'muted', ` — ${ref.note}`));
      list.append(item);
    }
    diagnoseResult.append(section('证据链', list));
  }

  for (const [title, items] of [
    ['修复建议', result.agent?.fixes ?? []],
    ['待补充信息', result.agent?.needsMoreInfo ?? []],
  ]) {
    if (!Array.isArray(items) || items.length === 0) continue;
    const list = el('ul', 'advice-list');
    for (const item of items) list.append(el('li', null, item));
    diagnoseResult.append(section(title, list));
  }

  const reportButton = el('button', 'secondary', '查看完整报告');
  reportButton.type = 'button';
  reportButton.addEventListener('click', () => {
    setTab('history');
    showRun(response.runId);
  });
  diagnoseResult.append(reportButton);
}

async function showRequest(id) {
  currentRequestId = id;
  requestTitle.textContent = '加载中…';
  requestMeta.textContent = '';
  detailEl.textContent = '加载中…';
  try {
    const { request } = await api.capture('detail', { id });
    if (!request) {
      detailEl.textContent = '请求已被清空或不存在';
      return;
    }
    currentRequest = request;
    requestTitle.textContent = `${request.method} ${requestPath(request.url)}`;
    requestMeta.textContent = [request.resourceType, request.status ?? '…', request.durationMs != null ? `${request.durationMs}ms` : null]
      .filter(Boolean)
      .join(' · ');
    detailEl.textContent = '';
    detailEl.append(
      section('概览', kv([
        ['方法', request.method],
        ['URL', request.url],
        ['状态', request.status ?? '—'],
        ['类型', request.resourceType ?? '—'],
        ['耗时', request.durationMs != null ? `${request.durationMs} ms` : '—'],
        ['错误', request.error ?? '—'],
      ])),
      section('请求头', preBlock(JSON.stringify(request.requestHeaders ?? {}, null, 2))),
      ...(request.postData ? [section('请求体', preBlock(request.postData))] : []),
      section('响应头', preBlock(JSON.stringify(request.responseHeaders ?? {}, null, 2))),
      buildBodySection(request),
    );
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
  routingStatus.textContent = `已加载 ${routingRules.length} 条规则${routingHits ? `，命中 ${routingHits} 次` : ''}`;
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

    const probe = document.createElement('button');
    probe.type = 'button';
    probe.className = 'secondary';
    probe.textContent = '探测';
    const probeStatus = document.createElement('span');
    probeStatus.className = 'probe-status';
    probeStatus.textContent = '未探测';
    probe.addEventListener('click', async () => {
      probeStatus.textContent = '探测中…';
      probeStatus.className = 'probe-status';
      const ok = await probeTarget(baseUrl.value.trim());
      probeStatus.textContent = ok ? '可达' : '不可达';
      probeStatus.className = `probe-status ${ok ? 'ok' : 'error'}`;
    });

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'remove';
    remove.textContent = '×';
    remove.title = '删除规则';
    remove.addEventListener('click', () => {
      routingRules = routingRules.filter((item) => item.id !== rule.id);
      renderRouting();
    });

    row.append(enabled, host, prefix, kind, baseUrl, probe, probeStatus, remove);
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
    routingMessage.textContent = `路由已保存（${routingRules.length} 条）`;
    routingMessage.className = 'message ok';
    routingStatus.textContent = `已加载 ${routingRules.length} 条规则${routingHits ? `，命中 ${routingHits} 次` : ''}`;
  } catch (err) {
    routingMessage.textContent = `保存失败：${err.message}`;
    routingMessage.className = 'message error';
  }
}

async function runDiagnose(mock) {
  if (!currentRequestId) {
    diagnoseMessage.textContent = '请先选择一条请求';
    return;
  }
  diagnoseMessage.textContent = mock ? 'Mock 诊断中…' : '真实诊断中…';
  diagnoseMessage.className = 'muted';
  diagnoseResult.hidden = true;
  const buttons = [$('diagnose-mock'), $('diagnose-live')];
  for (const button of buttons) button.disabled = true;
  try {
    const response = await api.diagnose({
      requestId: currentRequestId,
      question: diagnoseQuestion.value.trim(),
      mock,
      recheck: 1,
    });
    renderDiagnosis(response);
    diagnoseMessage.textContent = '诊断完成';
    diagnoseMessage.className = 'message ok';
    await loadRuns();
  } catch (err) {
    diagnoseMessage.textContent = `诊断失败：${err.message}`;
    diagnoseMessage.className = 'message error';
  } finally {
    for (const button of buttons) button.disabled = false;
  }
}

function backendDefault() {
  return (configCache?.workspace?.backendUrl || 'http://localhost:8080').replace('127.0.0.1', 'localhost');
}

async function probeTarget(url) {
  if (!url) return false;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 1500);
  try {
    await fetch(url, { mode: 'no-cors', cache: 'no-store', signal: controller.signal });
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

function addCandidateRules(requests) {
  const candidates = deriveCandidateRules(requests, {
    existingRules: routingRules,
    defaultBaseUrl: backendDefault(),
  });
  if (!candidates.length) {
    routingMessage.textContent = '没有可推导的 XHR/Fetch 请求（或前缀已被现有规则覆盖）';
    routingMessage.className = 'message error';
    return;
  }
  routingRules.push(...candidates);
  renderRouting();
  routingMessage.textContent = `已从捕获请求生成 ${candidates.length} 条规则，请确认本地/SIT 后保存`;
  routingMessage.className = 'message ok';
}

async function scanLocalPorts() {
  const ports = [8080, 8081, 8082, 9090, 8000, 3000, 5000];
  routingStatus.textContent = '扫描中…';
  const results = await Promise.all(
    ports.map(async (port) => ({ port, ok: await probeTarget(`http://localhost:${port}/`) })),
  );
  const reachable = results.filter((item) => item.ok).map((item) => item.port);
  routingStatus.textContent = reachable.length
    ? `本机可达端口：${reachable.join(', ')}`
    : '未探测到常见本机端口';
}

async function waitForBrowserIdle(timeoutMs = 15_000) {
  if (!api.isDesktop) return;
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const status = await api.browser('status');
      if (status.pendingUrl) browserUrlInput.value = status.pendingUrl;
      if (!status.isLoading) {
        if (status.url) browserUrlInput.value = status.url;
        setStatus('页面已加载', 'ok');
        return;
      }
    } catch {
      // keep polling
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  setStatus('页面加载超时', 'error');
}

async function openBrowser(url) {
  if (!api.isDesktop) {
    setStatus('内嵌浏览器仅在桌面版可用', 'error');
    return;
  }
  const target = (url ?? browserUrlInput.value ?? '').trim();
  try {
    if (target && configCache?.workspace) {
      configCache.workspace = { ...configCache.workspace, frontendUrl: target };
      api.saveConfig({ workspace: configCache.workspace }).catch(() => {});
    }
    setStatus('正在导航…', '');
    await api.browser('open', { url: target || undefined });
    // loadURL() resolving means navigation started; wait for isLoading() to become false.
    await waitForBrowserIdle();
  } catch (err) {
    setStatus(`打开失败：${err.message}`, 'error');
  }
}

const savedWidth = Number(localStorage.getItem('dc.leftWidth'));
if (Number.isFinite(savedWidth) && savedWidth >= 260 && savedWidth <= 640) {
  document.documentElement.style.setProperty('--left-width', `${savedWidth}px`);
}
let dragging = false;
splitter.addEventListener('mousedown', (event) => {
  dragging = true;
  splitter.classList.add('dragging');
  event.preventDefault();
});
window.addEventListener('mousemove', (event) => {
  if (!dragging) return;
  const width = Math.min(640, Math.max(260, event.clientX - 12));
  document.documentElement.style.setProperty('--left-width', `${width}px`);
  localStorage.setItem('dc.leftWidth', String(width));
  requestAnimationFrame(syncBounds);
});
window.addEventListener('mouseup', () => {
  if (!dragging) return;
  dragging = false;
  splitter.classList.remove('dragging');
  syncBounds();
});

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  setMessage('保存中…');
  try {
    const saved = await api.saveConfig(readForm());
    configCache = saved;
    if (saved.meta?.configDir) configPath.textContent = `配置目录：${saved.meta.configDir}`;
    setMessage(saved.meta?.configDir ? `已保存到 ${saved.meta.configDir}` : '已保存', 'ok');
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
$('derive-rules').addEventListener('click', () => addCandidateRules([...captureState.values()]));
$('scan-ports').addEventListener('click', scanLocalPorts);
makeRuleButton.addEventListener('click', () => {
  if (!currentRequest) {
    diagnoseMessage.textContent = '请先选择一条请求';
    return;
  }
  addCandidateRules([currentRequest]);
  setTab('routing');
});
$('diagnose-mock').addEventListener('click', () => runDiagnose(true));
$('diagnose-live').addEventListener('click', () => runDiagnose(false));
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
  } else if (event.type === 'loading') {
    if (event.pendingUrl) browserUrlInput.value = event.pendingUrl;
    setStatus(event.isLoading ? '加载中…' : '页面已加载', event.isLoading ? '' : 'ok');
  } else if (event.type === 'load-failed') {
    setStatus(`加载失败：${event.description ?? event.code ?? 'unknown'}`, 'error');
  } else if (event.type === 'routing-miss') {
    routingStatus.textContent = `最近未命中：${event.method} ${event.url}`;
  } else if (event.type === 'cors-warning') {
    setStatus(`预检失败：OPTIONS ${event.status}`, 'error');
    routingMessage.textContent = `预检失败（HTTP ${event.status}）：${event.url}。后端需对 OPTIONS 返回 2xx`;
    routingMessage.className = 'message error';
  } else if (event.type === 'routing') {
    routingHits += 1;
    routingMessage.textContent = `改道：${event.method} ${event.url} → ${event.target ?? 'OPTIONS（仅补 CORS）'}`;
    routingMessage.className = 'message ok';
    routingStatus.textContent = `已加载 ${routingRules.length} 条规则，命中 ${routingHits} 次`;
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

window.__dcUIReady = true;
