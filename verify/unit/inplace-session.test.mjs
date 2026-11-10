import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createInPlaceSession } from '../../src/core/inplace-session.mjs';
import { tempDir } from './tmp.mjs';

const exec = promisify(execFile);
const TMP = tempDir('inplace-session-test');

async function git(repo, args) {
  return (await exec('git', ['-C', repo, ...args], { encoding: 'utf8' })).stdout.trim();
}

async function fixture(t) {
  await rm(TMP, { recursive: true, force: true });
  const repo = path.join(TMP, 'repo');
  const runDir = path.join(TMP, 'run');
  await mkdir(repo, { recursive: true });
  await mkdir(runDir, { recursive: true });
  await git(repo, ['init', '-q']);
  await git(repo, ['config', 'user.email', 'test@example.com']);
  await git(repo, ['config', 'user.name', 'Test']);
  await writeFile(path.join(repo, 'OrderService.java'), 'old\n', 'utf8');
  await git(repo, ['add', '.']);
  await git(repo, ['commit', '-q', '-m', 'base']);
  t.after(async () => { await rm(TMP, { recursive: true, force: true }); });
  return { repo, runDir };
}

async function startSession(repo, runDir, runId = 'run-1') {
  return createInPlaceSession({
    runDir,
    roots: [{ key: 'backend', root: repo }],
    readOnlyRoots: [],
    runId,
    verifyCommand: '',
    projectRoot: repo,
  });
}

test('in-place session snapshots, extracts and discards to the pre-run content', async (t) => {
  const { repo, runDir } = await fixture(t);
  const file = path.join(repo, 'OrderService.java');
  const session = await startSession(repo, runDir);
  assert.equal(session.ok, true, JSON.stringify(session));
  await session.onBeforeWrite({ filePath: file });
  await writeFile(file, 'new\n', 'utf8');
  await session.onAfterWrite({ filePath: file });
  const extracted = await session.extract();
  assert.equal(extracted.fixes.length, 1);
  assert.equal(extracted.fixes[0].search, 'old\n');
  assert.equal(extracted.fixes[0].replace, 'new\n');
  assert.match(extracted.fixes[0].preview.patch, /\+new/);
  const discarded = await session.discard();
  assert.deepEqual(discarded.conflicts, []);
  assert.equal(await readFile(file, 'utf8'), 'old\n');
});

test('discard preserves a pre-run uncommitted change instead of HEAD', async (t) => {
  const { repo, runDir } = await fixture(t);
  const file = path.join(repo, 'OrderService.java');
  await writeFile(file, 'user-dirty\n', 'utf8');
  const session = await startSession(repo, runDir);
  await session.onBeforeWrite({ filePath: file });
  await writeFile(file, 'agent-change\n', 'utf8');
  await session.onAfterWrite({ filePath: file });
  const extracted = await session.extract();
  assert.equal(extracted.fixes[0].search, 'user-dirty\n');
  await session.discard();
  assert.equal(await readFile(file, 'utf8'), 'user-dirty\n');
});

test('overlapping sessions on the same repo degrade as busy', async (t) => {
  const { repo, runDir } = await fixture(t);
  const first = await startSession(repo, runDir, 'run-a');
  assert.equal(first.ok, true);
  const second = await startSession(repo, runDir, 'run-b');
  assert.equal(second.ok, false);
  assert.equal(second.reason, 'busy');
  await first.discard();
  const third = await startSession(repo, runDir, 'run-c');
  assert.equal(third.ok, true);
  await third.discard();
});

test('external edits after the agent write are reported as conflicts', async (t) => {
  const { repo, runDir } = await fixture(t);
  const file = path.join(repo, 'OrderService.java');
  const session = await startSession(repo, runDir);
  await session.onBeforeWrite({ filePath: file });
  await writeFile(file, 'agent\n', 'utf8');
  await session.onAfterWrite({ filePath: file });
  await writeFile(file, 'user-edited-after\n', 'utf8');
  const extracted = await session.extract();
  assert.equal(extracted.fixes.length, 0);
  assert.equal(extracted.conflicts.length, 1);
  const discarded = await session.discard();
  assert.equal(discarded.conflicts.length, 1);
  assert.equal(await readFile(file, 'utf8'), 'user-edited-after\n');
});

test('diagnosis keeps the in-place workspace pending for user decision', async (t) => {
  const { repo, runDir } = await fixture(t);
  const file = path.join(repo, 'OrderService.java');
  const agent = {
    id: 'inplace-agent',
    scope: null,
    configureScope(next) { this.scope = next; },
    async diagnose() {
      await this.scope.onBeforeWrite({ filePath: file });
      await writeFile(file, 'agent-edit\n', 'utf8');
      await this.scope.onAfterWrite({ filePath: file });
      return {
        conclusion: '已修改',
        evidenceRefs: [{ type: 'request', ref: 'request' }],
        confidence: 0.8,
        needsMoreInfo: [],
        fixes: [],
      };
    },
  };
  const { runCaptureDiagnosis } = await import('../../src/diagnose/run.mjs');
  const outcome = await runCaptureDiagnosis({
    request: { method: 'GET', url: 'http://localhost/api/order', headers: {}, body: null, startedAt: Date.now() },
    response: { status: 500, statusText: 'Error', ok: false, headers: {}, body: '{}', durationMs: 1 },
    firedAt: Date.now(),
  }, {
    workspace: { sourceRoot: repo, logfiles: [], window: { beforeMs: 1000, afterMs: 1000 }, agent: { toolMode: 'sandbox' } },
    root: TMP,
    runsDir: path.join(TMP, 'runs'),
    agent,
    sandbox: true,
  });
  assert.ok(outcome.workspaceSession, 'missing workspace session');
  assert.equal(outcome.result.agent.workspaceSession.status, 'pending');
  assert.equal(outcome.result.agent.fixes.length, 1);
  assert.equal(outcome.result.agent.fixes[0].workspaceApplied, true);
  assert.equal(await readFile(file, 'utf8'), 'agent-edit\n');
  await outcome.workspaceSession.discard();
  assert.equal(await readFile(file, 'utf8'), 'old\n');
});
