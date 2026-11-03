import { app, BrowserWindow, ipcMain } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createService } from '../service.mjs';
import { startServer } from '../server.mjs';
import { BrowserHost } from './browser-host.mjs';
import { Router } from './routing.mjs';
import { runCaptureDiagnosis } from '../../diagnose/run.mjs';
import { createMockAgent } from '../../agent/mock.mjs';
import { createClaudeAgent } from '../../agent/claude.mjs';
import { log, setLogFile } from '../../core/logger.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../../..');
const HOST = '127.0.0.1';

app.disableHardwareAcceleration();



function argValue(flag) {
  const inline = process.argv.find((arg) => arg.startsWith(`${flag}=`));
  if (inline) return inline.slice(flag.length + 1);
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const smoke = process.argv.includes('--smoke');
const smokeUrl = argValue('--smoke-url');
const port = Number(argValue('--port') ?? 7080);
const runsDir = argValue('--runs-dir');
const configDir = argValue('--config-dir');

function registerIpc(service, getHost, getRouter, setRules) {
  ipcMain.handle('dc:config', async (_event, payload = {}) => {
    if (payload.action === 'get') return service.getConfig();
    if (payload.action === 'save') {
      const saved = await service.saveConfig({ workspace: payload.workspace, routing: payload.routing });
      if (payload.routing !== undefined) {
        setRules(saved.routing.rules);
        getRouter()?.apply();
      }
      return saved;
    }
    throw new Error(`dc:config: unknown action ${payload.action}`);
  });

  ipcMain.handle('dc:runs', async (_event, payload = {}) => {
    if (payload.action === 'list') return { runs: await service.listRuns() };
    if (payload.action === 'get') return service.getRun(payload.runId);
    throw new Error(`dc:runs: unknown action ${payload.action}`);
  });

  ipcMain.handle('dc:browser', async (_event, payload = {}) => {
    const host = getHost();
    if (!host) throw new Error('browser host is not ready');
    switch (payload.action) {
      case 'open': {
        const url = payload.url ?? (await service.getConfig()).workspace.frontendUrl;
        if (!url) throw new Error('No frontendUrl configured');
        return { ok: true, ...host.open(url) };
      }
      case 'reload':
        host.reload();
        return { ok: true };
      case 'back':
        host.back();
        return { ok: true };
      case 'forward':
        host.forward();
        return { ok: true };
      case 'devtools':
        host.devtools();
        return { ok: true };
      case 'setBounds':
        host.setBounds(payload.bounds ?? payload);
        return { ok: true };
      case 'status':
        return host.status();
      default:
        throw new Error(`dc:browser: unknown action ${payload.action}`);
    }
  });

  ipcMain.handle('dc:capture', async (_event, payload = {}) => {
    const host = getHost();
    if (!host) throw new Error('browser host is not ready');
    switch (payload.action) {
      case 'list':
        return { requests: host.list(payload) };
      case 'detail':
        return { request: host.detail(payload.id) };
      case 'clear':
        host.clear();
        return { ok: true };
      default:
        throw new Error(`dc:capture: unknown action ${payload.action}`);
    }
  });

  ipcMain.handle('dc:diagnose', async (_event, payload = {}) => {
    const host = getHost();
    if (!host) throw new Error('browser host is not ready');
    const record = host.detail(payload.requestId);
    if (!record) throw new Error(`captured request not found: ${payload.requestId}`);

    const workspace = (await service.getConfig()).workspace;
    const observation = {
      request: {
        method: record.method,
        url: record.url,
        headers: record.requestHeaders,
        body: record.postData,
        startedAt: record.startedAt,
      },
      response: {
        status: record.status,
        statusText: record.statusText,
        ok: (record.status ?? 0) >= 200 && (record.status ?? 0) < 400,
        headers: record.responseHeaders,
        body: record.body?.text ?? null,
        truncated: record.body?.truncated ?? false,
        durationMs: record.durationMs,
        error: record.error,
      },
      firedAt: record.startedAt,
      resourceType: record.resourceType,
      ruleId: payload.ruleId ?? null,
    };

    const agent = payload.mock === false
      ? createClaudeAgent({
          cwd: workspace.sourceRoot ? path.resolve(ROOT, workspace.sourceRoot) : undefined,
        })
      : createMockAgent();

    return runCaptureDiagnosis(observation, {
      workspace,
      root: ROOT,
      runsDir: service.runsRoot,
      question: payload.question ?? '',
      recheck: payload.recheck ?? 1,
      agent,
    });
  });
}

function createWindow(url) {
  const window = new BrowserWindow({
    width: 1280,
    height: 820,
    show: !smoke,
    backgroundColor: '#0f1115',
    title: 'DebugCopilot',
    webPreferences: {
      preload: path.join(HERE, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });

  window.loadURL(url);
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event, target) => {
    if (!target.startsWith(url)) event.preventDefault();
  });
  return window;
}

async function waitForUi(window, timeoutMs = 5000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const state = await window.webContents
      .executeJavaScript('({ ready: window.__dcUIReady === true, error: window.__dcUIError ?? null })')
      .catch(() => ({ ready: false, error: 'executeJavaScript failed' }));
    if (state.ready || state.error) return state;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return { ready: false, error: 'timeout waiting for UI' };
}

async function waitForIdle(host, timeoutMs) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (!host.status().isLoading) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return false;
}

async function waitForCapture(host, timeoutMs) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (host.list({ limit: 500 }).length > 0) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}

async function runSmoke(window, host) {
  const timeout = setTimeout(() => {
    log.error('SMOKE_TIMEOUT');
    app.exit(1);
  }, 20_000);

  try {
    await new Promise((resolve, reject) => {
      window.webContents.once('did-finish-load', resolve);
      window.webContents.once('did-fail-load', (_event, code, description) => {
        reject(new Error(`did-fail-load ${code}: ${description}`));
      });
    });

    const uiState = await waitForUi(window);
    const ui = await window.webContents.executeJavaScript(`(async () => {
      const hasDc = !!window.dc && typeof window.dc.invoke === 'function';
      if (!hasDc) return { hasDc: false };
      try {
        const config = await window.dc.invoke('dc:config', { action: 'get' });
        return {
          hasDc,
          hasWorkspace: !!config && !!config.workspace,
          frontendUrl: config?.workspace?.frontendUrl ?? null,
          uiReady: window.__dcUIReady === true,
          hiddenAttrWorks: (() => {
            const element = document.getElementById('diagnose-result');
            return Boolean(element && element.hidden && getComputedStyle(element).display === 'none');
          })(),
        };
      } catch (error) {
        return { hasDc, error: String(error) };
      }
    })()`);
    ui.uiReady = uiState.ready;
    ui.uiError = uiState.error;

    let captured = 0;
    let captureOk = true;
    let diagnose = null;
    let pageTitle = null;
    if (smokeUrl) {
      host.open(smokeUrl);
      captureOk = await waitForCapture(host, 10_000);
      await waitForIdle(host, 8_000);
      captured = host.list({ limit: 500 }).length;
      if (captureOk) {
        diagnose = await window.webContents.executeJavaScript(`(async () => {
          const { requests } = await window.dc.invoke('dc:capture', { action: 'list' });
          if (!requests.length) return { ok: false, reason: 'no captures' };
          const response = await window.dc.invoke('dc:diagnose', {
            requestId: requests[0].id,
            question: 'smoke diagnosis',
            mock: true,
          });
          return {
            ok: true,
            runId: response.runId,
            gates: Boolean(response.result?.gates?.ok),
            mode: response.result?.meta?.mode ?? null,
          };
        })()`);
      }
    }

    if (smokeUrl) {
      await new Promise((resolve) => setTimeout(resolve, 400));
      pageTitle = await host.view.webContents.executeJavaScript('document.title').catch(() => null);
    }

    clearTimeout(timeout);
    const sample = host.list({ limit: 1 })[0] ?? null;
    const result = {
      ...ui,
      captured,
      captureOk,
      captureSample: sample ? { url: sample.url, status: sample.status } : null,
      diagnose,
      pageTitle,
      isLoading: host.status().isLoading,
    };
    console.log(`SMOKE_RESULT ${JSON.stringify(result)}`);
    const ok = Boolean(
      result.hasDc &&
      result.hasWorkspace &&
      captureOk &&
      (!smokeUrl || (diagnose?.ok && diagnose.gates)),
    );
    console.log(ok ? 'SMOKE_OK' : 'SMOKE_FAILED');
    return ok;
  } catch (error) {
    clearTimeout(timeout);
    log.error('SMOKE_FAILED', error);
    return false;
  }
}

async function bootstrap() {
  app.setName('DebugCopilot');
  try {
    setLogFile(path.join(app.getPath('userData'), 'debugcopilot.log'));
  } catch {
    // file logging is optional
  }
  const service = createService({ root: ROOT, runsDir, configDir });
  const initial = await service.getConfig();
  let host = null;
  let router = null;
  let currentRules = initial.routing.rules;
  let pageOrigin = null;
  registerIpc(
    service,
    () => host,
    () => router,
    (rules) => { currentRules = rules; },
  );

  const server = await startServer({
    service,
    uiDir: path.join(ROOT, 'src/ui'),
    host: HOST,
    port: Number.isFinite(port) ? port : 0,
  });
  log.info(`DebugCopilot Electron: ${server.url}`);

  const window = createWindow(server.url);
  host = new BrowserHost({
    window,
    onEvent: (event) => {
      if (event.type === 'navigation') {
        try {
          pageOrigin = new URL(event.url).origin;
        } catch {
          // ignore invalid navigation URLs
        }
      }
      if (!window.isDestroyed()) window.webContents.send('dc:capture:event', event);
    },
  });
  router = new Router({
    session: host.session,
    getRules: () => currentRules,
    getPageOrigin: () => pageOrigin,
    onHit: (event) => {
      if (!window.isDestroyed()) window.webContents.send('dc:capture:event', event);
    },
  });
  window.on('closed', () => {
    router?.dispose();
    host?.destroy();
  });

  if (!smoke && initial.workspace.frontendUrl) {
    try {
      host.open(initial.workspace.frontendUrl);
    } catch {
      // auto-open is best-effort
    }
  }

  if (smoke) {
    const ok = await runSmoke(window, host);
    await server.close();
    app.exit(ok ? 0 : 1);
    return;
  }

  app.on('window-all-closed', async () => {
    await server.close();
    app.quit();
  });
}

app.whenReady().then(bootstrap).catch((error) => {
  if (error?.code === 'EADDRINUSE') {
    log.error(`FATAL UI port ${port} is already in use; free it or pass --port`);
  } else {
    log.error('FATAL', error);
  }
  app.exit(1);
});
