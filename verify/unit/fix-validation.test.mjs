import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { resolveValidationCommands } from '../../src/core/fix-validation.mjs';
import { tempDir } from './tmp.mjs';

const TMP = tempDir('fix-validation-test');

const fix = {
  summary: 'replace',
  kind: 'edit',
  root: 'backend',
  file: 'a.txt',
  search: 'old',
  replace: 'new',
  preview: { status: 'ready' },
};

test('detects Maven, npm and Go build commands from the affected roots', async (t) => {
  await rm(TMP, { recursive: true, force: true });
  await mkdir(path.join(TMP, 'backend'), { recursive: true });
  await mkdir(path.join(TMP, 'frontend'), { recursive: true });
  t.after(async () => { await rm(TMP, { recursive: true, force: true }); });
  await writeFile(path.join(TMP, 'backend', 'pom.xml'), '<project/>', 'utf8');
  await writeFile(path.join(TMP, 'frontend', 'package.json'), JSON.stringify({
    scripts: { build: 'vite build' },
  }), 'utf8');

  const commands = await resolveValidationCommands({
    fixes: [
      { ...fix, root: 'backend', file: 'src/A.java' },
      { ...fix, root: 'frontend', file: 'src/App.vue' },
    ],
    roots: { sourceRoot: path.join(TMP, 'backend'), frontendSourceRoot: path.join(TMP, 'frontend') },
    projectRoot: TMP,
  });
  assert.equal(commands.length, 2);
  assert.ok(commands.some((entry) => entry.command.includes('mvn') && entry.cwd === path.join(TMP, 'backend')));
  assert.ok(commands.some((entry) => entry.command === 'npm run build' && entry.cwd === path.join(TMP, 'frontend')));
});
