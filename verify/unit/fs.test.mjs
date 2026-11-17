import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { listDirectory, statFile } from '../../src/evidence/fs.mjs';
import { isSensitivePath, normalizePath } from '../../src/core/path-policy.mjs';
import { tempDir } from './tmp.mjs';

async function fixture() {
  const root = tempDir('fs-tools-test');
  await rm(root, { recursive: true, force: true });
  await mkdir(path.join(root, 'src'), { recursive: true });
  await mkdir(path.join(root, 'sub/nested'), { recursive: true });
  await mkdir(path.join(root, 'node_modules/pkg'), { recursive: true });
  await mkdir(path.join(root, '.git'), { recursive: true });
  await writeFile(path.join(root, 'src/a.js'), 'console.log(1);\n');
  await writeFile(path.join(root, 'sub/nested/deep.txt'), 'deep\n');
  await writeFile(path.join(root, 'node_modules/pkg/index.js'), 'module.exports = 1;\n');
  await writeFile(path.join(root, '.env'), 'PASSWORD=hunter2\n');
  await writeFile(path.join(root, '.git/config'), '[core]\n');
  await writeFile(path.join(root, 'secret.pem'), 'key\n');
  return root;
}

test('lists metadata, hides sensitive names and .git', async (t) => {
  const root = await fixture();
  t.after(async () => { await rm(root, { recursive: true, force: true }); });
  const listing = await listDirectory({ root });
  const names = listing.entries.map((entry) => entry.name);
  assert.ok(names.includes('src'));
  assert.ok(names.includes('a.js') === false);
  assert.ok(names.includes('node_modules'));
  assert.equal(names.includes('.env'), false);
  assert.equal(names.includes('secret.pem'), false);
  assert.equal(names.includes('.git'), false);
  assert.ok(listing.hiddenSensitive >= 3);
  const file = listing.entries.find((entry) => entry.name === 'sub');
  assert.equal(file.type, 'dir');
  assert.ok(file.mtime);
  const deepAbsent = listing.entries.some((entry) => entry.path.includes('nested/deep.txt'));
  assert.equal(deepAbsent, false);
});

test('recurses to depth 2 but skips ignored directories', async (t) => {
  const root = await fixture();
  t.after(async () => { await rm(root, { recursive: true, force: true }); });
  const listing = await listDirectory({ root, depth: 2 });
  const paths = listing.entries.map((entry) => entry.path);
  assert.ok(paths.includes('src/a.js'));
  assert.ok(paths.includes('sub/nested'));
  assert.equal(paths.includes('sub/nested/deep.txt'), false);
  assert.ok(paths.includes('node_modules'));
  assert.equal(paths.includes('node_modules/pkg'), false);
});

test('caps entries and reports truncation', async (t) => {
  const root = await fixture();
  t.after(async () => { await rm(root, { recursive: true, force: true }); });
  const listing = await listDirectory({ root, limit: 2 });
  assert.equal(listing.count, 2);
  assert.equal(listing.truncated, true);
});

test('statFile returns metadata and missing files without content', async (t) => {
  const root = await fixture();
  t.after(async () => { await rm(root, { recursive: true, force: true }); });
  const file = await statFile({ root, path: 'src/a.js' });
  assert.equal(file.exists, true);
  assert.equal(file.type, 'file');
  assert.equal(file.size, 16);
  assert.ok(file.mtime);
  assert.equal(file.isSymlink, false);

  const dir = await statFile({ root, path: 'src' });
  assert.equal(dir.type, 'dir');
  assert.equal(dir.size, null);

  const missing = await statFile({ root, path: 'missing.txt' });
  assert.equal(missing.exists, false);
  assert.equal(missing.type, null);
});

test('rejects outside, sensitive and git-internal paths', async (t) => {
  const root = await fixture();
  t.after(async () => { await rm(root, { recursive: true, force: true }); });
  await assert.rejects(statFile({ root, path: '../package.json' }), (error) => error.code === 'PATH_OUT_OF_SCOPE');
  await assert.rejects(statFile({ root, path: '.env' }), (error) => error.code === 'SENSITIVE_PATH');
  await assert.rejects(statFile({ root, path: 'secret.pem' }), (error) => error.code === 'SENSITIVE_PATH');
  await assert.rejects(listDirectory({ root, path: '.git' }), (error) => error.code === 'SENSITIVE_PATH');
});

test('rejects a symlink that resolves outside the root', async (t) => {
  const root = await fixture();
  const outside = tempDir('fs-outside-test');
  await mkdir(outside, { recursive: true });
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  });
  const link = path.join(root, 'outside-link');
  try {
    await symlink(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
  } catch {
    t.skip('symlink creation is not permitted in this environment');
    return;
  }
  await assert.rejects(statFile({ root, path: 'outside-link' }), (error) => error.code === 'PATH_OUT_OF_SCOPE');
});

test('path policy recognizes sensitive and Windows-style paths', () => {
  assert.equal(isSensitivePath('.env'), true);
  assert.equal(isSensitivePath('config/.env.local'), true);
  assert.equal(isSensitivePath('certs/server.pem'), true);
  assert.equal(isSensitivePath('.git/config'), true);
  assert.equal(isSensitivePath('.ssh/id_rsa'), true);
  assert.equal(isSensitivePath('src/main/App.java'), false);
  const bs = String.fromCharCode(92);
  assert.equal(normalizePath(`src${bs}main${bs}App.java`), 'src/main/App.java');
});
