import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { tempDir } from './tmp.mjs';
import { checkWritablePath } from '../../src/core/write-policy.mjs';

const execFileAsync = promisify(execFile);
const TMP = tempDir('write-policy-test');

async function git(root, args) {
  await execFileAsync('git', ['-C', root, ...args], { windowsHide: true, timeout: 10_000 });
}

async function fixture(t) {
  await rm(TMP, { recursive: true, force: true });
  const root = path.join(TMP, 'project');
  const noRepo = path.join(TMP, 'plain');
  await mkdir(path.join(root, 'src'), { recursive: true });
  await mkdir(path.join(root, 'target'), { recursive: true });
  await mkdir(path.join(root, 'build'), { recursive: true });
  await mkdir(path.join(root, 'node_modules'), { recursive: true });
  await mkdir(path.join(noRepo, 'target'), { recursive: true });
  await writeFile(path.join(root, 'src', 'app.js'), 'value\n', 'utf8');
  await writeFile(path.join(root, 'target', 'out.js'), 'value\n', 'utf8');
  await writeFile(path.join(root, 'build', 'Tracked.java'), 'class Tracked {}\n', 'utf8');
  await writeFile(path.join(root, 'node_modules', 'dep.js'), 'value\n', 'utf8');
  await writeFile(path.join(root, '.env'), 'SECRET=1\n', 'utf8');
  await writeFile(path.join(root, '.gitignore'), 'target/\ndist/\n', 'utf8');
  await git(root, ['init']);
  await git(root, ['add', '-f', '.gitignore', 'build/Tracked.java']);
  await writeFile(path.join(noRepo, 'target', 'out.js'), 'value\n', 'utf8');
  t.after(async () => { await rm(TMP, { recursive: true, force: true }); });
  return { root, noRepo };
}

test('allows normal source files and tracked build folders', async (t) => {
  const { root } = await fixture(t);
  assert.equal((await checkWritablePath({ target: path.join(root, 'src', 'app.js'), roots: [root] })).ok, true);
  assert.equal((await checkWritablePath({ target: path.join(root, 'build', 'Tracked.java'), roots: [root] })).ok, true);
});

test('denies sensitive, VCS, dependency and ignored build paths', async (t) => {
  const { root } = await fixture(t);
  const check = (target) => checkWritablePath({ target, roots: [root] });
  assert.equal((await check(path.join(root, '.env'))).code, 'WRITE_SENSITIVE_PATH');
  assert.equal((await check(path.join(root, '.git', 'config'))).code, 'WRITE_SENSITIVE_PATH');
  assert.equal((await check(path.join(root, 'node_modules', 'dep.js'))).code, 'WRITE_VCS_DENIED');
  assert.equal((await check(path.join(root, 'target', 'out.js'))).code, 'WRITE_BUILD_OUTPUT');
});

test('denies root-level build outputs when there is no git repository', async (t) => {
  const { noRepo } = await fixture(t);
  const result = await checkWritablePath({ target: path.join(noRepo, 'target', 'out.js'), roots: [noRepo] });
  assert.equal(result.code, 'WRITE_BUILD_OUTPUT');
});

test('denies paths outside every writable root', async (t) => {
  const { root } = await fixture(t);
  const result = await checkWritablePath({ target: path.join(TMP, 'outside.js'), roots: [root] });
  assert.equal(result.code, 'WRITE_OUTSIDE_ROOT');
});
