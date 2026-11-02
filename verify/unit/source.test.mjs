import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readSource, searchSource } from '../../src/evidence/source.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SOURCE = path.resolve(HERE, '../fixtures/source');

test('reads source by fully-qualified class name', async () => {
  const result = await readSource({ sourceRoot: SOURCE, target: 'com.demo.OrderService' });
  assert.equal(result.found, true);
  assert.equal(result.relativePath, 'com/demo/OrderService.java');
  assert.match(result.content, /class OrderService/);
});

test('reads source by relative path with line range', async () => {
  const result = await readSource({
    sourceRoot: SOURCE,
    target: 'com/demo/OrderService.java',
    startLine: 3,
    endLine: 6,
  });
  assert.equal(result.found, true);
  assert.equal(result.startLine, 3);
  assert.match(result.content, /public void create/);
});

test('ambiguous class names return candidates instead of guessing', async () => {
  const result = await readSource({ sourceRoot: SOURCE, target: 'DupService' });
  assert.equal(result.found, false);
  assert.equal(result.reason, 'ambiguous');
  assert.deepEqual(
    result.candidates.map((candidate) => candidate.path).sort(),
    ['pkg/a/DupService.java', 'pkg/b/DupService.java'],
  );
});

test('missing source returns not-found', async () => {
  const result = await readSource({ sourceRoot: SOURCE, target: 'com.demo.NoSuchClass' });
  assert.equal(result.found, false);
  assert.equal(result.reason, 'not-found');
});

test('searches source by keyword', async () => {
  const result = await searchSource({ sourceRoot: SOURCE, keyword: 'IllegalArgumentException' });
  assert.ok(result.matches.length >= 1);
  assert.equal(result.matches[0].path, 'com/demo/OrderService.java');
  assert.ok(result.matches[0].line > 0);
});
