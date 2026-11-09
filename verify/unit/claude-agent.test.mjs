import test from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { buildToolShapes, createClaudeAgent, usageFromResult } from '../../src/agent/claude.mjs';
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

test('usageFromResult sums modelUsage tokens (including cache) and falls back to usage', () => {
  const fromModels = usageFromResult({
    num_turns: 7,
    total_cost_usd: 0.12,
    duration_ms: 900,
    modelUsage: {
      'claude-a': {
        inputTokens: 100,
        outputTokens: 40,
        cacheReadInputTokens: 20,
        cacheCreationInputTokens: 5,
      },
      'claude-b': {
        inputTokens: 60,
        outputTokens: 10,
        cacheReadInputTokens: 4,
        cacheCreationInputTokens: 1,
      },
    },
  });
  assert.equal(fromModels.numTurns, 7);
  assert.equal(fromModels.inputTokens, 160);
  assert.equal(fromModels.outputTokens, 50);
  assert.equal(fromModels.totalInputTokens, 160 + 24 + 6);
  assert.equal(fromModels.totalTokens, 160 + 24 + 6 + 50);

  const fallback = usageFromResult({
    num_turns: 2,
    usage: {
      input_tokens: 10,
      output_tokens: 5,
      cache_read_input_tokens: 2,
      cache_creation_input_tokens: 1,
    },
  });
  assert.equal(fallback.totalTokens, 18);
});
