import test from 'node:test';
import assert from 'node:assert/strict';
import { createClaudeAgent } from '../../src/agent/claude.mjs';

test('creates the live Claude agent adapter without spawning', () => {
  const agent = createClaudeAgent({ model: 'claude-sonnet-5', maxTurns: 12 });
  assert.equal(agent.id, 'claude');
  assert.equal(typeof agent.diagnose, 'function');
});
