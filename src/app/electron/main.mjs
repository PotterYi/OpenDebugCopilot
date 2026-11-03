import { app, BrowserWindow, ipcMain } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createService } from '../service.mjs';
import { startServer } from '../server.mjs';
import { BrowserHost } from './browser-host.mjs';

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
const port = Number(argValue('--port') ?? 0);
const runsDir = argValue('--runs-dir');
const configDir = argValue('--config-dir');

function registerIpc(service, getHost) {
  ipcMain.handle('dc:config', async (_event, payload = {}) => {
    if (payload.action === 'get') return service.getConfig();
    if (payload.action === 'save') {
      return service.saveConfig({ workspace: payload.workspace, routing: payload.routing });
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
        host.open(url);
        return { ok: true, url };
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

  ipcMain.handle('dc:diagnose', async () => ({ pending: 'not implemented in M2-S2' }));
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
    console.error('SMOKE_TIMEOUT');
    app.exit(1);
  }, 20_000);

  try {
    await new Promise((resolve, reject) => {
      window.webContents.once('did-finish-load', resolve);
      window.webContents.once('did-fail-load', (_event, code, description) => {
        reject(new Error(`did-fail-load ${code}: ${description}`));
      });
    });

    const ui = await window.webContents.executeJavaScript(`(async () => {
      const hasDc = !!window.dc && typeof window.dc.invoke === 'function';
      if (!hasDc) return { hasDc: false };
      try {
        const config = await window.dc.invoke('dc:config', { action: 'get' });
        return { hasDc, hasWorkspace: !!config && !!config.workspace, frontendUrl: config?.workspace?.frontendUrl ?? null };
      } catch (error) {
        return { hasDc, error: String(error) };
      }
    })()`);

    let captured = 0;
    let captureOk = true;
    if (smokeUrl) {
      host.open(smokeUrl);
      captureOk = await waitForCapture(host, 10_000);
      captured = host.list({ limit: 500 }).length;
    }

    clearTimeout(timeout);
    const result = { ...ui, captured, captureOk };
    console.log(`SMOKE_RESULT ${JSON.stringify(result)}`);
    const ok = Boolean(result.hasDc && result.hasWorkspace && captureOk);
    console.log(ok ? 'SMOKE_OK' : 'SMOKE_FAILED');
    return ok;
  } catch (error) {
    clearTimeout(timeout);
    console.error('SMOKE_FAILED', error);
    return false;
  }
}

async function bootstrap() {
  app.setName('DebugCopilot');
  const service = createService({ root: ROOT, runsDir, configDir });
  let host = null;
  registerIpc(service, () => host);

  const server = await startServer({
    service,
    uiDir: path.join(ROOT, 'src/ui'),
    host: HOST,
    port: Number.isFinite(port) ? port : 0,
  });
  console.log(`DebugCopilot Electron: ${server.url}`);

  const window = createWindow(server.url);
  host = new BrowserHost({
    window,
    onEvent: (event) => {
      if (!window.isDestroyed()) window.webContents.send('dc:capture:event', event);
    },
  });
  window.on('closed', () => host?.destroy());

  try {
    const config = await service.getConfig();
    if (!smoke && config.workspace.frontendUrl) host.open(config.workspace.frontendUrl);
  } catch {
    // auto-open is best-effort
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
  console.error('FATAL', error);
  app.exit(1);
});
