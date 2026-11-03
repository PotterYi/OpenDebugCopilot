import { app, BrowserWindow, ipcMain } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createService } from '../service.mjs';
import { startServer } from '../server.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../../..');
const HOST = '127.0.0.1';

app.disableHardwareAcceleration();

function argValue(flag) {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const smoke = process.argv.includes('--smoke');
const port = Number(argValue('--port') ?? 0);
const runsDir = argValue('--runs-dir');
const configDir = argValue('--config-dir');

function registerIpc(service) {
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

  for (const channel of ['dc:browser', 'dc:capture', 'dc:diagnose']) {
    ipcMain.handle(channel, async () => ({ pending: 'not implemented in M2-S2' }));
  }
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

async function runSmoke(window) {
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

    const result = await window.webContents.executeJavaScript(`(async () => {
      const hasDc = !!window.dc && typeof window.dc.invoke === 'function';
      if (!hasDc) return { hasDc: false };
      try {
        const config = await window.dc.invoke('dc:config', { action: 'get' });
        return { hasDc, hasWorkspace: !!config && !!config.workspace, frontendUrl: config?.workspace?.frontendUrl ?? null };
      } catch (error) {
        return { hasDc, error: String(error) };
      }
    })()`);

    clearTimeout(timeout);
    console.log(`SMOKE_RESULT ${JSON.stringify(result)}`);
    const ok = Boolean(result.hasDc && result.hasWorkspace);
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
  registerIpc(service);

  const handle = await startServer({
    service,
    uiDir: path.join(ROOT, 'src/ui'),
    host: HOST,
    port: Number.isFinite(port) ? port : 0,
  });
  console.log(`DebugCopilot Electron: ${handle.url}`);

  const window = createWindow(handle.url);

  if (smoke) {
    const ok = await runSmoke(window);
    await handle.close();
    app.exit(ok ? 0 : 1);
    return;
  }

  app.on('window-all-closed', async () => {
    await handle.close();
    app.quit();
  });
}

app.whenReady().then(bootstrap).catch((error) => {
  console.error('FATAL', error);
  app.exit(1);
});
