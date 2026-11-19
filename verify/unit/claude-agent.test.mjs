import test from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { MAX_TOOL_RESULT_BYTES } from '../../src/core/tool-limits.mjs';
import {
  CLAUDE_SETTING_SOURCES,
  buildCachedSystemPrompt,
  buildFollowUpPrompt,
  buildPrompt,
  buildRepairPrompt,
  buildToolShapes,
  turnUsageFromMessage,
  createClaudeAgent,
  redactToolOutputHook,
  sdkAuthOptions,
  toolResultText,
  usageFromResult,
  validationStrategyPrompt,
} from '../../src/agent/claude.mjs';
import { toolSpecs } from '../../src/tools/index.mjs';

test('puts triage answers at the start of the diagnosis prompt', () => {
  const triage = {
    asked: true,
    skipped: false,
    answers: { environment: 'deploy-only', scope: 'endpoint', change: 'dependency' },
    labels: {
      environment: '仅部署环境复现',
      scope: '仅当前接口/页面',
      change: '依赖或版本升级',
    },
    note: '升级后出现',
    askedAt: '2026-11-14T10:00:00.000Z',
  };
  const prompt = buildPrompt('下单失败', { symptom: { question: '下单失败' }, triage });
  assert.match(prompt, /# 诊断前确认/);
  assert.match(prompt, /仅部署环境复现/);
  assert.match(prompt, /升级后出现/);
  assert.match(prompt, /不要重复询问已经回答的问题/);
  assert.ok(prompt.indexOf('# 诊断前确认') < prompt.indexOf('# 已采集的证据包'));

  const follow = buildFollowUpPrompt('继续分析', {
    meta: { question: '下单失败', triage },
    agent: { conclusion: '旧结论' },
  });
  assert.match(follow, /仅部署环境复现/);
});

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
      'deepseek-flash': {
        inputTokens: 100,
        outputTokens: 40,
        cacheReadInputTokens: 20,
        cacheCreationInputTokens: 0,
        provider: 'gateway',
        canonicalModel: 'deepseek-flash',
        costBasis: 'unknown',
      },
      'claude-b': {
        inputTokens: 60,
        outputTokens: 10,
        cacheReadInputTokens: 4,
        cacheCreationInputTokens: 1,
        provider: 'firstParty',
        costBasis: 'list',
      },
    },
  }, {
    turns: [{ id: 'm1', inputTokens: 1, outputTokens: 2, cacheReadInputTokens: 3, cacheCreationInputTokens: 0 }],
  });
  assert.equal(fromModels.numTurns, 7);
  assert.equal(fromModels.inputTokens, 160);
  assert.equal(fromModels.outputTokens, 50);
  assert.equal(fromModels.totalInputTokens, 160 + 24 + 1);
  assert.equal(fromModels.totalTokens, 160 + 24 + 1 + 50);
  assert.equal(fromModels.provider, 'gateway');
  assert.equal(fromModels.canonicalModel, 'deepseek-flash');
  assert.equal(fromModels.costEstimated, true);
  assert.equal(fromModels.models.length, 2);
  assert.equal(fromModels.models[0].provider, 'gateway');
  assert.deepEqual(fromModels.perTurn, [
    { id: 'm1', inputTokens: 1, outputTokens: 2, cacheReadInputTokens: 3, cacheCreationInputTokens: 0 },
  ]);

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

test('builds a structured repair prompt with redaction', () => {
  const prompt = buildRepairPrompt({
    phase: 'sandbox-self-check',
    status: 'failed',
    error: 'mvn compile failed',
    errorLines: ['OrderService.java:12: error: cannot find symbol'],
    outputTail: 'password=hunter2secret',
    commands: [{ command: 'mvn compile', exitCode: 1 }],
    changedFiles: ['backend/src/OrderService.java'],
  }, {
    meta: { question: '下单失败' },
    agent: { conclusion: '旧结论', fixes: [{ summary: '旧修复' }] },
  });
  assert.match(prompt, /# 自动修复回合/);
  assert.match(prompt, /OrderService\.java:12/);
  assert.match(prompt, /password=<redacted>/);
  assert.match(prompt, /不要重复尝试/);
  assert.doesNotMatch(prompt, /hunter2secret/);
});

test('extracts per-turn usage and builds a cacheable system prompt', () => {
  const turn = turnUsageFromMessage({
    type: 'assistant',
    message: {
      id: 'msg-1',
      model: 'deepseek-flash',
      usage: {
        input_tokens: 10,
        output_tokens: 4,
        cache_read_input_tokens: 100,
        cache_creation_input_tokens: 0,
        cache_creation: { ephemeral_5m_input_tokens: 2 },
      },
    },
  });
  assert.equal(turn.id, 'msg-1');
  assert.equal(turn.model, 'deepseek-flash');
  assert.equal(turn.cacheReadInputTokens, 100);
  assert.equal(turn.cacheCreationInputTokens, 0);
  assert.equal(turn.cacheCreationEphemeral5mInputTokens, 2);

  const prompt = buildCachedSystemPrompt('static rules', 'dynamic workspace', 'BOUNDARY');
  assert.deepEqual(prompt, ['static rules', 'BOUNDARY', 'dynamic workspace']);
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
      verification: {
        status: 'failed',
        mode: 'full',
        error: '编译/测试验证失败：mvn compile',
        commands: [{ command: 'mvn compile', ok: false }],
      },
      needsMoreInfo: ['上次未通过编译'],
    },
  });
  assert.match(prompt, /fixesValidation/);
  assert.match(prompt, /cannot find symbol log/);
  assert.match(prompt, /fixesWithheld/);
  assert.match(prompt, /OrderService\.java/);
  assert.match(prompt, /沙箱新增文件暂不支持自动提取/);
  assert.match(prompt, /"verification"/);
  assert.match(prompt, /编译\/测试验证失败：mvn compile/);
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

test('sdkAuthOptions keeps user settings by default and injects app credentials', () => {
  const defaults = sdkAuthOptions(null);
  assert.deepEqual(defaults.settingSources, ['user']);
  assert.equal(defaults.env, undefined);

  const custom = sdkAuthOptions({
    settingSources: [],
    env: {
      ANTHROPIC_AUTH_TOKEN: 'sk-ant-test-token',
      ANTHROPIC_BASE_URL: 'https://gateway.example.com',
    },
  });
  assert.deepEqual(custom.settingSources, []);
  assert.equal(custom.env.ANTHROPIC_AUTH_TOKEN, 'sk-ant-test-token');
  assert.equal(custom.env.ANTHROPIC_BASE_URL, 'https://gateway.example.com');
  // env replaces the whole subprocess environment, so process.env must survive.
  assert.equal(custom.env.PATH, process.env.PATH);
});

test('tool result serialization never silently drops an oversized result', () => {
  const small = toolResultText({ text: 'ok' });
  assert.doesNotMatch(small, /TOOL_RESULT_UNSPILLED/);

  const oversized = toolResultText({ text: 'x'.repeat(MAX_TOOL_RESULT_BYTES) });
  assert.match(oversized, /TOOL_RESULT_UNSPILLED/);
  assert.match(oversized, /no evidence pointer/);
});
