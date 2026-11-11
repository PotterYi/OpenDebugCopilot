import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tempDir } from './tmp.mjs';
import {
  buildFixPreview,
  buildFixPreviews,
  clearProjectMethodIndexCache,
  inspectMissingMethods,
  mergeExtractedFixes,
  normalizeFixList,
} from '../../src/core/fixes.mjs';

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
  clearProjectMethodIndexCache();
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

test('rejects a patch that adds log calls without a logger definition', async (t) => {
  const dirs = await fixture(t);
  const fix = await buildFixPreview({
    summary: '加日志',
    root: 'backend',
    file: 'com/demo/OrderService.java',
    search: '        if (order.getQty() <= 0) {',
    replace: '        log.warn("qty invalid: {}", order.getQty());\n        if (order.getQty() <= 0) {',
    risk: 'low',
  }, roots(dirs));
  assert.equal(fix.preview.status, 'error');
  assert.match(fix.preview.message, /logger/);
});

test('allows log calls when the file already declares a logger', async (t) => {
  const dirs = await fixture(t);
  await writeFile(path.join(dirs.backend, 'com/demo/OrderService.java'), [
    'package com.demo;',
    '',
    'import lombok.extern.slf4j.Slf4j;',
    '',
    '@Slf4j',
    'public class OrderService {',
    '    public void create(Order order) {',
    '        if (order.getQty() <= 0) {',
    '            throw new IllegalArgumentException("qty must be positive");',
    '        }',
    '    }',
    '}',
  ].join('\n'), 'utf8');
  const fix = await buildFixPreview({
    summary: '加日志',
    root: 'backend',
    file: 'com/demo/OrderService.java',
    search: '        if (order.getQty() <= 0) {',
    replace: '        log.warn("qty invalid: {}", order.getQty());\n        if (order.getQty() <= 0) {',
    risk: 'low',
  }, roots(dirs));
  assert.equal(fix.preview.status, 'ready');
});

test('rejects @Slf4j when the lombok import is missing', async (t) => {
  const dirs = await fixture(t);
  await writeFile(path.join(dirs.backend, 'com/demo/OrderService.java'), [
    'package com.demo;',
    '',
    '@Slf4j',
    'public class OrderService {',
    '    public void create(Order order) {',
    '        if (order.getQty() <= 0) {',
    '            throw new IllegalArgumentException("qty must be positive");',
    '        }',
    '    }',
    '}',
  ].join('\n'), 'utf8');
  const fix = await buildFixPreview({
    summary: '加日志',
    root: 'backend',
    file: 'com/demo/OrderService.java',
    search: '        if (order.getQty() <= 0) {',
    replace: '        log.warn("qty invalid: {}", order.getQty());\n        if (order.getQty() <= 0) {',
    risk: 'low',
  }, roots(dirs));
  assert.equal(fix.preview.status, 'error');
  assert.match(fix.preview.message, /缺少 import lombok\.extern\.slf4j\.Slf4j/);
});

test('rejects a logger symbol that the file does not define', async (t) => {
  const dirs = await fixture(t);
  await writeFile(path.join(dirs.backend, 'com/demo/OrderService.java'), [
    'package com.demo;',
    '',
    'import lombok.extern.slf4j.Slf4j;',
    '',
    '@Slf4j',
    'public class OrderService {',
    '    public void create(Order order) {',
    '        if (order.getQty() <= 0) {',
    '            throw new IllegalArgumentException("qty must be positive");',
    '        }',
    '    }',
    '}',
  ].join('\n'), 'utf8');
  const fix = await buildFixPreview({
    summary: '加日志',
    root: 'backend',
    file: 'com/demo/OrderService.java',
    search: '        if (order.getQty() <= 0) {',
    replace: '        logger.warn("qty invalid: {}", order.getQty());\n        if (order.getQty() <= 0) {',
    risk: 'low',
  }, roots(dirs));
  assert.equal(fix.preview.status, 'error');
  assert.match(fix.preview.message, /没有定义这个 logger/);
});

test('rejects a call to a method that does not exist anywhere in the project', async (t) => {
  const dirs = await fixture(t);
  const fix = await buildFixPreview({
    summary: '补充库存校验',
    root: 'backend',
    file: 'com/demo/OrderService.java',
    search: '        if (order.getQty() <= 0) {',
    replace: '        order.ensureStockAvailable();\n        if (order.getQty() <= 0) {',
    risk: 'medium',
  }, roots(dirs));
  assert.equal(fix.preview.status, 'error');
  assert.match(fix.preview.message, /ensureStockAvailable/);
});

test('allows a method that is declared elsewhere in the project', async (t) => {
  const dirs = await fixture(t);
  await writeFile(path.join(dirs.backend, 'com/demo/StockService.java'), [
    'package com.demo;',
    '',
    'public class StockService {',
    '    public void ensureStockAvailable() {',
    '    }',
    '}',
  ].join('\n'), 'utf8');
  clearProjectMethodIndexCache();
  const fix = await buildFixPreview({
    summary: '补充库存校验',
    root: 'backend',
    file: 'com/demo/OrderService.java',
    search: '        if (order.getQty() <= 0) {',
    replace: '        order.ensureStockAvailable();\n        if (order.getQty() <= 0) {',
    risk: 'medium',
  }, roots(dirs));
  assert.equal(fix.preview.status, 'ready');
});

test('allows a method added in the same patch', async (t) => {
  const dirs = await fixture(t);
  const issue = await inspectMissingMethods({
    original: 'class A {\n}\n',
    updated: 'class A {\n    void helper() {\n    }\n    void run() {\n        helper();\n    }\n}\n',
    replacement: '    void run() {\n        helper();\n    }\n',
    sourceRoot: dirs.backend,
  });
  assert.equal(issue, null);
});

test('warn mode keeps logger/method issues as warnings instead of blocking', async (t) => {
  const dirs = await fixture(t);
  const fix = await buildFixPreview({
    summary: '加日志',
    root: 'backend',
    file: 'com/demo/OrderService.java',
    search: '        if (order.getQty() <= 0) {',
    replace: '        log.warn("qty invalid");\n        if (order.getQty() <= 0) {',
    risk: 'low',
  }, { ...roots(dirs), staticChecks: 'warn' });
  assert.equal(fix.preview.status, 'ready');
  assert.ok(fix.preview.warnings.some((warning) => /logger/.test(warning)));
});

test('previews and applies create/delete/baseHash fixes', async (t) => {
  const dirs = await fixture(t);
  const created = await buildFixPreview({
    summary: '新增文件',
    kind: 'create',
    root: 'backend',
    file: 'com/demo/NewService.java',
    content: 'package com.demo;\n\npublic class NewService {\n}\n',
  }, roots(dirs));
  assert.equal(created.preview.status, 'ready');
  assert.match(created.preview.patch, /^--- \/dev\/null\n\+\+\+ b\/com\/demo\/NewService\.java/m);
  assert.match(created.preview.patch, /\+public class NewService/);

  const { createHash } = await import('node:crypto');
  const original = await readFile(path.join(dirs.backend, 'com/demo/OrderService.java'));
  const hash = createHash('sha256').update(original).digest('hex');
  const removed = await buildFixPreview({
    summary: '删除文件',
    kind: 'delete',
    root: 'backend',
    file: 'com/demo/OrderService.java',
    baseHash: hash,
  }, roots(dirs));
  assert.equal(removed.preview.status, 'ready');
  assert.match(removed.preview.patch, /^\+\+\+ \/dev\/null/m);

  const stale = await buildFixPreview({
    summary: '旧补丁',
    root: 'backend',
    file: 'com/demo/OrderService.java',
    search: '        if (order.getQty() <= 0) {',
    replace: '        if (order.getQty() < 0) {',
    baseHash: 'stale',
  }, roots(dirs));
  assert.equal(stale.preview.status, 'error');
  assert.match(stale.preview.message, /文件在诊断后已被修改/);
});

test('keeps extra-root suggestions when workspace edits replace the fix list', () => {
  const merged = mergeExtractedFixes(
    [{ summary: 'workspace', root: 'backend', file: 'A.java' }],
    [
      { summary: 'extra', root: 'extra', extraRoot: 'extra-1', file: 'B.java' },
      { summary: 'agent backend', root: 'backend', file: 'C.java' },
    ],
  );
  assert.deepEqual(merged.map((fix) => fix.summary), ['extra', 'workspace']);
  assert.equal(merged[0].extraRoot, 'extra-1');
});
