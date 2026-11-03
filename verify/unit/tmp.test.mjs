import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { PROJECT_ROOT, tempDir } from './tmp.mjs';

test('test temp dirs stay under the project .tmp directory', () => {
  const dir = tempDir('tmp-check');
  assert.equal(path.dirname(dir), path.join(PROJECT_ROOT, '.tmp'));
  assert.ok(dir.startsWith(path.join(PROJECT_ROOT, '.tmp') + path.sep));
});
