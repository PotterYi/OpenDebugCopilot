import test from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { buildToolShapes, createClaudeAgent } from '../../src/agent/claude.mjs';
import { toolSpecs } from '../../src/tools/index.mjs';

test('creates the live Claude agent adapter without spawning', () => {
  const agent = createClaudeAgent({ model: 'claude-sonnet-5', maxTurns: 12 });
  assert.equal(agent.id, 'claude');
  assert.equal(typeof agent.diagnose, 'function');
});

test('every tool spec has a zod shape, including database tools', () => {
  const specs = toolSpecs({
    databases: [{ id: 'db-1', name: 'local', allowWrite: true }],
  });
  const shapes = buildToolShapes(z);
  for (const spec of specs) {
    assert.ok(shapes[spec.name], `missing schema for ${spec.name}`);
  }
  assert.ok(shapes.query_db);
  assert.ok(shapes.write_db);
  assert.deepEqual(shapes.query_db.sql.safeParse('select 1'), { success: true, data: 'select 1' });
  assert.equal(shapes.query_db.limit.safeParse(1001).success, false);
  assert.equal(shapes.write_db.sql.safeParse('').success, true);
});
