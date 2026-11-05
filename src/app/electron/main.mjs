import { app, BrowserWindow, dialog, ipcMain, Menu, shell } from 'electron';
import path from 'node:path';
import { access, appendFile, mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createService } from '../service.mjs';
import { startServer } from '../server.mjs';
import { BrowserHost } from './browser-host.mjs';
import { isLocalHostname, Router } from './routing.mjs';
import { startLocalProxy } from './local-proxy.mjs';
import { createDevServerManager, killProcessTreeSync } from './dev-server.mjs';
import { applyFix, revertFix } from '../../core/fix-apply.mjs';
import { resolveFrontendProjectRoot } from '../../core/frontend-service.mjs';
import { runVerifyCommand } from './verify-command.mjs';
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
const smokeQuit = process.argv.includes('--smoke-quit');
const smokeUrl = argValue('--smoke-url');
const smokeClick = argValue('--smoke-click');
const smokeEval = argValue('--smoke-eval');
const smokeWait = Number(argValue('--smoke-wait') ?? 0);
const smokeUiEval = argValue('--smoke-ui-eval');
const smokeOut = argValue('--smoke-out');
const port = Number(argValue('--port') ?? 7080);
const runsDir = argValue('--runs-dir');
const configDir = argValue('--config-dir');

// Smoke/harness runs with custom config or runs dirs must not steal the lock from a real
// desktop instance. `--allow-multiple-instances` is an explicit escape hatch.
const useSingleInstanceLock = !smoke
  && !configDir
  && !runsDir
  && !process.argv.includes('--allow-multiple-instances');
const hasSingleInstanceLock = useSingleInstanceLock ? app.requestSingleInstanceLock() : true;
let mainWindow = null;
let shutdownResources = null;
let shutdownRunning = false;
let shutdownDone = false;

/**
 * Stop everything this process owns before Electron exits. The frontend dev server
 * is a child process and would otherwise survive the app window.
 */
async function shutdownAndQuit() {
  if (shutdownDone || shutdownRunning) return;
  shutdownRunning = true;
  const resources = shutdownResources;
  try {
    resources?.router?.dispose();
    resources?.host?.destroy();
    const cleanup = Promise.allSettled([
      resources?.devServer ? resources.devServer.dispose() : Promise.resolve(),
      resources?.proxy ? resources.proxy.close() : Promise.resolve(),
      resources?.server ? resources.server.close() : Promise.resolve(),
    ]);
    // Never let a stuck socket or child process block quitting forever.
    await Promise.race([
      cleanup,
      new Promise((resolve) => setTimeout(resolve, 7_000)),
    ]);
    log.info('[shutdown] dev server, proxy and UI server stopped');
  } finally {
    shutdownRunning = false;
    shutdownDone = true;
    app.quit();
  }
}

process.on('exit', () => {
  const pid = shutdownResources?.devServer?.child?.pid;
  if (pid) killProcessTreeSync(pid);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    shutdownAndQuit().catch(() => app.exit(1));
  });
}

async function writeJsonAtomic(file, value) {
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  try {
    await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    await rename(tmp, file);
  } catch (error) {
    await rm(tmp, { force: true }).catch(() => {});
    throw error;
  }
}

async function loadRunFixes(service, runId) {
  const { result } = await service.getRun(runId);
  const fixes = result?.agent?.fixes;
  if (!Array.isArray(fixes)) throw new Error('该诊断没有修复建议');
  const roots = result?.meta?.fixRoots;
  if (!roots) throw new Error('该诊断缺少源码目录信息，无法应用修改');
  return {
    result,
    fixes,
    roots,
    runDir: path.join(service.runsRoot, runId),
  };
}

async function loadRunFix(service, runId, fixIndex) {
  const context = await loadRunFixes(service, runId);
  if (!context.fixes[fixIndex]) throw new Error('修复建议不存在');
  return { ...context, fix: context.fixes[fixIndex] };
}

function confirmFixDialog(parent, { title, message, detail }) {
  const options = {
    type: 'warning',
    title,
    message,
    detail,
    buttons: ['确认', '取消'],
    defaultId: 1,
    cancelId: 1,
    noLink: true,
  };
  const win = parent ?? mainWindow;
  const pending = win && !win.isDestroyed()
    ? dialog.showMessageBox(win, options)
    : dialog.showMessageBox(options);
  return pending.then((choice) => choice.response === 0);
}

function registerIpc(service, getHost, getRouter, setRules, getDevServer) {
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
    if (payload.action === 'save') {
      const saved = await service.saveConfig({ workspace: payload.workspace, routing: payload.routing });
      if (payload.routing !== undefined) {
        setRules(saved.routing.rules);
        getRouter()?.apply();
        getHost()?.syncPreflightInterception?.();
      }
      log.info('[config] saved to', service.configDir, 'rules:', saved.routing?.rules?.length ?? 0);
      for (const warning of saved.routing?.warnings ?? []) {
        log.warn('[config] routing warning:', warning.message);
      }
      return saved;
    }
    throw new Error(`dc:config: unknown action ${payload.action}`);
  });

  handle('dc:runs', async (_event, payload = {}) => {
    if (payload.action === 'list') return { runs: await service.listRuns() };
    if (payload.action === 'get') return service.getRun(payload.runId);
    throw new Error(`dc:runs: unknown action ${payload.action}`);
  });

  handle('dc:fixes', async (event, payload = {}) => {
    const parent = BrowserWindow.fromWebContents(event.sender) ?? mainWindow;

    if (payload.action === 'apply-all' || payload.action === 'undo-all') {
      const { result, fixes, roots, runDir } = await loadRunFixes(service, payload.runId);
      if (payload.action === 'apply-all') {
        const targets = fixes
          .map((fix, index) => ({ fix, index }))
          .filter(({ fix }) => fix?.kind === 'edit'
            && fix.preview?.status === 'ready'
            && !(fix.applied && !fix.applied.revertedAt));
        if (targets.length === 0) return { ok: true, applied: 0, fixes };
        if (!smoke) {
          const files = targets.slice(0, 8).map(({ fix }) => `- ${fix.file}`).join('\n');
          const ok = await confirmFixDialog(parent, {
            title: '全部应用修改',
            message: `将修改 ${targets.length} 个文件`,
            detail: `${files}${targets.length > 8 ? `\n… 另有 ${targets.length - 8} 个` : ''}\n\n每个文件都会先备份，可整体撤销。`,
          });
          if (!ok) return { cancelled: true, fixes };
        }
        let applied = 0;
        let error = null;
        for (const { fix, index } of targets) {
          try {
            const backupAbs = path.join(runDir, 'backups', `fix-${index}-${Date.now()}.orig`);
            const done = await applyFix({ fix, roots, backupPath: backupAbs });
            fix.applied = {
              at: Date.now(),
              // Stable order for same-millisecond batch entries (undo runs in reverse).
              order: applied,
              backup: path.relative(runDir, backupAbs).split(path.sep).join('/'),
              root: done.root,
              file: done.file,
              line: done.line,
            };
            applied += 1;
          } catch (applyError) {
            error = `${fix?.file ?? 'fix'}：${applyError.message}`;
            break;
          }
        }
        await writeJsonAtomic(path.join(runDir, 'result.json'), result);
        await appendFile(
          path.join(runDir, 'fixes.log'),
          `${new Date().toISOString()} apply-all applied=${applied} error=${error ?? ''}\n`,
          'utf8',
        ).catch(() => {});
        log.info('[fix] apply-all', applied, error ?? 'ok');
        return error ? { ok: false, applied, error, fixes } : { ok: true, applied, fixes };
      }

      const targets = fixes
        .map((fix, index) => ({ fix, index }))
        .filter(({ fix }) => fix?.applied && !fix.applied.revertedAt)
        .sort((a, b) => (
          ((b.fix.applied.at ?? 0) * 1000) + (b.fix.applied.order ?? 0)
          - (((a.fix.applied.at ?? 0) * 1000) + (a.fix.applied.order ?? 0))
        ));
      if (targets.length === 0) return { ok: true, reverted: 0, fixes };
      if (!smoke) {
        const files = targets.slice(0, 8).map(({ fix }) => `- ${fix.file}`).join('\n');
        const ok = await confirmFixDialog(parent, {
          title: '全部撤销修改',
          message: `将还原 ${targets.length} 个文件`,
          detail: `${files}${targets.length > 8 ? `\n… 另有 ${targets.length - 8} 个` : ''}\n\n将用诊断时的备份覆盖当前文件。`,
        });
        if (!ok) return { cancelled: true, fixes };
      }
      let reverted = 0;
      let error = null;
      const runRoot = path.resolve(runDir);
      for (const { fix } of targets) {
        try {
          const backupAbs = path.resolve(runDir, fix.applied.backup ?? '');
          if (!backupAbs.startsWith(`${runRoot}${path.sep}`)) throw new Error('备份路径无效');
          await revertFix({ fix, roots, backupPath: backupAbs });
          fix.applied = { ...fix.applied, revertedAt: Date.now() };
          reverted += 1;
        } catch (undoError) {
          error = `${fix?.file ?? 'fix'}：${undoError.message}`;
          break;
        }
      }
      await writeJsonAtomic(path.join(runDir, 'result.json'), result);
      await appendFile(
        path.join(runDir, 'fixes.log'),
        `${new Date().toISOString()} undo-all reverted=${reverted} error=${error ?? ''}\n`,
        'utf8',
      ).catch(() => {});
      log.info('[fix] undo-all', reverted, error ?? 'ok');
      return error ? { ok: false, reverted, error, fixes } : { ok: true, reverted, fixes };
    }

    const fixIndex = Number(payload.fixIndex);
    if (!Number.isInteger(fixIndex) || fixIndex < 0) throw new Error('fixIndex 无效');
    const { result, fix, roots, runDir } = await loadRunFix(service, payload.runId, fixIndex);

    if (payload.action === 'apply') {
      if (fix.preview?.status !== 'ready') throw new Error('该建议没有可应用的 diff 预览');
      if (fix.applied && !fix.applied.revertedAt) throw new Error('该修改已应用，请先撤销');
      if (!smoke) {
        const ok = await confirmFixDialog(parent, {
          title: '应用代码修改',
          message: `即将修改 ${fix.file}`,
          detail: `${fix.summary}\n风险：${fix.risk ?? 'medium'}\n\n应用前会备份原文件，可在诊断面板撤销。`,
        });
        if (!ok) return { cancelled: true, fix };
      }

      const backupName = `fix-${fixIndex}-${Date.now()}.orig`;
      const backupAbs = path.join(runDir, 'backups', backupName);
      const applied = await applyFix({ fix, roots, backupPath: backupAbs });
      fix.applied = {
        at: Date.now(),
        backup: path.relative(runDir, backupAbs).split(path.sep).join('/'),
        root: applied.root,
        file: applied.file,
        line: applied.line,
      };
      await writeJsonAtomic(path.join(runDir, 'result.json'), result);
      await appendFile(
        path.join(runDir, 'fixes.log'),
        `${new Date().toISOString()} apply ${applied.root}/${applied.file} backup=${fix.applied.backup}\n`,
        'utf8',
      ).catch(() => {});
      log.info('[fix] applied', applied.root, applied.file, 'backup', fix.applied.backup);
      return { ok: true, fix };
    }

    if (payload.action === 'undo') {
      if (!fix.applied || fix.applied.revertedAt) throw new Error('该修改当前没有可撤销的应用记录');
      const runRoot = path.resolve(runDir);
      const backupAbs = path.resolve(runDir, fix.applied.backup ?? '');
      if (!backupAbs.startsWith(`${runRoot}${path.sep}`)) throw new Error('备份路径无效');
      if (!smoke) {
        const ok = await confirmFixDialog(parent, {
          title: '撤销代码修改',
          message: `即将还原 ${fix.file}`,
          detail: `${fix.summary}\n\n将用诊断时备份的原文件覆盖当前文件。`,
        });
        if (!ok) return { cancelled: true, fix };
      }

      await revertFix({ fix, roots, backupPath: backupAbs });
      fix.applied = { ...fix.applied, revertedAt: Date.now() };
      await writeJsonAtomic(path.join(runDir, 'result.json'), result);
      await appendFile(
        path.join(runDir, 'fixes.log'),
        `${new Date().toISOString()} undo ${fix.file}\n`,
        'utf8',
      ).catch(() => {});
      log.info('[fix] reverted', fix.file);
      return { ok: true, fix };
    }

    throw new Error(`dc:fixes: unknown action ${payload.action}`);
  });

  handle('dc:verify', async (event, payload = {}) => {
    if (payload.action !== 'run') throw new Error(`dc:verify: unknown action ${payload.action}`);
    const workspace = (await service.getConfig()).workspace;
    const command = String(workspace.verifyCommand ?? '').trim();
    if (!command) throw new Error('未配置验证命令（工作区 → 验证命令）');
    const root = await resolveFrontendProjectRoot(workspace, { rootDir: ROOT });
    if (!root.ok) throw new Error(root.reason);

    const parent = BrowserWindow.fromWebContents(event.sender) ?? mainWindow;
    if (!smoke) {
      const ok = await confirmFixDialog(parent, {
        title: '运行验证命令',
        message: command,
        detail: `工作目录：${root.cwd}\n\n验证命令会以当前用户权限执行。`,
      });
      if (!ok) return { cancelled: true };
    }

    const timeoutMs = Math.min(Math.max(Number(payload.timeoutMs) || 120_000, 1_000), 600_000);
    const run = await runVerifyCommand({ command, cwd: root.cwd, timeoutMs });

    const runId = payload.runId ? String(payload.runId) : null;
    const fixIndex = Number(payload.fixIndex);
    const hasFix = Boolean(runId) && Number.isInteger(fixIndex) && fixIndex >= 0;
    const fixContext = hasFix ? await loadRunFix(service, runId, fixIndex) : null;
    const runDir = fixContext?.runDir ?? null;
    let logFile = null;
    if (runDir) {
      await mkdir(runDir, { recursive: true });
      logFile = path.join(runDir, `verification-${Date.now()}.log`);
      await writeFile(logFile, `${command}\n\n${run.output}`, 'utf8');
    }

    let restarted = false;
    let restartMessage = null;
    if (payload.restart && run.ok) {
      const devServer = getDevServer();
      if (devServer) {
        const state = await devServer.restart();
        restarted = state.status === 'starting' || state.status === 'running';
        restartMessage = state.message ?? null;
      } else {
        restartMessage = '前端服务管理器不可用';
      }
    }

    const verification = {
      ok: run.ok,
      exitCode: run.exitCode,
      timedOut: run.timedOut,
      durationMs: run.durationMs,
      command,
      cwd: root.cwd,
      at: Date.now(),
      truncated: run.truncated,
      output: run.output,
      restarted,
      restartMessage,
    };

    if (fixContext) {
      const { result, fix, runDir: dir } = fixContext;
      if (fix.applied) {
        fix.applied.verification = {
          ...verification,
          log: logFile ? path.relative(dir, logFile).split(path.sep).join('/') : null,
        };
        await writeJsonAtomic(path.join(dir, 'result.json'), result);
        await appendFile(
          path.join(dir, 'fixes.log'),
          `${new Date().toISOString()} verify ok=${verification.ok} exit=${verification.exitCode} command=${command}\n`,
          'utf8',
        ).catch(() => {});
      }
    }

    log.info('[verify]', command, verification.ok ? 'ok' : `failed (${verification.exitCode})`);
    return verification;
  });

  handle('dc:devserver', async (_event, payload = {}) => {
    const devServer = getDevServer();
    if (!devServer) throw new Error('dev server manager is not ready');
    switch (payload.action) {
      case 'status': return devServer.status();
      case 'logs': return { logs: devServer.logsFor(payload.limit) };
      case 'start': return devServer.start();
      case 'stop': return devServer.stop();
      case 'restart': return devServer.restart();
      default: throw new Error(`dc:devserver: unknown action ${payload.action}`);
    }
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
        tail: payload.tail === true,
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
          requestFilterPresent: document.querySelectorAll('#request-filter button[data-filter]').length === 3,
          devServerControlsPresent: Boolean(document.getElementById('devserver-start'))
            && Boolean(document.getElementById('devserver-restart'))
            && Boolean(document.getElementById('devserver-stop')),
          singleDiagnoseButton: Boolean(document.getElementById('diagnose-request')) && !document.getElementById('diagnose-mock'),
          questionIsTextarea: document.getElementById('diagnose-question')?.tagName === 'TEXTAREA',
          targetSelect: document.querySelector('[data-field="baseUrl"]')?.tagName === 'SELECT',
          routingWarningShown: document.getElementById('routing-warnings')?.hidden === false,
          sitPassthrough: (() => {
            const kind = document.querySelector('[data-field="kind"]');
            const target = document.querySelector('[data-field="baseUrl"]');
            if (!kind || !target) return false;
            const previous = kind.value;
            kind.value = 'sit';
            kind.dispatchEvent(new Event('change', { bubbles: true }));
            const ok = target.disabled && (target.options[0]?.textContent ?? '').includes('原样透传');
            kind.value = previous;
            kind.dispatchEvent(new Event('change', { bubbles: true }));
            return ok;
          })(),
          logSourcePresent: Boolean(document.getElementById('log-source')),
          openLogButtonRemoved: !document.getElementById('open-log'),
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
      menuHasLog: Boolean(Menu.getApplicationMenu()?.items?.some((item) => item.label === '日志')),
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

async function ensureLogFile() {
  const file = getLogFile();
  if (!file) return null;
  try {
    await mkdir(path.dirname(file), { recursive: true });
    await appendFile(file, '', 'utf8');
  } catch {
    // creating the file is best-effort
  }
  return file;
}

async function openLogFile() {
  const file = await ensureLogFile();
  if (!file) {
    dialog.showErrorBox('打开日志', '尚未配置日志文件');
    return;
  }
  const error = await shell.openPath(file);
  if (error) dialog.showErrorBox('打开日志失败', error);
}

async function revealLogFile() {
  const file = await ensureLogFile();
  if (!file) {
    dialog.showErrorBox('打开日志', '尚未配置日志文件');
    return;
  }
  shell.showItemInFolder(file);
}

function installApplicationMenu() {
  const template = [
    ...(process.platform === 'darwin' ? [{ role: 'appMenu' }] : []),
    { role: 'fileMenu' },
    { role: 'editMenu' },
    { role: 'viewMenu' },
    { role: 'windowMenu' },
    {
      label: '日志',
      submenu: [
        { label: '打开日志文件', click: () => { openLogFile().catch(() => {}); } },
        { label: '在文件夹中显示', click: () => { revealLogFile().catch(() => {}); } },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

/**
 * Start the UI server on the preferred port. A busy port must not prevent the app
 * from starting: fall back to an ephemeral port and tell the user once the window is up.
 */
async function startUiServer({ service, uiDir, preferredPort }) {
  try {
    return { server: await startServer({ service, uiDir, host: HOST, port: preferredPort }) };
  } catch (error) {
    if (error?.code !== 'EADDRINUSE') throw error;
    log.warn(`[server] UI port ${preferredPort} is already in use; using an ephemeral port`);
    const server = await startServer({ service, uiDir, host: HOST, port: 0 });
    return { server, conflictPort: preferredPort };
  }
}

async function bootstrap() {
  try {
    let logFile = process.env.DC_LOG_FILE || path.join(ROOT, 'logs', 'debugcopilot.log');
    if (app.isPackaged && !process.env.DC_LOG_FILE) {
      const besideExe = path.join(path.dirname(app.getPath('exe')), 'logs', 'debugcopilot.log');
      try {
        await mkdir(path.dirname(besideExe), { recursive: true });
        await access(path.dirname(besideExe), constants.W_OK);
        logFile = besideExe;
      } catch {
        logFile = path.join(app.getPath('userData'), 'logs', 'debugcopilot.log');
      }
    }
    setLogFile(logFile);
    log.info('[config] log file:', logFile);
  } catch {
    // file logging is optional
  }
  installApplicationMenu();
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
  for (const warning of initial.routing?.warnings ?? []) {
    log.warn('[config] routing warning:', warning.message);
  }

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
  const useProxy = process.env.DC_ROUTING_PROXY === '1';
  if (useProxy) {
    try {
      proxy = await startLocalProxy({ isAllowedTarget });
      log.info('[proxy] routing proxy:', proxy.url);
    } catch (error) {
      log.error('[proxy] failed to start; falling back to direct redirects', error);
    }
  }
  const devServer = createDevServerManager({
    getWorkspace: async () => (await service.getConfig()).workspace,
    rootDir: ROOT,
    onEvent: (event) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('dc:devserver:event', event);
      }
    },
  });
  registerIpc(
    service,
    () => host,
    () => router,
    (rules) => { currentRules = rules; },
    () => devServer,
  );

  const { server, conflictPort } = await startUiServer({
    service,
    uiDir: path.join(ROOT, 'src/ui'),
    preferredPort: Number.isFinite(port) ? port : 0,
  });
  log.info(`DebugCopilot Electron: ${server.url}`);

  const window = createWindow(server.url);
  mainWindow = window;
  if (conflictPort && !smoke) {
    window.webContents.once('did-finish-load', () => {
      dialog.showMessageBox(window, {
        type: 'warning',
        title: 'UI 端口被占用',
        message: `端口 ${conflictPort} 已被其他程序占用，DebugCopilot 已改用 ${server.port}。`,
        detail: '功能不受影响；如需固定端口，请先释放该端口或使用 --port 指定其他端口。',
        buttons: ['知道了'],
      }).catch(() => {});
    });
  }
  host = new BrowserHost({
    window,
    getRoutingRules: () => currentRules,
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
      if (event.type === 'routing-warning') {
        log.warn('[routing warning]', event.message, event.url);
      } else {
        const outcome = event.passthrough ? 'passthrough (SIT)' : (event.target ?? 'OPTIONS (no redirect)');
        log.info('[routing]', event.rule, event.method, event.url, '->', outcome);
      }
      if (!window.isDestroyed()) window.webContents.send('dc:capture:event', event);
    },
    onMiss: (event) => {
      if (!window.isDestroyed()) window.webContents.send('dc:capture:event', { type: 'routing-miss', ...event });
    },
    proxyBaseUrl: proxy?.url ?? null,
    getOriginalHeaders: (url) => {
      if (!host) return null;
      const direct = host.findRequestHeaders(url);
      if (direct) return direct;
      try {
        const parsed = new URL(url);
        return host.findRequestHeadersByPath(`${parsed.pathname}${parsed.search}`);
      } catch {
        return null;
      }
    },
  });
  shutdownResources = { devServer, server, proxy, router, host };
  window.on('closed', () => {
    mainWindow = null;
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
    if (smokeQuit) {
      // Exercise the normal before-quit cleanup path (used by closing the window).
      app.quit();
      return;
    }
    await devServer.dispose().catch(() => {});
    await server.close();
    await proxy?.close().catch(() => {});
    app.exit(ok ? 0 : 1);
    return;
  }

  app.on('window-all-closed', () => {
    app.quit();
  });
}

if (!hasSingleInstanceLock) {
  // Do not start a second server on the fixed UI port; the existing window is focused
  // by the first instance's 'second-instance' handler (registered below).
  app.quit();
} else {
  if (useSingleInstanceLock) {
    app.on('second-instance', () => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        if (mainWindow.isMinimized()) mainWindow.restore();
        mainWindow.show();
        mainWindow.focus();
      }
    });
  }

  app.on('before-quit', (event) => {
    if (shutdownDone) return;
    event.preventDefault();
    shutdownAndQuit().catch(() => {
      shutdownDone = true;
      app.exit(1);
    });
  });

  app.whenReady().then(bootstrap).catch((error) => {
    if (error?.code === 'EADDRINUSE') {
      log.error(`FATAL UI server could not bind (preferred port ${port})`);
    } else {
      log.error('FATAL', error);
    }
    app.exit(1);
  });
}
