import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tempDir } from './tmp.mjs';
import {
  findProjectRoot,
  detectStartCommand,
  resolveFrontendLaunch,
} from '../../src/core/frontend-service.mjs';

const TMP = tempDir('frontend-service-test');

async function fixture(t, scripts = { dev: 'vite' }, lockfile = null) {
  await rm(TMP, { recursive: true, force: true });
  t.after(async () => { await rm(TMP, { recursive: true, force: true }); });
  const project = path.join(TMP, 'frontend');
  await mkdir(path.join(project, 'src'), { recursive: true });
  await writeFile(path.join(project, 'package.json'), JSON.stringify({ scripts }), 'utf8');
  if (lockfile) await writeFile(path.join(project, lockfile), '', 'utf8');
  return project;
}

test('finds package.json by walking up from the source directory', async (t) => {
  const project = await fixture(t);
  const found = await findProjectRoot(path.join(project, 'src'), { rootDir: TMP });
  assert.equal(found, project);
});

test('detects npm and prefers the dev script', async (t) => {
  const project = await fixture(t, { dev: 'vite', build: 'vite build' });
  const detected = await detectStartCommand(project);
  assert.deepEqual(detected, { ok: true, command: 'npm run dev', packageManager: 'npm', script: 'dev' });
});

test('detects pnpm from the lockfile and falls back to serve', async (t) => {
  const project = await fixture(t, { serve: 'vue-cli-service serve' }, 'pnpm-lock.yaml');
  const detected = await detectStartCommand(project);
  assert.deepEqual(detected, { ok: true, command: 'pnpm run serve', packageManager: 'pnpm', script: 'serve' });
});

test('reports a missing dev script', async (t) => {
  const project = await fixture(t, { build: 'vite build' });
  const detected = await detectStartCommand(project);
  assert.equal(detected.ok, false);
  assert.match(detected.reason, /dev \/ serve \/ start/);
});

test('resolves the launch from frontendSourceRoot', async (t) => {
  const project = await fixture(t);
  const launch = await resolveFrontendLaunch({
    frontendSourceRoot: 'frontend/src',
  }, { rootDir: TMP });
  assert.equal(launch.ok, true);
  assert.equal(launch.cwd, project);
  assert.equal(launch.command, 'npm run dev');
  assert.equal(launch.source, 'auto');
});

test('an explicit project root and command win over auto detection', async (t) => {
  const project = await fixture(t);
  const launch = await resolveFrontendLaunch({
    frontendProjectRoot: 'frontend',
    frontendStartCommand: 'node custom-dev.js',
  }, { rootDir: TMP });
  assert.equal(launch.ok, true);
  assert.equal(launch.cwd, project);
  assert.equal(launch.command, 'node custom-dev.js');
  assert.equal(launch.source, 'config');
});

test('fails clearly when no project root can be inferred', async (t) => {
  await rm(TMP, { recursive: true, force: true });
  t.after(async () => { await rm(TMP, { recursive: true, force: true }); });
  const launch = await resolveFrontendLaunch({ frontendSourceRoot: 'missing/src' }, { rootDir: TMP });
  assert.equal(launch.ok, false);
  assert.match(launch.reason, /package\.json/);
});
