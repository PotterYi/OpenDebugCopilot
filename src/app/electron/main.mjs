import { app, BrowserWindow, dialog, ipcMain, Menu, safeStorage, shell } from 'electron';
import path from 'node:path';
import { access, appendFile, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createService } from '../service.mjs';
import { startServer } from '../server.mjs';
import { BrowserHost } from './browser-host.mjs';
import { isLocalHostname, Router } from './routing.mjs';
import { startLocalProxy } from './local-proxy.mjs';
import { createDevServerManager, killProcessTreeSync } from './dev-server.mjs';
import { applyFix, revertFix } from '../../core/fix-apply.mjs';
import { buildFixPreviews } from '../../core/fixes.mjs';
import {
  applyVerificationGate,
  detectCompileCommands,
  runWorkspaceCheck,
  validateFixes,
} from '../../core/fix-validation.mjs';
import {
  cleanupAgentSandbox,
  createAgentSandbox,
  createSandboxCommandRunner,
  extractSandboxFixes,
  sandboxPromptFor,
} from '../../core/agent-sandbox.mjs';
import { buildReport, renderMarkdown } from '../../report/report.mjs';
import { resolveFrontendProjectRoot } from '../../core/frontend-service.mjs';
import { runVerifyCommand } from './verify-command.mjs';
import { createTools } from '../../tools/index.mjs';
import { readLogs } from '../../evidence/logs.mjs';
import { runCaptureDiagnosis, runElementDiagnosis } from '../../diagnose/run.mjs';
import { finalizeWorkspaceJournal, listPendingWorkspaceJournals } from '../../core/inplace-session.mjs';
import { createMockAgent } from '../../agent/mock.mjs';
import { createClaudeAgent } from '../../agent/claude.mjs';
import { getLogFile, log, setLogFile } from '../../core/logger.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../../..');
const HOST = '127.0.0.1';
const workspaceSessions = new Map();

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
const smokeUiEvalAfter = argValue('--smoke-ui-eval-after');
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

async function finalizeWorkspaceSession(service, runId, action) {
  const runDir = path.join(service.runsRoot, runId);
  const session = workspaceSessions.get(runId);
  let outcome;
  if (session) {
    outcome = action === 'keep'
      ? await session.keep()
      : await session.discard();
  } else {
    // The app may have restarted; recover from the on-disk journal.
    outcome = await finalizeWorkspaceJournal(path.join(runDir, 'workspace-journal.json'), action);
    if (!outcome.ok) {
      return {
        ok: false,
        error: outcome.error ?? '工作区会话已失效',
        conflicts: outcome.conflicts ?? [],
      };
    }
  }
  if (action === 'discard' && outcome?.conflicts?.length) {
    return {
      ok: false,
      error: '部分文件在诊断期间被外部修改，未自动回滚',
      conflicts: outcome.conflicts,
    };
  }
  workspaceSessions.delete(runId);
  const status = action === 'keep'
    ? 'kept'
    : (outcome?.status === 'pending' ? 'pending' : 'discarded');
  const file = path.join(runDir, 'result.json');
  let result = null;
  try {
    result = JSON.parse(await readFile(file, 'utf8'));
  } catch {
    result = null;
  }
  if (result?.agent?.workspaceSession) {
    result.agent.workspaceSession.status = status;
    if (Array.isArray(outcome?.conflicts) && outcome.conflicts.length > 0) {
      result.agent.workspaceSession.conflicts = outcome.conflicts;
    }
    for (const fix of result.agent.fixes ?? []) {
      fix.workspaceApplied = status === 'kept';
      fix.pendingDecision = status === 'pending';
    }
    await writeJsonAtomic(file, result);
  }
  try {
    const metaFile = path.join(runDir, 'meta.json');
    const meta = JSON.parse(await readFile(metaFile, 'utf8'));
    meta.workspaceSessionStatus = status;
    await writeJsonAtomic(metaFile, meta);
  } catch {
    // meta.json is optional
  }
  return {
    ok: true,
    status,
    restored: outcome?.restored ?? [],
    workspaceSession: result?.agent?.workspaceSession ?? null,
  };
}

function agentToolMode(workspace = {}) {
  const mode = workspace.agent?.toolMode;
  if (['readonly', 'sandbox', 'full'].includes(mode)) return mode;
  return workspace.agent?.sandbox === false ? 'readonly' : 'sandbox';
}

function agentOptionsFromWorkspace(workspace = {}, { extraSourceRoots = [] } = {}) {
  const agent = workspace.agent ?? {};
  const roots = new Set();
  const writeRoots = new Set();
  const addRoot = (value) => {
    const text = String(value ?? '').trim();
    if (!text) return null;
    const resolved = path.resolve(ROOT, text);
    roots.add(resolved);
    return resolved;
  };
  const primaryRoot = addRoot(workspace.sourceRoot) ?? undefined;
  const frontendRoot = addRoot(workspace.frontendSourceRoot);
  const frontendProject = addRoot(workspace.frontendProjectRoot);
  if (primaryRoot) writeRoots.add(primaryRoot);
  if (frontendRoot) writeRoots.add(frontendRoot);
  else if (frontendProject) writeRoots.add(frontendProject);
  for (const root of extraSourceRoots) addRoot(root?.root ?? root);
  const fallbackRoot = [...roots][0];
  return {
    cwd: primaryRoot ?? fallbackRoot,
    allowedRoots: [...roots],
    writeRoots: [...writeRoots],
    model: agent.model || undefined,
    maxTurns: agent.maxTurns,
    maxBudgetUsd: agent.maxBudgetUsd ?? undefined,
    timeoutMs: agent.timeoutMs ?? undefined,
  };
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

/**
 * Encrypt database passwords with Electron safeStorage. If the platform cannot
 * encrypt, creation returns null and the store rejects plaintext passwords.
 */
function createSecretCodec() {
  return {
    scheme: 'safeStorage',
    encrypt(value) {
      try {
        if (!safeStorage.isEncryptionAvailable()) return null;
        return safeStorage.encryptString(String(value)).toString('base64');
      } catch {
        return null;
      }
    },
    decrypt(data) {
      return safeStorage.decryptString(Buffer.from(String(data), 'base64'));
    },
  };
}

/** Per-write confirmation for db tools; never auto-approve outside smoke runs. */
function createWriteApprover(event) {
  const parent = BrowserWindow.fromWebContents(event.sender) ?? mainWindow;
  return async ({ connection, sql }) => {
    if (smoke) return true;
    const target = `${connection?.host ?? '-'}${connection?.database ? `/${connection.database}` : ''}`;
    return confirmFixDialog(parent, {
      title: '确认执行数据库写入',
      message: `即将在 ${connection?.name ?? connection?.id ?? '测试库'} 执行写操作`,
      detail: `${target}\n\n${sql}\n\n该操作会直接修改测试数据库。`,
    });
  };
}

/** Per-action confirmation for full-permission Edit/Write/Bash. */
function createToolApprover(event) {
  const parent = BrowserWindow.fromWebContents(event.sender) ?? mainWindow;
  let queue = Promise.resolve();
  return (request) => {
    const next = queue.then(async () => {
      if (smoke) return false;
      const toolName = request?.toolName ?? '工具';
      const input = request?.input ?? {};
      let message;
      let detail;
      if (toolName === 'Bash') {
        message = 'AI 请求执行命令';
        detail = String(input.command ?? '');
      } else {
        message = toolName === 'Write' ? 'AI 请求写入文件' : 'AI 请求修改文件';
        detail = [
          String(input.file_path ?? ''),
          '',
          toolName === 'Write'
            ? String(input.content ?? '').slice(0, 3000)
            : `- ${String(input.old_string ?? '').slice(0, 1200)}\n+ ${String(input.new_string ?? '').slice(0, 1200)}`,
        ].join('\n');
      }
      return confirmFixDialog(parent, {
        title: '确认 AI 操作',
        message,
        detail: detail || '(无详情)',
      });
    });
    queue = next.catch(() => false);
    return next;
  };
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

  handle('dc:databases', async (_event, payload = {}) => {
    switch (payload.action) {
      case 'get':
        return service.getDatabaseConfig();
      case 'save':
        return service.saveDatabaseConfig(payload.config);
      case 'test':
        return service.testDatabase(payload.connection);
      default:
        throw new Error(`dc:databases: unknown action ${payload.action}`);
    }
  });

  handle('dc:profiles', async (_event, payload = {}) => {
    switch (payload.action) {
      case 'list':
        return service.listProfiles();
      case 'create': {
        const config = await service.createProfile(payload.name, {
          workspace: payload.workspace,
          routing: payload.routing,
        });
        setRules(config.routing.rules);
        getRouter()?.apply();
        return { config, profiles: await service.listProfiles() };
      }
      case 'switch': {
        const config = await service.switchProfile(payload.profileId);
        setRules(config.routing.rules);
        getRouter()?.apply();
        await getDevServer()?.stop();
        return { config, profiles: await service.listProfiles() };
      }
      case 'rename': {
        const config = await service.renameProfile(payload.profileId, payload.name);
        return { config, profiles: await service.listProfiles() };
      }
      case 'delete': {
        const config = await service.deleteProfile(payload.profileId);
        setRules(config.routing.rules);
        getRouter()?.apply();
        await getDevServer()?.stop();
        return { config, profiles: await service.listProfiles() };
      }
      default:
        throw new Error(`dc:profiles: unknown action ${payload.action}`);
    }
  });

  handle('dc:runs', async (_event, payload = {}) => {
    if (payload.action === 'list') return { runs: await service.listRuns() };
    if (payload.action === 'get') return service.getRun(payload.runId);
    if (payload.action === 'delete') {
      if (workspaceSessions.has(payload.runId)) {
        throw new Error('该诊断仍有未决定的工作区修改，请先保留或丢弃');
      }
      return service.deleteRun(payload.runId);
    }
    throw new Error(`dc:runs: unknown action ${payload.action}`);
  });

  handle('dc:workspace', async (_event, payload = {}) => {
    // Startup recovery scan does not belong to a single run: it must work even
    // when the crashed diagnosis never wrote result.json/meta.json.
    if (payload.action === 'pending') {
      return {
        sessions: await listPendingWorkspaceJournals(service.runsRoot),
        active: workspaceSessions.size,
      };
    }
    const runId = String(payload.runId ?? '');
    if (!runId) throw new Error('runId 不能为空');
    if (payload.action === 'keep' || payload.action === 'discard') {
      return finalizeWorkspaceSession(service, runId, payload.action);
    }
    if (payload.action === 'status') {
      const run = await service.getRun(runId);
      return {
        session: run.result?.agent?.workspaceSession ?? null,
        active: workspaceSessions.has(runId),
      };
    }
    throw new Error(`dc:workspace: unknown action ${payload.action}`);
  });

  handle('dc:fixes', async (event, payload = {}) => {
    const parent = BrowserWindow.fromWebContents(event.sender) ?? mainWindow;

    if (payload.action === 'apply-all' || payload.action === 'undo-all') {
      const { result, fixes, roots, runDir } = await loadRunFixes(service, payload.runId);
      if (payload.action === 'apply-all') {
        const targets = fixes
          .map((fix, index) => ({ fix, index }))
          .filter(({ fix }) => ['edit', 'create', 'delete'].includes(fix?.kind)
            && fix.preview?.status === 'ready'
            && !fix.workspaceApplied
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
      if (fix.workspaceApplied) throw new Error('该修改已在工作区中，无需重复应用');
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

  handle('dc:element', async (_event, payload = {}) => {
    const host = getHost();
    if (!host) throw new Error('browser host is not ready');
    switch (payload.action) {
      case 'start':
        await host.startElementPick();
        return { ok: true };
      case 'cancel':
        await host.cancelElementPick();
        return { ok: true };
      case 'toggle':
        return host.toggleElementPick();
      default:
        throw new Error(`dc:element: unknown action ${payload.action}`);
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
        host.clear({
          exceptIds: payload.exceptIds ?? [],
          exceptConsoleIds: payload.exceptConsoleIds ?? [],
        });
        return { ok: true };
      case 'console':
        return { events: host.listConsole({ limit: payload.limit ?? 50 }) };
      case 'console-clear':
        host.clearConsole({ exceptIds: payload.exceptIds ?? [] });
        return { ok: true };
      default:
        throw new Error(`dc:capture: unknown action ${payload.action}`);
    }
  });

  handle('dc:diagnose', async (event, payload = {}) => {
    const host = getHost();
    if (!host) throw new Error('browser host is not ready');
    const workspace = (await service.getConfig()).workspace;

    let element = payload.element && typeof payload.element === 'object' ? payload.element : null;
    if (element?.id) {
      const screenshot = host.consumeElementScreenshot(element.id);
      if (screenshot) {
        element = {
          ...element,
          screenshotDataUrl: screenshot.dataUrl,
          screenshotRect: screenshot.rect ?? null,
        };
      }
    }
    let observation;
    let frontendErrors;

    if (element) {
      observation = null;
      frontendErrors = [];
    } else if (payload.consoleId) {
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

    const toolMode = agentToolMode(workspace);
    const agent = payload.mock === true || smoke
      ? createMockAgent()
      : createClaudeAgent({
        ...agentOptionsFromWorkspace(workspace, {
          extraSourceRoots: payload.allowExtraSources === true ? (workspace.extraSourceRoots ?? []) : [],
        }),
        // Fail closed: sandbox config is applied only after the isolated copy
        // exists. Full mode is the only mode constructed with write access.
        toolMode: toolMode === 'full' ? 'full' : 'readonly',
        approval: createToolApprover(event),
      });

    const targetRequestId = payload.requestId != null ? String(payload.requestId) : null;
    const targetConsoleId = payload.consoleId != null ? String(payload.consoleId) : null;
    const targetElementId = element?.id != null ? String(element.id) : null;
    const sendProgress = (progress) => {
      if (!event.sender.isDestroyed()) {
        event.sender.send('dc:diagnose:progress', {
          ...progress,
          requestId: targetRequestId,
          consoleId: targetConsoleId,
          elementId: targetElementId,
        });
      }
    };
    let databaseConfig = { activeId: null, connections: [] };
    try {
      databaseConfig = await service.getDiagnosisDatabases();
    } catch (error) {
      log.warn('[db] database config unreadable; diagnosis continues without db tools:', error?.message ?? error);
    }
    try {
      const options = {
        workspace,
        root: ROOT,
        runsDir: service.runsRoot,
        question: payload.question ?? '',
        recheck: payload.recheck ?? 1,
        agent,
        allowExtraSources: payload.allowExtraSources === true,
        databases: databaseConfig.connections,
        activeDatabaseId: databaseConfig.activeId,
        approveWrite: createWriteApprover(event),
        verifyCommand: workspace.verifyCommand ?? '',
        sandbox: toolMode === 'sandbox',
        onProgress: sendProgress,
      };
      const outcome = element
        ? await runElementDiagnosis(element, options)
        : await runCaptureDiagnosis(observation, { ...options, frontendErrors });
      if (outcome.workspaceSession) {
        workspaceSessions.set(outcome.runId ?? outcome.result?.meta?.runId, outcome.workspaceSession);
      }
      const { workspaceSession: _session, ...response } = outcome;
      return response;
    } catch (error) {
      sendProgress({
        id: 'error',
        label: '诊断失败',
        status: 'error',
        detail: error?.message ?? String(error),
        at: Date.now(),
      });
      throw error;
    }
  });

  handle('dc:followup', async (event, payload = {}) => {
    const sendProgress = (progress) => {
      if (!event.sender.isDestroyed()) event.sender.send('dc:followup:progress', progress);
    };
    sendProgress({ id: 'prepare', label: '整理上一轮诊断', status: 'start' });
    let followSandbox = null;
    try {
      const question = String(payload.question ?? '').trim();
      if (!question) throw new Error('请输入继续诊断的内容');
      const { runId, result } = await service.getRun(String(payload.runId ?? ''));
      if (result.agent?.workspaceSession?.status === 'pending') {
        throw new Error('该诊断仍有未决定的工作区修改，请先保留或丢弃');
      }
      if (result.agent?.fixes?.some((fix) => fix?.applied && !fix.applied.revertedAt)) {
        throw new Error('请先撤销已应用的修改，再继续诊断');
      }
      sendProgress({ id: 'prepare', label: '整理上一轮诊断', status: 'done' });

      const workspace = (await service.getConfig()).workspace;
      const runDir = path.join(service.runsRoot, runId);
      const toolMode = agentToolMode(workspace);
      const agent = payload.mock === true || smoke
        ? createMockAgent()
        : createClaudeAgent({
          ...agentOptionsFromWorkspace(workspace, {
            extraSourceRoots: result.meta?.logContext?.extraSourceRoots ?? [],
          }),
          toolMode: toolMode === 'full' ? 'full' : 'readonly',
          approval: createToolApprover(event),
        });
      if (typeof agent.followUp !== 'function') throw new Error('当前 Agent 不支持继续诊断');

      let followRunCommand = null;
      if (toolMode === 'sandbox'
        && agent.id !== 'mock'
        && typeof agent.configureScope === 'function') {
        const fixRoots = result.meta?.fixRoots ?? {};
        const sandboxRoots = [
          fixRoots.sourceRoot ? { key: 'backend', name: 'backend', root: fixRoots.sourceRoot } : null,
          fixRoots.frontendSourceRoot
            ? { key: 'frontend', name: 'frontend', root: fixRoots.frontendSourceRoot }
            : null,
          ...(fixRoots.extraSourceRoots ?? []).map((entry) => ({
            key: 'extra',
            extraRoot: entry.id,
            name: `extra-${entry.id}`,
            root: entry.root,
          })),
        ].filter(Boolean);
        sendProgress({ id: 'sandbox', label: '创建隔离沙箱', status: 'start' });
        try {
          followSandbox = await createAgentSandbox({ runDir, roots: sandboxRoots });
          agent.configureScope({
            cwd: followSandbox.dir,
            allowedRoots: followSandbox.roots.map((entry) => entry.sandboxRoot),
            toolMode: 'sandbox',
            systemPromptSuffix: sandboxPromptFor(followSandbox),
          });
          followRunCommand = createSandboxCommandRunner({
            sandbox: followSandbox,
            verifyCommand: workspace.verifyCommand ?? '',
            workspace,
          });
          sendProgress({ id: 'sandbox', label: '沙箱已就绪，开放编辑与测试', status: 'done' });
        } catch (error) {
          followSandbox = null;
          followRunCommand = null;
          if (typeof agent.configureScope === 'function') {
            agent.configureScope({ toolMode: 'readonly', systemPromptSuffix: '' });
          }
          sendProgress({
            id: 'sandbox',
            label: '沙箱创建失败，退回只读模式',
            status: 'error',
            detail: error?.message ?? String(error),
          });
          log.warn('[sandbox] follow-up sandbox failed:', error?.message ?? error);
        }
      }

      let followTools = null;
      const logContext = result.meta?.logContext;
      if (logContext) {
        const toolLabels = {
          get_logs: '查询日志',
          list_threads: '分析线程',
          search_log: '搜索日志',
          read_source: '读取源码',
          search_source: '搜索源码',
          read: '读取工具结果',
          query_db: '查询数据库',
          write_db: '写入数据库',
          run_command: '运行编译/测试',
        };
        let databaseConfig = { activeId: null, connections: [] };
        try {
          databaseConfig = await service.getDiagnosisDatabases();
        } catch (error) {
          log.warn('[db] database config unreadable; follow-up continues without db tools:', error?.message ?? error);
        }
        // Keep the same database scope as the original run when it is known.
        const allowedDatabaseIds = Array.isArray(logContext.databases)
          ? new Set(logContext.databases.map((connection) => connection.id))
          : null;
        const followDatabases = allowedDatabaseIds
          ? databaseConfig.connections.filter((connection) => allowedDatabaseIds.has(connection.id))
          : databaseConfig.connections;
        const followWindow = logContext.window ?? result.window;
        const scenario = {
          logfiles: logContext.logfiles ?? [],
          parser: logContext.parser ?? { preset: 'auto' },
          logEncoding: logContext.logEncoding ?? 'auto',
          source: logContext.sourceRoot ? { root: logContext.sourceRoot } : undefined,
          frontendSourceRoot: logContext.frontendSourceRoot ?? null,
          extraSourceRoots: logContext.extraSourceRoots ?? [],
          window: followWindow,
          dir: ROOT,
        };
        followTools = createTools({
          scenario,
          anchor: logContext.anchor ?? result.window?.anchor ?? Date.now(),
          runDir: path.join(service.runsRoot, runId),
          logfiles: logContext.logfiles,
          sourceRoot: logContext.sourceRoot,
          frontendSourceRoot: logContext.frontendSourceRoot,
          extraSourceRoots: logContext.extraSourceRoots,
          databases: followDatabases,
          activeDatabaseId: logContext.activeDatabaseId ?? databaseConfig.activeId,
          approveWrite: createWriteApprover(event),
          runCommand: followRunCommand,
          window: followWindow,
          onCall: (call) => sendProgress({
            id: `tool-${call.id}`,
            label: call.stage === 'start'
              ? `${toolLabels[call.name] ?? call.name}…`
              : (toolLabels[call.name] ?? call.name),
            status: call.stage === 'start' ? 'start' : call.error ? 'error' : 'done',
            detail: call.name,
          }),
        });
      }

      sendProgress({ id: 'agent', label: 'AI 正在继续分析', status: 'start' });
      const builtinToolLabels = {
        Read: '读取文件',
        Grep: '搜索项目引用',
        Glob: '查找项目文件',
        Edit: '修改沙箱文件',
        Write: '写入沙箱文件',
      };
      let followWroteWorkspace = false;
      if (toolMode === 'full' && !followSandbox && typeof agent.configureScope === 'function') {
        agent.configureScope({
          onBeforeWrite: () => { followWroteWorkspace = true; },
          onAfterWrite: () => { followWroteWorkspace = true; },
        });
      }
      const follow = await agent.followUp({
        question,
        previous: result,
        tools: followTools,
        onToolUse: (tool) => {
          if (!tool?.id) return;
          if (tool.stage === 'start' && toolMode === 'full'
            && ['Edit', 'Write', 'Bash'].includes(tool.name)) {
            followWroteWorkspace = true;
          }
          const label = builtinToolLabels[tool.name] ?? tool.name;
          sendProgress({
            id: `builtin-${tool.id}`,
            label: tool.stage === 'start' ? `${label}…` : label,
            status: tool.stage === 'start' ? 'start' : tool.isError ? 'error' : 'done',
            detail: tool.name,
          });
        },
      });
      sendProgress({
        id: 'agent',
        label: follow.incomplete ? 'AI 未完成，已保留部分回复' : 'AI 已给出本轮回复',
        status: follow.incomplete ? 'error' : 'done',
      });
      const usedFollowSandbox = Boolean(followSandbox);
      let followFixes = follow.fixes;
      if (followSandbox) {
        try {
          const extracted = await extractSandboxFixes(followSandbox);
          followFixes = extracted.fixes;
          if (extracted.skipped.length > 0) {
            follow.needsMoreInfo = [
              ...(follow.needsMoreInfo ?? []),
              `沙箱中有 ${extracted.skipped.length} 个变更未能自动提取（新增/删除/大文件），请手动检查。`,
            ];
          }
          sendProgress({
            id: 'sandbox',
            label: `沙箱修改 ${extracted.changedFiles.length} 个文件`,
            status: 'done',
          });
        } catch (error) {
          followFixes = [];
          follow.needsMoreInfo = [
            ...(follow.needsMoreInfo ?? []),
            `沙箱修改提取失败，已隐藏修改建议：${error?.message ?? error}`,
          ];
          sendProgress({
            id: 'sandbox',
            label: '沙箱修改提取失败',
            status: 'error',
            detail: error?.message ?? String(error),
          });
        } finally {
          await cleanupAgentSandbox(followSandbox);
          followSandbox = null;
        }
      }

      let staticChecks = 'strict';
      if (usedFollowSandbox || toolMode === 'full') {
        const commands = await detectCompileCommands({
          roots: result.meta?.fixRoots ?? {},
          verifyCommand: workspace.verifyCommand ?? '',
          workspace,
          projectRoot: ROOT,
        }).catch(() => []);
        if (commands.length > 0) staticChecks = 'warn';
      }
      sendProgress({ id: 'preview', label: '生成修复预览', status: 'start' });
      const followAgent = {
        ...follow,
        fixes: await buildFixPreviews(followFixes, {
          ...(result.meta?.fixRoots ?? {}),
          staticChecks,
        }),
      };
      sendProgress({ id: 'preview', label: '生成修复预览', status: 'done' });

      const editableFixes = (followAgent.fixes ?? [])
        .filter((fix) => ['edit', 'create', 'delete'].includes(fix?.kind) && fix?.preview?.status === 'ready');
      if (editableFixes.length > 0) {
        sendProgress({ id: 'selfcheck', label: '编译自测修改后的代码', status: 'start' });
        let validation;
        try {
          validation = await validateFixes({
            fixes: followAgent.fixes,
            roots: result.meta?.fixRoots ?? {},
            verifyCommand: workspace.verifyCommand ?? '',
            workspace,
            projectRoot: ROOT,
            runDir: path.join(service.runsRoot, runId),
          });
        } catch (error) {
          validation = {
            status: 'failed',
            ok: false,
            error: `编译自测执行失败：${error?.message ?? error}`,
            commands: [],
            applied: 0,
          };
        }
        followAgent.fixesValidation = validation;
        if (validation.status === 'failed') {
          followAgent.fixesWithheld = followAgent.fixes;
          followAgent.fixes = [];
          followAgent.needsMoreInfo = [
            ...(followAgent.needsMoreInfo ?? []),
            `修改建议未通过编译自测，已隐藏。${validation.error ?? ''}`.trim(),
          ];
          sendProgress({
            id: 'selfcheck',
            label: '编译自测失败，修改建议已隐藏',
            status: 'error',
            detail: validation.error,
          });
        } else {
          sendProgress({
            id: 'selfcheck',
            label: validation.status === 'passed' ? '编译自测通过' : '未执行编译自测',
            status: 'done',
            detail: validation.reason,
          });
        }
      }

      // Full-permission follow-ups edit the real workspace directly and have
      // no sandbox baseline, so compile/test the current state independently.
      if (toolMode === 'full' && !usedFollowSandbox) {
        if (!followWroteWorkspace) {
          followAgent.verification = {
            scope: 'workspace',
            mode: 'full',
            status: 'skipped',
            ok: true,
            reason: '本轮没有直接写入工作区的操作',
            commands: [],
            durationMs: 0,
            output: '',
          };
        } else {
          sendProgress({ id: 'selfcheck', label: '编译/测试验证工作区修改', status: 'start' });
          const verification = await runWorkspaceCheck({
            roots: result.meta?.fixRoots ?? {},
            verifyCommand: workspace.verifyCommand ?? '',
            workspace,
            projectRoot: ROOT,
            runDir: path.join(service.runsRoot, runId),
          });
          followAgent.verification = { scope: 'workspace', mode: 'full', ...verification };
          const level = verification.status === 'failed'
            ? 'error'
            : (verification.status === 'skipped' && verification.detectionError ? 'error' : 'done');
          sendProgress({
            id: 'selfcheck',
            label: verification.status === 'passed'
              ? '编译/测试验证通过'
              : verification.status === 'failed'
                ? '编译/测试验证失败，工作区修改可能未修复问题'
                : '未执行编译/测试验证',
            status: level,
            detail: verification.error ?? verification.reason,
          });
          if (verification.status === 'failed') {
            followAgent.needsMoreInfo = [
              ...(followAgent.needsMoreInfo ?? []),
              `工作区修改未通过编译/测试：${verification.error ?? ''}`.trim(),
            ];
          } else if (verification.detectionError) {
            followAgent.needsMoreInfo = [
              ...(followAgent.needsMoreInfo ?? []),
              `未能验证工作区修改：${verification.reason ?? '命令探测失败'}`,
            ];
          }
          result.gates = applyVerificationGate(result.gates, followAgent.verification, {
            name: 'compile-self-check-followup',
          });
        }
      }
    if (!Array.isArray(followAgent.evidenceRefs) || followAgent.evidenceRefs.length === 0) {
      followAgent.evidenceRefs = result.agent?.evidenceRefs ?? [{ type: 'request', ref: 'request' }];
    }
    if (followTools?.dbQueries?.length) {
      result.databaseQueries = [
        ...(Array.isArray(result.databaseQueries) ? result.databaseQueries : []),
        ...followTools.dbQueries.map((query) => ({ ...query, source: 'followup' })),
      ];
    }
    let databaseNotice = logContext?.databaseNotice ?? result.databases?.notice ?? null;
    const failedFollowQueries = (followTools?.dbQueries ?? []).filter((query) => query.error);
    if (failedFollowQueries.length > 0) {
      const reason = failedFollowQueries[0].message || failedFollowQueries[0].code || '未知错误';
      databaseNotice = followTools.dbQueries.some((query) => !query.error)
        ? `部分数据库查询失败（${reason}），未成功的部分已改用源码与日志分析。`
        : '数据库查询不可用，本次诊断仅通过源码与日志分析获得结论。';
      sendProgress({
        id: 'database',
        label: '数据库查询失败，已降级',
        status: 'error',
        detail: databaseNotice,
        at: Date.now(),
      });
    }
    result.databases = {
      ...(result.databases ?? {}),
      activeId: result.databases?.activeId ?? logContext?.activeDatabaseId ?? null,
      connections: result.databases?.connections ?? logContext?.databases ?? [],
      notice: databaseNotice,
    };

    const at = Date.now();
    const conversation = Array.isArray(result.conversation) && result.conversation.length
      ? result.conversation
      : [];
    if (conversation.length === 0) {
      if (result.meta?.question) {
        conversation.push({ role: 'user', text: result.meta.question, at: result.meta.startedAt ?? null });
      }
      if (result.agent) {
        conversation.push({
          role: 'assistant',
          text: result.agent.conclusion ?? '',
          agent: result.agent,
          at: result.meta?.endedAt ?? null,
        });
      }
    }
    conversation.push({ role: 'user', text: question, at });
    conversation.push({ role: 'assistant', text: followAgent.conclusion ?? '', agent: followAgent, at });
    result.conversation = conversation;
    result.followUps = Array.isArray(result.followUps) ? result.followUps : [];
    result.followUps.push({ question, at, agent: followAgent });
    result.agent = followAgent;
    if (followAgent.verification && ['passed', 'failed'].includes(followAgent.verification.status)) {
      result.meta = { ...(result.meta ?? {}), verificationStatus: followAgent.verification.status };
    }

    await writeJsonAtomic(path.join(runDir, 'result.json'), result);
    await writeFile(path.join(runDir, 'report.md'), renderMarkdown(buildReport(result)), 'utf8');
    if (result.meta?.verificationStatus) {
      try {
        const metaFile = path.join(runDir, 'meta.json');
        const meta = JSON.parse(await readFile(metaFile, 'utf8'));
        meta.verificationStatus = result.meta.verificationStatus;
        await writeJsonAtomic(metaFile, meta);
      } catch {
        // meta.json is optional
      }
    }
    await appendFile(
      path.join(runDir, 'run.log'),
      `${new Date().toISOString()} followup question=${question.slice(0, 200)}\n`,
      'utf8',
    ).catch(() => {});
    log.info('[followup]', runId, question.slice(0, 80));
    sendProgress({ id: 'done', label: '继续诊断完成', status: 'done' });
    return { runId, result };
    } catch (error) {
      if (followSandbox) {
        await cleanupAgentSandbox(followSandbox);
        followSandbox = null;
      }
      sendProgress({
        id: 'error',
        label: '继续诊断失败',
        status: 'error',
        detail: error?.message ?? String(error),
      });
      throw error;
    }
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

async function runSmoke(window, host, service) {
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
          browserClearPresent: Boolean(document.getElementById('browser-clear')),
          browserUrlLayout: (() => {
            const input = document.getElementById('browser-url');
            const historyTab = document.querySelector('[data-tab="history"]');
            if (!input || !historyTab) return null;
            const inputRect = input.getBoundingClientRect();
            const historyRect = historyTab.getBoundingClientRect();
            return {
              width: Math.round(inputRect.width),
              gap: Math.round(inputRect.left - historyRect.right),
            };
          })(),
          advancedTogglePresent: Boolean(document.getElementById('toggle-advanced'))
            && Boolean(document.getElementById('advanced-config')),
          advancedHiddenByDefault: document.getElementById('advanced-config')?.hidden === true,
          extraSourceRootsFieldPresent: Boolean(document.querySelector('[name="extraSourceRoots"]')),
          logParserFieldPresent: Boolean(document.querySelector('[name="logParser"]')),
          modelModalPresent: Boolean(document.getElementById('model-modal')),
          profileBarPresent: Boolean(document.getElementById('profile-select'))
            && Boolean(document.getElementById('profile-save-as')),
          profileModalOpens: (() => {
            document.getElementById('profile-save-as')?.click();
            const modal = document.getElementById('profile-modal');
            const dialog = modal?.querySelector('.modal');
            const opened = modal?.hidden === false && (dialog?.getBoundingClientRect().width ?? 0) > 0;
            document.getElementById('profile-modal-cancel')?.click();
            return opened && modal?.hidden === true;
          })(),
          logToolbar: (() => {
            document.querySelector('[data-tab="logs"]').click();
            const parser = document.getElementById('log-parser');
            const anchor = document.getElementById('log-anchor');
            const query = document.getElementById('query-logs');
            const rects = [parser, anchor, query]
              .filter(Boolean)
              .map((node) => node.getBoundingClientRect());
            const centerY = (rect) => rect.top + rect.height / 2;
            const row = rects.length === 3
              && rects.every((rect) => Math.abs(centerY(rect) - centerY(rects[0])) < 4);
            const anchorText = anchor?.options?.[0]?.textContent?.trim() ?? '';
            document.querySelector('[data-tab="browser"]').click();
            return { row, anchorText };
          })(),
          allowExtraSourcesPresent: Boolean(document.getElementById('allow-extra-sources')),
          allowExtraSourcesDefault: document.getElementById('allow-extra-sources')?.checked === false,
          advancedExpand: (() => {
            const button = document.getElementById('toggle-advanced');
            const panel = document.getElementById('advanced-config');
            if (!button || !panel) return false;
            button.click();
            const opened = panel.hidden === false && button.getAttribute('aria-expanded') === 'true';
            button.click();
            return opened && panel.hidden === true;
          })(),
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
    let diagnoseUi = null;
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
        await new Promise((resolve) => setTimeout(resolve, 200));
        diagnoseUi = await window.webContents.executeJavaScript(`({
          progressVisible: document.getElementById('diagnose-progress')?.hidden === false,
          progressSteps: document.querySelectorAll('#diagnose-progress .diagnose-step').length,
          spinning: document.querySelectorAll('#diagnose-progress .diagnose-step.start').length,
          lastLabel: [...document.querySelectorAll('#diagnose-progress .diagnose-step-label')].pop()?.textContent ?? '',
        })`).catch(() => null);
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

    let elementUi = null;
    if (smokeUrl && process.argv.includes('--smoke-element')) {
      try {
        await host.startElementPick();
        const documentNode = await host.sendCdp('DOM.getDocument', { depth: 0 });
        const queried = await host.sendCdp('DOM.querySelector', {
          nodeId: documentNode.root.nodeId,
          selector: 'body',
        });
        const described = await host.sendCdp('DOM.describeNode', { nodeId: queried.nodeId });
        await host.handleElementPicked(described.node.backendNodeId);
        await new Promise((resolve) => setTimeout(resolve, 500));
        elementUi = await window.webContents.executeJavaScript(`(() => {
          const bar = document.getElementById('element-composer');
          return {
            composerOpen: Boolean(bar && bar.hidden === false),
            hasInput: Boolean(document.getElementById('element-composer-input')),
            hasButton: Boolean(document.getElementById('element-composer-submit')),
          };
        })()`);
        elementUi.screenshot = host.elementScreenshots.size > 0;
        elementUi.screenshotError = host.elementLastScreenshotError;
        if (!elementUi.composerOpen && host.elementLastError) elementUi.error = host.elementLastError;
        if (elementUi.composerOpen) {
          await window.webContents.executeJavaScript(`(() => {
            document.getElementById('element-composer-input').value = '元素显示异常';
            document.getElementById('element-composer-submit').click();
            return true;
          })()`);
          await new Promise((resolve) => setTimeout(resolve, 900));
          const runs = await window.webContents.executeJavaScript(
            `window.dc.invoke('dc:runs', { action: 'list' })`,
          );
          const elementRun = (runs?.runs ?? [])
            .find((run) => String(run.scenario).startsWith('element-'));
          elementUi.runScenario = elementRun?.scenario ?? null;
          elementUi.runId = elementRun?.runId ?? null;
        }
        await host.cancelElementPick();
      } catch (error) {
        elementUi = { error: String(error?.message ?? error) };
      }
    }

    // The database entry must sit in the application menu, immediately before
    // "模型", and open the settings modal.
    const menuLabels = Menu.getApplicationMenu()?.items?.map((item) => item.label) ?? [];
    const databaseMenuIndex = menuLabels.indexOf('数据库');
    const modelMenuIndex = menuLabels.indexOf('模型');
    const databaseMenuItem = Menu.getApplicationMenu()?.items
      ?.find((item) => item.label === '数据库')?.submenu?.items
      ?.find((item) => item.label === '数据库设置…');
    databaseMenuItem?.click();
    await new Promise((resolve) => setTimeout(resolve, 250));
    const databaseUi = await window.webContents.executeJavaScript(`(() => {
      document.getElementById('database-add')?.click();
      const allow = document.getElementById('database-allow-write');
      const enabled = document.getElementById('database-enabled');
      const allowRect = allow?.closest('label')?.getBoundingClientRect();
      const enabledRect = enabled?.closest('label')?.getBoundingClientRect();
      const test = document.getElementById('database-test')?.getBoundingClientRect();
      const save = document.getElementById('database-save')?.getBoundingClientRect();
      const cancel = document.getElementById('database-cancel')?.getBoundingClientRect();
      const close = document.getElementById('database-close')?.getBoundingClientRect();
      return {
        open: document.getElementById('database-modal')?.hidden === false,
        editorOpen: document.getElementById('database-editor')?.hidden === false,
        flagsSameRow: Boolean(allowRect && enabledRect && Math.abs(allowRect.top - enabledRect.top) < 2),
        actionsSameRow: Boolean(test && save && cancel && close && Math.abs(test.top - close.top) < 2),
        actionsLeftToRight: Boolean(
          test && save && cancel && close
          && test.left < save.left && save.left < cancel.left && cancel.left < close.left
        ),
        edgeButtons: Boolean(
          test && close
          && test.left - document.getElementById('database-modal').querySelector('.modal').getBoundingClientRect().left < 40
          && document.getElementById('database-modal').querySelector('.modal').getBoundingClientRect().right - close.right < 40
        ),
      };
    })()`).catch(() => null);

    // Model settings show timeout in seconds and default to 60 turns / 600s.
    const modelMenuItem = Menu.getApplicationMenu()?.items
      ?.find((item) => item.label === '模型')?.submenu?.items
      ?.find((item) => item.label === '模型设置…');
    modelMenuItem?.click();
    await new Promise((resolve) => setTimeout(resolve, 200));
    const modelUi = await window.webContents.executeJavaScript(`(async () => {
      const model = document.getElementById('model-name');
      const customRow = document.getElementById('model-name-custom-row');
      const maxTurns = document.getElementById('model-max-turns');
      const timeout = document.getElementById('model-timeout');
      const defaults = {
        model: model?.value ?? null,
        maxTurns: maxTurns?.value ?? null,
        timeoutSeconds: timeout?.value ?? null,
        toolMode: document.getElementById('model-tool-mode')?.value ?? null,
      };
      model.value = '__custom__';
      model.dispatchEvent(new Event('change', { bubbles: true }));
      const customShown = customRow?.hidden === false;
      model.value = 'claude-sonnet-5';
      model.dispatchEvent(new Event('change', { bubbles: true }));
      const customHidden = customRow?.hidden === true;
      document.getElementById('model-tool-mode').value = 'full';
      if (timeout) timeout.value = '900';
      document.getElementById('model-save')?.click();
      const deadline = Date.now() + 3000;
      let config = null;
      while (Date.now() < deadline) {
        config = await window.dc.invoke('dc:config', { action: 'get' });
        if (config?.workspace?.agent?.timeoutMs === 900000) break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      return { defaults, customShown, customHidden, saved: config?.workspace?.agent ?? null };
    })()`).catch(() => null);

    clearTimeout(timeout);
    const sample = host.list({ limit: 1 })[0] ?? null;
    const details = host.list({ limit: 50 }).map((item) => host.detail(item.id)).filter(Boolean);
    const sampleBody = details.find((item) => item.body?.text) ?? null;
    const workspaceUi = await window.webContents.executeJavaScript(`(async () => ({
      pending: await window.dc.invoke('dc:workspace', { action: 'pending' }),
      hasRecoveryModal: Boolean(document.getElementById('workspace-recovery-modal')),
      hasRecoveryList: Boolean(document.getElementById('workspace-recovery-list')),
    }))()`).catch((error) => ({ error: String(error?.message ?? error) }));

    // Exercise the on-disk journal keep path (no live session), including the
    // result.json/meta.json status update that the renderer relies on.
    const smokeRunId = '20261110-000000-smoke1';
    const smokeRunDir = path.join(service.runsRoot, smokeRunId);
    let workspaceKeep = null;
    try {
      await mkdir(smokeRunDir, { recursive: true });
      await writeFile(path.join(smokeRunDir, 'result.json'), JSON.stringify({
        meta: { runId: smokeRunId },
        agent: {
          workspaceSession: { mode: 'in-place', status: 'pending' },
          fixes: [{ summary: 'smoke', workspaceApplied: true, pendingDecision: true }],
        },
      }, null, 2), 'utf8');
      await writeFile(path.join(smokeRunDir, 'meta.json'), JSON.stringify({
        runId: smokeRunId,
        workspaceSessionStatus: 'pending',
      }, null, 2), 'utf8');
      await writeFile(path.join(smokeRunDir, 'workspace-journal.json'), JSON.stringify({
        version: 1,
        runId: smokeRunId,
        mode: 'in-place',
        status: 'pending',
        pid: process.pid,
        startedAt: Date.now(),
        repos: [],
        touched: [],
        changedFiles: [],
        skipped: [],
        conflicts: [],
        selfCheck: { status: 'failed', error: '编译/测试验证失败：smoke' },
      }, null, 2), 'utf8');
      const keep = await window.webContents.executeJavaScript(
        `window.dc.invoke('dc:workspace', { action: 'keep', runId: ${JSON.stringify(smokeRunId)} })`,
      );
      const updatedResult = JSON.parse(await readFile(path.join(smokeRunDir, 'result.json'), 'utf8'));
      const updatedMeta = JSON.parse(await readFile(path.join(smokeRunDir, 'meta.json'), 'utf8'));
      workspaceKeep = {
        ok: keep?.ok === true,
        status: keep?.status ?? null,
        resultStatus: updatedResult?.agent?.workspaceSession?.status ?? null,
        fixPending: updatedResult?.agent?.fixes?.[0]?.pendingDecision ?? null,
        metaStatus: updatedMeta?.workspaceSessionStatus ?? null,
      };
      await rm(smokeRunDir, { recursive: true, force: true }).catch(() => {});
    } catch (error) {
      workspaceKeep = { error: String(error?.message ?? error) };
    }
    const result = {
      ...ui,
      captured,
      captureOk,
      captureSample: sample ? { url: sample.url, status: sample.status } : null,
      captureBody: Boolean(sampleBody),
      diagnose,
      diagnoseUi,
      consoleDiagnose,
      elementUi,
      pageTitle,
      menuHasLog: Boolean(Menu.getApplicationMenu()?.items?.some((item) => item.label === '日志')),
      menuHasDatabase: databaseMenuIndex >= 0,
      databaseMenuLeftOfModel: databaseMenuIndex >= 0 && modelMenuIndex >= 0 && databaseMenuIndex < modelMenuIndex,
      databaseModalOpen: Boolean(databaseUi?.open),
      databaseUi,
      modelUi,
      workspaceUi,
      workspaceKeep,
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
    if (smokeUiEvalAfter) {
      const script = Buffer.from(smokeUiEvalAfter, 'base64').toString('utf8');
      result.uiEvalAfterResult = await window.webContents.executeJavaScript(script)
        .catch((error) => ({ error: String(error?.message ?? error) }));
    }
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
      label: '数据库',
      submenu: [
        {
          label: '数据库设置…',
          click: () => {
            if (mainWindow && !mainWindow.isDestroyed()) {
              mainWindow.webContents.send('dc:database:open');
            }
          },
        },
      ],
    },
    {
      label: '模型',
      submenu: [
        {
          label: '模型设置…',
          click: () => {
            if (mainWindow && !mainWindow.isDestroyed()) {
              mainWindow.webContents.send('dc:model:open');
            }
          },
        },
      ],
    },
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
  const service = createService({
    root: ROOT,
    runsDir: effectiveRunsDir,
    configDir: effectiveConfigDir,
    secretCodec: createSecretCodec(),
  });
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
      if (!window.isDestroyed()) {
        if (String(event.type).startsWith('element-')) {
          window.webContents.send('dc:element:event', event);
        }
        window.webContents.send('dc:capture:event', event);
      }
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

  // Closing the window with half-applied in-place edits is the easiest way to
  // forget about them. Warn once, and let the renderer reopen the recovery list.
  let closeConfirmed = false;
  let closePromptOpen = false;
  window.on('close', (event) => {
    if (smoke || closeConfirmed || shutdownDone || shutdownRunning) return;
    event.preventDefault();
    if (closePromptOpen) return;
    closePromptOpen = true;
    listPendingWorkspaceJournals(service.runsRoot)
      .then(async (sessions) => {
        if (window.isDestroyed()) return;
        if (sessions.length === 0) {
          closeConfirmed = true;
          window.close();
          return;
        }
        const { response } = await dialog.showMessageBox(window, {
          type: 'warning',
          title: '还有未收尾的工作区修改',
          message: `检测到 ${sessions.length} 个诊断修改了真实工作区，但尚未选择保留或丢弃。`,
          detail: '建议先返回处理，逐条保留或丢弃，避免半改状态被误提交。',
          buttons: ['返回处理', '仍要退出'],
          defaultId: 0,
          cancelId: 0,
          noLink: true,
        });
        if (response === 1) {
          closeConfirmed = true;
          if (!window.isDestroyed()) window.close();
        } else if (!window.isDestroyed()) {
          window.webContents.send('dc:workspace:event', { type: 'pending', sessions });
        }
      })
      .catch(() => {
        closeConfirmed = true;
        if (!window.isDestroyed()) window.close();
      })
      .finally(() => {
        closePromptOpen = false;
      });
  });

  if (!smoke && initial.workspace.frontendUrl) {
    try {
      host.open(initial.workspace.frontendUrl);
    } catch {
      // auto-open is best-effort
    }
  }

  if (smoke) {
    const ok = await runSmoke(window, host, service);
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
