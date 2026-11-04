import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tempDir } from './tmp.mjs';
import { runVerifyCommand } from '../../src/app/electron/verify-command.mjs';

const TMP = tempDir('verify-command-test');

async function fixture(t, script) {
  await rm(TMP, { recursive: true, force: true });
  t.after(async () => { await rm(TMP, { recursive: true, force: true }); });
  await mkdir(TMP, { recursive: true });
  await writeFile(path.join(TMP, 'verify.mjs'), script, 'utf8');
  return TMP;
}

test('runs a successful verification command and captures output', async (t) => {
  const cwd = await fixture(t, "console.log('verify-ok');\n");
  const result = await runVerifyCommand({ command: 'node verify.mjs', cwd, timeoutMs: 10_000 });
  assert.equal(result.ok, true);
  assert.equal(result.exitCode, 0);
  assert.equal(result.timedOut, false);
  assert.match(result.output, /verify-ok/);
  assert.ok(result.durationMs >= 0);
});

test('reports a non-zero exit code', async (t) => {
  const cwd = await fixture(t, "console.error('verify-failed'); process.exit(2);\n");
  const result = await runVerifyCommand({ command: 'node verify.mjs', cwd, timeoutMs: 10_000 });
  assert.equal(result.ok, false);
  assert.equal(result.exitCode, 2);
  assert.match(result.output, /verify-failed/);
});

test('times out and kills a hanging command', async (t) => {
  const cwd = await fixture(t, "setTimeout(() => {}, 60_000);\n");
  const started = Date.now();
  const result = await runVerifyCommand({ command: 'node verify.mjs', cwd, timeoutMs: 500 });
  assert.equal(result.ok, false);
  assert.equal(result.timedOut, true);
  assert.ok(Date.now() - started < 10_000);
});

test('caps very large output', async (t) => {
  const cwd = await fixture(t, "console.log('x'.repeat(5000));\n");
  const result = await runVerifyCommand({ command: 'node verify.mjs', cwd, timeoutMs: 10_000, maxOutputBytes: 100 });
  assert.equal(result.truncated, true);
  assert.ok(result.output.length <= 100);
});
