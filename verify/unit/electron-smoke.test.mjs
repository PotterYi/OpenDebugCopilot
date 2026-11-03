import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import http from 'node:http';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';

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

test('electron shell boots and exposes dc IPC', {
  skip: available ? false : 'Electron binary is not installed',
  timeout: 90_000,
}, async (t) => {
  await mkdir(TMP, { recursive: true });
  t.after(async () => { await rm(TMP, { recursive: true, force: true }); });

  const pageServer = http.createServer((req, res) => {
    if (req.url === '/page') {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end('<!doctype html><html><body><script>setTimeout(() => fetch("/api/ping").then(r=>r.json()), 300)</script></body></html>');
      return;
    }
    if (req.url === '/api/ping') {
      res.setHeader('Content-Type', 'application/json');
      res.end('{"ok":true}');
      return;
    }
    res.statusCode = 404;
    res.end('not found');
  });
  pageServer.listen(0, '127.0.0.1');
  await once(pageServer, 'listening');
  t.after(() => new Promise((resolve) => pageServer.close(resolve)));

  const child = spawn(electronPath, [
    MAIN,
    '--smoke',
    '--port', '0',
    `--smoke-url=http://127.0.0.1:${pageServer.address().port}/page`,
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
  assert.match(stdout, /"captureOk":true/);
  assert.match(stdout, /"captured":[1-9]/);
});
