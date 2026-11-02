import test from 'node:test';
import assert from 'node:assert/strict';
import { newRunId } from '../../src/core/ids.mjs';

test('run id is sortable and unique', () => {
  const a = newRunId(new Date('2026-11-02T19:30:12.345Z'));
  const b = newRunId(new Date('2026-11-02T19:30:12.345Z'));
  assert.match(a, /^20261102-193012-[0-9a-f]{6}$/);
  assert.notEqual(a, b);
});

test('run ids increase with time', () => {
  const early = newRunId(new Date('2026-11-02T19:30:12Z'));
  const late = newRunId(new Date('2026-11-02T19:30:13Z'));
  assert.ok(early.slice(0, 15) < late.slice(0, 15));
});
