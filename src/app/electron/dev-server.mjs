import { spawn } from 'node:child_process';
import { resolveFrontendLaunch } from '../../core/frontend-service.mjs';
import { log } from '../../core/logger.mjs';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function defaultProbe(url, timeoutMs = 1000) {
  if (!url) return false;
  try {
    const response = await fetch(url, {
      cache: 'no-store',
      signal: AbortSignal.timeout(timeoutMs),
    });
    return response.status < 500;
  } catch {
    return false;
  }
}

function killProcessTree(pid) {
  if (!pid) return Promise.resolve();
  if (process.platform === 'win32') {
    return new Promise((resolve) => {
      const killer = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true });
      killer.once('exit', resolve);
      killer.once('error', resolve);
    });
  }
  try {
    process.kill(-pid, 'SIGTERM');
  } catch {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      // process already gone
    }
  }
  return Promise.resolve();
}

function waitForExit(child, timeoutMs) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

/**
 * Frontend dev-server process manager.
 * Keeps a single child process, a bounded log buffer and a readiness probe on frontendUrl.
 */
export class DevServerManager {
  constructor({
    getWorkspace,
    rootDir = process.cwd(),
    onEvent = () => {},
    spawnProcess = spawn,
    probe = defaultProbe,
    readyTimeoutMs = 30_000,
    probeIntervalMs = 500,
    stopTimeoutMs = 5_000,
    maxLogLines = 300,
  }) {
    this.getWorkspace = getWorkspace;
    this.rootDir = rootDir;
    this.onEvent = onEvent;
    this.spawnProcess = spawnProcess;
    this.probe = probe;
    this.readyTimeoutMs = readyTimeoutMs;
    this.probeIntervalMs = probeIntervalMs;
    this.stopTimeoutMs = stopTimeoutMs;
    this.maxLogLines = maxLogLines;
    this.child = null;
    this.stopping = false;
    this.disposed = false;
    this.logs = [];
    this.lineBuffers = { out: '', err: '' };
    this.state = {
      status: 'stopped',
      pid: null,
      command: null,
      cwd: null,
      url: null,
      startedAt: null,
      message: '',
      exitCode: null,
      source: null,
    };
  }

  snapshot() {
    return { ...this.state };
  }

  setState(patch) {
    this.state = { ...this.state, ...patch };
    this.onEvent({ type: 'state', state: this.snapshot() });
  }

  appendLog(stream, rawLine) {
    const text = String(rawLine ?? '').replace(/\r$/, '');
    const line = text.length > 2000 ? `${text.slice(0, 2000)}…` : text;
    this.logs.push({ stream, line });
    if (this.logs.length > this.maxLogLines) {
      this.logs.splice(0, this.logs.length - this.maxLogLines);
    }
    this.onEvent({ type: 'log', stream, line });
  }

  consume(stream, chunk) {
    const text = chunk.toString('utf8');
    const buffered = `${this.lineBuffers[stream] ?? ''}${text}`;
    const parts = buffered.split(/\r\n|\r|\n/);
    this.lineBuffers[stream] = parts.pop() ?? '';
    for (const line of parts) this.appendLog(stream, line);
  }

  flushLogs() {
    for (const stream of ['out', 'err']) {
      const rest = this.lineBuffers[stream];
      if (rest) this.appendLog(stream, rest);
      this.lineBuffers[stream] = '';
    }
  }

  logsFor(limit = this.maxLogLines) {
    return this.logs.slice(-Math.max(1, Math.min(Number(limit) || this.maxLogLines, this.maxLogLines)));
  }

  async start() {
    if (this.disposed) throw new Error('dev server manager is disposed');
    if (this.child) return this.snapshot();

    const workspace = await this.getWorkspace();
    const url = String(workspace.frontendUrl ?? '').trim() || null;

    // An already reachable frontend is external: do not spawn a second dev server
    // (and do not fail just because launch settings are incomplete).
    if (url && await this.probe(url, 800)) {
      this.setState({
        status: 'external',
        url,
        message: '前端地址已可达，可能由外部进程启动；本工具不接管',
        exitCode: null,
      });
      return this.snapshot();
    }

    const launch = await resolveFrontendLaunch(workspace, { rootDir: this.rootDir });
    if (!launch.ok) {
      this.setState({
        status: 'error',
        command: null,
        cwd: launch.cwd ?? null,
        url,
        message: launch.reason,
        exitCode: null,
      });
      log.warn('[devserver] cannot start:', launch.reason);
      return this.snapshot();
    }

    this.logs = [];
    this.lineBuffers = { out: '', err: '' };
    this.setState({
      status: 'starting',
      pid: null,
      command: launch.command,
      cwd: launch.cwd,
      url,
      startedAt: Date.now(),
      message: `正在启动：${launch.command}`,
      exitCode: null,
      source: launch.source,
    });
    log.info('[devserver] starting', launch.command, 'in', launch.cwd);

    let child;
    try {
      child = this.spawnProcess(launch.command, {
        cwd: launch.cwd,
        env: { ...process.env, FORCE_COLOR: '0', BROWSER: 'none' },
        shell: true,
        windowsHide: true,
        detached: process.platform !== 'win32',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      this.setState({ status: 'error', message: `启动失败：${error?.message ?? error}` });
      log.error('[devserver] spawn failed', error);
      return this.snapshot();
    }

    this.child = child;
    child.stdout?.setEncoding?.('utf8');
    child.stderr?.setEncoding?.('utf8');
    child.stdout?.on('data', (chunk) => this.consume('out', chunk));
    child.stderr?.on('data', (chunk) => this.consume('err', chunk));
    child.on('error', (error) => {
      if (this.child !== child) return;
      this.child = null;
      this.setState({
        status: 'error',
        pid: null,
        message: `启动失败：${error?.message ?? error}`,
      });
      log.error('[devserver] child error', error);
    });
    child.on('exit', (code, signal) => {
      if (this.child !== child) return;
      this.flushLogs();
      this.child = null;
      const expected = this.stopping;
      this.stopping = false;
      if (this.disposed) return;
      if (expected) {
        this.setState({ status: 'stopped', pid: null, message: '前端服务已停止', exitCode: code ?? null });
      } else {
        this.setState({
          status: code === 0 ? 'stopped' : 'error',
          pid: null,
          message: code === 0
            ? '前端进程已退出'
            : `前端进程异常退出${code != null ? `（code ${code}）` : signal ? `（${signal}）` : ''}`,
          exitCode: code ?? null,
        });
      }
      log.info('[devserver] exited', code, signal);
    });

    this.setState({ pid: child.pid ?? null, message: `已启动：${launch.command}` });
    this.waitForReady(child, url);
    return this.snapshot();
  }

  async waitForReady(child, url) {
    if (!url) {
      if (this.child === child) this.setState({ status: 'running', message: '已启动（未配置前端地址，无法探活）' });
      return;
    }
    const deadline = Date.now() + this.readyTimeoutMs;
    while (Date.now() < deadline) {
      if (this.disposed || this.child !== child) return;
      if (await this.probe(url, 800)) {
        if (this.child === child) this.setState({ status: 'running', message: `前端已就绪：${url}` });
        return;
      }
      await sleep(this.probeIntervalMs);
    }
    if (this.child === child) {
      this.setState({
        status: 'error',
        message: `进程仍在运行，但 ${Math.round(this.readyTimeoutMs / 1000)}s 内未探活成功；请查看日志或前端地址`,
      });
    }
  }

  async stop() {
    if (!this.child) {
      const message = this.state.status === 'external'
        ? '该前端由外部进程启动，本工具无法停止'
        : '前端服务未运行';
      this.setState({ status: this.state.status === 'external' ? 'external' : 'stopped', pid: null, message });
      return this.snapshot();
    }
    const child = this.child;
    this.stopping = true;
    this.setState({ status: 'stopping', message: '正在停止前端服务…' });
    log.info('[devserver] stopping', child.pid);
    await killProcessTree(child.pid);
    await waitForExit(child, this.stopTimeoutMs);
    if (this.child === child) {
      try {
        child.kill('SIGKILL');
      } catch {
        // ignore
      }
      await waitForExit(child, 1500);
    }
    if (this.child === child) this.child = null;
    this.stopping = false;
    this.setState({ status: 'stopped', pid: null, message: '前端服务已停止', exitCode: null });
    return this.snapshot();
  }

  async restart() {
    if (this.state.status === 'external') {
      this.setState({ message: '外部启动的前端服务无法通过本工具重启；请先手动停止外部进程' });
      return this.snapshot();
    }
    if (this.child) await this.stop();
    return this.start();
  }

  async status() {
    if (!this.child && !['starting', 'stopping'].includes(this.state.status)) {
      const workspace = await this.getWorkspace();
      const url = String(workspace.frontendUrl ?? '').trim() || null;
      if (url && await this.probe(url, 800)) {
        if (this.state.status !== 'external') {
          this.setState({
            status: 'external',
            url,
            message: '检测到前端地址已可达（可能由外部进程启动）；本工具不接管',
          });
        }
      } else if (this.state.status === 'external') {
        this.setState({ status: 'stopped', message: '前端服务未运行' });
      }
    }
    return this.snapshot();
  }

  async dispose() {
    this.disposed = true;
    if (!this.child) return;
    const child = this.child;
    this.stopping = true;
    await killProcessTree(child.pid);
    await waitForExit(child, this.stopTimeoutMs);
    if (this.child === child) this.child = null;
    this.stopping = false;
    this.state = { ...this.state, status: 'stopped', pid: null };
  }
}

export function createDevServerManager(options) {
  return new DevServerManager(options);
}
