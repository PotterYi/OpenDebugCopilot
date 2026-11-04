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
