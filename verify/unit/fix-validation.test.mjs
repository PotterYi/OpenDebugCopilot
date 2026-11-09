import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { resolveValidationCommands, validateFixes } from '../../src/core/fix-validation.mjs';
import { tempDir } from './tmp.mjs';

const TMP = tempDir('fix-validation-test');

async function fixture(t, checker) {
  await rm(TMP, { recursive: true, force: true });
  await mkdir(TMP, { recursive: true });
  t.after(async () => { await rm(TMP, { recursive: true, force: true }); });
  await writeFile(path.join(TMP, 'a.txt'), 'old\n', 'utf8');
  await writeFile(path.join(TMP, 'check.mjs'), checker, 'utf8');
  await mkdir(path.join(TMP, 'run'), { recursive: true });
}

const fix = {
  summary: 'replace',
  kind: 'edit',
  root: 'backend',
  file: 'a.txt',
  search: 'old',
  replace: 'new',
  preview: { status: 'ready' },
};

test('applies fixes, runs the configured self-check and always reverts', async (t) => {
  await fixture(t, `import { readFileSync } from 'node:fs';
const text = readFileSync('a.txt', 'utf8');
process.exit(text.includes('new') ? 0 : 1);
`);
  const result = await validateFixes({
    fixes: [fix],
    roots: { sourceRoot: TMP },
    verifyCommand: 'node check.mjs',
    projectRoot: TMP,
    runDir: path.join(TMP, 'run'),
  });
  assert.equal(result.status, 'passed');
  assert.equal(result.applied, 1);
  assert.equal(result.commands.length, 1);
  assert.equal(await readFile(path.join(TMP, 'a.txt'), 'utf8'), 'old\n');
  assert.match(await readFile(path.join(TMP, 'run', 'self-check.log'), 'utf8'), /passed/);
});

test('hides fixes when the self-check command fails', async (t) => {
  await fixture(t, `process.exit(1);\n`);
  const result = await validateFixes({
    fixes: [fix],
    roots: { sourceRoot: TMP },
    verifyCommand: 'node check.mjs',
    projectRoot: TMP,
    runDir: path.join(TMP, 'run'),
  });
  assert.equal(result.status, 'failed');
  assert.match(result.error, /编译自测失败/);
  assert.equal(await readFile(path.join(TMP, 'a.txt'), 'utf8'), 'old\n');
});

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
