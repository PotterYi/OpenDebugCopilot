import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tempDir } from './tmp.mjs';
import { normalizeFixList, buildFixPreview, buildFixPreviews } from '../../src/core/fixes.mjs';

const TMP = tempDir('fixes-test');

async function fixture(t) {
  await rm(TMP, { recursive: true, force: true });
  t.after(async () => { await rm(TMP, { recursive: true, force: true }); });
  const backend = path.join(TMP, 'backend');
  const frontend = path.join(TMP, 'frontend');
  await mkdir(path.join(backend, 'com/demo'), { recursive: true });
  await mkdir(path.join(frontend, 'src'), { recursive: true });
  await writeFile(path.join(backend, 'com/demo/OrderService.java'), [
    'package com.demo;',
    '',
    'public class OrderService {',
    '    public void create(Order order) {',
    '        if (order.getQty() <= 0) {',
    '            throw new IllegalArgumentException("qty must be positive");',
    '        }',
    '    }',
    '}',
  ].join('\n'), 'utf8');
  await writeFile(path.join(frontend, 'src/App.vue'), [
    '<template>',
    '  <div>Hello</div>',
    '</template>',
  ].join('\n'), 'utf8');
  return { backend, frontend };
}

const roots = (dirs) => ({ sourceRoot: dirs.backend, frontendSourceRoot: dirs.frontend });

test('normalizes strings and structured fixes', () => {
  const fixes = normalizeFixList([
    '增加库存校验',
    {
      summary: '防御空数量',
      root: 'backend',
      file: 'com/demo/OrderService.java',
      search: 'if (order.getQty() <= 0) {',
      replace: 'if (order.getQty() == null || order.getQty() <= 0) {',
      risk: 'low',
      verification: '运行单测',
    },
  ]);
  assert.equal(fixes.length, 2);
  assert.equal(fixes[0].kind, 'text');
  assert.equal(fixes[1].kind, 'edit');
  assert.equal(fixes[1].risk, 'low');
});

test('builds a line-numbered diff for a unique search snippet', async (t) => {
  const dirs = await fixture(t);
  const fix = await buildFixPreview({
    summary: '防御空数量',
    root: 'backend',
    file: 'com/demo/OrderService.java',
    search: '        if (order.getQty() <= 0) {',
    replace: '        if (order.getQty() == null || order.getQty() <= 0) {',
    risk: 'low',
  }, roots(dirs));
  assert.equal(fix.preview.status, 'ready');
  assert.equal(fix.preview.line, 5);
  assert.match(fix.preview.patch, /^--- a\/com\/demo\/OrderService\.java/m);
  assert.match(fix.preview.patch, /^-        if \(order\.getQty\(\) <= 0\) \{/m);
  assert.match(fix.preview.patch, /^\+        if \(order\.getQty\(\) == null \|\| order\.getQty\(\) <= 0\) \{/m);
});

test('rejects missing and ambiguous search snippets', async (t) => {
  const dirs = await fixture(t);
  const missing = await buildFixPreview({
    summary: '不存在', root: 'backend', file: 'com/demo/OrderService.java',
    search: 'not-in-file', replace: 'x', risk: 'low',
  }, roots(dirs));
  assert.equal(missing.preview.status, 'error');
  assert.match(missing.preview.message, /未在文件中找到/);

  const ambiguous = await buildFixPreview({
    summary: '重复', root: 'backend', file: 'com/demo/OrderService.java',
    search: 'public', replace: 'protected', risk: 'low',
  }, roots(dirs));
  assert.equal(ambiguous.preview.status, 'error');
  assert.match(ambiguous.preview.message, /出现 2 次/);
});

test('rejects path traversal and ambiguous roots', async (t) => {
  const dirs = await fixture(t);
  const traversal = await buildFixPreview({
    summary: '越界', root: 'backend', file: '../secret.txt',
    search: 'x', replace: 'y', risk: 'high',
  }, roots(dirs));
  assert.equal(traversal.preview.status, 'error');
  assert.match(traversal.preview.message, /越出源码目录/);

  await mkdir(path.join(dirs.frontend, 'com/demo'), { recursive: true });
  await writeFile(path.join(dirs.frontend, 'com/demo/OrderService.java'), 'same\n', 'utf8');
  const ambiguous = await buildFixPreview({
    summary: '同名', file: 'com/demo/OrderService.java',
    search: 'same', replace: 'changed', risk: 'low',
  }, roots(dirs));
  assert.equal(ambiguous.preview.status, 'error');
  assert.match(ambiguous.preview.message, /指定 root/);
});

test('resolves frontend files and matches CRLF sources', async (t) => {
  const dirs = await fixture(t);
  await writeFile(path.join(dirs.frontend, 'src/App.vue'), '<template>\r\n  <div>Hi</div>\r\n</template>\r\n', 'utf8');
  const fix = await buildFixPreview({
    summary: '改文案', root: 'frontend', file: 'src/App.vue',
    search: '  <div>Hi</div>', replace: '  <div>Hello</div>', risk: 'low',
  }, roots(dirs));
  assert.equal(fix.preview.status, 'ready');
  assert.equal(fix.root, 'frontend');
  assert.match(fix.preview.patch, /^\+  <div>Hello<\/div>/m);
});

test('text-only fixes and the preview cap are explicit', async (t) => {
  const dirs = await fixture(t);
  const text = await buildFixPreview({ summary: '增加校验', risk: 'low' }, roots(dirs));
  assert.equal(text.preview.status, 'no-edit');

  const many = await buildFixPreviews(
    Array.from({ length: 7 }, (_, index) => ({ summary: `fix ${index}`, risk: 'low' })),
    { ...roots(dirs), maxFixes: 3 },
  );
  assert.equal(many[2].preview.status, 'no-edit');
  assert.equal(many[3].preview.status, 'skipped');
});

test('previews fixes in an authorized additional backend root', async (t) => {
  const dirs = await fixture(t);
  const extraRoot = path.join(TMP, 'extra-backend');
  await mkdir(path.join(extraRoot, 'com/demo'), { recursive: true });
  await writeFile(path.join(extraRoot, 'com/demo/Other.java'), 'class Other {\n    int value = 1;\n}\n', 'utf8');
  const rootsWithExtra = {
    ...roots(dirs),
    extraSourceRoots: [{ id: 'extra-1', root: extraRoot }],
  };

  const fix = await buildFixPreview({
    summary: '修改其他后端',
    root: 'extra',
    extraRoot: 'extra-1',
    file: 'com/demo/Other.java',
    search: '    int value = 1;',
    replace: '    int value = 2;',
    risk: 'medium',
  }, rootsWithExtra);
  assert.equal(fix.preview.status, 'ready');
  assert.equal(fix.root, 'extra');
  assert.equal(fix.extraRoot, 'extra-1');

  const unauthorized = await buildFixPreview({
    summary: '未授权',
    root: 'extra',
    extraRoot: 'extra-1',
    file: 'com/demo/Other.java',
    search: '    int value = 1;',
    replace: '    int value = 2;',
    risk: 'medium',
  }, roots(dirs));
  assert.equal(unauthorized.preview.status, 'error');
  assert.match(unauthorized.preview.message, /未授权|无效/);
});
