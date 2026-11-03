import { api } from './api.js';
import { deriveCandidateRules } from './routing-assist.mjs';
import { formatBodyText } from './format-body.mjs';

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
const logPath = $('log-path');
const logSource = $('log-source');
const logParser = $('log-parser');
const logRegex = $('log-regex');
const logAnchor = $('log-anchor');
const logMessage = $('log-message');
const logSummary = $('log-summary');
const logOutput = $('log-output');
const logsWarning = $('logs-warning');
const splitter = $('splitter');
const routingWarning = $('routing-warning');
const routingStatus = $('routing-status');
const targetStatus = $('target-status');
const makeRuleButton = $('make-rule');
const routingList = $('routing-list');
const routingMessage = $('routing-message');
const diagnoseQuestion = $('diagnose-question');
const diagnoseMessage = $('diagnose-message');
const consoleList = $('console-list');
const consoleCount = $('console-count');
const diagnoseResult = $('diagnose-result');

let currentTab = 'browser';
let configCache = null;
let routingRules = [];
let routingHits = 0;
let targetCandidates = { local: [], sit: [] };
let discoveredLocalPorts = [];
let currentRequest = null;
let consoleErrorCount = 0;
const consoleState = new Map();
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
  form.elements.sitUrl.value = workspace.sitUrl ?? '';
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
      sitUrl: form.elements.sitUrl.value.trim(),
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
    refreshTargetCandidates().catch(() => {});
    renderLogSource(config.workspace?.logfiles ?? []);
    if (config.meta?.logFile) logPath.textContent = `日志文件：${config.meta.logFile}`;
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
      logsWarning.hidden = false;
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
    ? `${items.length} 条（显示 ${filtered.length}）${consoleErrorCount ? ` · 页面错误 ${consoleErrorCount}` : ''}`
    : '内嵌浏览器仅在桌面版可用';
  renderLogAnchors();
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
    const consoleResult = await api.capture('console', { limit: 200 }).catch(() => ({ events: [] }));
    consoleState.clear();
    for (const event of Array.isArray(consoleResult?.events) ? consoleResult.events : []) {
      consoleState.set(event.id, event);
    }
    consoleErrorCount = consoleState.size;
    renderConsoleList();
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

function requestContentType(request) {
  const entry = Object.entries(request.requestHeaders ?? {})
    .find(([key]) => key.toLowerCase() === 'content-type');
  return entry ? String(entry[1]) : '';
}

function buildBodySection(request) {
  const block = section('响应体');
  if (request.body && typeof request.body.text === 'string') {
    block.append(
      el('div', 'muted small', `${request.body.bytes ?? request.body.text.length} bytes${request.body.truncated ? '，已截断' : ''}`),
      preBlock(formatBodyText(request.body.text, request.mimeType)),
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
    ['前端错误', String(result.frontend?.errors?.length ?? 0)],
    ['前端源码', String(result.frontend?.files?.length ?? 0)],
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
      ...(request.postData
        ? [section('请求体', preBlock(formatBodyText(request.postData, requestContentType(request))))]
        : []),
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
  if (name === 'routing') {
    renderRouting();
    refreshTargetCandidates().catch(() => {});
  }
  if (name === 'logs') renderLogAnchors();
  if (name === 'history') loadRuns();
}

function normalizeOrigin(value) {
  try {
    const parsed = new URL(value);
    if (['127.0.0.1', '::1', '[::1]'].includes(parsed.hostname.toLowerCase())) {
      parsed.hostname = 'localhost';
    }
    return parsed.origin;
  } catch {
    return null;
  }
}

function isLoopbackOrigin(value) {
  try {
    const host = new URL(value).hostname.toLowerCase();
    return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]';
  } catch {
    return true;
  }
}

function observedOrigins() {
  const frontendOrigin = normalizeOrigin(configCache?.workspace?.frontendUrl ?? '');
  const origins = new Set();
  for (const item of captureState.values()) {
    let parsed;
    try {
      parsed = new URL(item.url);
    } catch {
      continue;
    }
    // Ignore proxy URLs left over from proxy mode.
    if (parsed.pathname === '/__dcproxy') continue;
    const origin = normalizeOrigin(parsed.origin);
    if (!origin || origin === frontendOrigin) continue;
    // Loopback addresses are local services; they must be declared (backendUrl / scan),
    // not inferred from captures. This keeps 127.0.0.1:8080 out of SIT candidates.
    if (isLoopbackOrigin(origin)) continue;
    origins.add(origin);
  }
  return [...origins];
}

function candidateSets() {
  const local = new Set();
  const sit = new Set();
  const workspace = configCache?.workspace ?? {};
  const normalize = (url) => {
    const origin = normalizeOrigin(String(url ?? ''));
    return origin ? origin.replace(/\/+$/, '') : '';
  };
  if (workspace.backendUrl) local.add(normalize(workspace.backendUrl));
  if (workspace.sitUrl) sit.add(normalize(workspace.sitUrl));
  for (const rule of routingRules) {
    if (!rule.target?.baseUrl) continue;
    const url = normalize(rule.target.baseUrl);
    if (!url) continue;
    if (rule.target.kind === 'sit') sit.add(url);
    else local.add(url);
  }
  for (const port of discoveredLocalPorts) local.add(`http://localhost:${port}`);
  for (const origin of observedOrigins()) {
    if (!local.has(origin)) sit.add(origin);
  }
  return { local: [...local].filter(Boolean), sit: [...sit].filter(Boolean) };
}

async function refreshTargetCandidates() {
  const sets = candidateSets();
  targetStatus.textContent = '探测候选地址…';
  const probeList = async (list) => {
    const reachable = [];
    for (const url of list) {
      if (await probeTarget(url)) reachable.push(url);
    }
    return reachable;
  };
  const [local, sit] = await Promise.all([probeList(sets.local), probeList(sets.sit)]);
  targetCandidates = { local, sit };
  targetStatus.textContent = `本地可达 ${local.length} 个 / SIT 可达 ${sit.length} 个`;
  renderRouting();
}

function fillTargetOptions(select, kind, current) {
  const probed = targetCandidates[kind] ?? [];
  const values = [...new Set([...(current ? [current] : []), ...probed])];
  select.textContent = '';
  if (values.length === 0) {
    const option = document.createElement('option');
    option.value = '';
    option.textContent = '未探测到可用地址';
    select.append(option);
    return;
  }
  for (const url of values) {
    const option = document.createElement('option');
    option.value = url;
    option.textContent = probed.includes(url) ? url : `${url}（当前，未探测/不可达）`;
    select.append(option);
  }
  select.value = current && values.includes(current) ? current : values[0];
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

    const baseUrl = document.createElement('select');
    baseUrl.dataset.field = 'baseUrl';
    baseUrl.title = '从探测可达的候选地址中选择；切换类型会刷新选项';
    fillTargetOptions(baseUrl, kind.value, rule.target?.baseUrl);
    kind.addEventListener('change', () => fillTargetOptions(baseUrl, kind.value, ''));

    const probe = document.createElement('button');
    probe.type = 'button';
    probe.className = 'secondary';
    probe.textContent = '探测';
    const probeStatus = document.createElement('span');
    probeStatus.className = 'probe-status';
    probeStatus.textContent = '未探测';
    if (rule.assistant?.probed) {
      probeStatus.textContent = '可达（自动）';
      probeStatus.className = 'probe-status ok';
    }
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
      baseUrl: targetCandidates.local[0]
        ?? (configCache?.workspace?.backendUrl ?? '').replace('127.0.0.1', 'localhost'),
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

function renderConsoleList() {
  consoleCount.textContent = String(consoleState.size);
  consoleList.textContent = '';
  const items = [...consoleState.values()].sort((a, b) => (b.ts ?? 0) - (a.ts ?? 0));
  if (items.length === 0) {
    const empty = document.createElement('li');
    empty.className = 'muted';
    empty.textContent = '暂无页面错误';
    consoleList.append(empty);
    return;
  }
  for (const item of items) {
    const row = document.createElement('li');
    const time = document.createElement('span');
    time.className = 'muted';
    time.textContent = item.ts ? new Date(item.ts).toLocaleTimeString() : '—';
    const message = document.createElement('span');
    message.className = 'console-message';
    message.textContent = item.message ?? '';
    message.title = item.message ?? '';
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'secondary';
    button.textContent = '诊断';
    button.addEventListener('click', () => runConsoleDiagnose(item.id));
    row.append(time, message, button);
    consoleList.append(row);
  }
}

async function runDiagnosisPayload(payload, label) {
  diagnoseMessage.textContent = `${label}诊断中…`;
  diagnoseMessage.className = 'muted';
  diagnoseResult.hidden = true;
  const button = $('diagnose-request');
  button.disabled = true;
  try {
    const response = await api.diagnose({
      ...payload,
      question: diagnoseQuestion.value.trim(),
      mock: false,
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
    button.disabled = false;
  }
}

async function runDiagnoseRequest() {
  if (!currentRequestId) {
    diagnoseMessage.textContent = '请先选择一条请求';
    return;
  }
  await runDiagnosisPayload({ requestId: currentRequestId }, '请求');
}

async function runConsoleDiagnose(consoleId) {
  if (!consoleId) return;
  await runDiagnosisPayload({ consoleId }, '页面错误');
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

async function addCandidateRules(requests) {
  const declared = [];
  const backend = configCache?.workspace?.backendUrl;
  if (backend) {
    declared.push({
      kind: 'local',
      baseUrl: backend.replace('127.0.0.1', 'localhost'),
      source: 'workspace.backendUrl',
    });
  }
  const sitUrl = configCache?.workspace?.sitUrl;
  if (sitUrl) {
    declared.push({
      kind: 'sit',
      baseUrl: sitUrl.replace('127.0.0.1', 'localhost'),
      source: 'workspace.sitUrl',
    });
  }
  for (const rule of routingRules) {
    if (rule.target?.baseUrl) {
      declared.push({
        kind: rule.target.kind === 'sit' ? 'sit' : 'local',
        baseUrl: rule.target.baseUrl,
        source: `rule:${rule.id}`,
      });
    }
  }

  routingMessage.textContent = '正在探测已声明的目标地址…';
  routingMessage.className = 'message';
  try {
    const result = await deriveCandidateRules(requests, {
      existingRules: routingRules,
      declaredTargets: declared,
      probe: probeTarget,
    });
    if (result.rules.length === 0) {
      routingMessage.textContent = result.unreachable.length > 0
        ? `未生成规则：${result.unreachable.length} 组前缀没有可达的已声明目标`
        : '没有可推导的 XHR/Fetch 请求（或前缀已被现有规则覆盖）';
      routingMessage.className = 'message error';
      return;
    }
    routingRules.push(...result.rules);
    renderRouting();
    const suspicious = result.rules.filter((rule) => rule.assistant?.suspicious).length;
    routingMessage.textContent = [
      `已生成 ${result.rules.length} 条（观测前缀 + 已声明目标 + 探活通过）`,
      result.unreachable.length > 0 ? `${result.unreachable.length} 组不可达已剔除` : null,
      suspicious > 0 ? `${suspicious} 条 SIT 目标指向本机，请确认` : null,
    ].filter(Boolean).join('；');
    routingMessage.className = suspicious > 0 ? 'message error' : 'message ok';
  } catch (err) {
    routingMessage.textContent = `生成失败：${err.message}`;
    routingMessage.className = 'message error';
  }
}

async function scanLocalPorts() {
  const ports = [8080, 8081, 8082, 9090, 8000, 3000, 5000];
  routingStatus.textContent = '扫描中…';
  const results = await Promise.all(
    ports.map(async (port) => ({ port, ok: await probeTarget(`http://localhost:${port}/`) })),
  );
  const reachable = results.filter((item) => item.ok).map((item) => item.port);
  discoveredLocalPorts = reachable;
  routingStatus.textContent = reachable.length
    ? `本机可达端口：${reachable.join(', ')}`
    : '未探测到常见本机端口';
  await refreshTargetCandidates();
}

function renderLogAnchors() {
  const current = logAnchor.value;
  logAnchor.textContent = '';
  const nowOption = document.createElement('option');
  nowOption.value = 'now';
  nowOption.textContent = '当前时间';
  logAnchor.append(nowOption);
  const items = [...captureState.values()].sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0));
  for (const item of items) {
    const option = document.createElement('option');
    option.value = item.id;
    option.textContent = `${item.method} ${requestPath(item.url)} [${item.status ?? '…'}]`;
    logAnchor.append(option);
  }
  if ([...logAnchor.options].some((option) => option.value === current)) logAnchor.value = current;
}

function currentLogParser() {
  if (logParser.value === 'regex') {
    return { regex: logRegex.value.trim() };
  }
  return logParser.value;
}

function renderLogResult(result, anchorRequest) {
  const stats = result.stats ?? {};
  const anchorText = anchorRequest
    ? `${anchorRequest.method} ${requestPath(anchorRequest.url)} [${anchorRequest.status ?? '…'}] @ ${new Date(anchorRequest.startedAt ?? Date.now()).toLocaleString()}`
    : `当前时间 @ ${new Date().toLocaleString()}`;
  logSummary.textContent = `${anchorText} · 解析器 ${result.parser ?? '-'} · 文件 ${stats.files ?? 0} · 行 ${stats.lines ?? 0} · 解析 ${stats.parsed ?? 0} · 续行 ${stats.continuations ?? 0} · 未解析 ${stats.unparsed ?? 0}`;
  logOutput.textContent = '';
  if (!result.records || result.records.length === 0) {
    logOutput.textContent = '时间窗内没有匹配日志；可调整时间窗或切换解析器。';
    return;
  }
  for (const record of result.records) {
    const line = document.createElement('div');
    line.className = 'log-line';
    const ts = document.createElement('span');
    ts.textContent = record.ts ? new Date(record.ts).toLocaleString() : '—';
    const level = document.createElement('span');
    level.className = `log-level ${record.level ?? ''}`;
    level.textContent = record.level ?? '—';
    const thread = document.createElement('span');
    thread.textContent = record.thread ?? '—';
    const message = document.createElement('span');
    message.className = 'log-msg';
    message.textContent = [record.message, ...(record.stack ?? [])].join(String.fromCharCode(10));
    line.append(ts, level, thread, message);
    logOutput.append(line);
  }
}

function renderLogSource(files) {
  logSource.textContent = files.length > 0
    ? `日志来源：${files.join('；')}（在左侧工作区修改）`
    : '日志来源：未配置（请在左侧工作区填写并保存）';
}

async function queryLogsTab() {
  if (!api.isDesktop) {
    logMessage.textContent = '日志查询仅在桌面版可用';
    logMessage.className = 'message error';
    return;
  }
  const files = [...(configCache?.workspace?.logfiles ?? [])];
  if (files.length === 0) {
    logMessage.textContent = '工作区还没有配置日志文件，请先在左侧填写并保存';
    logMessage.className = 'message error';
    return;
  }
  const anchorValue = logAnchor.value;
  let anchor = Date.now();
  let anchorRequest = null;
  if (anchorValue && anchorValue !== 'now') {
    anchorRequest = captureState.get(anchorValue) ?? null;
    if (anchorRequest?.startedAt) anchor = anchorRequest.startedAt;
  }
  const parser = currentLogParser();
  if (parser && typeof parser === 'object' && !parser.regex) {
    logMessage.textContent = '请填写自定义正则';
    logMessage.className = 'message error';
    return;
  }
  logMessage.textContent = '查询中…';
  logMessage.className = 'message';
  try {
    const result = await api.queryLogs({
      logfiles: files,
      parser,
      anchor,
      window: configCache?.workspace?.window,
      limit: 300,
    });
    renderLogResult(result, anchorRequest);
    logMessage.textContent = `查询完成：${result.records?.length ?? 0} 条`;
    logMessage.className = 'message ok';
  } catch (err) {
    logOutput.textContent = '';
    logSummary.textContent = '';
    logMessage.textContent = `查询失败：${err.message}`;
    logMessage.className = 'message error';
  }
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
    renderLogSource(saved.workspace?.logfiles ?? []);
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
    await api.capture('console-clear').catch(() => {});
    captureState.clear();
    consoleState.clear();
    consoleErrorCount = 0;
    renderConsoleList();
    renderRequests();
  } catch (err) {
    hintEl.textContent = `清空失败：${err.message}`;
  }
});
$('only-errors').addEventListener('change', renderRequests);
$('refresh-runs').addEventListener('click', loadRuns);
$('open-log').addEventListener('click', async () => {
  if (!api.isDesktop) {
    setMessage(logPath.textContent || 'WebUI 模式日志输出到 stderr', '');
    return;
  }
  try {
    const result = await api.openLog();
    if (!result.ok) setMessage(`打开日志失败：${result.reason ?? result.error ?? 'unknown'}`, 'error');
  } catch (err) {
    setMessage(`打开日志失败：${err.message}`, 'error');
  }
});

logParser.addEventListener('change', () => {
  logRegex.hidden = logParser.value !== 'regex';
});
$('query-logs').addEventListener('click', queryLogsTab);
$('add-rule').addEventListener('click', addRule);
$('derive-rules').addEventListener('click', () => {
  addCandidateRules([...captureState.values()]).catch(() => {});
});
$('scan-ports').addEventListener('click', scanLocalPorts);
$('refresh-targets').addEventListener('click', () => {
  refreshTargetCandidates().catch(() => {});
});
makeRuleButton.addEventListener('click', () => {
  if (!currentRequest) {
    diagnoseMessage.textContent = '请先选择一条请求';
    return;
  }
  addCandidateRules([currentRequest]).then(() => setTab('routing')).catch(() => {});
});
$('diagnose-request').addEventListener('click', runDiagnoseRequest);
$('clear-console').addEventListener('click', async () => {
  await api.capture('console-clear').catch(() => {});
  consoleState.clear();
  consoleErrorCount = 0;
  renderConsoleList();
});
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
  } else if (event.type === 'console') {
    consoleState.set(event.event.id, event.event);
    consoleErrorCount = consoleState.size;
    renderConsoleList();
    scheduleRender();
  } else if (event.type === 'console-clear') {
    consoleState.clear();
    consoleErrorCount = 0;
    renderConsoleList();
    scheduleRender();
  } else if (event.type === 'routing-miss') {
    routingStatus.textContent = `最近未命中：${event.method} ${event.url}`;
  } else if (event.type === 'cors-warning') {
    if (event.repaired) {
      setStatus(`预检已兜底为 200（原 ${event.status}）`, 'ok');
      routingMessage.textContent = `预检已兜底：OPTIONS 原状态 ${event.status} → 200 OK`;
      routingMessage.className = 'message ok';
    } else {
      setStatus(`预检失败：OPTIONS ${event.status}`, 'error');
      routingMessage.textContent = `预检失败（HTTP ${event.status}）：${event.url}。后端需对 OPTIONS 返回 2xx`;
      routingMessage.className = 'message error';
    }
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
