import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { access, mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { gitDiff, gitLog, gitStatus, parseLogOutput, parseStatusV2 } from '../../src/evidence/git.mjs';
import { tempDir } from './tmp.mjs';

const exec = promisify(execFile);

async function gitAvailable() {
  try {
    await exec('git', ['--version'], { timeout: 8000, windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

async function git(dir, args) {
  return exec('git', args, { cwd: dir, timeout: 15000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 });
}

async function createRepo() {
  const dir = tempDir('git-tools-test');
  await rm(dir, { recursive: true, force: true });
  await mkdir(path.join(dir, 'sub'), { recursive: true });
  await git(dir, ['init', '-q']);
  await git(dir, ['config', 'user.email', 'test@example.com']);
  await git(dir, ['config', 'user.name', 'Test User']);
  await writeFile(path.join(dir, 'root.txt'), 'root\n');
  await writeFile(path.join(dir, 'sub/a.txt'), 'a\n');
  await git(dir, ['add', '.']);
  await git(dir, ['commit', '-qm', 'init']);
  return dir;
}

test('parses git status v2 and log output', () => {
  const status = parseStatusV2([
    '# branch.head main',
    '# branch.upstream origin/main',
    '# branch.ab +2 -1',
    '1 .M N... 100644 100644 100644 abc def sub/a.txt',
    '1 M. N... 100644 100644 100644 abc def path with spaces.txt',
    '? new.txt',
    '',
  ].join('\n'));
  assert.equal(status.branch, 'main');
  assert.equal(status.upstream, 'origin/main');
  assert.equal(status.ahead, 2);
  assert.equal(status.behind, 1);
  assert.deepEqual(status.entries.map((entry) => entry.path), ['sub/a.txt', 'path with spaces.txt', 'new.txt']);

  const log = parseLogOutput('abc\x1f2026-11-14\x1fsubject\n\nfile1.txt\nfile2.txt\n\ndef\x1f2026-11-13\x1fsecond\n');
  assert.equal(log.length, 2);
  assert.deepEqual(log[0].files, ['file1.txt', 'file2.txt']);
  assert.equal(log[1].hash, 'def');
});

test('reads status/log/diff from a real repository', { skip: (await gitAvailable()) ? false : 'git is not available' }, async (t) => {
  const dir = await createRepo();
  t.after(async () => { await rm(dir, { recursive: true, force: true }); });

  const clean = await gitStatus({ root: dir });
  assert.equal(clean.clean, true);
  assert.equal(clean.entries.length, 0);

  await writeFile(path.join(dir, 'root.txt'), 'root\npassword=hunter2secret\n');
  await writeFile(path.join(dir, 'sub/new.txt'), 'new\n');

  const status = await gitStatus({ root: dir });
  assert.equal(status.clean, false);
  assert.ok(status.entries.some((entry) => entry.path === 'root.txt'));
  assert.ok(status.entries.some((entry) => entry.path === 'sub/new.txt' && entry.index === '?'));

  const log = await gitLog({ root: dir, limit: 5 });
  assert.ok(log.commits.length >= 1);
  assert.equal(log.commits[0].subject, 'init');
  assert.ok(log.commits[0].files.includes('root.txt'));
  assert.doesNotMatch(JSON.stringify(log), /test@example\.com|Test User/);

  const stat = await gitDiff({ root: dir });
  assert.equal(stat.statOnly, true);
  assert.ok(stat.files.some((file) => file.path === 'root.txt' && file.additions === 1));
  assert.equal(stat.patch, undefined);

  const patch = await gitDiff({ root: dir, path: 'root.txt', statOnly: false });
  assert.match(patch.patch, /password=<redacted>/);
  assert.doesNotMatch(patch.patch, /hunter2secret/);

  await assert.rejects(
    gitDiff({ root: dir, statOnly: false }),
    (error) => error.code === 'DIFF_PATH_REQUIRED',
  );
});

test('hides sensitive paths from status, log and diff', { skip: (await gitAvailable()) ? false : 'git is not available' }, async (t) => {
  const dir = await createRepo();
  t.after(async () => { await rm(dir, { recursive: true, force: true }); });
  await writeFile(path.join(dir, '.env'), 'PASSWORD=hunter2\n');
  await git(dir, ['add', '-f', '.env']);
  await git(dir, ['commit', '-qm', 'add env']);
  await writeFile(path.join(dir, '.env'), 'PASSWORD=changed\n');

  const status = await gitStatus({ root: dir });
  assert.equal(status.entries.some((entry) => entry.path === '.env'), false);
  assert.ok(status.hiddenSensitive >= 1);

  const log = await gitLog({ root: dir, limit: 5 });
  assert.equal(log.commits.some((commit) => commit.files.includes('.env')), false);
  assert.ok(log.hiddenSensitive >= 1);

  const stat = await gitDiff({ root: dir });
  assert.equal(stat.files.some((file) => file.path === '.env'), false);
  assert.ok(stat.hiddenSensitive >= 1);
  await assert.rejects(
    gitDiff({ root: dir, path: '.env', statOnly: false }),
    (error) => error.code === 'SENSITIVE_PATH',
  );
});

test('does not execute configured textconv drivers', { skip: (await gitAvailable()) ? false : 'git is not available' }, async (t) => {
  const dir = await createRepo();
  const marker = path.join(dir, 'textconv-ran.txt');
  const script = path.join(dir, 'evil-textconv.mjs');
  t.after(async () => { await rm(dir, { recursive: true, force: true }); });
  await writeFile(script, `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(marker)}, 'ran');\nprocess.stdout.write('evil');\n`);
  await writeFile(path.join(dir, '.gitattributes'), '*.txt diff=evil\n');
  await git(dir, ['config', 'diff.evil.textconv', `"${process.execPath}" "${script}"`]);
  await writeFile(path.join(dir, 'root.txt'), 'root changed\n');

  const patch = await gitDiff({ root: dir, path: 'root.txt', statOnly: false });
  assert.match(patch.patch, /root changed/);
  await assert.rejects(access(marker), /ENOENT/);
});

test('reports non-git roots clearly', { skip: (await gitAvailable()) ? false : 'git is not available' }, async (t) => {
  const dir = tempDir('git-tools-nongit');
  await mkdir(dir, { recursive: true });
  t.after(async () => { await rm(dir, { recursive: true, force: true }); });
  const previous = process.env.GIT_CEILING_DIRECTORIES;
  process.env.GIT_CEILING_DIRECTORIES = path.dirname(dir);
  try {
    await assert.rejects(gitStatus({ root: dir }), (error) => error.code === 'NOT_A_GIT_REPO');
  } finally {
    if (previous === undefined) delete process.env.GIT_CEILING_DIRECTORIES;
    else process.env.GIT_CEILING_DIRECTORIES = previous;
  }
});
