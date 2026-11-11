import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { createToolPermission } from '../../src/agent/claude.mjs';
import { tempDir } from './tmp.mjs';

const exec = promisify(execFile);
const TMP = tempDir('write-permission-test');

function permissionFor(root) {
  return createToolPermission([root], {
    cwd: root,
    allowWrite: true,
    writeRoots: [root],
  });
}

async function fixture(t) {
  await rm(TMP, { recursive: true, force: true });
  t.after(async () => { await rm(TMP, { recursive: true, force: true }); });
}

test('allows writes inside a copy sandbox located under runs/', async (t) => {
  await fixture(t);
  const root = path.join(TMP, 'runs', 'run-1', 'sandbox', 'backend');
  await mkdir(root, { recursive: true });
  const result = await permissionFor(root)('Write', {
    file_path: path.join(root, 'src', 'app.js'),
    content: 'x',
  });
  assert.equal(result.behavior, 'allow', JSON.stringify(result));
});

test('ignores denied folder names that are only in the workspace ancestor path', async (t) => {
  await fixture(t);
  const root = path.join(TMP, 'build', 'my-app');
  await mkdir(root, { recursive: true });
  const result = await permissionFor(root)('Write', {
    file_path: path.join(root, 'src', 'main.js'),
    content: 'x',
  });
  assert.equal(result.behavior, 'allow', JSON.stringify(result));
});

test('still denies top-level build output and node_modules', async (t) => {
  await fixture(t);
  const root = path.join(TMP, 'repo');
  await mkdir(root, { recursive: true });
  const permission = permissionFor(root);

  const target = await permission('Write', {
    file_path: path.join(root, 'target', 'classes', 'A.class'),
    content: 'x',
  });
  assert.equal(target.behavior, 'deny');

  const modules = await permission('Write', {
    file_path: path.join(root, 'node_modules', 'pkg', 'index.js'),
    content: 'x',
  });
  assert.equal(modules.behavior, 'deny');
});

test('nested output names are denied only when Git ignores them', async (t) => {
  await fixture(t);
  const root = path.join(TMP, 'repo');
  await mkdir(path.join(root, 'pkg', 'dist'), { recursive: true });
  await mkdir(path.join(root, 'src', 'build'), { recursive: true });
  await writeFile(path.join(root, '.gitignore'), 'dist/\n', 'utf8');
  await exec('git', ['-C', root, 'init', '-q']);

  const permission = permissionFor(root);
  const ignored = await permission('Write', {
    file_path: path.join(root, 'pkg', 'dist', 'bundle.js'),
    content: 'x',
  });
  assert.equal(ignored.behavior, 'deny', JSON.stringify(ignored));

  const source = await permission('Write', {
    file_path: path.join(root, 'src', 'build', 'parser.js'),
    content: 'x',
  });
  assert.equal(source.behavior, 'allow', JSON.stringify(source));
});

test('allows a tracked source folder named build inside a Git project', async (t) => {
  await fixture(t);
  const root = path.join(TMP, 'repo');
  await mkdir(path.join(root, 'build'), { recursive: true });
  await exec('git', ['-C', root, 'init', '-q']);
  const result = await permissionFor(root)('Write', {
    file_path: path.join(root, 'build', 'schema.js'),
    content: 'x',
  });
  assert.equal(result.behavior, 'allow', JSON.stringify(result));
});
