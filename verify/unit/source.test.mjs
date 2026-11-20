import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { readSource, searchSource, validateRegexPattern } from '../../src/evidence/source.mjs';
import { tempDir } from './tmp.mjs';
import iconv from 'iconv-lite';

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

test('reads config files by direct path', async () => {
  const pom = await readSource({ sourceRoot: SOURCE, target: 'pom.xml' });
  assert.equal(pom.found, true);
  assert.match(pom.content, /demo-parent/);
  const yml = await readSource({
    sourceRoot: SOURCE,
    target: 'src/main/resources/application-prod.yml',
  });
  assert.equal(yml.found, true);
  assert.match(yml.content, /CONFIG_ONLY_TOKEN/);
});

test('rejects out-of-root, sensitive and unsupported direct reads', async () => {
  await assert.rejects(
    readSource({ sourceRoot: SOURCE, target: '../outside.java' }),
    (error) => error.code === 'PATH_OUT_OF_SCOPE',
  );
  await assert.rejects(
    readSource({ sourceRoot: SOURCE, target: '.git/config.json' }),
    (error) => error.code === 'SENSITIVE_PATH',
  );
  await assert.rejects(
    readSource({ sourceRoot: SOURCE, target: 'docs/notes.txt' }),
    (error) => error.code === 'SOURCE_FILE_TYPE_UNSUPPORTED',
  );
});

test('searches source by keyword with stable ordering', async () => {
  const result = await searchSource({ sourceRoot: SOURCE, keyword: 'IllegalArgumentException' });
  assert.ok(result.matches.length >= 1);
  assert.equal(result.matches[0].path, 'com/demo/OrderService.java');
  assert.ok(result.matches[0].line > 0);

  const classes = await searchSource({ sourceRoot: SOURCE, keyword: 'class' });
  const paths = classes.matches.map((match) => `${match.path}:${match.line}`);
  assert.deepEqual(paths, [...paths].sort());
});

test('includes config files by default and skips them on request', async () => {
  const included = await searchSource({ sourceRoot: SOURCE, keyword: 'CONFIG_ONLY_TOKEN' });
  assert.deepEqual(included.matches.map((match) => match.path), ['src/main/resources/application-prod.yml']);
  const excluded = await searchSource({ sourceRoot: SOURCE, keyword: 'CONFIG_ONLY_TOKEN', includeConfig: false });
  assert.equal(excluded.matches.length, 0);
});

test('skips lockfiles, minified assets and source maps', async () => {
  for (const keyword of ['LOCKFILE_ONLY_TOKEN', 'MINIFIED_ONLY_TOKEN', 'SOURCEMAP_ONLY_TOKEN']) {
    const result = await searchSource({ sourceRoot: SOURCE, keyword });
    assert.equal(result.matches.length, 0, keyword);
  }
});

test('supports regex and case-sensitive search', async () => {
  const regex = await searchSource({ sourceRoot: SOURCE, keyword: 'Illegal[A-Za-z]+Exception', regex: true });
  assert.ok(regex.matches.length >= 1);
  assert.equal(regex.matches[0].path, 'com/demo/OrderService.java');

  const insensitive = await searchSource({ sourceRoot: SOURCE, keyword: 'ILLEGALARGUMENTEXCEPTION' });
  assert.ok(insensitive.matches.length >= 1);
  const sensitive = await searchSource({
    sourceRoot: SOURCE,
    keyword: 'ILLEGALARGUMENTEXCEPTION',
    caseSensitive: true,
  });
  assert.equal(sensitive.matches.length, 0);
});

test('rejects unsafe or oversized regex patterns', async () => {
  assert.throws(() => validateRegexPattern('(a+)+$'), (error) => error.code === 'SOURCE_REGEX_UNSAFE');
  assert.throws(() => validateRegexPattern('(?<=x)y'), (error) => error.code === 'SOURCE_REGEX_UNSAFE');
  assert.throws(() => validateRegexPattern('a'.repeat(201)), (error) => error.code === 'SOURCE_REGEX_TOO_LONG');
  await assert.rejects(
    searchSource({ sourceRoot: SOURCE, keyword: '(a+)+$', regex: true }),
    (error) => error.code === 'SOURCE_REGEX_UNSAFE',
  );
});

test('regex search returns timedOut instead of hanging', async (t) => {
  const dir = tempDir('source-regex-timeout');
  t.after(async () => { await rm(dir, { recursive: true, force: true }); });
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'Big.java'), `class Big { String s = "${'a'.repeat(20000)}"; }`, 'utf8');
  const result = await searchSource({
    sourceRoot: dir,
    keyword: 'a*a*a*a*a*a*a*a*b',
    regex: true,
    timeoutMs: 10,
  });
  assert.equal(result.timedOut, true);
  assert.equal(result.matches.length, 0);
});

test('reads frontend asset files directly', async () => {
  const result = await readSource({ sourceRoot: SOURCE, target: 'public/index.html' });
  assert.equal(result.found, true);
  assert.match(result.content, /frontend index/);
});

test('reads and searches GBK source files', async (t) => {
  const dir = tempDir('source-gbk-test');
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  t.after(async () => { await rm(dir, { recursive: true, force: true }); });
  const content = 'class GbkService { String message = "订单不存在"; }';
  await writeFile(path.join(dir, 'GbkService.java'), iconv.encode(content, 'gbk'));
  const read = await readSource({ sourceRoot: dir, target: 'GbkService.java' });
  assert.equal(read.found, true);
  assert.match(read.content, /订单不存在/);
  const search = await searchSource({ sourceRoot: dir, keyword: '订单不存在' });
  assert.equal(search.matches.length, 1);
});
