import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractFrameHints, resolveFrontendSources } from '../../src/evidence/frontend.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FRONTEND_ROOT = path.resolve(HERE, '../fixtures/frontend');

test('extracts frontend stack hints from exceptions', () => {
  const hints = extractFrameHints([
    {
      url: 'http://localhost:5173/src/App.vue',
      line: 7,
      stack: [
        'at submit (http://localhost:5173/src/App.vue:7:9)',
        'at http://localhost:5173/src/main.ts:3:1',
        'at native',
      ],
    },
  ]);
  assert.equal(hints.length, 2);
  assert.deepEqual(hints[0], { url: 'http://localhost:5173/src/App.vue', line: 7, column: 9 });
});

test('maps frontend stack hints to source files', async () => {
  const result = await resolveFrontendSources({
    frontendSourceRoot: FRONTEND_ROOT,
    errors: [
      {
        url: 'http://localhost:5173/src/App.vue',
        line: 7,
        stack: ['at submit (http://localhost:5173/src/App.vue:7:9)'],
      },
    ],
  });
  assert.equal(result.available, true);
  assert.equal(result.files.length, 1);
  assert.equal(result.files[0].path, 'src/App.vue');
  assert.match(result.files[0].content, /throw new Error/);
});

test('falls back to basename and reports unavailable root', async () => {
  const viaBasename = await resolveFrontendSources({
    frontendSourceRoot: FRONTEND_ROOT,
    errors: [{ stack: ['at submit (http://localhost:5173/bundled/App.vue:7:9)'] }],
  });
  assert.equal(viaBasename.files[0].path, 'src/App.vue');

  const unavailable = await resolveFrontendSources({ frontendSourceRoot: null, errors: [] });
  assert.equal(unavailable.available, false);
  assert.deepEqual(unavailable.files, []);
});
