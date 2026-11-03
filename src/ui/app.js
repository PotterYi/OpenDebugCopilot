import { api } from './api.js';

const statusEl = document.getElementById('status');
const form = document.getElementById('config-form');
const messageEl = document.getElementById('config-message');
const runsEl = document.getElementById('runs');
const reportEl = document.getElementById('report');

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
    fillForm(config);
    setStatus('已连接', 'ok');
  } catch (err) {
    setStatus(`连接失败：${err.message}`, 'error');
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

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  setMessage('保存中…');
  try {
    await api.saveConfig(readForm());
    setMessage('已保存', 'ok');
  } catch (err) {
    setMessage(`保存失败：${err.message}`, 'error');
  }
});

document.getElementById('refresh-runs').addEventListener('click', loadRuns);

await loadConfig();
await loadRuns();
