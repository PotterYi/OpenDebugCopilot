import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import { once } from 'node:events';
import { pageHtml } from '../manual/page.mjs';
import { tempDir } from './tmp.mjs';

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const MAIN = path.join(ROOT, 'src/app/electron/main.mjs');
const TMP = tempDir('electron-test');

let electronPath = null;
try {
  electronPath = require('electron');
} catch {
  electronPath = null;
}
const available = Boolean(electronPath && existsSync(electronPath));

test('electron shell boots, captures, routes and diagnoses', {
  skip: available ? false : 'Electron binary is not installed',
  timeout: 90_000,
}, async (t) => {
  await mkdir(TMP, { recursive: true });
  t.after(async () => { await rm(TMP, { recursive: true, force: true }); });

  let backendHits = 0;
  let pageApiHits = 0;
  let backendOrigin = null;
  let backendHeaders = null;
  let backendOptions = 0;
  let pageOptionsHits = 0;

  let envHits = 0;
  const envServer = http.createServer((req, res) => {
    if (req.method === 'OPTIONS') {
      res.statusCode = 204;
      res.end();
      return;
    }
    envHits += 1;
    res.statusCode = 500;
    res.setHeader('Content-Type', 'application/json');
    res.end('{"from":"env"}');
  });
  envServer.listen(0);
  await once(envServer, 'listening');
  t.after(() => new Promise((resolve) => envServer.close(resolve)));
  const envUrl = `http://localhost:${envServer.address().port}`;

  const backendServer = http.createServer((req, res) => {
    if (req.method === 'OPTIONS') {
      backendOptions += 1;
      res.statusCode = 404;
      res.end('no options');
      return;
    }
    if (req.url === '/api/order' && req.method === 'POST') {
      backendHits += 1;
      backendOrigin = req.headers.origin ?? null;
      backendHeaders = req.headers;
      res.setHeader('Content-Type', 'application/json');
      res.end('{"from":"backend"}');
      return;
    }
    res.statusCode = 404;
    res.end('not found');
  });
  backendServer.listen(0);
  await once(backendServer, 'listening');
  t.after(() => new Promise((resolve) => backendServer.close(resolve)));

  const pageServer = http.createServer((req, res) => {
    if (req.url === '/page') {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end(pageHtml(envUrl, { token: 'smoke-token', 'X-Demo-Userid': 'smoke-user' }));

      return;
    }
    if (req.url === '/api/order' && req.method === 'OPTIONS') {
      pageOptionsHits += 1;
      res.statusCode = 204;
      res.end();
      return;
    }
    if (req.url === '/api/order') {
      pageApiHits += 1;
      res.setHeader('Content-Type', 'application/json');
      res.end('{"from":"page"}');
      return;
    }
    res.statusCode = 404;
    res.end('not found');
  });
  pageServer.listen(0);
  await once(pageServer, 'listening');
  t.after(() => new Promise((resolve) => pageServer.close(resolve)));

  await mkdir(path.join(TMP, 'configs'), { recursive: true });
  await writeFile(path.join(TMP, 'configs', 'routing.json'), JSON.stringify({
    rules: [
      {
        id: 'local-api',
        enabled: true,
        match: { host: 'localhost', prefix: '/api' },
        target: {
          kind: 'local',
          baseUrl: `http://127.0.0.1:${backendServer.address().port}`,
        },
      },
      {
        id: 'sit-ignored-target',
        enabled: true,
        match: { host: 'localhost', prefix: '/never' },
        target: { kind: 'sit', baseUrl: 'http://localhost:9999' },
      },
    ],
  }), 'utf8');

  const child = spawn(electronPath, [
    MAIN,
    '--smoke',
    '--port', '0',
    `--smoke-url=http://localhost:${pageServer.address().port}/page`,
    '--smoke-click=#create',
    '--runs-dir', path.join(TMP, 'runs'),
    '--config-dir', path.join(TMP, 'configs'),
  ], { env: { ...process.env } });

  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });

  const code = await new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.kill();
      resolve(-1);
    }, 60_000);
    child.on('close', (exitCode) => {
      clearTimeout(timer);
      resolve(exitCode);
    });
  });

  assert.equal(code, 0, `electron exited ${code}\nstdout:\n${stdout}\nstderr:\n${stderr}`);
  assert.match(stdout, /SMOKE_OK/);
  assert.doesNotMatch(stdout, /DebugCopilot Electron/);
  assert.match(stdout, /"hasDc":true/);
  assert.match(stdout, /"hasWorkspace":true/);
  assert.match(stdout, /"uiReady":true/);
  assert.match(stdout, /"hiddenAttrWorks":true/);
  assert.match(stdout, /"tempConfigFlag":true/);
  assert.match(stdout, /"logPathVisible":true/);
  assert.match(stdout, /"logTabPresent":true/);
  assert.match(stdout, /"pipeParserOption":true/);
  assert.match(stdout, /"consolePanel":true/);
  assert.match(stdout, /"requestFilterPresent":true/);
  assert.match(stdout, /"browserClearPresent":true/);
  const smokeResult = JSON.parse(stdout.match(/SMOKE_RESULT (\{.*\})/)[1]);
  assert.ok(smokeResult.browserUrlLayout.width > 260, JSON.stringify(smokeResult.browserUrlLayout));
  assert.ok(smokeResult.browserUrlLayout.gap >= 8, JSON.stringify(smokeResult.browserUrlLayout));
  assert.match(stdout, /"advancedTogglePresent":true/);
  assert.match(stdout, /"advancedHiddenByDefault":true/);
  assert.match(stdout, /"advancedExpand":true/);
  assert.match(stdout, /"extraSourceRootsFieldPresent":true,"logParserFieldPresent":true,"modelModalPresent":true,"profileBarPresent":true,"profileModalOpens":true,"logToolbar":\{"row":true,"anchorText":"[^"]+"/);
  assert.match(stdout, /"allowExtraSourcesPresent":true,"allowExtraSourcesDefault":true/);
  assert.match(stdout, /"devServerControlsPresent":true/);
  assert.match(stdout, /"singleDiagnoseButton":true/);
  assert.match(stdout, /"questionIsTextarea":true/);
  assert.match(stdout, /"targetSelect":true/);
  assert.match(stdout, /"sitPassthrough":true/);
  assert.match(stdout, /"routingWarningShown":true/);
  assert.match(stdout, /"logSourcePresent":true/);
  assert.match(stdout, /"openLogButtonRemoved":true/);
  assert.match(stdout, /"menuHasLog":true/);
  assert.match(stdout, /"captureOk":true/);
  assert.match(stdout, /"captured":[1-9]/);
  assert.match(stdout, /"pageTitle":"ok"/);
  assert.match(stdout, /"isLoading":false/);
  assert.match(stdout, /"captureBody":true/);
  assert.match(stdout, /"diagnose":\{"ok":true/);
  assert.match(stdout, /"diagnoseUi":\{"progressVisible":true,"progressSteps":[1-9]\d*,"spinning":0/);
  assert.match(stdout, /"gates":true/);
  assert.match(stdout, /"frontendErrors":[1-9]/);
  assert.match(stdout, /"consoleDiagnose":\{"ok":true/);
  assert.match(stdout, /"gates":true/);
  assert.ok(backendHits >= 1, `expected redirect to backend, got ${backendHits}`);
  // The tool answers local preflights itself; the backend must never see OPTIONS.
  assert.equal(backendOptions, 0, `backend received ${backendOptions} OPTIONS request(s)`);
  // Custom preflight headers must survive the redirect to the local target.
  assert.equal(backendHeaders?.['x-demo-userid'], 'smoke-user');
  assert.equal(backendHeaders?.token, 'smoke-token');
  assert.equal(pageOptionsHits, 0, 'preflight should not reach the page server');
  assert.equal(pageApiHits, 0, `request should have been redirected, page hits: ${pageApiHits}`);
  assert.equal(envHits, 0, `request should have been redirected to local, env hits: ${envHits}`);
  assert.ok(backendOrigin, 'backend should receive an Origin header');
});

test('falls back to an ephemeral UI port when the requested port is busy', {
  skip: available ? false : 'Electron binary is not installed',
  timeout: 60_000,
}, async (t) => {
  const DIR = tempDir('electron-port-conflict');
  await rm(DIR, { recursive: true, force: true });
  await mkdir(path.join(DIR, 'configs'), { recursive: true });
  await mkdir(path.join(DIR, 'runs'), { recursive: true });
  t.after(async () => { await rm(DIR, { recursive: true, force: true }); });

  const blocker = http.createServer((_req, res) => {
    res.statusCode = 204;
    res.end();
  });
  blocker.listen(0, '127.0.0.1');
  await once(blocker, 'listening');
  t.after(() => new Promise((resolve) => blocker.close(resolve)));
  const busyPort = blocker.address().port;

  const child = spawn(electronPath, [
    MAIN,
    '--smoke',
    '--port', String(busyPort),
    '--config-dir', path.join(DIR, 'configs'),
    '--runs-dir', path.join(DIR, 'runs'),
  ], { env: { ...process.env } });

  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });

  const code = await new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.kill();
      resolve(-1);
    }, 50_000);
    child.on('close', (exitCode) => {
      clearTimeout(timer);
      resolve(exitCode);
    });
  });

  assert.equal(code, 0, `electron exited ${code}\nstdout:\n${stdout}\nstderr:\n${stderr}`);
  assert.match(stdout, /SMOKE_OK/);
  assert.match(stderr, /UI port \d+ is already in use; using an ephemeral port/);
});

async function freePort() {
  const server = http.createServer((_req, res) => res.end(''));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function waitUntil(predicate, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}

test('starts a configured frontend dev server from the UI', {
  skip: available ? false : 'Electron binary is not installed',
  timeout: 90_000,
}, async (t) => {
  const DIR = tempDir('electron-devserver');
  await rm(DIR, { recursive: true, force: true });
  const project = path.join(DIR, 'frontend');
  await mkdir(path.join(DIR, 'configs'), { recursive: true });
  await mkdir(path.join(DIR, 'runs'), { recursive: true });
  await mkdir(project, { recursive: true });
  t.after(async () => { await rm(DIR, { recursive: true, force: true }); });

  const frontendPort = await freePort();
  const frontendUrl = `http://127.0.0.1:${frontendPort}`;
  await writeFile(path.join(project, 'package.json'), JSON.stringify({ scripts: { dev: 'node server.mjs' } }), 'utf8');
  await writeFile(path.join(project, 'server.mjs'), `
import http from 'node:http';
http.createServer((req, res) => { res.end('frontend-ok'); }).listen(${frontendPort}, '127.0.0.1', () => {
  console.log('frontend-ready');
});
`, 'utf8');
  await writeFile(path.join(DIR, 'configs', 'workspace.json'), JSON.stringify({
    frontendUrl,
    backendUrl: 'http://127.0.0.1:8080',
    frontendProjectRoot: project,
    frontendStartCommand: 'node server.mjs',
    logfiles: [],
    sourceRoot: '',
    frontendSourceRoot: '',
    window: { beforeMs: 3000, afterMs: 2000 },
  }), 'utf8');

  const uiScript = `(async () => {
    const button = document.getElementById('devserver-start');
    if (!button) return { started: false, reason: 'button missing' };
    button.click();
    const deadline = Date.now() + 12000;
    while (Date.now() < deadline) {
      const state = await window.dc.invoke('dc:devserver', { action: 'status' });
      if (state.status === 'running') return { started: true, status: state.status, message: state.message };
      if (state.status === 'error') return { started: false, status: state.status, message: state.message };
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    return { started: false, status: 'timeout' };
  })()`;

  const child = spawn(electronPath, [
    MAIN,
    '--smoke',
    '--smoke-quit',
    '--port', '0',
    '--config-dir', path.join(DIR, 'configs'),
    '--runs-dir', path.join(DIR, 'runs'),
    '--smoke-ui-eval', Buffer.from(uiScript).toString('base64'),
  ], { env: { ...process.env } });

  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });

  const code = await new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.kill();
      resolve(-1);
    }, 80_000);
    child.on('close', (exitCode) => {
      clearTimeout(timer);
      resolve(exitCode);
    });
  });

  assert.equal(code, 0, `electron exited ${code}\nstdout:\n${stdout}\nstderr:\n${stderr}`);
  assert.match(stdout, /SMOKE_OK/);
  assert.match(stdout, /"uiEvalResult":\{"started":true/);
  assert.match(stdout, /"devserver"|frontend-ready|正在|已启动|已就绪/);
  assert.ok(await waitUntil(async () => {
    try {
      await fetch(frontendUrl, { signal: AbortSignal.timeout(300) });
      return false;
    } catch {
      return true;
    }
  }, 5_000), 'dev server should be stopped when the app exits');
});

test('applies, verifies and reverts a structured fix through IPC', {
  skip: available ? false : 'Electron binary is not installed',
  timeout: 60_000,
}, async (t) => {
  const DIR = tempDir('electron-fix-apply');
  const runId = 'run-apply';
  const runDir = path.join(DIR, 'runs', runId);
  const backend = path.join(DIR, 'backend');
  const sourceFile = path.join(backend, 'com/demo/OrderService.java');
  const original = [
    'package com.demo;',
    '',
    'public class OrderService {',
    '    public void create(Order order) {',
    '        if (order.getQty() <= 0) {',
    '        }',
    '    }',
    '}',
  ].join('\n');

  const frontend = path.join(DIR, 'frontend');
  await rm(DIR, { recursive: true, force: true });
  await mkdir(path.join(DIR, 'configs'), { recursive: true });
  await mkdir(path.join(runDir, 'backups'), { recursive: true });
  await mkdir(path.dirname(sourceFile), { recursive: true });
  await mkdir(frontend, { recursive: true });
  await writeFile(sourceFile, original, 'utf8');
  await writeFile(path.join(frontend, 'verify.mjs'), "console.log('verify-ok');\n", 'utf8');
  await writeFile(path.join(DIR, 'configs', 'workspace.json'), JSON.stringify({
    frontendUrl: 'http://127.0.0.1:5173',
    backendUrl: 'http://127.0.0.1:8080',
    frontendProjectRoot: frontend,
    verifyCommand: 'node verify.mjs',
    logfiles: [],
    sourceRoot: '',
    frontendSourceRoot: '',
    window: { beforeMs: 3000, afterMs: 2000 },
  }), 'utf8');
  t.after(async () => { await rm(DIR, { recursive: true, force: true }); });

  const fix = {
    summary: '防御空数量',
    kind: 'edit',
    root: 'backend',
    file: 'com/demo/OrderService.java',
    search: '        if (order.getQty() <= 0) {',
    replace: '        if (order.getQty() == null || order.getQty() <= 0) {',
    risk: 'low',
    preview: {
      status: 'ready',
      line: 5,
      patch: '--- a/com/demo/OrderService.java\n+++ b/com/demo/OrderService.java',
    },
  };
  await writeFile(path.join(runDir, 'result.json'), JSON.stringify({
    meta: {
      runId,
      fixRoots: { sourceRoot: backend, frontendSourceRoot: null },
    },
    agent: { conclusion: 'test', evidenceRefs: [], fixes: [fix] },
  }, null, 2), 'utf8');

  const uiScript = `(async () => {
    const applied = await window.dc.invoke('dc:fixes', { action: 'apply', runId: '${runId}', fixIndex: 0 });
    const verified = await window.dc.invoke('dc:verify', { action: 'run', runId: '${runId}', fixIndex: 0, restart: false });
    const undone = await window.dc.invoke('dc:fixes', { action: 'undo', runId: '${runId}', fixIndex: 0 });
    return {
      applied: applied.ok === true,
      appliedFile: applied.fix?.applied?.file ?? null,
      verified: verified.ok === true,
      verifyOutput: String(verified.output ?? '').includes('verify-ok'),
      undone: undone.ok === true,
      reverted: Boolean(undone.fix?.applied?.revertedAt),
    };
  })()`;

  const child = spawn(electronPath, [
    MAIN,
    '--smoke',
    '--port', '0',
    '--config-dir', path.join(DIR, 'configs'),
    '--runs-dir', path.join(DIR, 'runs'),
    '--smoke-ui-eval', Buffer.from(uiScript).toString('base64'),
  ], { env: { ...process.env } });

  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });

  const code = await new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.kill();
      resolve(-1);
    }, 50_000);
    child.on('close', (exitCode) => {
      clearTimeout(timer);
      resolve(exitCode);
    });
  });

  assert.equal(code, 0, `electron exited ${code}\nstdout:\n${stdout}\nstderr:\n${stderr}`);
  assert.match(stdout, /SMOKE_OK/);
  const match = stdout.match(/SMOKE_RESULT (\{.*\})/);
  assert.ok(match, `missing SMOKE_RESULT\n${stdout}`);
  const smoke = JSON.parse(match[1]);
  assert.deepEqual(smoke.uiEvalResult, {
    applied: true,
    appliedFile: 'com/demo/OrderService.java',
    verified: true,
    verifyOutput: true,
    undone: true,
    reverted: true,
  });

  assert.equal(await readFile(sourceFile, 'utf8'), original);
  const persisted = JSON.parse(await readFile(path.join(runDir, 'result.json'), 'utf8'));
  assert.ok(persisted.agent.fixes[0].applied.revertedAt);
  assert.equal(persisted.agent.fixes[0].applied.verification.ok, true);
  assert.equal(persisted.agent.fixes[0].applied.verification.exitCode, 0);
  const backups = await readdir(path.join(runDir, 'backups'));
  assert.equal(backups.length, 1);
  const files = await readdir(runDir);
  assert.ok(files.some((name) => name.startsWith('verification-') && name.endsWith('.log')));
  assert.match(await readFile(path.join(runDir, 'fixes.log'), 'utf8'), /apply .*verify ok=true .*undo /s);
});

test('applies and reverts all fixes through IPC', {
  skip: available ? false : 'Electron binary is not installed',
  timeout: 60_000,
}, async (t) => {
  const DIR = tempDir('electron-fix-batch');
  const runId = 'run-batch';
  const runDir = path.join(DIR, 'runs', runId);
  const backend = path.join(DIR, 'backend');
  const files = [
    { file: 'com/demo/A.java', original: 'class A {\n    int x = 1;\n}\n', search: '    int x = 1;', replace: '    int x = 2;' },
    { file: 'com/demo/B.java', original: 'class B {\n    int y = 1;\n}\n', search: '    int y = 1;', replace: '    int y = 2;' },
  ];

  await rm(DIR, { recursive: true, force: true });
  await mkdir(path.join(DIR, 'configs'), { recursive: true });
  await mkdir(path.join(runDir, 'backups'), { recursive: true });
  for (const entry of files) {
    const absolute = path.join(backend, entry.file);
    await mkdir(path.dirname(absolute), { recursive: true });
    await writeFile(absolute, entry.original, 'utf8');
  }
  t.after(async () => { await rm(DIR, { recursive: true, force: true }); });

  await writeFile(path.join(runDir, 'result.json'), JSON.stringify({
    meta: { runId, fixRoots: { sourceRoot: backend, frontendSourceRoot: null } },
    agent: {
      conclusion: 'batch test',
      evidenceRefs: [],
      fixes: files.map((entry) => ({
        summary: `change ${entry.file}`,
        kind: 'edit',
        root: 'backend',
        file: entry.file,
        search: entry.search,
        replace: entry.replace,
        risk: 'low',
        preview: { status: 'ready', line: 2, patch: '' },
      })),
    },
  }, null, 2), 'utf8');

  const uiScript = `(async () => {
    const applied = await window.dc.invoke('dc:fixes', { action: 'apply-all', runId: '${runId}' });
    const undone = await window.dc.invoke('dc:fixes', { action: 'undo-all', runId: '${runId}' });
    return {
      applied: applied.ok === true,
      appliedCount: applied.applied ?? 0,
      undone: undone.ok === true,
      revertedCount: undone.reverted ?? 0,
    };
  })()`;

  const child = spawn(electronPath, [
    MAIN, '--smoke', '--port', '0',
    '--config-dir', path.join(DIR, 'configs'),
    '--runs-dir', path.join(DIR, 'runs'),
    '--smoke-ui-eval', Buffer.from(uiScript).toString('base64'),
  ], { env: { ...process.env } });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const code = await new Promise((resolve) => {
    const timer = setTimeout(() => { child.kill(); resolve(-1); }, 50_000);
    child.on('close', (exitCode) => { clearTimeout(timer); resolve(exitCode); });
  });

  assert.equal(code, 0, `electron exited ${code}\nstdout:\n${stdout}\nstderr:\n${stderr}`);
  assert.match(stdout, /SMOKE_OK/);
  const match = stdout.match(/SMOKE_RESULT (\{.*\})/);
  const smoke = JSON.parse(match[1]);
  assert.deepEqual(smoke.uiEvalResult, {
    applied: true,
    appliedCount: 2,
    undone: true,
    revertedCount: 2,
  });

  for (const entry of files) {
    assert.equal(await readFile(path.join(backend, entry.file), 'utf8'), entry.original);
  }
  const persisted = JSON.parse(await readFile(path.join(runDir, 'result.json'), 'utf8'));
  assert.equal(persisted.agent.fixes.filter((fix) => fix.applied?.revertedAt).length, 2);
  assert.equal((await readdir(path.join(runDir, 'backups'))).length, 2);
});

test('renders full fixes and chat in the history tab with actions only on the latest turn', {
  skip: available ? false : 'Electron binary is not installed',
  timeout: 60_000,
}, async (t) => {
  const DIR = tempDir('electron-history-view');
  const runId = 'run-history';
  const runDir = path.join(DIR, 'runs', runId);
  await rm(DIR, { recursive: true, force: true });
  await mkdir(path.join(DIR, 'configs'), { recursive: true });
  await mkdir(runDir, { recursive: true });
  t.after(async () => { await rm(DIR, { recursive: true, force: true }); });

  const now = Date.now();
  await writeFile(path.join(runDir, 'meta.json'), JSON.stringify({
    runId, scenario: 'history-test', driver: 'capture', agent: 'mock', mode: 'mock',
    startedAt: now, endedAt: now + 10, durationMs: 10, question: 'history render',
  }), 'utf8');
  await writeFile(path.join(runDir, 'result.json'), JSON.stringify({
    meta: { runId, scenario: 'history-test', driver: 'capture', agent: 'mock', mode: 'mock', durationMs: 10, fixRoots: { sourceRoot: null, frontendSourceRoot: null } },
    request: { method: 'POST', url: 'http://localhost:8080/api/order' },
    response: { status: 500, durationMs: 12 },
    logs: { count: 1 },
    threads: { total: 1 },
    agent: {
      conclusion: '历史诊断结论',
      evidenceRefs: [{ type: 'request', ref: 'request' }],
      toolCalls: [],
      needsMoreInfo: [],
      fixes: [{
        summary: '历史修复建议',
        kind: 'edit',
        root: 'backend',
        file: 'com/demo/A.java',
        search: 'x',
        replace: 'y',
        risk: 'low',
        preview: { status: 'ready', line: 1, patch: '--- a/com/demo/A.java\n+++ b/com/demo/A.java' },
      }],
    },
  }, null, 2), 'utf8');

  const uiScript = `(async () => {
    document.querySelector('[data-tab="history"]').click();
    const deadline = Date.now() + 8000;
    let item = null;
    while (Date.now() < deadline) {
      item = document.querySelector('#runs li');
      if (item) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (!item) return { rendered: false, reason: 'no run item' };
    item.click();
    let card = null;
    while (Date.now() < deadline) {
      card = document.querySelector('#report .fix-card');
      if (card) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const result = {
      rendered: Boolean(card),
      conclusion: document.querySelector('#report .conclusion')?.textContent ?? '',
      fixSummary: document.querySelector('#report .fix-summary')?.textContent ?? '',
      batchButtons: document.querySelectorAll('#report .fix-batch button').length,
      actionButtons: [...document.querySelectorAll('#report button')].filter((button) => (
        /应用修改|撤销|运行验证|全部应用|全部撤销/.test(button.textContent)
      )).length,
      followupProgressPresent: Boolean(document.querySelector('#report .followup-progress')),
      reportClass: document.getElementById('report').className,
    };

    const chatInput = document.querySelector('#report .chat-input');
    const chatButton = document.querySelector('#report .chat-input-row button');
    if (chatInput && chatButton) {
      chatInput.value = '先给方案，不写具体代码';
      chatButton.click();
      const chatDeadline = Date.now() + 8000;
      while (Date.now() < chatDeadline) {
        const conclusions = [...document.querySelectorAll('#report .conclusion')].map((node) => node.textContent);
        if (conclusions.some((text) => text.includes('继续诊断')) && document.querySelectorAll('#report .chat-msg').length >= 3) break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      result.chatUpdated = [...document.querySelectorAll('#report .conclusion')]
        .some((node) => node.textContent.includes('继续诊断'));
      result.chatMessages = document.querySelectorAll('#report .chat-msg').length;
      result.chatHasUserText = [...document.querySelectorAll('#report .chat-msg.user')]
        .some((node) => node.textContent.includes('先给方案'));
    }

    const actionCount = (root) => [...(root?.querySelectorAll('button') ?? [])].filter((button) => (
      /应用修改|撤销|运行验证|全部应用|全部撤销/.test(button.textContent)
    )).length;
    const assistants = [...document.querySelectorAll('#report .history-assistant')];
    result.oldActionButtons = assistants.slice(0, -1).reduce((sum, node) => sum + actionCount(node), 0);
    result.latestActionButtons = assistants.length > 0 ? actionCount(assistants[assistants.length - 1]) : 0;

    const remove = document.querySelector('#runs .run-delete');
    if (!remove) return { ...result, deleted: false, reason: 'delete button missing' };
    window.confirm = () => true;
    remove.click();
    const deleteDeadline = Date.now() + 5000;
    while (Date.now() < deleteDeadline) {
      if ((document.querySelector('#runs li')?.textContent ?? '').includes('暂无诊断记录')) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    result.deleted = (document.querySelector('#runs li')?.textContent ?? '').includes('暂无诊断记录');
    result.reportCleared = document.getElementById('report')?.hidden === true;
    return result;
  })()`;

  const child = spawn(electronPath, [
    MAIN, '--smoke', '--port', '0',
    '--config-dir', path.join(DIR, 'configs'),
    '--runs-dir', path.join(DIR, 'runs'),
    '--smoke-ui-eval', Buffer.from(uiScript).toString('base64'),
  ], { env: { ...process.env } });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const code = await new Promise((resolve) => {
    const timer = setTimeout(() => { child.kill(); resolve(-1); }, 50_000);
    child.on('close', (exitCode) => { clearTimeout(timer); resolve(exitCode); });
  });

  assert.equal(code, 0, `electron exited ${code}\nstdout:\n${stdout}\nstderr:\n${stderr}`);
  assert.match(stdout, /SMOKE_OK/);
  const match = stdout.match(/SMOKE_RESULT (\{.*\})/);
  const smoke = JSON.parse(match[1]);
  assert.equal(smoke.uiEvalResult.rendered, true);
  assert.equal(smoke.uiEvalResult.conclusion, '历史诊断结论');
  assert.equal(smoke.uiEvalResult.fixSummary, '历史修复建议');
  assert.equal(smoke.uiEvalResult.batchButtons, 2);
  assert.ok(smoke.uiEvalResult.actionButtons > 0);
  assert.equal(smoke.uiEvalResult.oldActionButtons, 0);
  assert.ok(smoke.uiEvalResult.latestActionButtons > 0);
  assert.equal(smoke.uiEvalResult.followupProgressPresent, true);
  assert.match(smoke.uiEvalResult.reportClass, /diagnose-card/);
  assert.doesNotMatch(smoke.uiEvalResult.reportClass, /muted/);
  assert.equal(smoke.uiEvalResult.chatUpdated, true);
  assert.ok(smoke.uiEvalResult.chatMessages >= 3);
  assert.equal(smoke.uiEvalResult.chatHasUserText, true);
  assert.equal(smoke.uiEvalResult.deleted, true);
  assert.equal(smoke.uiEvalResult.reportCleared, true);
  await assert.rejects(readFile(path.join(runDir, 'result.json'), 'utf8'));
});

test('history runs behave as an accordion', {
  skip: available ? false : 'Electron binary is not installed',
  timeout: 60_000,
}, async (t) => {
  const DIR = tempDir('electron-history-accordion');
  await rm(DIR, { recursive: true, force: true });
  await mkdir(path.join(DIR, 'configs'), { recursive: true });
  t.after(async () => { await rm(DIR, { recursive: true, force: true }); });
  const now = Date.now();
  for (const [runId, scenario, conclusion, offset] of [
    ['run-a', 'A', 'A结论', 0],
    ['run-b', 'B', 'B结论', -1000],
  ]) {
    const dir = path.join(DIR, 'runs', runId);
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'meta.json'), JSON.stringify({
      runId, scenario, driver: 'capture', agent: 'mock', mode: 'mock',
      startedAt: now + offset, endedAt: now + offset + 10, durationMs: 10, question: '',
    }), 'utf8');
    await writeFile(path.join(dir, 'result.json'), JSON.stringify({
      meta: { runId, scenario, agent: 'mock', mode: 'mock', durationMs: 10 },
      request: { method: 'GET', url: 'http://localhost:8080/api/ping' },
      response: { status: 200 },
      logs: { count: 0 },
      threads: { total: 0 },
      agent: {
        conclusion,
        evidenceRefs: [{ type: 'request', ref: 'request' }],
        fixes: [],
        toolCalls: [],
        needsMoreInfo: [],
      },
    }, null, 2), 'utf8');
  }

  const uiScript = `(async () => {
    const waitFor = async (fn, timeout = 6000) => {
      const deadline = Date.now() + timeout;
      while (Date.now() < deadline) {
        if (fn()) return true;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      return false;
    };
    document.querySelector('[data-tab="history"]').click();
    await waitFor(() => document.querySelectorAll('#runs li[data-run-id]').length >= 2);
    const report = document.getElementById('report');
    const initial = {
      reportHidden: report.hidden,
      visibleRuns: document.querySelectorAll('#runs li[data-run-id]:not([hidden])').length,
    };
    const first = () => document.querySelector('#runs li[data-run-id]');
    first().click();
    await waitFor(() => report.hidden === false && report.textContent.includes('A结论'));
    const opened = {
      reportHidden: report.hidden,
      visibleRuns: document.querySelectorAll('#runs li[data-run-id]:not([hidden])').length,
      selected: document.querySelector('#runs li.selected')?.textContent.includes('A') === true,
    };
    first().click();
    await waitFor(() => report.hidden === true);
    const closed = {
      reportHidden: report.hidden,
      visibleRuns: document.querySelectorAll('#runs li[data-run-id]:not([hidden])').length,
    };
    const second = [...document.querySelectorAll('#runs li[data-run-id]')].find((li) => li.textContent.includes('B'));
    second.click();
    await waitFor(() => report.hidden === false && report.textContent.includes('B结论'));
    const secondOpen = {
      reportHidden: report.hidden,
      visibleRuns: document.querySelectorAll('#runs li[data-run-id]:not([hidden])').length,
      selected: document.querySelector('#runs li.selected')?.textContent.includes('B') === true,
    };
    return { initial, opened, closed, secondOpen };
  })()`;

  const child = spawn(electronPath, [
    MAIN, '--smoke', '--port', '0',
    '--config-dir', path.join(DIR, 'configs'),
    '--runs-dir', path.join(DIR, 'runs'),
    '--smoke-ui-eval', Buffer.from(uiScript).toString('base64'),
  ], { env: { ...process.env } });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const code = await new Promise((resolve) => {
    const timer = setTimeout(() => { child.kill(); resolve(-1); }, 50_000);
    child.on('close', (exitCode) => { clearTimeout(timer); resolve(exitCode); });
  });

  assert.equal(code, 0, `electron exited ${code}\nstdout:\n${stdout}\nstderr:\n${stderr}`);
  assert.match(stdout, /SMOKE_OK/);
  const match = stdout.match(/SMOKE_RESULT (\{.*\})/);
  const smoke = JSON.parse(match[1]);
  assert.deepEqual(smoke.uiEvalResult, {
    initial: { reportHidden: true, visibleRuns: 2 },
    opened: { reportHidden: false, visibleRuns: 1, selected: true },
    closed: { reportHidden: true, visibleRuns: 2 },
    secondOpen: { reportHidden: false, visibleRuns: 1, selected: true },
  });
});

test('saving config persists the current browser URL input', {
  skip: available ? false : 'Electron binary is not installed',
  timeout: 60_000,
}, async (t) => {
  const DIR = tempDir('electron-profile-save-url');
  await rm(DIR, { recursive: true, force: true });
  await mkdir(path.join(DIR, 'configs'), { recursive: true });
  t.after(async () => { await rm(DIR, { recursive: true, force: true }); });

  const uiScript = `(async () => {
    const waitFor = async (fn, timeout = 6000) => {
      const deadline = Date.now() + timeout;
      while (Date.now() < deadline) {
        if (fn()) return true;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      return false;
    };
    document.getElementById('browser-url').value = 'http://localhost:6001';
    document.getElementById('config-form').requestSubmit();
    await waitFor(() => (document.getElementById('config-message')?.textContent ?? '').includes('已保存'));
    const config = await window.dc.invoke('dc:config', { action: 'get' });
    return {
      frontendUrl: config.workspace.frontendUrl,
      message: document.getElementById('config-message')?.textContent ?? '',
    };
  })()`;

  const child = spawn(electronPath, [
    MAIN, '--smoke', '--port', '0',
    '--config-dir', path.join(DIR, 'configs'),
    '--runs-dir', path.join(DIR, 'runs'),
    '--smoke-ui-eval', Buffer.from(uiScript).toString('base64'),
  ], { env: { ...process.env } });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const code = await new Promise((resolve) => {
    const timer = setTimeout(() => { child.kill(); resolve(-1); }, 50_000);
    child.on('close', (exitCode) => { clearTimeout(timer); resolve(exitCode); });
  });

  assert.equal(code, 0, `electron exited ${code}\nstdout:\n${stdout}\nstderr:\n${stderr}`);
  assert.match(stdout, /SMOKE_OK/);
  const match = stdout.match(/SMOKE_RESULT (\{.*\})/);
  const smoke = JSON.parse(match[1]);
  assert.equal(smoke.uiEvalResult.frontendUrl, 'http://localhost:6001');
  assert.match(smoke.uiEvalResult.message, /已保存/);
});
