import test from 'node:test';
import assert from 'node:assert/strict';
import { buildReport, renderMarkdown } from '../../src/report/report.mjs';

const result = {
  meta: {
    runId: '20261102-120000-abcdef',
    scenario: 'order-create',
    question: '下单失败',
    triage: {
      asked: true,
      skipped: false,
      answers: { environment: 'deploy-only', scope: 'endpoint', change: 'dependency' },
      labels: {
        environment: '仅部署环境复现',
        scope: '仅当前接口/页面',
        change: '依赖或版本升级',
      },
      note: '升级 Spring Boot 后出现',
      askedAt: '2026-11-14T10:00:00.000Z',
    },
    agent: 'claude',
    mode: 'live',
    durationMs: 1234,
    startedAt: 1,
    endedAt: 2,
  },
  target: { driver: 'http', method: 'POST', path: '/api/order' },
  request: {
    method: 'POST',
    url: 'http://127.0.0.1:8080/api/order?env=dev',
    headers: { Authorization: 'Bearer secret-token' },
    body: '{"qty":2}',
  },
  response: { status: 500, headers: { 'set-cookie': 'sid=abc' }, body: '{"error":"boom"}', durationMs: 20 },
  logs: {
    count: 2,
    markerMatched: true,
    records: [{ level: 'ERROR', message: 'secret-log-line', stack: ['at com.demo.X.y(X.java:1)'] }],
  },
  threads: { total: 3 },
  source: { files: [{ path: '/abs/path/OrderService.java', content: 'secret-source-line' }] },
  agent: { conclusion: '库存校验失败', evidenceRefs: [], confidence: 0.8, toolCalls: [{ name: 'get_logs' }] },
  gates: { ok: true, checks: [{ name: 'request-captured', ok: true }, { name: 'conclusion-present', ok: true }] },
  recheck: { runs: 3, verdict: 'consistent', note: '一致不等于正确' },
};

test('report projection keeps whitelisted fields only', () => {
  const report = buildReport(result);
  assert.equal(report.target.scenario, 'order-create');
  assert.equal(report.symptom, '下单失败');
  assert.equal(report.request.path, '/api/order?env=dev');
  assert.equal(report.request.status, 500);
  assert.equal(report.summary.logs, 2);
  assert.equal(report.summary.toolCalls, 1);
  assert.equal(report.request.headers, undefined);
  assert.equal(report.response, undefined);
});

test('renders symptom verification status and steps', () => {
  const withSymptom = {
    ...result,
    gates: { ...result.gates, level: 'verified' },
    symptomCheck: {
      status: 'passed',
      method: 'replay',
      steps: ['重新触发请求：GET /api/order'],
      expected: '原始症状不再出现',
      observed: 'HTTP 200 / code 200',
      reason: 'error-signature-cleared',
    },
  };
  const markdown = renderMarkdown(buildReport(withSymptom));
  assert.match(markdown, /## 症状验证/);
  assert.match(markdown, /已确认症状消失/);
  assert.match(markdown, /自动重放/);
  assert.match(markdown, /HTTP 200 \/ code 200/);
  assert.match(markdown, /已验证（编译\/测试通过 \+ 症状确认）/);
});

test('renders the automatic repair retry section', () => {
  const withRepair = {
    ...result,
    agent: {
      ...result.agent,
      verification: {
        status: 'passed',
        mode: 'copy',
        scope: 'sandbox',
        commands: [{ command: 'mvn -q -DskipTests compile' }],
        repair: {
          attempted: true,
          finalStatus: 'passed',
          failure: {
            error: '编译/测试验证失败',
            errorLines: ['OrderService.java:12: error: cannot find symbol'],
            commands: ['mvn -q -DskipTests compile'],
          },
          budget: { maxRounds: 6, maxBudgetUsd: 1, timeoutMs: 120000 },
          usage: { numTurns: 1, costUsd: 0.01 },
        },
      },
    },
  };
  const markdown = renderMarkdown(buildReport(withRepair));
  assert.match(markdown, /## 修复重试/);
  assert.match(markdown, /重试后通过/);
  assert.match(markdown, /OrderService\.java:12/);
  assert.match(markdown, /\$0\.0100/);
});

test('renders cache, provider and estimated cost details', () => {
  const withUsage = {
    ...result,
    agent: {
      ...result.agent,
      usage: {
        numTurns: 7,
        totalTokens: 1234,
        cacheReadInputTokens: 1000,
        cacheCreationInputTokens: 0,
        provider: 'gateway',
        canonicalModel: 'deepseek-flash',
        costBasis: 'unknown',
        costEstimated: true,
        costUsd: 0.1234,
      },
    },
  };
  const markdown = renderMarkdown(buildReport(withUsage));
  assert.match(markdown, /缓存读\/写：1000 \/ 0/);
  assert.match(markdown, /模型\/供应商：deepseek-flash \/ gateway/);
  assert.match(markdown, /\$0\.1234（估算）/);
});

test('renders the triage answers before the conclusion', () => {
  const markdown = renderMarkdown(buildReport(result));
  const triageAt = markdown.indexOf('## 诊断前提');
  const conclusionAt = markdown.indexOf('## 结论');
  assert.ok(triageAt >= 0, 'triage section should exist');
  assert.ok(conclusionAt > triageAt, 'triage should precede conclusion');
  assert.match(markdown, /仅部署环境复现/);
  assert.match(markdown, /仅当前接口\/页面/);
  assert.match(markdown, /依赖或版本升级/);
  assert.match(markdown, /升级 Spring Boot 后出现/);

  const skipped = {
    ...result,
    meta: {
      ...result.meta,
      triage: { asked: true, skipped: true, answers: {}, labels: {}, note: null, askedAt: '2026-11-14T10:00:00.000Z' },
    },
  };
  assert.match(renderMarkdown(buildReport(skipped)), /未提供（诊断前已跳过）/);
});

test('markdown report excludes absolute paths, headers and raw evidence', () => {
  const markdown = renderMarkdown(buildReport(result));
  assert.match(markdown, /库存校验失败/);
  assert.match(markdown, /\/api\/order\?env=dev/);
  assert.match(markdown, /一致不等于正确/);
  assert.doesNotMatch(markdown, /127\.0\.0\.1/);
  assert.doesNotMatch(markdown, /Bearer/);
  assert.doesNotMatch(markdown, /secret-log-line/);
  assert.doesNotMatch(markdown, /secret-source-line/);
  assert.doesNotMatch(markdown, /set-cookie/);
  assert.doesNotMatch(markdown, /\/abs\/path/);
});

test('scrubs absolute paths and tokens from conclusion text', () => {
  const bs = String.fromCharCode(92);
  const winPath = `G:${bs}develop${bs}project${bs}OrderService.java`;
  const fake = {
    meta: { scenario: 's', question: 'q', durationMs: 1, runId: 'r', agent: 'claude', mode: 'live' },
    target: { driver: 'http' },
    request: { url: 'http://127.0.0.1:8080/api/order', method: 'POST' },
    response: { status: 500 },
    agent: { conclusion: `源码 ${winPath}，令牌 Bearer abc.def，/Users/me/x.java，接口 /api/order` },
    gates: { checks: [] },
  };
  const markdown = renderMarkdown(buildReport(fake));
  assert.equal(markdown.includes(`G:${bs}`), false);
  assert.doesNotMatch(markdown, /\/Users\/me/);
  assert.doesNotMatch(markdown, /Bearer abc\.def/);
  assert.match(markdown, /<path>/);
  assert.match(markdown, /\/api\/order/);
});

test('renders fixes and needsMoreInfo with scrubbing', () => {
  const bs = String.fromCharCode(92);
  const winPath = `G:${bs}tmp${bs}file.java`;
  const withAdvice = {
    ...result,
    agent: {
      ...result.agent,
      fixes: [`修复 ${winPath}`, '增加库存校验'],
      needsMoreInfo: [`补充 ${winPath} 的版本`, '确认库存数据'],
    },
  };
  const markdown = renderMarkdown(buildReport(withAdvice));
  assert.match(markdown, /## 修复建议/);
  assert.match(markdown, /增加库存校验/);
  assert.match(markdown, /## 待补充信息/);
  assert.match(markdown, /确认库存数据/);
  assert.equal(markdown.includes(winPath), false);
});

test('renders structured fix metadata without leaking the raw diff', () => {
  const withFix = {
    ...result,
    agent: {
      ...result.agent,
      fixes: [{
        summary: '防御空数量',
        root: 'backend',
        file: 'com/demo/OrderService.java',
        search: 'secret-source-line',
        replace: 'safe-source-line',
        risk: 'low',
        verification: '运行单测',
        preview: {
          status: 'ready',
          line: 5,
          patch: '--- a/com/demo/OrderService.java\n+++ b/com/demo/OrderService.java\n-secret-source-line\n+safe-source-line',
        },
      }],
    },
  };
  const markdown = renderMarkdown(buildReport(withFix));
  assert.match(markdown, /防御空数量/);
  assert.match(markdown, /com\/demo\/OrderService\.java/);
  assert.match(markdown, /风险：low/);
  assert.match(markdown, /验证：运行单测/);
  assert.equal(markdown.includes('secret-source-line'), false);
  assert.equal(markdown.includes('safe-source-line'), false);
  assert.equal(markdown.includes('-secret-source-line'), false);
});

test('reports the actual correlation method and flags time-window fallback', () => {
  const timed = {
    ...result,
    marker: { injected: false },
    logs: {
      ...result.logs,
      markerMatched: false,
      correlation: { strategy: 'time-window', matchedId: null },
    },
  };
  const timedMarkdown = renderMarkdown(buildReport(timed));
  assert.match(timedMarkdown, /日志关联：时间窗兜底（可能混入其他请求）/);
  assert.doesNotMatch(timedMarkdown, /marker 未匹配/);
  assert.doesNotMatch(timedMarkdown, /marker：/);

  const business = {
    ...timed,
    logs: { ...timed.logs, correlation: { strategy: 'business-id', matchedId: 'ORD123' } },
  };
  const businessMarkdown = renderMarkdown(buildReport(business));
  assert.match(businessMarkdown, /日志关联：business-id（ORD123）/);
  assert.doesNotMatch(businessMarkdown, /marker：/);

  const injected = {
    ...timed,
    marker: { injected: true },
  };
  const injectedMarkdown = renderMarkdown(buildReport(injected));
  assert.match(injectedMarkdown, /marker：已注入但未匹配/);
});

test('report shows compile/test verification and a failed gate', () => {
  const withFailure = {
    ...result,
    agent: {
      ...result.agent,
      verification: {
        status: 'failed',
        mode: 'full',
        scope: 'workspace',
        error: '编译/测试验证失败：mvn -q -DskipTests compile',
        commands: [{ command: 'mvn -q -DskipTests compile', ok: false, exitCode: 1 }],
        durationMs: 321,
      },
    },
    gates: {
      ok: false,
      checks: [...result.gates.checks, { name: 'compile-self-check', ok: false }],
    },
  };
  const report = buildReport(withFailure);
  assert.equal(report.verification.status, 'failed');
  assert.equal(report.verification.mode, 'full');

  const markdown = renderMarkdown(report);
  assert.match(markdown, /## 编译\/测试验证/);
  assert.match(markdown, /状态：失败（full）/);
  assert.match(markdown, /mvn -q -DskipTests compile/);
  assert.match(markdown, /compile-self-check：失败/);
});

test('renders rejected hypotheses before the conclusion', () => {
  const withHypotheses = {
    ...result,
    agent: {
      ...result.agent,
      rejectedHypotheses: [{
        hypothesis: 'Redis 缓存未命中导致重复扣款',
        reason: '同一 key 在请求窗口内命中',
        refutedBy: [{ type: 'log', ref: 'logs.records[0]', note: 'cache hit' }],
      }],
      noRejectedHypothesesReason: null,
    },
  };
  const report = buildReport(withHypotheses);
  assert.equal(report.rejectedHypotheses.length, 1);
  assert.equal(report.rejectedHypotheses[0].hypothesis, 'Redis 缓存未命中导致重复扣款');
  const markdown = renderMarkdown(report);
  const sectionAt = markdown.indexOf('## 排除的假设');
  const conclusionAt = markdown.indexOf('## 结论');
  assert.ok(sectionAt >= 0 && conclusionAt > sectionAt);
  assert.match(markdown, /Redis 缓存未命中导致重复扣款/);
  assert.match(markdown, /\[log\] logs\.records\[0\] — cache hit/);
  assert.match(markdown, /同一 key 在请求窗口内命中/);

  const empty = {
    ...result,
    agent: { ...result.agent, rejectedHypotheses: [], noRejectedHypothesesReason: '未形成可排除假设' },
  };
  const emptyMarkdown = renderMarkdown(buildReport(empty));
  assert.match(emptyMarkdown, /未形成可排除假设/);
});
