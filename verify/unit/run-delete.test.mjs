import test from 'node:test';
import assert from 'node:assert/strict';
import { deleteRunWithWorkspacePolicy } from '../../src/core/run-delete.mjs';

function fakeService({ pending = null, keepResult = { ok: true } } = {}) {
  const calls = [];
  return {
    calls,
    async getRunWorkspacePending() {
      calls.push('getPending');
      return pending;
    },
    async keepRunWorkspace() {
      calls.push('keepJournal');
      return keepResult;
    },
    async deleteRun(runId) {
      calls.push('delete');
      return { runId, deleted: true, databaseQueries: 0 };
    },
  };
}

test('deletes immediately when no workspace changes are pending', async () => {
  const service = fakeService();
  const result = await deleteRunWithWorkspacePolicy({ service, runId: 'run-1' });
  assert.equal(result.deleted, true);
  assert.equal(result.keptWorkspace, false);
  assert.deepEqual(service.calls, ['getPending', 'delete']);
});

test('asks for keep confirmation before deleting a journal-pending run', async () => {
  const service = fakeService({ pending: { kind: 'journal', status: 'pending', files: ['backend/A.java'] } });
  const result = await deleteRunWithWorkspacePolicy({ service, runId: 'run-1' });
  assert.equal(result.requiresKeepConfirmation, true);
  assert.deepEqual(service.calls, ['getPending']);

  const confirmed = await deleteRunWithWorkspacePolicy({
    service,
    runId: 'run-1',
    confirmedKeep: true,
  });
  assert.equal(confirmed.deleted, true);
  assert.equal(confirmed.keptWorkspace, true);
  assert.deepEqual(service.calls, ['getPending', 'getPending', 'keepJournal', 'delete']);
});

test('keeps a live session before deleting and releases it from the map', async () => {
  const calls = [];
  const service = fakeService();
  const workspaceSessions = new Map([['run-live', {
    describeTouchedFiles: () => [{ file: 'backend/A.java' }],
    async keep() { calls.push('liveKeep'); },
  }]]);
  const result = await deleteRunWithWorkspacePolicy({
    service,
    runId: 'run-live',
    workspaceSessions,
    confirmedKeep: true,
  });
  assert.equal(result.deleted, true);
  assert.deepEqual(calls, ['liveKeep']);
  assert.deepEqual(service.calls, ['delete']);
  assert.equal(workspaceSessions.has('run-live'), false);
});

test('does not delete when keeping the workspace fails', async () => {
  const service = fakeService({
    pending: { kind: 'journal', status: 'pending', files: [] },
    keepResult: { ok: false, error: 'lock busy' },
  });
  const result = await deleteRunWithWorkspacePolicy({
    service,
    runId: 'run-1',
    confirmedKeep: true,
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /lock busy/);
  assert.deepEqual(service.calls, ['getPending', 'keepJournal']);
});

test('does not delete when a live session keep throws', async () => {
  const service = fakeService();
  const workspaceSessions = new Map([['run-live', {
    describeTouchedFiles: () => [],
    async keep() { throw new Error('disk full'); },
  }]]);
  const result = await deleteRunWithWorkspacePolicy({
    service,
    runId: 'run-live',
    workspaceSessions,
    confirmedKeep: true,
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /disk full/);
  assert.deepEqual(service.calls, []);
  assert.equal(workspaceSessions.has('run-live'), true);
});
