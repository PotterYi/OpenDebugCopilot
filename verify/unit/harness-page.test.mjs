import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HARNESS = path.resolve(HERE, '../manual/e2e-harness.mjs');

test('manual harness page script is syntactically valid', async () => {
  const source = await readFile(HARNESS, 'utf8');
  const fnStart = source.indexOf('function pageHtml');
  const start = source.indexOf('return `', fnStart) + 'return `'.length;
  const end = source.indexOf('`;', start);
  const template = source.slice(start, end);
  const html = new Function(`return \`${template}\`;`)();
  const match = html.match(/<script>([\s\S]*?)<\/script>/);
  assert.ok(match, 'harness page must contain a script block');
  assert.doesNotThrow(() => new Function(match[1]), 'harness page script must parse');
  assert.match(match[1], /String\.fromCharCode\(10\)/);
});
