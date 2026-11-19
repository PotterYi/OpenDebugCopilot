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

test('detects backend tests and keeps build before test', async (t) => {
  await rm(TMP, { recursive: true, force: true });
  const backend = path.join(TMP, 'maven-tests');
  await mkdir(path.join(backend, 'src/test/java'), { recursive: true });
  t.after(async () => { await rm(TMP, { recursive: true, force: true }); });
  await writeFile(path.join(backend, 'pom.xml'), '<project/>', 'utf8');
  const commands = await resolveValidationCommands({
    fixes: [{ ...fix, root: 'backend', file: 'src/A.java' }],
    roots: { sourceRoot: backend },
    projectRoot: TMP,
  });
  assert.equal(commands.length, 2);
  assert.equal(commands[0].phase, 'build');
  assert.match(commands[0].command, /-DskipTests compile/);
  assert.equal(commands[1].phase, 'test');
  assert.match(commands[1].command, /mvn -q test/);
  assert.equal(commands[1].required, false);
});

test('frontend test scripts are hints, not auto-run commands', async (t) => {
  await rm(TMP, { recursive: true, force: true });
  const frontend = path.join(TMP, 'frontend-hints');
  await mkdir(frontend, { recursive: true });
  t.after(async () => { await rm(TMP, { recursive: true, force: true }); });
  await writeFile(path.join(frontend, 'package.json'), JSON.stringify({
    scripts: { build: 'vite build', test: 'vitest' },
  }), 'utf8');
  const { detectValidationPlan } = await import('../../src/core/fix-validation.mjs');
  const plan = await detectValidationPlan({
    roots: { frontendSourceRoot: frontend },
    projectRoot: TMP,
  });
  assert.equal(plan.commands.some((entry) => entry.phase === 'test'), false);
  assert.equal(plan.hints.length, 1);
  assert.match(plan.hints[0].command, /npm test/);
});

test('ordered verifyCommands keep phase and required flags', async (t) => {
  await rm(TMP, { recursive: true, force: true });
  const backend = path.join(TMP, 'ordered');
  await mkdir(backend, { recursive: true });
  t.after(async () => { await rm(TMP, { recursive: true, force: true }); });
  const commands = await resolveValidationCommands({
    fixes: [{ ...fix, root: 'backend', file: 'src/A.java' }],
    roots: { sourceRoot: backend },
    verifyCommands: [
      { command: 'echo build', phase: 'build', required: true },
      { command: 'echo test', phase: 'test', required: true },
    ],
    projectRoot: TMP,
  });
  assert.deepEqual(commands.map((entry) => [entry.phase, entry.required, entry.command]), [
    ['build', true, 'echo build'],
    ['test', true, 'echo test'],
  ]);
});

test('detects Go and Python test commands when tests exist', async (t) => {
  await rm(TMP, { recursive: true, force: true });
  const goRoot = path.join(TMP, 'go-app');
  const pyRoot = path.join(TMP, 'py-app');
  await mkdir(goRoot, { recursive: true });
  await mkdir(pyRoot, { recursive: true });
  t.after(async () => { await rm(TMP, { recursive: true, force: true }); });
  await writeFile(path.join(goRoot, 'go.mod'), 'module demo\n', 'utf8');
  await writeFile(path.join(goRoot, 'main_test.go'), 'package main\n', 'utf8');
  await writeFile(path.join(pyRoot, 'pyproject.toml'), '[tool.pytest.ini_options]\n', 'utf8');

  const go = await resolveValidationCommands({
    fixes: [{ ...fix, root: 'backend', file: 'main.go' }],
    roots: { sourceRoot: goRoot },
    projectRoot: TMP,
  });
  assert.ok(go.some((entry) => entry.phase === 'test' && entry.command === 'go test ./...'));

  const py = await resolveValidationCommands({
    fixes: [{ ...fix, root: 'backend', file: 'app.py' }],
    roots: { sourceRoot: pyRoot },
    projectRoot: TMP,
  });
  assert.ok(py.some((entry) => entry.phase === 'test' && entry.command.includes('pytest')));
});
