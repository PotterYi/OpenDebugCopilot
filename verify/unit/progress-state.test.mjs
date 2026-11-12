import test from 'node:test';
import assert from 'node:assert/strict';
import { buildProgressView, resolveFollowUpRunId, upsertProgressStep } from '../../src/ui/progress-state.mjs';

test('a done event without label keeps the start label', () => {
  const steps = [];
  upsertProgressStep(steps, { id: 'builtin-1', label: '读取文件…', status: 'start' });
  // Built-in tool completion events historically omitted the tool name.
  upsertProgressStep(steps, { id: 'builtin-1', status: 'done' });
  assert.equal(steps.length, 1);
  assert.equal(steps[0].label, '读取文件…');
  assert.equal(steps[0].status, 'done');
});

test('an empty label never erases an existing one', () => {
  const steps = [];
  upsertProgressStep(steps, { id: 'tool-1', label: '查询日志…', status: 'start', detail: 'get_logs' });
  upsertProgressStep(steps, { id: 'tool-1', label: '', status: 'done' });
  assert.equal(steps[0].label, '查询日志…');
  assert.equal(steps[0].detail, 'get_logs');
});

test('deduplicates by id and caps the list', () => {
  const steps = [];
  for (let i = 0; i < 50; i += 1) {
    upsertProgressStep(steps, { id: `step-${i}`, label: `step ${i}`, status: 'start' });
  }
  upsertProgressStep(steps, { id: 'step-25', label: 'updated', status: 'done' });
  assert.equal(steps.length, 40);
  assert.ok(steps.some((step) => step.id === 'step-25' && step.label === 'updated'));
});

test('keeps the active step in a pinned footer and trims old steps', () => {
  const steps = [];
  for (let i = 0; i < 15; i += 1) {
    steps.push({ id: `done-${i}`, label: `done ${i}`, status: 'done' });
  }
  steps.push({ id: 'active', label: '读取文件', status: 'start' });

  const view = buildProgressView(steps, {
    running: true,
    startedAt: 1_000,
    now: 13_000,
    timeoutMs: 600_000,
  });
  assert.equal(view.hiddenCount, 5);
  assert.equal(view.visibleSteps.length, 10);
  assert.ok(!view.visibleSteps.some((step) => step.id === 'active'));
  assert.deepEqual(view.footer, {
    label: '读取文件…',
    elapsedSec: 12,
    timeoutSec: 600,
  });
});

test('shows a generic thinking footer when no step is active', () => {
  const view = buildProgressView(
    [{ id: 'prepare', label: '整理请求与证据', status: 'done' }],
    { running: true, startedAt: 0, now: 5_000 },
  );
  assert.deepEqual(view.footer, {
    label: 'AI 正在思考…',
    elapsedSec: 5,
    timeoutSec: null,
  });
});

test('does not add a footer when the run is not running', () => {
  const view = buildProgressView(
    [{ id: 'error', label: '诊断失败', status: 'error' }],
    { running: false },
  );
  assert.equal(view.footer, null);
  assert.equal(view.visibleSteps.length, 1);
  assert.equal(view.hiddenCount, 0);
});

test('routes legacy follow-up progress without runId when unambiguous', () => {
  const states = new Map([
    ['run-a', { status: 'running' }],
    ['run-b', { status: 'done' }],
  ]);
  assert.equal(resolveFollowUpRunId({ id: 'prepare' }, states), 'run-a');
  assert.equal(resolveFollowUpRunId({ id: 'prepare', runId: 'run-b' }, states), 'run-b');

  states.set('run-c', { status: 'running' });
  assert.equal(resolveFollowUpRunId({ id: 'prepare' }, states), '');
});
