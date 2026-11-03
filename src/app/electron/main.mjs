import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import path from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createService } from '../service.mjs';
import { startServer } from '../server.mjs';
import { BrowserHost } from './browser-host.mjs';
import { isLocalHostname, Router } from './routing.mjs';
import { startLocalProxy } from './local-proxy.mjs';
import { readLogs } from '../../evidence/logs.mjs';
import { runCaptureDiagnosis } from '../../diagnose/run.mjs';
import { createMockAgent } from '../../agent/mock.mjs';
import { createClaudeAgent } from '../../agent/claude.mjs';
import { getLogFile, log, setLogFile } from '../../core/logger.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../../..');
const HOST = '127.0.0.1';

app.disableHardwareAcceleration();
app.setName('DebugCopilot');



function argValue(flag) {
  const inline = process.argv.find((arg) => arg.startsWith(`${flag}=`));
  if (inline) return inline.slice(flag.length + 1);
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const smoke = process.argv.includes('--smoke');
const smokeUrl = argValue('--smoke-url');
const smokeClick = argValue('--smoke-click');
const smokeEval = argValue('--smoke-eval');
const smokeWait = Number(argValue('--smoke-wait') ?? 0);
const smokeUiEval = argValue('--smoke-ui-eval');
const smokeOut = argValue('--smoke-out');
const port = Number(argValue('--port') ?? 7080);
const runsDir = argValue('--runs-dir');
const configDir = argValue('--config-dir');

function registerIpc(service, getHost, getRouter, setRules) {
  const handle = (channel, fn) => ipcMain.handle(channel, async (event, payload) => {
    try {
      return await fn(event, payload);
    } catch (error) {
      log.error('[ipc]', channel, error?.message ?? error);
      throw error;
    }
  });

  handle('dc:config', async (_event, payload = {}) => {
    if (payload.action === 'get') return service.getConfig();
    if (payload.action === 'open-log') {
      const file = getLogFile();
      if (!file) return { ok: false, reason: 'no-log-file' };
      const error = await shell.openPath(file);
      return { ok: !error, path: file, error: error || null };
    }
    if (payload.action === 'save') {
      const saved = await service.saveConfig({ workspace: payload.workspace, routing: payload.routing });
      if (payload.routing !== undefined) {
        setRules(saved.routing.rules);
        getRouter()?.apply();
      }
      log.info('[config] saved to', service.configDir, 'rules:', saved.routing?.rules?.length ?? 0);
      return saved;
    }
    throw new Error(`dc:config: unknown action ${payload.action}`);
  });

  handle('dc:runs', async (_event, payload = {}) => {
    if (payload.action === 'list') return { runs: await service.listRuns() };
    if (payload.action === 'get') return service.getRun(payload.runId);
    throw new Error(`dc:runs: unknown action ${payload.action}`);
  });

  handle('dc:browser', async (_event, payload = {}) => {
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

  handle('dc:logs', async (_event, payload = {}) => {
    if (payload.action === 'pick') {
      const result = await dialog.showOpenDialog({
        properties: ['openFile', 'multiSelections'],
        filters: [{ name: 'Log files', extensions: ['log', 'txt', 'out'] }],
      });
      return { paths: result.canceled ? [] : result.filePaths };
    }
    if (payload.action === 'query') {
      const workspace = (await service.getConfig()).workspace;
      const logfiles = (payload.logfiles?.length ? payload.logfiles : workspace.logfiles ?? [])
        .map((file) => path.resolve(ROOT, file));
      const anchor = Number(payload.anchor) || Date.now();
      const result = await readLogs({
        logfiles,
        parser: payload.parser ?? 'auto',
        anchor,
        window: payload.window ?? workspace.window,
        limit: payload.limit ?? 300,
        encoding: 'auto',
      });
      return { ...result, logfiles };
    }
    throw new Error(`dc:logs: unknown action ${payload.action}`);
  });

  handle('dc:capture', async (_event, payload = {}) => {
    const host = getHost();
    if (!host) throw new Error('browser host is not ready');
    switch (payload.action) {
      case 'list':
        return { requests: host.list(payload) };
      case 'detail':
        return { request: host.detail(payload.id) };
      case 'body':
        return { request: await host.loadBody(payload.id) };
      case 'clear':
        host.clear();
        return { ok: true };
      case 'console':
        return { events: host.listConsole({ limit: payload.limit ?? 50 }) };
      case 'console-clear':
        host.clearConsole();
        return { ok: true };
      default:
        throw new Error(`dc:capture: unknown action ${payload.action}`);
    }
  });

  handle('dc:diagnose', async (_event, payload = {}) => {
    const host = getHost();
    if (!host) throw new Error('browser host is not ready');
    const workspace = (await service.getConfig()).workspace;

    let observation;
    let frontendErrors;

    if (payload.consoleId) {
      const event = host.listConsole({ limit: 200 }).find((item) => String(item.id) === String(payload.consoleId));
      if (!event) throw new Error(`console error not found: ${payload.consoleId}`);
      const pageUrl = host.status().url;
      observation = {
        request: {
          method: 'CONSOLE',
          url: pageUrl,
          headers: {},
          body: null,
          startedAt: event.ts,
        },
        response: {
          status: null,
          statusText: '',
          ok: false,
          headers: {},
          body: null,
          durationMs: 0,
          error: event.message,
        },
        firedAt: event.ts,
        resourceType: 'console',
      };
      frontendErrors = [event];
    } else {
      const record = host.detail(payload.requestId);
      if (!record) throw new Error(`captured request not found: ${payload.requestId}`);
      observation = {
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
      frontendErrors = host.listConsole({ limit: 20 });
    }

    const agent = payload.mock === true
      ? createMockAgent()
      : createClaudeAgent({
          cwd: workspace.sourceRoot ? path.resolve(ROOT, workspace.sourceRoot) : undefined,
        });

    return runCaptureDiagnosis(observation, {
      workspace,
      root: ROOT,
      runsDir: service.runsRoot,
      question: payload.question ?? '',
      recheck: payload.recheck ?? 1,
      agent,
      frontendErrors,
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
          tempConfigFlag: document.getElementById('config-path')?.textContent.includes('临时配置') === true,
          logPathVisible: document.getElementById('log-path')?.textContent.includes('日志文件') === true,
          logTabPresent: Boolean(document.querySelector('[data-tab="logs"]')),
          pipeParserOption: [...document.querySelectorAll('#log-parser option')].some((option) => option.value === 'pipe'),
          consolePanel: Boolean(document.getElementById('console-list')),
          singleDiagnoseButton: Boolean(document.getElementById('diagnose-request')) && !document.getElementById('diagnose-mock'),
          questionIsTextarea: document.getElementById('diagnose-question')?.tagName === 'TEXTAREA',
          targetSelect: document.querySelector('[data-field="baseUrl"]')?.tagName === 'SELECT',
          sitUrlField: Boolean(document.querySelector('input[name="sitUrl"]')),
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
    let uiEvalResult = null;
    if (smokeUiEval) {
      const script = Buffer.from(smokeUiEval, 'base64').toString('utf8');
      uiEvalResult = await window.webContents.executeJavaScript(script);
    }

    let captured = 0;
    let captureOk = true;
    let diagnose = null;
    let pageTitle = null;
    let evalResult = null;
    let consoleDiagnose = null;
    if (smokeUrl) {
      host.open(smokeUrl);
      if (smokeEval) {
        await waitForIdle(host, 8_000);
        const script = Buffer.from(smokeEval, 'base64').toString('utf8');
        evalResult = await host.view.webContents.executeJavaScript(script);
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      if (smokeClick) {
        await waitForIdle(host, 8_000);
        await host.view.webContents.executeJavaScript(`(() => {
          const script = document.createElement('script');
          script.textContent = 'console.error("smoke-frontend-error"); setTimeout(function () { throw new Error("smoke-frontend-error"); }, 0);';
          document.body.appendChild(script);
          return true;
        })()`);
        await new Promise((resolve) => setTimeout(resolve, 250));
        await host.view.webContents.executeJavaScript(`(() => {
          const element = document.querySelector(${JSON.stringify(smokeClick)});
          if (!element) throw new Error('smoke-click selector not found');
          element.click();
          return true;
        })()`);
      }
      if (Number.isFinite(smokeWait) && smokeWait > 0) {
        await new Promise((resolve) => setTimeout(resolve, smokeWait));
      }
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
            frontendErrors: response.result?.frontend?.errors?.length ?? 0,
          };
        })()`);
      }
    }

    if (smokeUrl) {
      await new Promise((resolve) => setTimeout(resolve, 400));
      pageTitle = await host.view.webContents.executeJavaScript('document.title').catch(() => null);
    }

    await new Promise((resolve) => setTimeout(resolve, 300));
    if (smokeUrl) {
      consoleDiagnose = await window.webContents.executeJavaScript(`(async () => {
        const { events } = await window.dc.invoke('dc:capture', { action: 'console', limit: 5 });
        if (!events.length) return { ok: false, reason: 'no console events' };
        const response = await window.dc.invoke('dc:diagnose', {
          consoleId: events[0].id,
          question: 'smoke console diagnosis',
          mock: true,
        });
        return { ok: true, gates: Boolean(response.result?.gates?.ok) };
      })()`);
    }

    clearTimeout(timeout);
    const sample = host.list({ limit: 1 })[0] ?? null;
    const details = host.list({ limit: 50 }).map((item) => host.detail(item.id)).filter(Boolean);
    const sampleBody = details.find((item) => item.body?.text) ?? null;
    const result = {
      ...ui,
      captured,
      captureOk,
      captureSample: sample ? { url: sample.url, status: sample.status } : null,
      captureBody: Boolean(sampleBody),
      diagnose,
      consoleDiagnose,
      pageTitle,
      url: host.status().url,
      evalResult,
      uiEvalResult,
      isLoading: host.status().isLoading,
    };
    const ok = Boolean(
      result.hasDc &&
      result.hasWorkspace &&
      captureOk &&
      (!smokeUrl || (diagnose?.ok && diagnose.gates)),
    );
    result.ok = ok;
    console.log(`SMOKE_RESULT ${JSON.stringify(result)}`);
    console.log(ok ? 'SMOKE_OK' : 'SMOKE_FAILED');
    if (smokeOut) {
      await writeFile(smokeOut, JSON.stringify(result, null, 2), 'utf8').catch(() => {});
    }
    return ok;
  } catch (error) {
    clearTimeout(timeout);
    log.error('SMOKE_FAILED', error);
    return false;
  }
}

async function bootstrap() {
  try {
    setLogFile(path.join(app.getPath('userData'), 'debugcopilot.log'));
  } catch {
    // file logging is optional
  }
  const userData = app.getPath('userData');
  const effectiveConfigDir = configDir ? path.resolve(configDir) : app.isPackaged ? path.join(userData, 'configs') : path.join(ROOT, 'configs');
  const effectiveRunsDir = runsDir ? path.resolve(runsDir) : app.isPackaged ? path.join(userData, 'runs') : path.join(ROOT, 'runs');
  if (app.isPackaged) {
    await mkdir(effectiveConfigDir, { recursive: true });
    await mkdir(effectiveRunsDir, { recursive: true });
  }
  const service = createService({ root: ROOT, runsDir: effectiveRunsDir, configDir: effectiveConfigDir });
  const initial = await service.getConfig();
  let host = null;
  let router = null;
  let proxy = null;
  let currentRules = initial.routing.rules;
  let pageOrigin = null;
  log.info('[config] loaded rules:', currentRules.length, 'from', service.configDir);

  const portOf = (url) => url.port || (url.protocol === 'https:' ? '443' : '80');
  const isAllowedTarget = (target) => currentRules.some((rule) => {
    if (rule.enabled === false) return false;
    try {
      const base = new URL(rule.target.baseUrl);
      const sameHost = isLocalHostname(base.hostname) && isLocalHostname(target.hostname)
        ? true
        : base.hostname.toLowerCase() === target.hostname.toLowerCase();
      return sameHost && portOf(base) === portOf(target);
    } catch {
      return false;
    }
  });
  try {
    proxy = await startLocalProxy({ isAllowedTarget });
    log.info('[proxy] routing proxy:', proxy.url);
  } catch (error) {
    log.error('[proxy] failed to start; falling back to direct redirects', error);
  }
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
      log.info('[routing]', event.rule, event.method, event.url, '->', event.target ?? 'OPTIONS (no redirect)');
      if (!window.isDestroyed()) window.webContents.send('dc:capture:event', event);
    },
    onMiss: (event) => {
      if (!window.isDestroyed()) window.webContents.send('dc:capture:event', { type: 'routing-miss', ...event });
    },
    proxyBaseUrl: proxy?.url ?? null,
    getOriginalHeaders: (pathAndQuery) => host?.findRequestHeadersByPath(pathAndQuery) ?? null,
  });
  window.on('closed', () => {
    router?.dispose();
    host?.destroy();
    proxy?.close().catch(() => {});
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
    await proxy?.close().catch(() => {});
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
