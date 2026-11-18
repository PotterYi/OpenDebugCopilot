import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateGates } from '../../src/diagnose/run.mjs';

const evidence = {
  request: { method: 'POST', url: 'http://localhost/api/order', headers: {}, body: '{}' },
  response: { status: 500, body: '{"error":"inventory"}' },
  logs: { records: [{ level: 'ERROR', message: 'inventory not enough' }] },
  source: { files: [{ path: 'com/demo/OrderService.java', content: 'class OrderService' }] },
  threads: { total: 1, threads: [{ name: 'http-nio-8080-exec-1' }] },
};
const fired = { request: { url: 'http://localhost/api/order' }, response: { status: 500 } };

function agent(overrides = {}) {
  return {
    conclusion: '库存校验失败',
    evidenceRefs: [{ type: 'request', ref: 'request' }],
    rejectedHypotheses: [{
      hypothesis: '请求未到达后端',
      refutedBy: [{ type: 'response', ref: 'response.status', note: '已收到 500' }],
      reason: '已捕获后端响应，排除请求未到达后端',
    }],
    ...overrides,
  };
}

function check(gates, name) {
  return gates.checks.find((item) => item.name === name);
}

test('accepts a rejected hypothesis with existing refuting evidence', () => {
  const gates = evaluateGates(fired, agent(), null, evidence);
  assert.equal(gates.ok, true, JSON.stringify(gates.checks));
  assert.equal(check(gates, 'hypothesis-disclosure').ok, true);
});

test('accepts an empty list with an explicit reason', () => {
  const gates = evaluateGates(fired, agent({
    rejectedHypotheses: [],
    noRejectedHypothesesReason: '本轮只有单一可解释路径，未形成可排除假设',
  }), null, evidence);
  assert.equal(gates.ok, true, JSON.stringify(gates.checks));
});

test('rejects a missing disclosure and a missing reason', () => {
  const missing = evaluateGates(fired, agent({ rejectedHypotheses: undefined }), null, evidence);
  assert.equal(check(missing, 'hypothesis-disclosure').ok, false);

  const noReason = evaluateGates(fired, agent({
    rejectedHypotheses: [{ hypothesis: '请求未到达后端', refutedBy: [{ type: 'response', ref: 'response.status' }], reason: '' }],
  }), null, evidence);
  assert.equal(check(noReason, 'hypothesis-disclosure').ok, false);
});

test('rejects fabricated refs in hypotheses and evidenceRefs', () => {
  const fabricated = evaluateGates(fired, agent({
    rejectedHypotheses: [{
      hypothesis: '请求未到达后端',
      refutedBy: [{ type: 'log', ref: 'logs.records[99]' }],
      reason: '不存在的日志',
    }],
  }), null, evidence);
  assert.equal(check(fabricated, 'hypothesis-disclosure').ok, false);
  assert.match(check(fabricated, 'hypothesis-disclosure').detail, /logs\.records\[99\]/);

  const badSupport = evaluateGates(fired, agent({
    evidenceRefs: [{ type: 'log', ref: 'logs.records[99]' }],
  }), null, evidence);
  assert.equal(check(badSupport, 'evidence-refs').ok, false);
});
