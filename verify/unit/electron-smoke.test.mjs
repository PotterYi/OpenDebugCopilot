import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
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
  let pageOptionsHits = 0;

  let backendOptions = 0;
  const backendServer = http.createServer((req, res) => {
    if (req.url === '/api/order' && req.method === 'POST') {
      backendHits += 1;
      backendOrigin = req.headers.origin ?? null;
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
      res.end(pageHtml(`http://localhost:${backendServer.address().port}`));

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
    rules: [{
      id: 'local-api',
      enabled: true,
      match: { host: 'localhost', prefix: '/api' },
      target: {
        kind: 'local',
        baseUrl: `http://127.0.0.1:${backendServer.address().port}`,
      },
    }],
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
  assert.match(stdout, /"captureOk":true/);
  assert.match(stdout, /"captured":[1-9]/);
  assert.match(stdout, /"pageTitle":"ok"/);
  assert.match(stdout, /"isLoading":false/);
  assert.match(stdout, /"captureBody":true/);
  assert.match(stdout, /"diagnose":\{"ok":true/);
  assert.match(stdout, /"gates":true/);
  assert.match(stdout, /"frontendErrors":[1-9]/);
  assert.ok(backendHits >= 1, `expected redirect to backend, got ${backendHits}`);
  assert.equal(backendOptions, 0, 'preflight should be answered by the local proxy');
  assert.equal(pageOptionsHits, 0, 'preflight should not reach the page server');
  assert.equal(pageApiHits, 0, `request should have been redirected, page hits: ${pageApiHits}`);
  assert.ok(backendOrigin, 'backend should receive an Origin header');
});
