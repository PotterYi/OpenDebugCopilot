import test from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import {
  CLAUDE_SETTING_SOURCES,
  buildFollowUpPrompt,
  buildToolShapes,
  createClaudeAgent,
  redactToolOutputHook,
  usageFromResult,
  validationStrategyPrompt,
} from '../../src/agent/claude.mjs';
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

test('follow-up snapshot carries validation output, withheld fixes and sandbox skips', () => {
  const prompt = buildFollowUpPrompt('继续修', {
    agent: {
      conclusion: '未通过编译',
      fixes: [],
      fixesWithheld: [{
        summary: '修改订单服务',
        root: 'backend',
        file: 'OrderService.java',
        risk: 'medium',
        preview: { status: 'ready', patch: '+ log.info("x");' },
      }],
      fixesValidation: {
        status: 'failed',
        ok: false,
        error: '编译自测失败：mvn compile',
        commands: [{ command: 'mvn compile', ok: false, exitCode: 1 }],
        output: 'ERROR OrderService.java:12 cannot find symbol log',
      },
      sandbox: {
        changedFiles: ['backend/OrderService.java'],
        skipped: [{ file: 'frontend/package.json', reason: '沙箱新增文件暂不支持自动提取' }],
      },
      needsMoreInfo: ['上次未通过编译'],
    },
  });
  assert.match(prompt, /fixesValidation/);
  assert.match(prompt, /cannot find symbol log/);
  assert.match(prompt, /fixesWithheld/);
  assert.match(prompt, /OrderService\.java/);
  assert.match(prompt, /沙箱新增文件暂不支持自动提取/);
  assert.match(prompt, /mvn compile/);
});

test('validation strategy is compile-first in sandbox/full and static in readonly', () => {
  assert.match(validationStrategyPrompt('sandbox'), /编译优先/);
  assert.match(validationStrategyPrompt('full'), /直到通过为止/);
  assert.match(validationStrategyPrompt('readonly'), /静态兜底/);
  assert.doesNotMatch(validationStrategyPrompt('readonly'), /编译优先/);
});

test('loads user settings so Claude Code auth/base URL are available', () => {
  assert.deepEqual([...CLAUDE_SETTING_SOURCES], ['user']);
  assert.notEqual(CLAUDE_SETTING_SOURCES.length, 0);
});

test('PostToolUse hook redacts secrets from built-in tool output', async () => {
  const output = await redactToolOutputHook({
    hook_event_name: 'PostToolUse',
    tool_response: {
      content: 'ANTHROPIC_AUTH_TOKEN=abcdef123456',
      rows: [{ id: 1, password: 'hunter2secret', note: 'keep me' }],
    },
  });
  assert.equal(output.hookSpecificOutput.hookEventName, 'PostToolUse');
  assert.equal(output.hookSpecificOutput.updatedToolOutput.content, 'ANTHROPIC_AUTH_TOKEN=<redacted>');
  assert.equal(output.hookSpecificOutput.updatedToolOutput.rows[0].password, '<redacted>');
  assert.equal(output.hookSpecificOutput.updatedToolOutput.rows[0].note, 'keep me');

  const ignored = await redactToolOutputHook({ hook_event_name: 'PreToolUse' });
  assert.equal(ignored.continue, true);
  assert.equal(ignored.hookSpecificOutput, undefined);
});

test('follow-up prompt snapshots are redacted before reaching the model', () => {
  const prompt = buildFollowUpPrompt('继续诊断', {
    request: {
      method: 'POST',
      url: 'http://localhost/api/login',
      headers: { authorization: 'Bearer abcdefghijklmnopqrstuvwxyz' },
      body: 'token=abcdef123456',
    },
    response: { status: 401, body: 'password="hunter2secret"' },
    logs: { records: [{ message: 'api-key: sk-ant-api03-abcdefghijklmnopqrstuvwxyz' }] },
  });
  assert.doesNotMatch(prompt, /abcdef123456|hunter2secret|abcdefghijklmnopqrstuvwxyz/);
  assert.match(prompt, /<redacted>/);
});
