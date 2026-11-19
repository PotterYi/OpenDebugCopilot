import { spawn } from 'node:child_process';
import { killProcessTree, waitForExit } from './dev-server.mjs';
import { createVerifyOutputScanner } from '../../core/verify-output.mjs';

/**
 * Run the user-configured verification command once, with a hard timeout.
 * Output is capped so a noisy build cannot exhaust memory or the IPC payload.
 *
 * @param {{
 *   command: string,
 *   cwd: string,
 *   timeoutMs?: number,
 *   maxOutputBytes?: number,
 *   phase?: 'build' | 'test' | null
 * }} options
 */
export async function runVerifyCommand({
  command,
  cwd,
  timeoutMs = 120_000,
  maxOutputBytes = 256 * 1024,
  phase = null,
}) {
  const startedAt = Date.now();
  const scanner = createVerifyOutputScanner({ phase, command });
  let child;
  try {
    child = spawn(command, {
      cwd,
      env: { ...process.env, FORCE_COLOR: '0', BROWSER: 'none' },
      shell: true,
      windowsHide: true,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    return {
      ok: false,
      exitCode: null,
      signal: null,
      timedOut: false,
      durationMs: Date.now() - startedAt,
      command,
      cwd,
      output: `启动失败：${error?.message ?? error}`,
      truncated: false,
    };
  }

  let output = '';
  let truncated = false;
  let timedOut = false;
  const append = (chunk) => {
    const text = chunk.toString('utf8');
    scanner.push(text);
    output += text;
    if (output.length > maxOutputBytes) {
      output = output.slice(output.length - maxOutputBytes);
      truncated = true;
    }
  };
  child.stdout?.setEncoding?.('utf8');
  child.stderr?.setEncoding?.('utf8');
  child.stdout?.on('data', append);
  child.stderr?.on('data', append);

  const exit = await new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      killProcessTree(child.pid).catch(() => {});
    }, timeoutMs);
    child.once('exit', (code, signal) => finish({ code, signal }));
    child.once('error', (error) => finish({ error }));
  });

  if (timedOut && child.exitCode === null && child.signalCode === null) {
    const exited = await waitForExit(child, 2_000);
    if (!exited && process.platform !== 'win32' && child.pid) {
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        // process already gone
      }
      await waitForExit(child, 1_000);
    }
  }

  const ok = !timedOut && exit.code === 0;
  const analysis = scanner.finish();
  return {
    ok,
    exitCode: exit.code ?? null,
    signal: exit.signal ?? null,
    timedOut,
    durationMs: Date.now() - startedAt,
    command,
    cwd,
    output,
    truncated,
    outputTruncated: truncated,
    suspicions: ok ? analysis.suspicions : [],
    testSummary: analysis.testSummary,
    error: exit.error?.message ?? null,
  };
}
