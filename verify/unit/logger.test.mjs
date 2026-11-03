import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdir, readdir, readFile, rm } from 'node:fs/promises';
import { tempDir } from './tmp.mjs';

test('writes logs to stderr target file and rotates by size', async (t) => {
  process.env.DC_LOG_MAX_BYTES = '400';
  process.env.DC_LOG_KEEP = '2';
  const { setLogFile, log } = await import('../../src/core/logger.mjs');
  const dir = tempDir('logger-test');
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  t.after(async () => { await rm(dir, { recursive: true, force: true }); });

  const file = path.join(dir, 'app.log');
  setLogFile(file);
  for (let i = 0; i < 260; i += 1) log.info(`line-${i}-${'x'.repeat(40)}`);

  const files = await readdir(dir);
  assert.ok(files.includes('app.log'));
  assert.ok(files.some((name) => name.endsWith('.1')), `expected rotation, got ${files.join(',')}`);
  const content = await readFile(file, 'utf8');
  assert.match(content, /\[INFO\]/);
  setLogFile(null);
});
