import test from 'node:test';
import assert from 'node:assert/strict';
import { buildReport, renderMarkdown } from '../../src/report/report.mjs';

const result = {
  meta: {
    runId: '20261102-120000-abcdef',
    scenario: 'order-create',
    question: '下单失败',
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
