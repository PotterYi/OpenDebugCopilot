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

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const MAIN = path.join(ROOT, 'src/app/electron/main.mjs');
const TMP = path.resolve(HERE, `../../../.tmp/electron-test-${process.pid}`);

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

  const backendServer = http.createServer((req, res) => {
    if (req.url === '/api/ping') {
      backendHits += 1;
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
      res.end(`<!doctype html><html><body><script>
        setTimeout(() => {
          fetch('/api/ping')
            .then((r) => r.json())
            .then(() => { document.title = 'ok'; })
            .catch((e) => { document.title = 'blocked:' + e.message; });
        }, 300);
      </script></body></html>`);
      return;
    }
    if (req.url === '/api/ping') {
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
  assert.match(stdout, /"hasDc":true/);
  assert.match(stdout, /"hasWorkspace":true/);
  assert.match(stdout, /"uiReady":true/);
  assert.match(stdout, /"captureOk":true/);
  assert.match(stdout, /"captured":[1-9]/);
  assert.match(stdout, /"pageTitle":"ok"/);
  assert.match(stdout, /"isLoading":false/);
  assert.match(stdout, /"diagnose":\{"ok":true/);
  assert.match(stdout, /"gates":true/);
  assert.ok(backendHits >= 1, `expected redirect to backend, got ${backendHits}`);
  assert.equal(pageApiHits, 0, `request should have been redirected, page hits: ${pageApiHits}`);
});
