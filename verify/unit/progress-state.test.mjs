import test from 'node:test';
import assert from 'node:assert/strict';
import { upsertProgressStep } from '../../src/ui/progress-state.mjs';

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
