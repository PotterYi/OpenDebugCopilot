import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const CLI = path.join(ROOT, 'src/app/cli.mjs');
const TMP = path.resolve(HERE, `../../../.tmp/serve-test-${process.pid}`);

function startServe(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, 'serve', ...args]);
    let output = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`serve did not start in time: ${output}`));
    }, 15000);
    const onData = (chunk) => {
      output += chunk;
      const match = output.match(/DebugCopilot WebUI: (http:\/\/\S+)/);
      if (match) {
        clearTimeout(timer);
        resolve({ child, url: match[1] });
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', (chunk) => { output += chunk; });
    child.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`serve exited with ${code}: ${output}`));
    });
  });
}

test('serve starts WebUI and serves the API', async (t) => {
  await mkdir(TMP, { recursive: true });
  t.after(async () => { await rm(TMP, { recursive: true, force: true }); });

  const { child, url } = await startServe([
    '--port', '0',
    '--runs-dir', path.join(TMP, 'runs'),
    '--config-dir', path.join(TMP, 'configs'),
  ]);
  t.after(() => new Promise((resolve) => {
    child.once('exit', resolve);
    child.kill();
    setTimeout(resolve, 3000);
  }));

  const health = await fetch(`${url}/api/health`).then((response) => response.json());
  assert.equal(health.ok, true);

  const saved = await fetch(`${url}/api/config`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      workspace: {
        frontendUrl: 'http://localhost:5173',
        backendUrl: 'http://127.0.0.1:8080',
        logfiles: [],
        sourceRoot: '',
        window: { beforeMs: 3000, afterMs: 2000 },
      },
    }),
  }).then((response) => response.json());
  assert.equal(saved.workspace.backendUrl, 'http://127.0.0.1:8080');

  const file = JSON.parse(await readFile(path.join(TMP, 'configs', 'workspace.json'), 'utf8'));
  assert.equal(file.frontendUrl, 'http://localhost:5173');
});
