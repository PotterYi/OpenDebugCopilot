import { api } from './api.js';
import { deriveCandidateRules } from './routing-assist.mjs';
import { formatBodyText } from './format-body.mjs';
import { REQUEST_FILTERS, matchesRequestFilter } from './request-filter.mjs';

const $ = (id) => document.getElementById(id);
const statusEl = $('status');
const form = $('config-form');
const messageEl = $('config-message');
const runsEl = $('runs');
const reportEl = $('report');
const historyMessageEl = $('history-message');
const requestsEl = $('requests');
const requestFilterBar = $('request-filter');
const devServerStatusEl = $('devserver-status');
const devServerDetailEl = $('devserver-detail');
const devServerLogEl = $('devserver-log');
const devServerStartBtn = $('devserver-start');
const devServerRestartBtn = $('devserver-restart');
const devServerStopBtn = $('devserver-stop');
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
const routingWarningsEl = $('routing-warnings');
const makeRuleButton = $('make-rule');
const routingList = $('routing-list');
const routingMessage = $('routing-message');
const diagnoseQuestion = $('diagnose-question');
const diagnoseMessage = $('diagnose-message');
const diagnoseProgressEl = $('diagnose-progress');
const consoleList = $('console-list');
const consoleCount = $('console-count');
const diagnoseResult = $('diagnose-result');
const profileSelect = $('profile-select');
const profileSaveAsBtn = $('profile-save-as');
const profileRenameBtn = $('profile-rename');
const profileDeleteBtn = $('profile-delete');
const profileModal = $('profile-modal');
const profileNameInput = $('profile-name-input');
const modelModal = $('model-modal');
const modelNameInput = $('model-name');
const modelNameCustomRow = $('model-name-custom-row');
const modelNameCustomInput = $('model-name-custom');
const modelMaxTurnsInput = $('model-max-turns');
const modelMaxBudgetInput = $('model-max-budget');
const modelTimeoutInput = $('model-timeout');
const modelToolModeInput = $('model-tool-mode');
const databaseListEl = $('database-list');
const databaseMessageEl = $('database-message');
const databaseStatusEl = $('database-status');
const databaseModal = $('database-modal');
const databaseEditor = $('database-editor');
const databaseEditorTitle = $('database-editor-title');
const databaseEditorActions = $('database-editor-actions');
const databaseNameInput = $('database-name');
const databaseHostInput = $('database-host');
const databasePortInput = $('database-port');
const databaseDbInput = $('database-name-db');
const databaseUserInput = $('database-user');
const databasePasswordInput = $('database-password');
const databasePasswordEnvInput = $('database-password-env');
const databaseAllowWriteInput = $('database-allow-write');
const databaseEnabledInput = $('database-enabled');
const databaseModalMessage = $('database-modal-message');

let currentTab = 'browser';
let configCache = null;
let routingRules = [];
let routingWarnings = [];
let routingHits = 0;
let targetCandidates = { local: [], sit: [] };
let discoveredLocalPorts = [];
let currentRequest = null;
let requestDetailCollapsed = false;
let consoleErrorCount = 0;
const consoleState = new Map();
let currentRequestId = null;
const captureState = new Map();
let requestFilter = 'all';
let devServerState = null;
let devServerLogLines = [];
let currentRunView = null;
let selectedRunId = null;
let profilesState = { activeId: null, profiles: [] };
let profileModalMode = 'create';
let profileModalTargetId = null;
let databasesState = { activeId: null, connections: [] };
let databaseEditingId = null;
const diagnosisStates = new Map();
let activeDiagnosisKey = null;
let elementPicking = false;
let pendingElement = null;
let pendingWorkspaceSessions = [];
const elementComposerEl = $('element-composer');
const elementComposerMeta = $('element-composer-meta');
const elementComposerInput = $('element-composer-input');
const elementComposerSubmit = $('element-composer-submit');
const elementComposerCancel = $('element-composer-cancel');
const workspacePendingEl = $('workspace-pending');
const workspacePendingText = $('workspace-pending-text');
const workspacePendingOpen = $('workspace-pending-open');
const workspaceRecoveryModal = $('workspace-recovery-modal');
const workspaceRecoveryList = $('workspace-recovery-list');
const workspaceRecoveryMessage = $('workspace-recovery-message');
const workspaceRecoveryClose = $('workspace-recovery-close');
let followUpProgressContext = null;
const MAX_DEV_LOG_LINES = 300;
const DEV_STATUS_LABELS = {
  stopped: '未启动',
  starting: '启动中',
  running: '运行中',
  stopping: '停止中',
  external: '外部运行',
  error: '异常',
};
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
  form.elements.extraSourceRoots.value = (workspace.extraSourceRoots ?? []).join('\n');
  form.elements.logParser.value = workspace.logParser ?? 'auto';
  if (logParser) logParser.value = workspace.logParser ?? 'auto';
  form.elements.frontendSourceRoot.value = workspace.frontendSourceRoot ?? '';
  form.elements.frontendProjectRoot.value = workspace.frontendProjectRoot ?? '';
  form.elements.frontendStartCommand.value = workspace.frontendStartCommand ?? '';
  form.elements.verifyCommand.value = workspace.verifyCommand ?? '';
  form.elements.beforeMs.value = workspace.window?.beforeMs ?? 3000;
  form.elements.afterMs.value = workspace.window?.afterMs ?? 2000;
  if (!browserUrlInput.value && workspace.frontendUrl) browserUrlInput.value = workspace.frontendUrl;
}

function readForm() {
  return {
    workspace: {
      frontendUrl: browserUrlInput.value.trim() || configCache?.workspace?.frontendUrl || '',
      backendUrl: form.elements.backendUrl.value.trim(),
      logfiles: form.elements.logfiles.value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean),
      sourceRoot: form.elements.sourceRoot.value.trim(),
      extraSourceRoots: form.elements.extraSourceRoots.value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean),
      logParser: form.elements.logParser.value,
      frontendSourceRoot: form.elements.frontendSourceRoot.value.trim(),
      frontendProjectRoot: form.elements.frontendProjectRoot.value.trim(),
      frontendStartCommand: form.elements.frontendStartCommand.value.trim(),
      verifyCommand: form.elements.verifyCommand.value.trim(),
      agent: configCache?.workspace?.agent ?? {},
      window: {
        beforeMs: Number(form.elements.beforeMs.value) || 0,
        afterMs: Number(form.elements.afterMs.value) || 0,
      },
    },
  };
}

function renderProfiles() {
  profileSelect.textContent = '';
  if (profilesState.profiles.length === 0) {
    const option = document.createElement('option');
    option.value = '';
    option.textContent = '当前配置（未保存）';
    profileSelect.append(option);
    profileSelect.value = '';
  } else {
    if (!profilesState.activeId) {
      const option = document.createElement('option');
      option.value = '';
      option.textContent = '当前配置（未保存）';
      profileSelect.append(option);
    }
    for (const profile of profilesState.profiles) {
      const option = document.createElement('option');
      option.value = profile.id;
      option.textContent = profile.name;
      option.title = [profile.frontendUrl, profile.backendUrl].filter(Boolean).join(' · ');
      profileSelect.append(option);
    }
    profileSelect.value = profilesState.activeId ?? '';
  }
  const hasActive = profilesState.profiles.some((profile) => profile.id === profilesState.activeId);
  profileRenameBtn.disabled = !hasActive;
  profileDeleteBtn.disabled = !hasActive;
}

async function loadProfiles() {
  try {
    profilesState = await api.listProfiles();
  } catch (error) {
    profilesState = { activeId: null, profiles: [] };
    setStatus(`读取配置列表失败：${error.message}`, 'error');
  }
  renderProfiles();
}

function openProfileModal(mode, profileId = null) {
  profileModalMode = mode;
  profileModalTargetId = profileId;
  const profile = profilesState.profiles.find((item) => item.id === profileId);
  $('profile-modal-title').textContent = mode === 'rename' ? '重命名工作区配置' : '保存工作区配置';
  profileNameInput.value = mode === 'rename' ? (profile?.name ?? '') : '';
  profileModal.hidden = false;
  hideBrowserForModal();
  profileNameInput.focus();
  profileNameInput.select();
}

function closeProfileModal() {
  profileModal.hidden = true;
  restoreBrowserAfterModal();
}

async function submitProfileName() {
  const name = profileNameInput.value.trim();
  if (!name) {
    setStatus('配置名称不能为空', 'error');
    return;
  }
  try {
    if (profileModalMode === 'rename') {
      await api.renameProfile(profileModalTargetId, name);
      closeProfileModal();
      await loadConfig();
      setStatus(`配置已重命名为 ${name}`, 'ok');
    } else {
      await api.createProfile(name, {
        workspace: readForm().workspace,
        routing: { rules: collectRules() },
      });
      closeProfileModal();
      await loadConfig();
      setStatus(`已保存配置 ${name}`, 'ok');
    }
  } catch (error) {
    setStatus(`保存配置失败：${error.message}`, 'error');
  }
}

async function switchProfileById(profileId) {
  if (!profileId || profileId === profilesState.activeId) return;
  const profile = profilesState.profiles.find((item) => item.id === profileId);
  setStatus(`正在切换配置${profile ? `：${profile.name}` : ''}…`);
  try {
    await api.switchProfile(profileId);
    await loadConfig();
    if (configCache?.workspace?.frontendUrl) {
      browserUrlInput.value = configCache.workspace.frontendUrl;
    }
    setStatus(`已切换配置${profile ? `：${profile.name}` : ''}`, 'ok');
  } catch (error) {
    setStatus(`切换配置失败：${error.message}`, 'error');
    await loadProfiles();
  }
}

async function deleteSelectedProfile() {
  const profile = profilesState.profiles.find((item) => item.id === profileSelect.value);
  if (!profile) return;
  const suffix = profile.id === profilesState.activeId
    ? '\n\n这是当前配置，删除后会切换到其他配置（若存在）。'
    : '';
  if (!window.confirm(`删除配置 ${profile.name}？${suffix}`)) return;
  try {
    await api.deleteProfile(profile.id);
    await loadConfig();
    setStatus(`已删除配置 ${profile.name}`, 'ok');
  } catch (error) {
    setStatus(`删除配置失败：${error.message}`, 'error');
  }
}

function databaseTarget(connection) {
  const host = connection.host || '-';
  const port = connection.port ?? 3306;
  return `${host}:${port}${connection.database ? `/${connection.database}` : ''}`;
}

function renderDatabases() {
  databaseListEl.textContent = '';
  const connections = databasesState.connections ?? [];
  if (connections.length === 0) {
    databaseListEl.append(el('li', 'muted small', '尚未配置数据库连接'));
    databaseStatusEl.textContent = '未配置';
    return;
  }
  databaseStatusEl.textContent = `${connections.filter((item) => item.enabled !== false).length}/${connections.length} 启用`;
  for (const connection of connections) {
    const li = el('li', 'database-item');
    if (connection.id === databasesState.activeId) li.classList.add('active');
    const main = el('div', 'database-main');
    const titleRow = el('span', 'database-name');
    titleRow.textContent = connection.name || connection.id;
    if (connection.id === databasesState.activeId) titleRow.append(el('span', 'badge ok', '当前'));
    if (connection.allowWrite) titleRow.append(el('span', 'badge', '可写'));
    if (connection.enabled === false) titleRow.append(el('span', 'badge', '已停用'));
    main.append(titleRow, el('span', 'database-target', databaseTarget(connection)));
    li.append(main);

    if (connection.id !== databasesState.activeId) {
      const activate = el('button', 'secondary', '设为当前');
      activate.type = 'button';
      activate.addEventListener('click', async (event) => {
        event.stopPropagation();
        await saveDatabasesConfig({ activeId: connection.id });
      });
      li.append(activate);
    }
    const edit = el('button', 'secondary', '编辑');
    edit.type = 'button';
    edit.addEventListener('click', (event) => {
      event.stopPropagation();
      openDatabaseEditor(connection);
    });
    const test = el('button', 'secondary', '测试');
    test.type = 'button';
    test.addEventListener('click', async (event) => {
      event.stopPropagation();
      test.textContent = '测试中…';
      test.disabled = true;
      try {
        const result = await api.testDatabase(connection);
        setDatabaseMessage(
          result?.ok
            ? `连接成功：${result.name || connection.name}（${result.latencyMs}ms）`
            : `连接失败：${result?.error ?? '未知错误'}`,
          result?.ok ? 'ok' : 'error',
        );
      } catch (error) {
        setDatabaseMessage(`连接失败：${error.message}`, 'error');
      } finally {
        test.textContent = '测试';
        test.disabled = false;
      }
    });
    const remove = el('button', 'secondary', '删除');
    remove.type = 'button';
    remove.addEventListener('click', async (event) => {
      event.stopPropagation();
      if (!window.confirm(`删除数据库连接 ${connection.name || connection.id}？`)) return;
      const connectionsNext = connections.filter((item) => item.id !== connection.id);
      const activeId = databasesState.activeId === connection.id
        ? (connectionsNext.find((item) => item.enabled !== false)?.id ?? connectionsNext[0]?.id ?? null)
        : databasesState.activeId;
      await saveDatabasesConfig({ activeId, connections: connectionsNext });
    });
    li.append(edit, test, remove);
    databaseListEl.append(li);
  }
}

function setDatabaseMessage(text, kind = '') {
  databaseMessageEl.textContent = text;
  databaseMessageEl.className = `message ${kind}`.trim();
}

async function saveDatabasesConfig(patch = {}) {
  // Never send the public `hasPassword` flag back to the store.
  const connections = (patch.connections ?? databasesState.connections).map((connection) => {
    const { hasPassword: _hasPassword, ...rest } = connection;
    return rest;
  });
  try {
    const saved = await api.saveDatabases({
      activeId: patch.activeId ?? databasesState.activeId,
      connections,
    });
    databasesState = saved;
    renderDatabases();
    setDatabaseMessage('已保存', 'ok');
    return true;
  } catch (error) {
    setDatabaseMessage(`保存失败：${error.message}`, 'error');
    return false;
  }
}

async function loadDatabases() {
  try {
    databasesState = await api.getDatabases();
    renderDatabases();
  } catch (error) {
    databaseStatusEl.textContent = '读取失败';
    setDatabaseMessage(`读取数据库配置失败：${error.message}`, 'error');
  }
}

async function openDatabaseManager() {
  closeDatabaseEditor();
  databaseModalMessage.textContent = '';
  databaseModalMessage.className = 'message';
  databaseModal.hidden = false;
  hideBrowserForModal();
  await loadDatabases();
}

function openDatabaseEditor(connection = null) {
  databaseEditingId = connection?.id ?? null;
  databaseEditorTitle.textContent = connection ? '编辑数据库连接' : '添加数据库连接';
  databaseNameInput.value = connection?.name ?? '';
  databaseHostInput.value = connection?.host ?? '127.0.0.1';
  databasePortInput.value = connection?.port ?? 3306;
  databaseDbInput.value = connection?.database ?? '';
  databaseUserInput.value = connection?.user ?? '';
  databasePasswordInput.value = '';
  databasePasswordInput.placeholder = connection?.hasPassword ? '已保存；留空表示不修改' : '留空表示无密码';
  databasePasswordEnvInput.value = connection?.passwordEnv ?? '';
  databaseAllowWriteInput.checked = Boolean(connection?.allowWrite);
  databaseEnabledInput.checked = connection?.enabled !== false;
  databaseModalMessage.textContent = '';
  databaseModalMessage.className = 'message';
  databaseEditor.hidden = false;
  databaseEditorActions.hidden = false;
  databaseNameInput.focus();
}

function closeDatabaseEditor() {
  databaseEditor.hidden = true;
  databaseEditorActions.hidden = true;
  databaseEditingId = null;
}

function closeDatabaseModal() {
  closeDatabaseEditor();
  databaseModal.hidden = true;
  restoreBrowserAfterModal();
}

function databaseFormPayload() {
  const password = databasePasswordInput.value;
  return {
    ...(databaseEditingId ? { id: databaseEditingId } : {}),
    name: databaseNameInput.value.trim(),
    host: databaseHostInput.value.trim(),
    port: Number(databasePortInput.value || 3306),
    database: databaseDbInput.value.trim(),
    user: databaseUserInput.value.trim(),
    ...(password ? { password } : {}),
    passwordEnv: databasePasswordEnvInput.value.trim(),
    allowWrite: databaseAllowWriteInput.checked,
    enabled: databaseEnabledInput.checked,
  };
}

async function saveDatabaseModal() {
  const payload = databaseFormPayload();
  if (!payload.host) {
    databaseModalMessage.textContent = '主机不能为空';
    databaseModalMessage.className = 'message error';
    return;
  }
  const connections = [...databasesState.connections];
  const index = connections.findIndex((item) => item.id === databaseEditingId);
  if (index >= 0) connections[index] = { ...connections[index], ...payload };
  else connections.push(payload);
  const ok = await saveDatabasesConfig({ connections });
  if (ok) closeDatabaseEditor();
  else {
    databaseModalMessage.textContent = databaseMessageEl.textContent;
    databaseModalMessage.className = 'message error';
  }
}

async function testDatabaseModal() {
  const payload = databaseFormPayload();
  if (!payload.host) {
    databaseModalMessage.textContent = '主机不能为空';
    databaseModalMessage.className = 'message error';
    return;
  }
  const button = $('database-test');
  button.disabled = true;
  button.textContent = '测试中…';
  databaseModalMessage.textContent = '';
  databaseModalMessage.className = 'message';
  try {
    const result = await api.testDatabase(payload);
    databaseModalMessage.textContent = result?.ok
      ? `连接成功（${result.latencyMs}ms）`
      : `连接失败：${result?.error ?? '未知错误'}`;
    databaseModalMessage.className = `message ${result?.ok ? 'ok' : 'error'}`;
  } catch (error) {
    databaseModalMessage.textContent = `连接失败：${error.message}`;
    databaseModalMessage.className = 'message error';
  } finally {
    button.disabled = false;
    button.textContent = '测试连接';
  }
}

async function loadConfig() {
  try {
    const config = await api.getConfig();
    configCache = config;
    routingRules = config.routing?.rules ?? [];
    routingWarnings = config.routing?.warnings ?? [];
    fillForm(config);
    renderRouting();
    loadProfiles().catch(() => {});
    refreshTargetCandidates().catch(() => {});
    refreshDevServer().catch(() => {});
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

function applyHistorySelection() {
  for (const li of runsEl.querySelectorAll('li[data-run-id]')) {
    const selected = li.dataset.runId === selectedRunId;
    li.hidden = Boolean(selectedRunId) && !selected;
    li.classList.toggle('selected', selected);
  }
  reportEl.hidden = !selectedRunId;
}

function closeRun() {
  selectedRunId = null;
  currentRunView = null;
  reportEl.hidden = true;
  reportEl.textContent = '';
  reportEl.className = 'diagnose-card muted';
  applyHistorySelection();
}

async function loadRuns() {
  runsEl.textContent = '';
  try {
    const runs = await api.listRuns();
    if (!runs.length) {
      selectedRunId = null;
      reportEl.hidden = true;
      const li = document.createElement('li');
      li.className = 'muted';
      li.textContent = '暂无诊断记录';
      runsEl.append(li);
      return;
    }
    for (const run of runs) {
      const li = document.createElement('li');
      li.dataset.runId = run.runId;
      const title = document.createElement('span');
      title.className = 'run-title';
      title.textContent = run.scenario || run.runId;
      const meta = document.createElement('span');
      meta.className = 'meta';
      const when = run.startedAt ? new Date(run.startedAt).toLocaleString() : '';
      meta.textContent = `${run.agent ?? ''} ${run.mode ?? ''} · ${when}`.trim();

      const main = document.createElement('div');
      main.className = 'run-main';
      const head = document.createElement('div');
      head.className = 'run-head';
      head.append(title);
      if (run.workspaceSessionStatus === 'pending') {
        head.append(el('span', 'badge error', '待决定'));
      }
      head.append(meta);
      main.append(head);
      const questionText = String(run.question ?? '').trim();
      if (questionText) {
        const question = document.createElement('span');
        question.className = 'run-question';
        question.textContent = questionText;
        question.title = questionText;
        main.append(question);
      }

      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'run-delete';
      remove.textContent = '删除';
      remove.title = '删除该诊断及其备份';
      remove.addEventListener('click', async (event) => {
        event.stopPropagation();
        const ok = window.confirm(`删除诊断 ${run.runId}？\n\n该诊断的结果、日志、备份和数据库查询结果都会删除，且不可恢复。`);
        if (!ok) return;
        try {
          const deleted = await api.deleteRun(run.runId);
          if (selectedRunId === run.runId) {
            selectedRunId = null;
            currentRunView = null;
            reportEl.hidden = true;
            reportEl.textContent = '';
            reportEl.className = 'diagnose-card muted';
          }
          const queryNote = deleted?.databaseQueries
            ? `（同时删除 ${deleted.databaseQueries} 条数据库查询结果）`
            : '';
          historyMessageEl.textContent = `已删除 ${run.runId}${queryNote}`;
          historyMessageEl.className = 'message ok';
          await loadRuns();
          await loadWorkspacePending();
        } catch (err) {
          historyMessageEl.textContent = `删除失败：${err.message}`;
          historyMessageEl.className = 'message error';
        }
      });

      li.append(main, remove);
      li.addEventListener('click', () => {
        if (selectedRunId === run.runId) closeRun();
        else showRun(run.runId);
      });
      runsEl.append(li);
    }
    if (selectedRunId && ![...runsEl.querySelectorAll('li[data-run-id]')]
      .some((li) => li.dataset.runId === selectedRunId)) {
      selectedRunId = null;
    }
    applyHistorySelection();
  } catch (err) {
    historyMessageEl.textContent = `加载历史失败：${err.message}`;
    historyMessageEl.className = 'message error';
  }
}

async function showRun(runId) {
  selectedRunId = runId;
  applyHistorySelection();
  reportEl.hidden = false;
  historyMessageEl.textContent = '加载中…';
  historyMessageEl.className = 'muted';
  reportEl.textContent = '';
  reportEl.className = 'diagnose-card muted';
  try {
    const run = await api.getRun(runId);
    const view = {
      response: run,
      container: reportEl,
      messageEl: historyMessageEl,
      mode: 'history',
    };
    currentRunView = view;
    renderRunInto(view);
    historyMessageEl.textContent = '';
    historyMessageEl.className = 'message';
  } catch (err) {
    historyMessageEl.textContent = `加载失败：${err.message}`;
    historyMessageEl.className = 'message error';
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

function requestDiagnosisKey(id) {
  return `request:${String(id)}`;
}

function consoleDiagnosisKey(id) {
  return `console:${String(id)}`;
}

function elementDiagnosisKey(id) {
  return `element:${String(id)}`;
}

function activeDiagnosisState() {
  return activeDiagnosisKey ? diagnosisStates.get(activeDiagnosisKey) : null;
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
  const filtered = items.filter((item) =>
    matchesRequestFilter(item, requestFilter)
    && (!errorsOnly || item.error || (item.status ?? 0) >= 400));
  requestsEl.textContent = '';
  const elementStates = [...diagnosisStates.values()]
    .filter((state) => state.element)
    .sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0));
  for (const state of elementStates) {
    const li = document.createElement('li');
    li.dataset.elementId = state.elementId;
    li.classList.add('element-diagnosis-item');
    if (activeDiagnosisKey === state.key) li.classList.add('selected');
    const method = document.createElement('span');
    method.className = 'method';
    method.textContent = 'ELEM';
    const urlCell = document.createElement('span');
    urlCell.className = 'url-cell';
    const url = document.createElement('span');
    url.className = 'url';
    url.textContent = state.element.framework?.componentName
      || state.element.selector
      || '页面元素';
    url.title = state.element.selector ?? '';
    urlCell.append(url);
    const marker = document.createElement('span');
    marker.className = `diagnose-state ${state.status}`;
    marker.textContent = state.status === 'running'
      ? '（诊断中）'
      : state.status === 'done'
        ? '（诊断完成）'
        : '（诊断失败）';
    urlCell.append(marker);
    const type = document.createElement('span');
    type.className = 'muted';
    type.textContent = '元素';
    li.append(method, urlCell, document.createElement('span'), document.createElement('span'), type);
    li.addEventListener('click', () => showElementState(state.key));
    requestsEl.append(li);
  }
  for (const item of filtered) {
    const li = document.createElement('li');
    if (currentRequestId != null && String(item.id) === String(currentRequestId)) {
      li.classList.add('selected');
    }
    const method = document.createElement('span');
    method.className = 'method';
    method.textContent = item.method ?? '';
    const urlCell = document.createElement('span');
    urlCell.className = 'url-cell';
    const url = document.createElement('span');
    url.className = 'url';
    url.textContent = requestPath(item.url);
    url.title = item.url;
    urlCell.append(url);
    const diagnosis = diagnosisStates.get(requestDiagnosisKey(item.id));
    if (diagnosis) {
      const marker = document.createElement('span');
      marker.className = `diagnose-state ${diagnosis.status}`;
      marker.textContent = diagnosis.status === 'running'
        ? '（诊断中）'
        : diagnosis.status === 'done'
          ? '（诊断完成）'
          : '（诊断失败）';
      urlCell.append(marker);
    }
    const status = document.createElement('span');
    const isError = Boolean(item.error) || (item.status ?? 0) >= 400 || Boolean(item.businessError);
    status.className = `status ${isError ? 'error' : 'ok'}`;
    status.textContent = item.error
      ? 'FAIL'
      : item.businessError
        ? `${item.status ?? 200}/${item.businessCode}`
        : item.status ?? '…';
    if (item.businessError && item.businessMessage) status.title = item.businessMessage;
    const duration = document.createElement('span');
    duration.textContent = item.durationMs != null ? `${item.durationMs}ms` : '';
    const type = document.createElement('span');
    type.className = 'muted';
    type.textContent = item.resourceType ?? '';
    li.append(method, urlCell, status, duration, type);
    li.addEventListener('click', () => showRequest(item.id));
    requestsEl.append(li);
  }
  const counts = {
    all: items.length,
    backend: items.filter((item) => matchesRequestFilter(item, 'backend')).length,
    script: items.filter((item) => matchesRequestFilter(item, 'script')).length,
  };
  for (const button of requestFilterBar.querySelectorAll('button[data-filter]')) {
    const filter = REQUEST_FILTERS.find((item) => item.id === button.dataset.filter);
    button.textContent = `${filter?.label ?? button.dataset.filter} ${counts[button.dataset.filter] ?? 0}`;
    const active = button.dataset.filter === requestFilter;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', String(active));
  }
  const scope = requestFilter === 'all'
    ? '显示'
    : REQUEST_FILTERS.find((item) => item.id === requestFilter)?.label ?? requestFilter;
  hintEl.textContent = api.isDesktop
    ? `${items.length} 条（${scope} ${filtered.length}）${consoleErrorCount ? ` · 页面错误 ${consoleErrorCount}` : ''}`
    : '内嵌浏览器仅在桌面版可用';
  renderLogAnchors();
}

function renderDevServerLog() {
  if (devServerLogLines.length === 0) {
    devServerLogEl.textContent = '暂无输出';
    return;
  }
  devServerLogEl.textContent = devServerLogLines
    .map((entry) => `${entry.stream === 'err' ? '! ' : '  '}${entry.line}`)
    .join('\n');
  devServerLogEl.scrollTop = devServerLogEl.scrollHeight;
}

function renderDevServer() {
  const state = devServerState;
  if (!api.isDesktop) {
    devServerStatusEl.textContent = '仅桌面版';
    devServerStatusEl.className = 'badge';
    devServerDetailEl.textContent = '前端服务控制仅在桌面版可用';
    devServerStartBtn.disabled = true;
    devServerRestartBtn.disabled = true;
    devServerStopBtn.disabled = true;
    return;
  }
  if (!state) {
    devServerStatusEl.textContent = '未连接';
    devServerStatusEl.className = 'badge';
    devServerDetailEl.textContent = '正在读取前端服务状态…';
    return;
  }
  const status = state.status ?? 'stopped';
  devServerStatusEl.textContent = DEV_STATUS_LABELS[status] ?? status;
  devServerStatusEl.className = `badge${status === 'running' ? ' ok' : status === 'error' ? ' error' : ''}`;
  const bits = [
    state.message,
    state.command ? `命令：${state.command}` : null,
    state.cwd ? `目录：${state.cwd}` : null,
    state.pid ? `PID：${state.pid}` : null,
  ].filter(Boolean);
  devServerDetailEl.textContent = bits.join(' · ');
  const busy = status === 'starting' || status === 'stopping';
  const external = status === 'external';
  devServerStartBtn.disabled = busy || external || status === 'running';
  devServerStopBtn.disabled = busy || !state.pid;
  devServerRestartBtn.disabled = busy || external;
}

async function refreshDevServer() {
  if (!api.isDesktop) {
    renderDevServer();
    renderDevServerLog();
    return;
  }
  try {
    devServerState = await api.devServer('status');
    const { logs } = await api.devServer('logs', { limit: MAX_DEV_LOG_LINES });
    devServerLogLines = Array.isArray(logs) ? logs : [];
  } catch (error) {
    devServerState = { status: 'error', message: `读取前端服务状态失败：${error.message}` };
  }
  renderDevServer();
  renderDevServerLog();
}

async function devServerAction(action) {
  if (!api.isDesktop) return;
  if (action === 'start' || action === 'restart') {
    devServerLogLines = [];
    renderDevServerLog();
  }
  devServerDetailEl.textContent = '处理中…';
  try {
    devServerState = await api.devServer(action);
    renderDevServer();
    const { logs } = await api.devServer('logs', { limit: MAX_DEV_LOG_LINES });
    devServerLogLines = Array.isArray(logs) ? logs : [];
    renderDevServerLog();
  } catch (error) {
    devServerState = { ...(devServerState ?? {}), status: 'error', message: `操作失败：${error.message}` };
    renderDevServer();
  }
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

function formatTokenUsage(usage) {
  const total = Number(usage?.totalTokens);
  if (!Number.isFinite(total)) return '—';
  const input = Number(usage?.totalInputTokens);
  const output = Number(usage?.outputTokens);
  const detail = Number.isFinite(input) && Number.isFinite(output)
    ? `（入 ${input.toLocaleString()} / 出 ${output.toLocaleString()}）`
    : '';
  return `${total.toLocaleString()}${detail}`;
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

function showMessage(view, text, kind = 'muted') {
  if (!view.messageEl) return;
  view.messageEl.textContent = text;
  view.messageEl.className = `message ${kind}`.trim();
}

async function runVerification(fixIndex, view) {
  const response = view.response;
  const runId = response?.runId ?? response?.result?.meta?.runId;
  if (!runId) return;
  showMessage(view, '正在运行验证命令…');
  try {
    const verification = await api.verify('run', { runId, fixIndex, restart: true });
    if (verification?.cancelled) {
      showMessage(view, '已取消验证');
      return;
    }
    const fix = response.result?.agent?.fixes?.[fixIndex];
    if (fix) fix.applied = { ...(fix.applied ?? {}), verification };
    renderRunInto(view);
    showMessage(
      view,
      verification.ok
        ? `验证通过（${verification.durationMs}ms）${verification.restarted ? '，前端已重启' : ''}`
        : `验证失败${verification.timedOut ? '（超时）' : `（退出码 ${verification.exitCode}）`}`,
      verification.ok ? 'message ok' : 'message error',
    );
  } catch (error) {
    showMessage(view, `验证失败：${error.message}`, 'message error');
  }
}

async function runFixAction(action, fixIndex, view) {
  const response = view.response;
  const runId = response?.runId ?? response?.result?.meta?.runId;
  if (!runId) return;
  showMessage(view, action === 'apply' ? '正在应用修改…' : '正在撤销修改…');
  try {
    const result = await api.fixes(action, { runId, fixIndex });
    if (result?.cancelled) {
      showMessage(view, '已取消');
      return;
    }
    if (result?.fix && Array.isArray(response.result?.agent?.fixes)) {
      response.result.agent.fixes[fixIndex] = result.fix;
    }
    renderRunInto(view);
    showMessage(
      view,
      action === 'apply' ? '修改已应用（已备份，可撤销）' : '修改已撤销',
      'message ok',
    );
  } catch (error) {
    showMessage(view, `${action === 'apply' ? '应用' : '撤销'}失败：${error.message}`, 'message error');
  }
}

async function runFixBatch(action, view) {
  const response = view.response;
  const runId = response?.runId ?? response?.result?.meta?.runId;
  if (!runId) return;
  showMessage(view, action === 'apply-all' ? '正在应用全部修改…' : '正在撤销全部修改…');
  try {
    const result = await api.fixes(action, { runId });
    if (result?.cancelled) {
      showMessage(view, '已取消');
      return;
    }
    if (Array.isArray(result?.fixes)) response.result.agent.fixes = result.fixes;
    renderRunInto(view);
    const count = action === 'apply-all' ? result.applied ?? 0 : result.reverted ?? 0;
    if (result.ok === false) {
      showMessage(
        view,
        `已处理 ${count} 条，后续失败：${result.error ?? '未知错误'}`,
        'message error',
      );
    } else {
      showMessage(
        view,
        action === 'apply-all' ? `已应用 ${count} 条修改` : `已撤销 ${count} 条修改`,
        'message ok',
      );
    }
  } catch (error) {
    showMessage(view, `${action === 'apply-all' ? '全部应用' : '全部撤销'}失败：${error.message}`, 'message error');
  }
}

function renderFixCard(fix, view, fixIndex, { readOnly = false } = {}) {
  if (typeof fix === 'string') return el('li', 'fix-card', fix);
  const runId = view.response?.runId ?? view.response?.result?.meta?.runId;
  const card = el('li', 'fix-card');
  const workspaceApplied = Boolean(fix.workspaceApplied);
  const applied = (Boolean(fix.applied) && !fix.applied.revertedAt) || workspaceApplied;
  const reverted = Boolean(fix.applied?.revertedAt);
  const head = el('div', 'fix-head');
  head.append(el('span', 'fix-summary', fix.summary ?? '(无摘要)'));
  if (fix.risk) head.append(el('span', `badge risk-${fix.risk}`, `风险 ${fix.risk}`));
  if (applied) head.append(el('span', 'badge ok', '已应用'));
  else if (reverted) head.append(el('span', 'badge', '已撤销'));
  card.append(head);

  const target = [fix.root ?? null, fix.extraRoot ?? null, fix.file ?? null].filter(Boolean).join(' / ');
  if (target) card.append(el('div', 'muted small', target));
  if (fix.verification) card.append(el('div', 'muted small', `验证：${fix.verification}`));
  if (fix.note) card.append(el('div', 'muted small', `说明：${fix.note}`));

  const preview = fix.preview;
  if (preview?.status === 'ready' && preview.patch) {
    const bar = el('div', 'fix-preview-head');
    bar.append(el('span', 'muted small', `diff · 第 ${preview.line} 行`));
    const copy = el('button', 'secondary', '复制 diff');
    copy.type = 'button';
    copy.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(preview.patch);
        copy.textContent = '已复制';
      } catch {
        copy.textContent = '复制失败';
      }
    });
    bar.append(copy);
    if (!readOnly && api.isDesktop && !workspaceApplied && ['edit', 'create', 'delete'].includes(fix.kind)) {
      if (applied) {
        const verifyCmd = configCache?.workspace?.verifyCommand;
        if (verifyCmd) {
          const verify = el('button', 'secondary', '运行验证');
          verify.type = 'button';
          verify.title = verifyCmd;
          verify.disabled = !runId;
          verify.addEventListener('click', () => runVerification(fixIndex, view));
          bar.append(verify);
        }
        const undo = el('button', 'secondary', '撤销');
        undo.type = 'button';
        undo.disabled = !runId;
        undo.addEventListener('click', () => runFixAction('undo', fixIndex, view));
        bar.append(undo);
      } else {
        const apply = el('button', null, '应用修改');
        apply.type = 'button';
        apply.disabled = !runId;
        apply.addEventListener('click', () => runFixAction('apply', fixIndex, view));
        bar.append(apply);
      }
    }
    card.append(bar);
    if (Array.isArray(preview.warnings) && preview.warnings.length > 0) {
      card.append(el('p', 'error-text small', `静态告警（以编译结果为准）：${preview.warnings.join('；')}`));
    }

    const diff = el('pre', 'fix-diff');
    for (const line of preview.patch.split('\n')) {
      let className = 'diff-context';
      if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('@@')) className = 'diff-meta';
      else if (line.startsWith('+')) className = 'diff-add';
      else if (line.startsWith('-')) className = 'diff-del';
      const span = el('span', className, `${line}\n`);
      diff.append(span);
    }
    card.append(diff);
  } else if (preview?.status === 'error') {
    card.append(el('p', 'error-text small', `无法生成预览：${preview.message}`));
  } else if (preview?.status === 'no-change' || preview?.status === 'skipped') {
    card.append(el('p', 'muted small', preview.message));
  }

  const verification = applied ? fix.applied?.verification : null;
  if (verification) {
    const line = el('div', 'verify-summary');
    line.append(el(
      'span',
      `badge ${verification.ok ? 'ok' : 'error'}`,
      verification.ok ? '验证通过' : verification.timedOut ? '验证超时' : '验证失败',
    ));
    line.append(el('span', 'muted small', `${verification.command ?? ''} · ${verification.durationMs ?? 0} ms`));
    if (verification.restarted) line.append(el('span', 'muted small', '前端已重启'));
    else if (verification.restartMessage) line.append(el('span', 'muted small', verification.restartMessage));
    card.append(line);
    const output = String(verification.output ?? '').trimEnd();
    if (output) {
      const tail = output.split('\n').slice(-40).join('\n');
      card.append(el('pre', 'verify-log', tail));
    }
  }
  return card;
}

function renderDiagnosis(response) {
  const view = {
    response,
    container: diagnoseResult,
    messageEl: diagnoseMessage,
    mode: 'live',
  };
  currentRunView = view;
  renderRunInto(view);
}

function conversationFor(result) {
  if (Array.isArray(result?.conversation) && result.conversation.length > 0) {
    return result.conversation;
  }
  const messages = [];
  if (result?.meta?.question) {
    messages.push({ role: 'user', text: result.meta.question });
  }
  if (result?.agent) {
    messages.push({ role: 'assistant', text: result.agent.conclusion ?? '', agent: result.agent });
  }
  return messages;
}

async function runFollowUp(view, input, button) {
  const response = view.response;
  const runId = response?.runId ?? response?.result?.meta?.runId;
  const question = input.value.trim();
  if (!runId || !question) return;
  const label = button.textContent;
  input.disabled = true;
  button.disabled = true;
  button.textContent = '继续诊断中…';
  showMessage(view, '继续诊断中…');
  const progressEl = view.container.querySelector('.followup-progress');
  if (progressEl) {
    followUpProgressContext = { container: progressEl, steps: [] };
    upsertProgressStep(followUpProgressContext.steps, {
      id: 'client-start',
      label: '开始继续诊断',
      status: 'start',
    });
    renderProgressSteps(progressEl, followUpProgressContext.steps);
  }
  try {
    const result = await api.followUp({ runId, question, mock: false });
    if (result?.result) view.response.result = result.result;
    followUpProgressContext = null;
    renderRunInto(view);
    showMessage(view, '已根据追问更新诊断', 'message ok');
    requestAnimationFrame(() => {
      view.container.scrollTop = view.container.scrollHeight;
    });
  } catch (error) {
    if (followUpProgressContext) {
      // Stop every in-flight spinner: a rejected follow-up (for example when a
      // fix is still applied) must not leave the "思考中" steps animating.
      for (const step of followUpProgressContext.steps) {
        if (step.status === 'start') {
          step.status = 'error';
          step.label = `${step.label ?? ''}（已中止）`;
        }
      }
      upsertProgressStep(followUpProgressContext.steps, {
        id: 'error',
        label: '继续诊断失败',
        status: 'error',
        detail: error.message,
      });
      renderProgressSteps(followUpProgressContext.container, followUpProgressContext.steps);
      followUpProgressContext = null;
    }
    showMessage(view, `继续诊断失败：${error.message}`, 'message error');
    input.disabled = false;
    button.disabled = false;
    button.textContent = label;
  }
}

function buildChatSection(view) {
  const block = el('section', 'card-section chat-panel');
  block.append(el('div', 'card-title', '继续诊断'));

  const row = el('div', 'chat-input-row');
  const input = document.createElement('input');
  input.className = 'chat-input';
  input.placeholder = '继续描述你的问题，或对当前修复方案的调整意见…';
  const send = el('button', null, '继续诊断');
  send.type = 'button';
  send.addEventListener('click', () => runFollowUp(view, input, send));
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      runFollowUp(view, input, send);
    }
  });
  row.append(input, send);
  const progress = el('div', 'followup-progress diagnose-progress');
  progress.hidden = true;
  // Thinking steps belong under the composer so the input stays visually first.
  block.append(row, progress);
  return block;
}

function renderRunInto(view) {
  const response = view.response;
  const result = response.result ?? {};
  const container = view.container;
  container.hidden = false;
  container.classList.remove('muted');
  container.textContent = '';

  if (view.mode === 'history') {
    renderHistoryThread(view, result);
    return;
  }

  renderRunBody(container, result, result.agent ?? {}, view, { readOnly: false, showHeader: true });

  const reportButton = el('button', 'secondary', '查看完整报告');
  reportButton.type = 'button';
  reportButton.addEventListener('click', () => {
    setTab('history');
    showRun(response.runId ?? result.meta?.runId);
  });
  container.append(reportButton);
}

/** History is a chat thread: each assistant turn keeps its full diagnosis. */
function renderHistoryThread(view, result) {
  const container = view.container;
  container.classList.add('history-thread-card');
  const thread = el('div', 'history-thread');
  const conversation = conversationFor(result);
  if (conversation.length === 0 && result.agent) {
    conversation.push({ role: 'assistant', agent: result.agent, text: result.agent.conclusion ?? '' });
  }
  let lastAssistantIndex = -1;
  conversation.forEach((message, index) => {
    if (message?.role === 'assistant') lastAssistantIndex = index;
  });

  conversation.forEach((message, index) => {
    if (!message) return;
    if (message.role === 'user') {
      const bubble = el('div', 'chat-msg user history-user');
      bubble.textContent = message.text ?? '';
      thread.append(bubble);
      return;
    }
    if (message.role !== 'assistant') return;
    const bubble = el('div', 'chat-msg assistant history-assistant');
    if (message.at) bubble.append(el('div', 'chat-time muted small', new Date(message.at).toLocaleString()));
    // The latest turn uses the run's current agent so apply/undo/verify state stays in sync.
    const agentForMessage = index === lastAssistantIndex
      ? (result.agent ?? message.agent ?? {})
      : (message.agent ?? result.agent ?? {});
    renderRunBody(bubble, result, agentForMessage, view, {
      readOnly: index !== lastAssistantIndex,
      showHeader: false,
    });
    thread.append(bubble);
  });
  container.append(thread);
  if (api.isDesktop) container.append(buildChatSection(view));
}

function describeCorrelation(result) {
  const strategy = result.logs?.correlation?.strategy;
  const id = result.logs?.correlation?.matchedId;
  const labels = {
    marker: 'marker',
    'business-id': 'business-id',
    'trace-id': 'trace-id',
    'window-thread': '时间窗 + 线程',
    'time-window': '时间窗兜底',
  };
  if (!strategy || strategy === 'none') return { label: '未匹配到日志', warning: null };
  const label = `${labels[strategy] ?? strategy}${id ? `（${id}）` : ''}`;
  return {
    label,
    warning: strategy === 'time-window'
      ? '当前仅按时间窗关联，命中的日志可能混入其他请求。'
      : null,
  };
}

function renderFixValidation(validation) {
  const block = el('section', 'card-section fix-validation');
  const summary = el('div', 'verify-summary');
  if (validation.status === 'passed') {
    summary.append(el('span', 'badge ok', '编译自测通过'));
    const commands = (validation.commands ?? []).map((entry) => entry.command).filter(Boolean);
    if (commands.length) summary.append(el('span', 'muted small', commands.join('；')));
    if (validation.durationMs != null) summary.append(el('span', 'muted small', `${validation.durationMs} ms`));
  } else if (validation.status === 'failed') {
    const count = Number(validation.applied);
    summary.append(el(
      'span',
      'badge error',
      `编译自测失败，已隐藏${count > 0 ? ` ${count} 条` : ''}修改建议`,
    ));
  } else {
    summary.append(el('span', 'badge', '未执行编译自测'));
    if (validation.reason) summary.append(el('span', 'muted small', validation.reason));
  }
  block.append(summary);
  if (validation.error) block.append(el('p', 'error-text small', validation.error));
  if (validation.output && validation.status === 'failed') {
    const output = String(validation.output);
    const tail = output.length > 8000 ? output.slice(output.length - 8000) : output;
    block.append(el('pre', 'verify-log', tail));
  }
  return block;
}

function renderWorkspaceSession(session, view, runId, { readOnly = false } = {}) {
  const block = el('section', 'card-section workspace-session');
  const summary = el('div', 'verify-summary');
  const status = session.status ?? 'pending';
  const badge = status === 'kept'
    ? '工作区修改已保留'
    : status === 'discarded'
      ? '工作区修改已丢弃'
      : '本次诊断已修改工作区';
  summary.append(el(
    'span',
    `badge ${status === 'kept' ? 'ok' : status === 'pending' ? 'error' : ''}`,
    badge,
  ));
  summary.append(el('span', 'muted small', `${session.changedFiles?.length ?? 0} 个文件`));
  if (session.selfCheck) {
    summary.append(el(
      'span',
      `badge ${session.selfCheck.status === 'passed' ? 'ok' : session.selfCheck.status === 'failed' ? 'error' : ''}`,
      session.selfCheck.status === 'passed'
        ? '编译自测通过'
        : session.selfCheck.status === 'failed'
          ? '编译自测失败'
          : '未执行编译自测',
    ));
    if (session.selfCheck.durationMs) {
      summary.append(el('span', 'muted small', `${session.selfCheck.durationMs} ms`));
    }
  }
  block.append(summary);

  if (session.changedFiles?.length) {
    const list = el('ul', 'evidence-list');
    for (const file of session.changedFiles.slice(0, 20)) list.append(el('li', null, file));
    block.append(list);
  }
  if (session.conflicts?.length) {
    block.append(el('p', 'error-text small', `冲突：${session.conflicts.map((item) => `${item.file}（${item.reason}）`).join('；')}`));
  }
  if (session.selfCheck?.error) {
    block.append(el('p', 'error-text small', session.selfCheck.error));
  }
  if (session.selfCheck?.output && session.selfCheck.status === 'failed') {
    block.append(el('pre', 'verify-log', String(session.selfCheck.output).slice(-8000)));
  }

  if (status === 'pending' && !readOnly && runId) {
    const actions = el('div', 'modal-actions');
    const keep = el('button', null, '保留修改');
    keep.type = 'button';
    keep.addEventListener('click', () => runWorkspaceAction(view, 'keep'));
    const discard = el('button', 'secondary', '丢弃修改');
    discard.type = 'button';
    discard.addEventListener('click', () => runWorkspaceAction(view, 'discard'));
    actions.append(keep, discard);
    block.append(actions);
  }
  return block;
}

async function runWorkspaceAction(view, action) {
  const response = view.response;
  const runId = response?.runId ?? response?.result?.meta?.runId;
  if (!runId) return;
  showMessage(view, action === 'keep' ? '正在保留工作区修改…' : '正在丢弃工作区修改…');
  try {
    const result = await api.workspace(action, { runId });
    if (result?.ok === false) {
      showMessage(view, result.error ?? '操作失败', 'message error');
      return;
    }
    const run = await api.getRun(runId);
    view.response.result = run.result;
    renderRunInto(view);
    showMessage(view, action === 'keep' ? '已保留工作区修改' : '已丢弃工作区修改', 'message ok');
    await loadWorkspacePending();
  } catch (error) {
    showMessage(view, `操作失败：${error.message}`, 'message error');
  }
}

async function loadWorkspacePending() {
  if (!api.isDesktop) {
    workspacePendingEl.hidden = true;
    return;
  }
  try {
    const result = await api.workspace('pending');
    pendingWorkspaceSessions = Array.isArray(result?.sessions) ? result.sessions : [];
    if (pendingWorkspaceSessions.length === 0) {
      workspacePendingEl.hidden = true;
      if (!workspaceRecoveryModal.hidden) closeWorkspaceRecovery();
      return;
    }
    workspacePendingText.textContent = `检测到 ${pendingWorkspaceSessions.length} 个未收尾的工作区修改，请确认保留或丢弃。`;
    workspacePendingEl.hidden = false;
    if (!workspaceRecoveryModal.hidden) renderWorkspaceRecovery();
  } catch {
    workspacePendingEl.hidden = true;
  }
}

function openWorkspaceRecovery() {
  workspaceRecoveryMessage.textContent = '';
  workspaceRecoveryMessage.className = 'message';
  renderWorkspaceRecovery();
  workspaceRecoveryModal.hidden = false;
  hideBrowserForModal();
}

function closeWorkspaceRecovery() {
  workspaceRecoveryModal.hidden = true;
  restoreBrowserAfterModal();
}

function renderWorkspaceRecovery() {
  workspaceRecoveryList.textContent = '';
  if (pendingWorkspaceSessions.length === 0) {
    workspaceRecoveryList.append(el('p', 'muted small', '当前没有未收尾的工作区修改。'));
    return;
  }
  for (const session of pendingWorkspaceSessions) {
    const item = el('div', 'workspace-recovery-item');
    const meta = el('div', 'workspace-recovery-meta');
    const startedAt = session.startedAt ? new Date(session.startedAt).toLocaleString() : '未知时间';
    const statusLabel = session.status === 'pending' ? '待决定' : '编辑中（可能未生成诊断结果）';
    const detail = el('span', null, `${statusLabel} · 改动 ${session.changedFiles ?? 0} 个文件 · 已快照 ${session.touchedFiles ?? 0} 个 · ${session.repoCount ?? 0} 个仓库 · ${startedAt}`);
    meta.append(el('strong', null, session.runId), detail);
    if (Array.isArray(session.files) && session.files.length > 0) {
      const shown = session.files.length > 6 ? `${session.files.slice(0, 6).join('、')} …` : session.files.join('、');
      meta.append(el('span', null, `文件：${shown}`));
    }

    const actions = el('div', 'workspace-recovery-actions');
    const keep = el('button', null, '保留修改');
    keep.type = 'button';
    keep.addEventListener('click', () => finalizeRecoveredWorkspace(session.runId, 'keep'));
    const discard = el('button', 'secondary', '丢弃并恢复');
    discard.type = 'button';
    discard.addEventListener('click', () => finalizeRecoveredWorkspace(session.runId, 'discard'));
    actions.append(keep, discard);
    if (session.status === 'pending') {
      const view = el('button', 'secondary', '查看结果');
      view.type = 'button';
      view.addEventListener('click', () => openRecoveredRun(session.runId));
      actions.append(view);
    }
    item.append(meta, actions);
    workspaceRecoveryList.append(item);
  }
}

async function finalizeRecoveredWorkspace(runId, action) {
  if (action === 'discard' && typeof window.confirm === 'function'
    && !window.confirm(`丢弃 ${runId} 的修改并恢复诊断前内容？诊断期间被外部修改的文件会保留并报告冲突。`)) {
    return;
  }
  workspaceRecoveryMessage.textContent = action === 'keep' ? '正在保留…' : '正在恢复…';
  workspaceRecoveryMessage.className = 'message muted';
  try {
    const result = await api.workspace(action, { runId });
    if (result?.ok === false) {
      const conflicts = Array.isArray(result.conflicts) ? result.conflicts.length : 0;
      workspaceRecoveryMessage.textContent = `${result.error ?? '操作失败'}${conflicts ? `（${conflicts} 个冲突文件未覆盖）` : ''}`;
      workspaceRecoveryMessage.className = 'message error';
      return;
    }
    const restored = Array.isArray(result?.restored) ? result.restored.length : 0;
    workspaceRecoveryMessage.textContent = action === 'keep'
      ? `已保留 ${runId} 的修改`
      : `已恢复 ${restored} 个文件`;
    workspaceRecoveryMessage.className = 'message ok';
    await loadWorkspacePending();
    await loadRuns();
  } catch (error) {
    workspaceRecoveryMessage.textContent = `操作失败：${error.message}`;
    workspaceRecoveryMessage.className = 'message error';
  }
}

function openRecoveredRun(runId) {
  closeWorkspaceRecovery();
  setTab('history');
  loadRuns().then(() => showRun(runId)).catch((error) => {
    setStatus(`打开诊断失败：${error.message}`, 'error');
  });
}

workspacePendingOpen.addEventListener('click', async () => {
  await loadWorkspacePending();
  if (pendingWorkspaceSessions.length > 0) openWorkspaceRecovery();
});
workspaceRecoveryClose.addEventListener('click', () => {
  closeWorkspaceRecovery();
});
workspaceRecoveryModal.addEventListener('click', (event) => {
  if (event.target === workspaceRecoveryModal) closeWorkspaceRecovery();
});

function renderRunBody(container, result, agent, view, { readOnly = false, showHeader = true } = {}) {
  const runId = view.response?.runId ?? result.meta?.runId;
  const correlationInfo = describeCorrelation(result);
  if (showHeader) {
    const head = el('div', 'card-head');
    head.append(
      el('strong', null, `Run ${runId ?? '-'}`),
      el('span', `badge ${result.gates?.ok ? 'ok' : 'error'}`, result.gates?.ok ? 'Gates ok' : 'Gates failed'),
      el('span', 'badge', `${result.meta?.agent ?? '-'} / ${result.meta?.mode ?? '-'}`),
    );
    if (agent?.incomplete || result.meta?.incomplete) {
      head.append(el('span', 'badge error', '未完成'));
    }
    container.append(head);
  }
  if (agent?.incomplete || result.meta?.incomplete) {
    const rawReason = agent?.incompleteReason ?? result.meta?.incompleteReason ?? 'unknown';
    const reasonLabel = {
      error_max_turns: '达到最大轮次',
      error_max_budget_usd: '达到费用上限',
      error_max_structured_output_retries: '结构化输出重试次数用尽',
    }[rawReason] ?? rawReason;
    container.append(el('p', 'error-text small', `未完成：${reasonLabel}`));
  }

  container.append(section('结论', el('p', 'conclusion', agent?.conclusion ?? '(无结论)')));
  if (result.databases?.notice && agent === result.agent) {
    container.append(el('p', 'error-text small', `⚠ ${result.databases.notice}`));
  }
  if (result.element) {
    const element = result.element;
    container.append(section('元素信息', kv([
      ['页面', element.page?.url ?? '—'],
      ['选择器', element.selector ?? '—'],
      ['文本', element.text || '—'],
      ['组件', element.framework?.componentName ?? '—'],
      ['组件文件', element.framework?.componentFile
        ?? element.componentCandidates?.[0]?.file
        ?? '未解析'],
      ['尺寸', element.rect ? `${element.rect.width} × ${element.rect.height}` : '—'],
      ['display', element.styles?.display ?? '—'],
      ['color', element.styles?.color ?? '—'],
      ['API 候选', (element.apiCandidates ?? []).map((api) => `${api.method ?? 'GET'} ${api.url}`).join('、') || '—'],
      ['后端候选', (element.backendCandidates ?? []).map((candidate) => candidate.file).join('、') || '—'],
      ['截图', element.screenshot ?? '—'],
    ])));
  }

  if (!result.element && (result.request || result.response)) {
    container.append(section('请求 / 响应', kv([
      ['方法', result.request?.method ?? '-'],
      ['路径', result.request?.url ? requestPath(result.request.url) : '-'],
      ['状态', result.response?.status ?? '-'],
      ['耗时', result.response?.durationMs != null ? `${result.response.durationMs} ms` : '-'],
    ])));
  }

  container.append(section('上下文', kv([
    ['日志关联', correlationInfo.label],
    ['日志', `${result.logs?.count ?? 0} 条`],
    ['日志解析', result.logs?.parser
      ? `${result.logs.parser}${result.logs.parserFallback ? '（降级）' : ''}`
      : 'n/a'],
    ['线程', String(result.threads?.total ?? 0)],
    ['工具调用', String(agent?.toolCalls?.length ?? 0)],
    ['数据库查询', String(result.databaseQueries?.length ?? 0)],
    ['前端错误', String(result.frontend?.errors?.length ?? 0)],
    ['前端源码', String(result.frontend?.files?.length ?? 0)],
    ['轮次', agent?.usage?.numTurns != null ? String(agent.usage.numTurns) : '—'],
    ['消耗 Token', formatTokenUsage(agent?.usage)],
    ['耗时', `${result.meta?.durationMs ?? 0} ms`],
  ])));
  if (correlationInfo.warning) {
    container.append(el('p', 'error-text small', correlationInfo.warning));
  }
  if (result.logs?.parserWarning) {
    container.append(el('p', 'error-text small', `日志解析告警：${result.logs.parserWarning}`));
  }

  const databaseQueries = Array.isArray(result.databaseQueries) ? result.databaseQueries : [];
  if (databaseQueries.length > 0) {
    const list = el('ul', 'evidence-list');
    for (const query of databaseQueries) {
      const target = query.connection?.name ?? query.connection?.id ?? '-';
      const outcome = query.error
        ? `失败：${query.message ?? query.code ?? 'unknown'}`
        : (query.rowCount != null ? `${query.rowCount} 行` : (query.affectedRows != null ? `影响 ${query.affectedRows} 行` : 'ok'));
      const item = el('li', null, `${query.error ? '❌' : '✅'} ${query.name} · ${target} · ${outcome}`);
      if (query.sql) {
        const sql = String(query.sql);
        item.append(el('code', 'muted small', ` ${sql.length > 200 ? `${sql.slice(0, 200)}…` : sql}`));
      }
      if (query.file) item.append(el('span', 'muted small', ` (${query.file})`));
      list.append(item);
    }
    container.append(section(`数据库查询 (${databaseQueries.length})`, list));
    container.append(el('p', 'muted small', '查询结果随诊断记录保存；删除该诊断会一并删除。'));
  }

  const refs = Array.isArray(agent?.evidenceRefs) ? agent.evidenceRefs : [];
  if (refs.length) {
    const list = el('ul', 'evidence-list');
    for (const ref of refs) {
      const item = el('li', null, `[${ref.type}] ${ref.ref}`);
      if (ref.note) item.append(el('span', 'muted', ` — ${ref.note}`));
      list.append(item);
    }
    container.append(section('证据链', list));
  }

  const checks = result.gates?.checks;
  if (Array.isArray(checks) && checks.length > 0) {
    const list = el('ul', 'advice-list');
    for (const check of checks) list.append(el('li', null, `${check.ok ? '✅' : '❌'} ${check.name}`));
    container.append(section('自检', list));
  }
  if (result.recheck) {
    container.append(section('复检', kv([
      ['结论', result.recheck.verdict ?? '-'],
      ['轮次', result.recheck.runs ?? '-'],
      ['说明', result.recheck.note ?? '-'],
    ])));
  }

  if (agent?.workspaceSession) {
    container.append(renderWorkspaceSession(
      agent.workspaceSession,
      view,
      result.meta?.runId ?? view.response?.runId,
      { readOnly },
    ));
  }
  if (agent?.fixesValidation) {
    container.append(renderFixValidation(agent.fixesValidation));
  }

  const fixes = agent?.fixes;
  if (Array.isArray(fixes) && fixes.length > 0) {
    const block = el('section', 'card-section');
    const headRow = el('div', 'fix-section-head');
    headRow.append(el('div', 'card-title', `修复建议 (${fixes.length})`));
    if (!readOnly && api.isDesktop) {
      const applicable = fixes.filter((fix) => (
        typeof fix === 'object'
        && ['edit', 'create', 'delete'].includes(fix.kind)
        && fix.preview?.status === 'ready'
        && !fix.workspaceApplied
        && !(fix.applied && !fix.applied.revertedAt)
      )).length;
      const appliedCount = fixes.filter((fix) => fix?.applied && !fix.applied.revertedAt).length;
      const batch = el('div', 'fix-batch');
      const applyAll = el('button', null, `全部应用${applicable ? ` (${applicable})` : ''}`);
      applyAll.type = 'button';
      applyAll.disabled = applicable === 0;
      applyAll.addEventListener('click', () => runFixBatch('apply-all', view));
      const undoAll = el('button', 'secondary', `全部撤销${appliedCount ? ` (${appliedCount})` : ''}`);
      undoAll.type = 'button';
      undoAll.disabled = appliedCount === 0;
      undoAll.addEventListener('click', () => runFixBatch('undo-all', view));
      batch.append(applyAll, undoAll);
      headRow.append(batch);
    }
    block.append(headRow);

    const list = el('ul', 'fix-list');
    fixes.forEach((fix, index) => list.append(renderFixCard(fix, view, index, { readOnly })));
    block.append(list);
    container.append(block);
  }

  const needsMoreInfo = agent?.needsMoreInfo;
  if (Array.isArray(needsMoreInfo) && needsMoreInfo.length > 0) {
    const list = el('ul', 'advice-list');
    for (const item of needsMoreInfo) list.append(el('li', null, item));
    container.append(section('待补充信息', list));
  }
}

function applyRequestDetailCollapse() {
  const body = detailEl.querySelector('.detail-overview-body');
  const head = detailEl.querySelector('.detail-overview-head');
  const chevron = head?.querySelector('.overview-chevron');
  if (body) body.hidden = requestDetailCollapsed;
  if (head) head.setAttribute('aria-expanded', String(!requestDetailCollapsed));
  if (chevron) chevron.textContent = requestDetailCollapsed ? '▸' : '▾';
  detailEl.classList.toggle('collapsed', Boolean(body) && requestDetailCollapsed);
}

async function showRequest(id) {
  currentRequestId = id;
  activeDiagnosisKey = requestDiagnosisKey(id);
  const diagnosis = diagnosisStates.get(activeDiagnosisKey);
  diagnoseQuestion.value = diagnosis?.question ?? '';
  renderRequests();
  renderDiagnosisState();
  requestTitle.textContent = '加载中…';
  requestMeta.textContent = '';
  detailEl.textContent = '加载中…';
  detailEl.classList.remove('collapsed');
  try {
    const { request } = await api.capture('detail', { id });
    // Selection may have moved while the detail request was in flight.
    if (String(currentRequestId) !== String(id)) return;
    if (!request) {
      detailEl.textContent = '请求已被清空或不存在';
      detailEl.classList.remove('collapsed');
      renderDiagnosisState();
      return;
    }
    currentRequest = request;
    requestTitle.textContent = `${request.method} ${requestPath(request.url)}`;
    requestMeta.textContent = [request.resourceType, request.status ?? '…', request.durationMs != null ? `${request.durationMs}ms` : null]
      .filter(Boolean)
      .join(' · ');
    detailEl.textContent = '';
    const overviewHead = el('button', 'detail-overview-head');
    overviewHead.type = 'button';
    overviewHead.id = 'detail-overview-toggle';
    overviewHead.setAttribute('aria-expanded', String(!requestDetailCollapsed));
    overviewHead.append(
      el('span', 'detail-overview-title', '概览'),
      el('span', 'overview-chevron', '▾'),
    );
    overviewHead.addEventListener('click', () => {
      requestDetailCollapsed = !requestDetailCollapsed;
      applyRequestDetailCollapse();
    });
    const overviewBody = el('div', 'detail-overview-body');
    overviewBody.id = 'detail-overview-body';
    overviewBody.append(
      kv([
        ['方法', request.method],
        ['URL', request.url],
        ['状态', request.status ?? '—'],
        ['类型', request.resourceType ?? '—'],
        ['耗时', request.durationMs != null ? `${request.durationMs} ms` : '—'],
        ['错误', request.error ?? '—'],
      ]),
      section('请求头', preBlock(JSON.stringify(request.requestHeaders ?? {}, null, 2))),
      ...(request.postData
        ? [section('请求体', preBlock(formatBodyText(request.postData, requestContentType(request))))]
        : []),
      section('响应头', preBlock(JSON.stringify(request.responseHeaders ?? {}, null, 2))),
      buildBodySection(request),
    );
    detailEl.append(overviewHead, overviewBody);
    applyRequestDetailCollapse();
  } catch (err) {
    if (String(currentRequestId) !== String(id)) return;
    detailEl.textContent = `加载失败：${err.message}`;
    detailEl.classList.remove('collapsed');
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

function candidateSets() {
  const local = new Set();
  const workspace = configCache?.workspace ?? {};
  const normalize = (url) => {
    const origin = normalizeOrigin(String(url ?? ''));
    return origin ? origin.replace(/\/+$/, '') : '';
  };
  if (workspace.backendUrl) local.add(normalize(workspace.backendUrl));
  for (const rule of routingRules) {
    if (rule.target?.kind !== 'local' || !rule.target?.baseUrl) continue;
    const url = normalize(rule.target.baseUrl);
    if (url) local.add(url);
  }
  for (const port of discoveredLocalPorts) local.add(`http://localhost:${port}`);
  return { local: [...local].filter(Boolean) };
}

async function refreshTargetCandidates() {
  const sets = candidateSets();
  targetStatus.textContent = '探测本地候选地址…';
  const probed = [];
  for (const url of sets.local) {
    if (await probeTarget(url)) probed.push(url);
  }
  targetCandidates = { local: probed, sit: [] };
  targetStatus.textContent = `改道目标可达 ${probed.length} 个（「原样透传」不需要目标地址）`;
  renderRouting();
}

function fillTargetOptions(select, kind, current) {
  select.textContent = '';
  if (kind === 'sit') {
    const option = document.createElement('option');
    option.value = '';
    option.textContent = '原样透传（不改道、不兜底）';
    select.append(option);
    select.value = '';
    select.disabled = true;
    return;
  }
  select.disabled = false;
  const probed = targetCandidates.local ?? [];
  const values = [...new Set([...(current ? [current] : []), ...probed])];
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

function applyRoutingWarningFix(warning) {
  const rule = routingRules.find((item) => item.id === warning.ruleId);
  if (!rule) return;
  rule.target = { kind: 'local', baseUrl: warning.baseUrl };
  routingWarnings = routingWarnings.filter((item) => item.ruleId !== warning.ruleId);
  renderRouting();
  routingMessage.textContent = `规则 ${warning.ruleId} 已改为「改道」，点击保存生效`;
  routingMessage.className = 'message';
}

/** Drop a stale server-side warning once the user edits that rule locally. */
function clearRuleWarning(ruleId) {
  const next = routingWarnings.filter((warning) => warning.ruleId !== ruleId);
  if (next.length === routingWarnings.length) return;
  routingWarnings = next;
  renderRoutingWarnings();
  const row = [...routingList.querySelectorAll('.rule-row')].find((item) => item.dataset.id === ruleId);
  row?.classList.remove('has-warning');
  row?.querySelector('.rule-warning')?.remove();
}

function renderRoutingWarnings() {
  routingWarningsEl.textContent = '';
  if (routingWarnings.length === 0) {
    routingWarningsEl.hidden = true;
    return;
  }
  routingWarningsEl.hidden = false;
  for (const warning of routingWarnings) {
    const line = el('p', null, `⚠ ${warning.message}`);
    if (warning.code === 'SIT_TARGET_IGNORED' && warning.baseUrl) {
      const fix = el('button', 'secondary', '改为改道');
      fix.type = 'button';
      fix.addEventListener('click', () => applyRoutingWarningFix(warning));
      line.append(' ', fix);
    }
    routingWarningsEl.append(line);
  }
}

function renderRouting() {
  routingStatus.textContent = `已加载 ${routingRules.length} 条规则${routingHits ? `，命中 ${routingHits} 次` : ''}`;
  renderRoutingWarnings();
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
    const ruleWarning = routingWarnings.find((warning) => warning.ruleId === rule.id);
    if (ruleWarning) row.classList.add('has-warning');

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
    for (const [value, label] of [
      ['local', '改道到目标地址（自动补 CORS）'],
      ['sit', '原样透传（不改道、不兜底）'],
    ]) {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = label;
      kind.append(option);
    }
    kind.value = rule.target?.kind ?? 'local';
    if (ruleWarning) kind.title = ruleWarning.message;
    const kindCell = el('div', 'rule-kind');
    kindCell.append(kind);
    if (ruleWarning) {
      const hint = el('span', 'rule-warning',
        ruleWarning.code === 'SIT_TARGET_IGNORED' ? '⚠ 地址被忽略' : '⚠ 类型无法识别');
      hint.title = ruleWarning.message;
      kindCell.append(hint);
    }

    const baseUrl = document.createElement('select');
    baseUrl.dataset.field = 'baseUrl';
    baseUrl.title = '从探测可达的候选地址中选择；切换路由方式会刷新选项';
    fillTargetOptions(baseUrl, kind.value, rule.target?.baseUrl);
    kind.addEventListener('change', () => {
      fillTargetOptions(baseUrl, kind.value, '');
      clearRuleWarning(rule.id);
    });

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
    const syncProbeState = () => {
      const isSit = kind.value === 'sit';
      probe.disabled = isSit;
      if (isSit) {
        probeStatus.textContent = '不需要';
        probeStatus.className = 'probe-status';
      }
    };
    kind.addEventListener('change', syncProbeState);
    syncProbeState();
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
      routingWarnings = routingWarnings.filter((warning) => warning.ruleId !== rule.id);
      renderRouting();
    });

    row.append(enabled, host, prefix, kindCell, baseUrl, probe, probeStatus, remove);
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
    routingWarnings = saved.routing?.warnings ?? [];
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
    const diagnosis = diagnosisStates.get(consoleDiagnosisKey(item.id));
    button.disabled = diagnosis?.status === 'running';
    button.textContent = diagnosis?.status === 'running' ? '诊断中…' : '诊断';
    button.addEventListener('click', () => runConsoleDiagnose(item.id));
    row.append(time, message, button);
    consoleList.append(row);
  }
}

function renderProgressSteps(container, steps) {
  container.textContent = '';
  if (steps.length === 0) {
    container.hidden = true;
    return;
  }
  container.hidden = false;
  for (const step of steps) {
    const row = el('div', `diagnose-step ${step.status ?? 'start'}`);
    const icon = step.status === 'start' ? '◌' : step.status === 'error' ? '✕' : '✓';
    row.append(
      el('span', 'diagnose-step-icon', icon),
      el('span', 'diagnose-step-label', step.label ?? ''),
    );
    if (step.detail) {
      const detail = el('span', 'diagnose-step-detail', step.detail);
      detail.title = step.detail;
      row.append(detail);
    }
    container.append(row);
  }
  container.scrollTop = container.scrollHeight;
}

function upsertProgressStep(steps, event) {
  if (!event) return;
  const id = event.id ?? event.label;
  if (!id) return;
  const existing = steps.find((step) => step.id === id);
  if (existing) {
    Object.assign(existing, event, { id });
  } else {
    steps.push({ ...event, id });
    if (steps.length > 40) steps.splice(0, steps.length - 40);
  }
}

function syncDiagnoseControls() {
  const state = currentRequestId
    ? diagnosisStates.get(requestDiagnosisKey(currentRequestId))
    : null;
  const running = state?.status === 'running';
  const button = $('diagnose-request');
  if (button) {
    button.disabled = running;
    button.textContent = running ? '诊断中…' : '诊断此请求';
  }
  diagnoseQuestion.disabled = running;
}

function renderDiagnosisState() {
  const state = activeDiagnosisState();
  if (state?.status === 'done') {
    // Finished diagnoses only keep the overview and the report; every
    // thinking step is hidden to leave room for the result.
    diagnoseProgressEl.textContent = '';
    diagnoseProgressEl.hidden = true;
  } else {
    renderProgressSteps(diagnoseProgressEl, state?.progressSteps ?? []);
  }
  if (!state) {
    diagnoseMessage.textContent = '';
    diagnoseMessage.className = 'muted';
    diagnoseResult.hidden = true;
    diagnoseResult.textContent = '';
    currentRunView = null;
  } else if (state.status === 'running') {
    diagnoseMessage.textContent = `${state.label}诊断中…`;
    diagnoseMessage.className = 'muted';
    diagnoseResult.hidden = true;
    diagnoseResult.textContent = '';
    currentRunView = null;
  } else if (state.status === 'done') {
    diagnoseMessage.textContent = '诊断完成';
    diagnoseMessage.className = 'message ok';
    if (state.response) {
      renderDiagnosis(state.response);
      diagnoseResult.hidden = false;
    }
  } else {
    diagnoseMessage.textContent = `诊断失败：${state.error ?? '未知错误'}`;
    diagnoseMessage.className = 'message error';
    diagnoseResult.hidden = true;
    diagnoseResult.textContent = '';
    currentRunView = null;
  }
  syncDiagnoseControls();
}

function finalizeStateProgress(state, status, label, detail = null) {
  // The client-side placeholder must never keep spinning after the run settles.
  state.progressSteps = state.progressSteps.filter((step) => step.id !== 'client-start');
  const id = status === 'error' ? 'error' : 'done';
  if (!state.progressSteps.some((step) => step.id === id)) {
    upsertProgressStep(state.progressSteps, { id, label, status, detail });
  }
}

async function runDiagnosisPayload(payload, label) {
  const requestId = payload.requestId != null ? String(payload.requestId) : null;
  const consoleId = payload.consoleId != null ? String(payload.consoleId) : null;
  if (!requestId && !consoleId) return;
  const key = requestId ? requestDiagnosisKey(requestId) : consoleDiagnosisKey(consoleId);
  if (diagnosisStates.get(key)?.status === 'running') return;

  const question = diagnoseQuestion.value.trim();
  const state = {
    key,
    requestId,
    consoleId,
    label,
    question,
    status: 'running',
    progressSteps: [],
    response: null,
    error: null,
    startedAt: Date.now(),
    endedAt: null,
  };
  diagnosisStates.set(key, state);
  activeDiagnosisKey = key;
  upsertProgressStep(state.progressSteps, { id: 'client-start', label: `${label}诊断已开始`, status: 'start' });
  renderDiagnosisState();
  renderRequests();
  renderConsoleList();

  try {
    const response = await api.diagnose({
      ...payload,
      question,
      allowExtraSources: $('allow-extra-sources').checked,
      mock: false,
      recheck: 1,
    });
    state.status = 'done';
    state.response = response;
    state.endedAt = Date.now();
    finalizeStateProgress(state, 'done', '诊断完成');
    if (activeDiagnosisKey === key) renderDiagnosisState();
    renderRequests();
    renderConsoleList();
    await loadRuns();
  } catch (err) {
    state.status = 'error';
    state.error = err?.message ?? String(err);
    state.endedAt = Date.now();
    finalizeStateProgress(state, 'error', '诊断失败', state.error);
    if (activeDiagnosisKey === key) renderDiagnosisState();
    renderRequests();
    renderConsoleList();
  }
}

function setElementPicking(active) {
  elementPicking = Boolean(active);
  const button = $('element-scan');
  button.classList.toggle('active', elementPicking);
  button.textContent = elementPicking ? '选择元素…' : '元素视野';
}

function showElementComposerBar(element) {
  pendingElement = element;
  elementComposerMeta.textContent = element?.framework?.componentFile
    || element?.framework?.componentName
    || element?.selector
    || '';
  elementComposerInput.value = '';
  elementComposerEl.hidden = false;
  requestAnimationFrame(syncBounds);
  elementComposerInput.focus();
}

function hideElementComposerBar() {
  elementComposerEl.hidden = true;
  elementComposerInput.value = '';
  pendingElement = null;
  requestAnimationFrame(syncBounds);
}

async function cancelElementComposer() {
  hideElementComposerBar();
  setElementPicking(false);
  await api.element('cancel').catch(() => {});
  setStatus('已取消元素选择', 'ok');
}

function submitElementComposer() {
  const element = pendingElement;
  if (!element) return;
  const question = elementComposerInput.value.trim();
  if (!question) {
    elementComposerInput.focus();
    return;
  }
  hideElementComposerBar();
  setElementPicking(false);
  setStatus('元素诊断已开始', 'ok');
  runElementDiagnosisPayload(element, question).catch((error) => {
    setStatus(`元素诊断启动失败：${error.message}`, 'error');
  });
}

function renderElementDetail(state) {
  const element = state?.element;
  if (!element) return;
  currentRequestId = null;
  diagnoseQuestion.value = state.question ?? '';
  requestTitle.textContent = '元素诊断';
  requestMeta.textContent = [
    element.framework?.componentName,
    element.framework?.componentFile,
    element.selector,
  ].filter(Boolean).join(' · ');
  detailEl.hidden = false;
  detailEl.classList.remove('collapsed');
  detailEl.textContent = '';
  const styles = element.styles ?? {};
  detailEl.append(
    section('元素概览', kv([
      ['页面', element.page?.url ?? '—'],
      ['路由', element.page?.route ?? '—'],
      ['选择器', element.selector ?? '—'],
      ['标签', element.tag ?? '—'],
      ['文本', element.text || '—'],
      ['组件', element.framework?.componentName ?? '—'],
      ['组件文件', element.framework?.componentFile ?? '未解析'],
      ['尺寸', element.rect ? `${element.rect.width} × ${element.rect.height}` : '—'],
      ['display', styles.display ?? '—'],
      ['color', styles.color ?? '—'],
      ['background', styles.backgroundColor ?? '—'],
      ['font-size', styles.fontSize ?? '—'],
      ...(element.frame?.url ? [['iframe', element.frame.url]] : []),
      ...(element.shadowHost ? [['shadow host', element.shadowHost]] : []),
    ])),
    section('关键样式', preBlock(JSON.stringify({
      display: styles.display,
      visibility: styles.visibility,
      position: styles.position,
      width: styles.width,
      height: styles.height,
      overflow: styles.overflow,
      color: styles.color,
      backgroundColor: styles.backgroundColor,
      fontSize: styles.fontSize,
      fontWeight: styles.fontWeight,
      lineHeight: styles.lineHeight,
      margin: styles.margin,
      padding: styles.padding,
      flex: styles.flex,
      gridTemplateColumns: styles.gridTemplateColumns,
    }, null, 2))),
    ...(element.componentCandidates?.length
      ? [section('组件候选', preBlock(element.componentCandidates.map((candidate) => (
        `${candidate.file}  (score ${candidate.score})${candidate.matches?.length ? ` · ${candidate.matches.join(', ')}` : ''}`
      )).join('\n')))]
      : []),
    ...(element.apiCandidates?.length
      ? [section('API 候选', preBlock(element.apiCandidates.map((api) => (
        `${api.method ?? 'GET'} ${api.url} · ${api.apiFile}`
      )).join('\n')))]
      : []),
    ...(element.backendCandidates?.length
      ? [section('后端候选', preBlock(element.backendCandidates.map((candidate) => (
        `${candidate.file}${candidate.matches?.length ? ` · ${candidate.matches.join(', ')}` : ''}`
      )).join('\n')))]
      : []),
    ...(element.nearbyRequests?.length
      ? [section('附近请求', preBlock(element.nearbyRequests.map((request) => (
        `${request.method ?? ''} ${request.url ?? ''} · ${request.status ?? '—'}`
      )).join('\n')))]
      : []),
    ...(element.html ? [section('HTML 片段', preBlock(element.html))] : []),
  );
  if (element.screenshotDataUrl) {
    const image = document.createElement('img');
    image.className = 'element-screenshot';
    image.src = element.screenshotDataUrl;
    image.alt = '元素截图';
    detailEl.append(section('元素截图', image));
  } else if (element.screenshot) {
    detailEl.append(section('元素截图', el('p', 'muted small', `已保存：${element.screenshot}`)));
  }
}

function showElementState(key) {
  const state = diagnosisStates.get(key);
  if (!state?.element) return;
  activeDiagnosisKey = key;
  renderElementDetail(state);
  renderDiagnosisState();
  renderRequests();
}

async function runElementDiagnosisPayload(element, question) {
  if (!element) return;
  const elementId = String(element.id ?? `element-${Date.now().toString(36)}`);
  const key = elementDiagnosisKey(elementId);
  if (diagnosisStates.get(key)?.status === 'running') return;
  const state = {
    key,
    elementId,
    element: { ...element, id: elementId },
    label: '元素',
    question: question ?? '',
    status: 'running',
    progressSteps: [],
    response: null,
    error: null,
    startedAt: Date.now(),
    endedAt: null,
  };
  diagnosisStates.set(key, state);
  activeDiagnosisKey = key;
  setTab('requests');
  setElementPicking(false);
  upsertProgressStep(state.progressSteps, {
    id: 'client-start',
    label: '元素诊断已开始',
    status: 'start',
  });
  renderElementDetail(state);
  renderDiagnosisState();
  renderRequests();

  try {
    const response = await api.diagnose({
      element: state.element,
      question: state.question,
      allowExtraSources: $('allow-extra-sources').checked,
      mock: false,
      recheck: 1,
    });
    state.status = 'done';
    state.response = response;
    state.endedAt = Date.now();
    finalizeStateProgress(state, 'done', '诊断完成');
    if (activeDiagnosisKey === key) {
      renderElementDetail(state);
      renderDiagnosisState();
    }
    renderRequests();
    await loadRuns();
  } catch (err) {
    state.status = 'error';
    state.error = err?.message ?? String(err);
    state.endedAt = Date.now();
    finalizeStateProgress(state, 'error', '诊断失败', state.error);
    if (activeDiagnosisKey === key) renderDiagnosisState();
    renderRequests();
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
  for (const rule of routingRules) {
    if (rule.target?.kind === 'local' && rule.target.baseUrl) {
      declared.push({
        kind: 'local',
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
    routingMessage.textContent = [
      `已生成 ${result.rules.length} 条（观测前缀 + 已声明目标 + 探活通过）`,
      result.unreachable.length > 0 ? `${result.unreachable.length} 组不可达已剔除` : null,
    ].filter(Boolean).join('；');
    routingMessage.className = 'message ok';
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
  nowOption.value = 'latest';
  nowOption.textContent = '最近日志（最后 N 条）';
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

function renderLogResult(result, anchorRequest, tailMode = false) {
  const stats = result.stats ?? {};
  const anchorText = tailMode
    ? `最近日志（最后 ${result.records?.length ?? 0} 条）`
    : anchorRequest
      ? `${anchorRequest.method} ${requestPath(anchorRequest.url)} [${anchorRequest.status ?? '…'}] @ ${new Date(anchorRequest.startedAt ?? Date.now()).toLocaleString()}`
      : `时间窗 @ ${new Date().toLocaleString()}`;
  const parserLabel = `${result.parser ?? '-'}${result.parserFallback ? '（降级）' : ''}`;
  logSummary.textContent = `${anchorText} · 解析器 ${parserLabel} · 文件 ${stats.files ?? 0} · 行 ${stats.lines ?? 0} · 解析 ${stats.parsed ?? 0} · 续行 ${stats.continuations ?? 0} · 未解析 ${stats.unparsed ?? 0}`;
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
  const tail = !anchorValue || anchorValue === 'latest';
  let anchor = Date.now();
  let anchorRequest = null;
  if (!tail) {
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
      ...(tail ? { tail: true } : { anchor, window: configCache?.workspace?.window }),
      limit: 300,
    });
    renderLogResult(result, anchorRequest, tail);
    if (result.parserFallback && result.parserWarning) {
      logMessage.textContent = `查询完成（降级解析）：${result.parserWarning}`;
      logMessage.className = 'message error';
    } else {
      logMessage.textContent = `查询完成：${result.records?.length ?? 0} 条`;
      logMessage.className = 'message ok';
    }
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

function hideBrowserForModal() {
  if (api.isDesktop && currentTab === 'browser') {
    api.browser('setBounds', { visible: false }).catch(() => {});
  }
}

function restoreBrowserAfterModal() {
  if (api.isDesktop && currentTab === 'browser') {
    requestAnimationFrame(() => syncBounds());
  }
}

function syncModelCustomRow({ focus = false } = {}) {
  const custom = modelNameInput.value === '__custom__';
  modelNameCustomRow.hidden = !custom;
  if (custom && focus) modelNameCustomInput.focus();
}

function openModelModal() {
  const agent = configCache?.workspace?.agent ?? {};
  const model = String(agent.model ?? '').trim();
  const known = [...modelNameInput.options]
    .some((option) => option.value === model && option.value !== '__custom__');
  modelNameInput.value = known ? model : (model ? '__custom__' : '');
  modelNameCustomInput.value = known ? '' : model;
  syncModelCustomRow();
  modelMaxTurnsInput.value = agent.maxTurns ?? '';
  modelMaxBudgetInput.value = agent.maxBudgetUsd ?? '';
  modelTimeoutInput.value = Math.round((agent.timeoutMs ?? 600000) / 1000);
  modelToolModeInput.value = ['readonly', 'sandbox', 'full'].includes(agent.toolMode)
    ? agent.toolMode
    : (agent.sandbox === false ? 'readonly' : 'sandbox');
  modelModal.hidden = false;
  hideBrowserForModal();
  modelNameInput.focus();
}

function closeModelModal() {
  modelModal.hidden = true;
  restoreBrowserAfterModal();
}

async function saveModelSettings() {
  if (!configCache?.workspace) {
    setStatus('配置尚未加载，请稍后重试', 'error');
    return;
  }
  const selectedModel = modelNameInput.value;
  const model = selectedModel === '__custom__'
    ? modelNameCustomInput.value.trim()
    : selectedModel;
  if (selectedModel === '__custom__' && !model) {
    setStatus('请输入自定义模型名称', 'error');
    return;
  }
  const maxTurns = Number(modelMaxTurnsInput.value);
  const maxBudget = Number(modelMaxBudgetInput.value);
  // The modal shows seconds; workspace.agent.timeoutMs stays in milliseconds.
  const timeoutSeconds = Number(modelTimeoutInput.value);
  const agent = {
    model,
    maxTurns: Number.isFinite(maxTurns) && maxTurns > 0 ? Math.floor(maxTurns) : null,
    maxBudgetUsd: Number.isFinite(maxBudget) && maxBudget > 0 ? maxBudget : null,
    timeoutMs: Number.isFinite(timeoutSeconds) && timeoutSeconds > 0
      ? Math.floor(timeoutSeconds * 1000)
      : 600000,
    toolMode: modelToolModeInput.value,
  };
  try {
    const saved = await api.saveConfig({
      workspace: { ...(configCache?.workspace ?? {}), agent },
    });
    configCache = saved;
    closeModelModal();
    setStatus('模型设置已保存', 'ok');
  } catch (error) {
    setStatus(`模型设置保存失败：${error.message}`, 'error');
  }
}

$('model-save').addEventListener('click', saveModelSettings);
modelNameInput.addEventListener('change', () => syncModelCustomRow({ focus: true }));
modelNameCustomInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    event.preventDefault();
    saveModelSettings();
  }
});
$('model-cancel').addEventListener('click', closeModelModal);
modelModal.addEventListener('click', (event) => {
  if (event.target === modelModal) closeModelModal();
});

profileSaveAsBtn.addEventListener('click', () => openProfileModal('create'));
profileRenameBtn.addEventListener('click', () => openProfileModal('rename', profilesState.activeId));
profileDeleteBtn.addEventListener('click', deleteSelectedProfile);
profileSelect.addEventListener('change', () => switchProfileById(profileSelect.value));
$('profile-modal-save').addEventListener('click', submitProfileName);
$('profile-modal-cancel').addEventListener('click', closeProfileModal);
profileNameInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    event.preventDefault();
    submitProfileName();
  }
});
profileModal.addEventListener('click', (event) => {
  if (event.target === profileModal) closeProfileModal();
});

$('database-add').addEventListener('click', () => openDatabaseEditor(null));
$('database-save').addEventListener('click', saveDatabaseModal);
$('database-cancel').addEventListener('click', closeDatabaseEditor);
$('database-close').addEventListener('click', closeDatabaseModal);
$('database-test').addEventListener('click', testDatabaseModal);
databaseModal.addEventListener('click', (event) => {
  if (event.target === databaseModal) closeDatabaseModal();
});
window.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return;
  if (!databaseModal.hidden) closeDatabaseModal();
  else if (!profileModal.hidden) closeProfileModal();
  else if (!modelModal.hidden) closeModelModal();
});

api.onModelSettings(openModelModal);
api.onDatabaseSettings(openDatabaseManager);

const advancedToggle = $('toggle-advanced');
const advancedConfig = $('advanced-config');
let advancedOpen = false;
function setAdvancedOpen(open) {
  advancedOpen = Boolean(open);
  advancedConfig.hidden = !advancedOpen;
  advancedToggle.setAttribute('aria-expanded', String(advancedOpen));
  advancedToggle.textContent = advancedOpen ? '收起高级配置 ▴' : '高级配置 ▾';
}
advancedToggle.addEventListener('click', () => setAdvancedOpen(!advancedOpen));

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  setMessage('保存中…');
  try {
    const saved = await api.saveConfig(readForm());
    configCache = saved;
    renderLogSource(saved.workspace?.logfiles ?? []);
    if (saved.meta?.configDir) configPath.textContent = `配置目录：${saved.meta.configDir}`;
    setMessage(saved.meta?.configDir ? `已保存到 ${saved.meta.configDir}` : '已保存', 'ok');
    if (logParser) logParser.value = saved.workspace?.logParser ?? 'auto';
    loadProfiles().catch(() => {});
    refreshDevServer().catch(() => {});
    if (currentRunView) renderRunInto(currentRunView);
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
$('element-scan').addEventListener('click', async () => {
  if (!api.isDesktop) {
    setStatus('元素视野仅桌面版可用', 'error');
    return;
  }
  if (pendingElement || !elementComposerEl.hidden) {
    await cancelElementComposer();
    return;
  }
  try {
    setTab('browser');
    const result = await api.element('toggle');
    const picking = Boolean(result?.picking);
    setElementPicking(picking);
    setStatus(picking ? '请在页面中选择一个元素' : '已取消元素选择', picking ? '' : 'ok');
  } catch (error) {
    setElementPicking(false);
    setStatus(`元素视野操作失败：${error.message}`, 'error');
  }
});

elementComposerSubmit.addEventListener('click', submitElementComposer);
elementComposerCancel.addEventListener('click', () => { cancelElementComposer().catch(() => {}); });
elementComposerInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    event.preventDefault();
    submitElementComposer();
  }
  if (event.key === 'Escape') {
    event.preventDefault();
    cancelElementComposer().catch(() => {});
  }
});

api.onElementEvent((event) => {
  if (!event) return;
  if (event.type === 'element-pick-start') {
    setElementPicking(true);
    setStatus('请在页面中选择一个元素');
  } else if (event.type === 'element-picked') {
    setElementPicking(false);
    showElementComposerBar(event.element);
    setStatus('已选中元素，请在浏览器下方输入问题');
  } else if (event.type === 'element-submit') {
    hideElementComposerBar();
    setElementPicking(false);
    setStatus('元素诊断已开始', 'ok');
    runElementDiagnosisPayload(event.element, event.question).catch((error) => {
      setStatus(`元素诊断启动失败：${error.message}`, 'error');
    });
  } else if (event.type === 'element-pick-cancel') {
    hideElementComposerBar();
    setElementPicking(false);
  } else if (event.type === 'element-error') {
    hideElementComposerBar();
    setElementPicking(false);
    setStatus(`元素选择失败：${event.message ?? '未知错误'}`, 'error');
  }
});

api.onWorkspaceEvent((event) => {
  if (event?.type !== 'pending') return;
  if (Array.isArray(event.sessions)) pendingWorkspaceSessions = event.sessions;
  workspacePendingText.textContent = `检测到 ${pendingWorkspaceSessions.length} 个未收尾的工作区修改，请确认保留或丢弃。`;
  workspacePendingEl.hidden = pendingWorkspaceSessions.length === 0;
  openWorkspaceRecovery();
});

async function clearCapturedData() {
  const runningRequestIds = [];
  const runningConsoleIds = [];
  for (const state of diagnosisStates.values()) {
    if (state.status !== 'running') continue;
    if (state.requestId != null) runningRequestIds.push(String(state.requestId));
    if (state.consoleId != null) runningConsoleIds.push(String(state.consoleId));
  }
  const keepRequests = new Set(runningRequestIds);
  const keepConsoles = new Set(runningConsoleIds);
  try {
    await api.capture('clear', {
      exceptIds: runningRequestIds,
      exceptConsoleIds: runningConsoleIds,
    });
    for (const id of [...captureState.keys()]) {
      if (!keepRequests.has(String(id))) captureState.delete(id);
    }
    for (const id of [...consoleState.keys()]) {
      if (!keepConsoles.has(String(id))) consoleState.delete(id);
    }
    consoleErrorCount = consoleState.size;

    // Settled diagnoses for cleared records disappear with them; running ones
    // stay alive until they finish and can be cleared next time.
    for (const [key, state] of [...diagnosisStates]) {
      if (state.status === 'running') continue;
      const requestGone = state.requestId != null && !keepRequests.has(String(state.requestId));
      const consoleGone = state.consoleId != null && !keepConsoles.has(String(state.consoleId));
      if (requestGone || consoleGone) diagnosisStates.delete(key);
    }

    if (currentRequestId != null && !keepRequests.has(String(currentRequestId))) {
      currentRequestId = null;
      currentRequest = null;
      requestTitle.textContent = '选择一条请求';
      requestMeta.textContent = '';
      detailEl.textContent = '选择一条请求查看详情';
      applyRequestDetailCollapse();
    }
    if (activeDiagnosisKey && !diagnosisStates.has(activeDiagnosisKey)) {
      activeDiagnosisKey = currentRequestId != null ? requestDiagnosisKey(currentRequestId) : null;
    }
    renderConsoleList();
    renderRequests();
    renderDiagnosisState();
  } catch (err) {
    hintEl.textContent = `清空失败：${err.message}`;
  }
}
$('clear-requests').addEventListener('click', clearCapturedData);
$('browser-clear').addEventListener('click', clearCapturedData);
$('only-errors').addEventListener('change', renderRequests);
devServerStartBtn.addEventListener('click', () => devServerAction('start'));
devServerRestartBtn.addEventListener('click', () => devServerAction('restart'));
devServerStopBtn.addEventListener('click', () => devServerAction('stop'));
requestFilterBar.addEventListener('click', (event) => {
  const button = event.target.closest('button[data-filter]');
  if (!button) return;
  requestFilter = button.dataset.filter;
  renderRequests();
});
$('refresh-runs').addEventListener('click', loadRuns);


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
  const keep = new Set();
  for (const state of diagnosisStates.values()) {
    if (state.status === 'running' && state.consoleId != null) keep.add(String(state.consoleId));
  }
  await api.capture('console-clear', { exceptIds: [...keep] }).catch(() => {});
  for (const id of [...consoleState.keys()]) {
    if (!keep.has(String(id))) consoleState.delete(id);
  }
  consoleErrorCount = consoleState.size;
  for (const [key, state] of [...diagnosisStates]) {
    if (state.status === 'running') continue;
    if (state.consoleId != null && !keep.has(String(state.consoleId))) diagnosisStates.delete(key);
  }
  if (activeDiagnosisKey && !diagnosisStates.has(activeDiagnosisKey)) {
    activeDiagnosisKey = currentRequestId != null ? requestDiagnosisKey(currentRequestId) : null;
    renderDiagnosisState();
  }
  renderConsoleList();
});
$('save-routing').addEventListener('click', saveRouting);
for (const tab of document.querySelectorAll('.tab')) {
  tab.addEventListener('click', () => setTab(tab.dataset.tab));
}

api.onDiagnoseProgress((progress) => {
  const key = progress?.elementId != null
    ? elementDiagnosisKey(progress.elementId)
    : progress?.consoleId != null
      ? consoleDiagnosisKey(progress.consoleId)
      : progress?.requestId != null
        ? requestDiagnosisKey(progress.requestId)
        : null;
  if (!key) return;
  const state = diagnosisStates.get(key);
  if (!state || state.status !== 'running') return;
  upsertProgressStep(state.progressSteps, progress);
  if (activeDiagnosisKey !== key) return;
  renderProgressSteps(diagnoseProgressEl, state.progressSteps);
});

api.onFollowUpProgress((progress) => {
  if (!followUpProgressContext) return;
  upsertProgressStep(followUpProgressContext.steps, progress);
  renderProgressSteps(followUpProgressContext.container, followUpProgressContext.steps);
});

api.onDevServer((event) => {
  if (event.type === 'state') {
    const previous = devServerState;
    devServerState = event.state;
    if (event.state?.status === 'starting' && previous?.status !== 'starting') {
      devServerLogLines = [];
      renderDevServerLog();
    }
    renderDevServer();
  } else if (event.type === 'log') {
    devServerLogLines.push({ stream: event.stream, line: event.line });
    if (devServerLogLines.length > MAX_DEV_LOG_LINES) {
      devServerLogLines.splice(0, devServerLogLines.length - MAX_DEV_LOG_LINES);
    }
    renderDevServerLog();
  }
});

api.onCapture((event) => {
  if (event.type === 'request' || event.type === 'update') {
    captureState.set(event.record.id, event.record);
    scheduleRender();
  } else if (event.type === 'clear') {
    const keep = new Set((event.keepRequestIds ?? []).map(String));
    if (keep.size === 0) {
      captureState.clear();
    } else {
      for (const id of [...captureState.keys()]) {
        if (!keep.has(String(id))) captureState.delete(id);
      }
    }
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
    const keep = new Set((event.keepIds ?? []).map(String));
    if (keep.size === 0) {
      consoleState.clear();
    } else {
      for (const id of [...consoleState.keys()]) {
        if (!keep.has(String(id))) consoleState.delete(id);
      }
    }
    consoleErrorCount = consoleState.size;
    renderConsoleList();
    scheduleRender();
  } else if (event.type === 'routing-miss') {
    routingStatus.textContent = `最近未命中：${event.method} ${event.url}`;
  } else if (event.type === 'routing-warning') {
    routingMessage.textContent = `⚠ ${event.message}`;
    routingMessage.className = 'message error';
  } else if (event.type === 'cors-warning') {
    if (event.repaired) {
      setStatus(`预检已兜底：${event.url} 原状态 ${event.status} → 200`, 'ok');
      routingMessage.textContent = `预检已兜底：${event.url} 原状态 ${event.status} → 200 OK`;
      routingMessage.className = 'message ok';
    } else {
      setStatus(`预检失败：${event.url} 返回 HTTP ${event.status}`, 'error');
      routingMessage.textContent = `预检失败：${event.url} 由该地址返回 HTTP ${event.status}；该请求未改道（SIT），不会兜底`;
      routingMessage.className = 'message error';
    }
  } else if (event.type === 'routing') {
    routingHits += 1;
    routingMessage.textContent = event.passthrough
      ? `透传（未改道）：${event.method} ${event.url}`
      : `改道：${event.method} ${event.url} → ${event.target ?? 'OPTIONS（仅补 CORS）'}`;
    routingMessage.className = event.passthrough ? 'message' : 'message ok';
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
await loadWorkspacePending();
setTab('browser');
requestAnimationFrame(syncBounds);
setTimeout(syncBounds, 300);
await refreshRequests();

window.__dcUIReady = true;
