import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tempDir } from './tmp.mjs';
import { applyFix, revertFix } from '../../src/core/fix-apply.mjs';

const TMP = tempDir('fix-apply-test');
const FILE = 'com/demo/OrderService.java';
const ORIGINAL = [
  'package com.demo;',
  '',
  'public class OrderService {',
  '    public void create(Order order) {',
  '        if (order.getQty() <= 0) {',
  '            throw new IllegalArgumentException("qty must be positive");',
  '        }',
  '    }',
  '}',
].join('\n');

const fix = {
  summary: '防御空数量',
  root: 'backend',
  file: FILE,
  search: '        if (order.getQty() <= 0) {',
  replace: '        if (order.getQty() == null || order.getQty() <= 0) {',
  risk: 'low',
};

async function fixture(t, content = ORIGINAL) {
  await rm(TMP, { recursive: true, force: true });
  t.after(async () => { await rm(TMP, { recursive: true, force: true }); });
  const backend = path.join(TMP, 'backend');
  const file = path.join(backend, FILE);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, content, 'utf8');
  return { backend, file, roots: { sourceRoot: backend, frontendSourceRoot: null } };
}

test('applies a fix, writes a backup and reverts it', async (t) => {
  const { file, roots } = await fixture(t);
  const backupPath = path.join(TMP, 'backups', 'fix-0.orig');
  const applied = await applyFix({ fix, roots, backupPath });
  assert.equal(applied.file, FILE);
  assert.equal(applied.line, 5);
  assert.equal(await readFile(backupPath, 'utf8'), ORIGINAL);

  const changed = await readFile(file, 'utf8');
  assert.match(changed, /^        if \(order\.getQty\(\) == null \|\| order\.getQty\(\) <= 0\) \{/m);
  assert.equal((await stat(file)).isFile(), true);

  await revertFix({ fix, roots, backupPath });
  assert.equal(await readFile(file, 'utf8'), ORIGINAL);
});

test('preserves CRLF when the source file uses it', async (t) => {
  const crlf = ORIGINAL.replace(/\n/g, '\r\n');
  const { file, roots } = await fixture(t, crlf);
  const backupPath = path.join(TMP, 'backups', 'fix-crlf.orig');
  await applyFix({ fix, roots, backupPath });
  const changed = await readFile(file, 'utf8');
  assert.match(changed, /^        if \(order\.getQty\(\) == null \|\| order\.getQty\(\) <= 0\) \{\r$/m);
  assert.equal(changed.includes('\n') && changed.includes('\r\n'), true);
  await revertFix({ fix, roots, backupPath });
  assert.equal(await readFile(file, 'utf8'), crlf);
});

test('rejects stale, ambiguous or escaping fixes', async (t) => {
  const { roots } = await fixture(t);
  const backupPath = path.join(TMP, 'backups', 'fix-bad.orig');

  await assert.rejects(
    applyFix({ fix: { ...fix, search: 'not-in-file' }, roots, backupPath }),
    /未在文件中找到/,
  );
  await assert.rejects(
    applyFix({ fix: { ...fix, search: 'public', replace: 'protected' }, roots, backupPath }),
    /出现 2 次/,
  );
  await assert.rejects(
    applyFix({ fix: { ...fix, file: '../secret.txt' }, roots, backupPath }),
    /越出源码目录/,
  );
});

test('refuses to apply a text-only suggestion', async (t) => {
  const { roots } = await fixture(t);
  await assert.rejects(
    applyFix({ fix: { summary: '只给建议', risk: 'low' }, roots, backupPath: path.join(TMP, 'b.orig') }),
    /没有可应用的代码修改/,
  );
});

test('applies and reverts a fix in an authorized additional backend root', async (t) => {
  const { roots } = await fixture(t);
  const extraRoot = path.join(TMP, 'extra');
  const extraFile = path.join(extraRoot, 'com/demo/Other.java');
  const originalExtra = 'class Other {\n    int value = 1;\n}\n';
  await mkdir(path.dirname(extraFile), { recursive: true });
  await writeFile(extraFile, originalExtra, 'utf8');
  const extraFix = {
    summary: '修改其他后端',
    root: 'extra',
    extraRoot: 'extra-1',
    file: 'com/demo/Other.java',
    search: '    int value = 1;',
    replace: '    int value = 2;',
    risk: 'medium',
  };
  const rootsWithExtra = {
    ...roots,
    extraSourceRoots: [{ id: 'extra-1', root: extraRoot }],
  };
  const backupPath = path.join(TMP, 'backups', 'fix-extra.orig');
  await applyFix({ fix: extraFix, roots: rootsWithExtra, backupPath });
  assert.match(await readFile(extraFile, 'utf8'), /int value = 2;/);
  await revertFix({ fix: extraFix, roots: rootsWithExtra, backupPath });
  assert.equal(await readFile(extraFile, 'utf8'), originalExtra);

  await assert.rejects(
    applyFix({ fix: extraFix, roots, backupPath }),
    /未授权|无效/,
  );
});

test('creates a new file and reverts by deleting it', async (t) => {
  const { backend, roots } = await fixture(t);
  const createdFile = 'com/demo/NewService.java';
  const content = 'package com.demo;\n\npublic class NewService {\n}\n';
  const create = {
    summary: '新增服务',
    kind: 'create',
    root: 'backend',
    file: createdFile,
    content,
  };
  const target = path.join(backend, createdFile);
  const backupPath = path.join(TMP, 'backups', 'create.orig');
  const applied = await applyFix({ fix: create, roots, backupPath });
  assert.equal(applied.created, true);
  assert.equal(await readFile(target, 'utf8'), content);
  await revertFix({ fix: create, roots, backupPath });
  await assert.rejects(stat(target), /ENOENT/);
});

test('deletes a file and restores it on revert', async (t) => {
  const { file, roots } = await fixture(t);
  const { createHash } = await import('node:crypto');
  const baseHash = createHash('sha256').update(await readFile(file)).digest('hex');
  const remove = {
    summary: '删除旧文件',
    kind: 'delete',
    root: 'backend',
    file: FILE,
    baseHash,
  };
  const backupPath = path.join(TMP, 'backups', 'delete.orig');
  const applied = await applyFix({ fix: remove, roots, backupPath });
  assert.equal(applied.deleted, true);
  await assert.rejects(stat(file), /ENOENT/);
  await revertFix({ fix: remove, roots, backupPath });
  assert.equal(await readFile(file, 'utf8'), ORIGINAL);
});

test('refuses to apply a patch when the base hash no longer matches', async (t) => {
  const { roots } = await fixture(t);
  const stale = { ...fix, baseHash: 'not-the-current-hash' };
  await assert.rejects(
    applyFix({ fix: stale, roots, backupPath: path.join(TMP, 'backups', 'stale.orig') }),
    /文件在诊断后已被修改/,
  );
});
