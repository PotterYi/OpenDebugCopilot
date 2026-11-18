import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateRecheck } from '../../src/diagnose/recheck.mjs';

const base = {
  conclusion: '请求返回 HTTP 500，日志显示库存不足，OrderService 抛出 IllegalStateException。',
  evidenceRefs: [
    { type: 'request', ref: 'request' },
    { type: 'response', ref: 'response' },
    { type: 'log', ref: 'logs.records[0]' },
  ],
};

test('identical runs are consistent', () => {
  const result = evaluateRecheck([base, { ...base }, { ...base }], { responseStatus: 500 });
  assert.equal(result.verdict, 'consistent');
  assert.equal(result.checks.every((check) => check.ok), true);
});

test('empty conclusions are undetermined', () => {
  const result = evaluateRecheck([base, { ...base, conclusion: '' }], { responseStatus: 500 });
  assert.equal(result.verdict, 'undetermined');
});

test('conflicting status codes are inconsistent', () => {
  const other = { ...base, conclusion: '请求返回 HTTP 404，日志显示库存不足，OrderService 抛出 IllegalStateException。' };
  const result = evaluateRecheck([base, other, base], { responseStatus: 500 });
  assert.equal(result.verdict, 'inconsistent');
  assert.equal(result.checks.find((c) => c.name === 'status-code').ok, false);
});

test('divergent conclusions are inconsistent', () => {
  const other = {
    conclusion: '前端参数校验失败，qty 字段为空，未进入后端。',
    evidenceRefs: [{ type: 'thread', ref: 'threads' }],
  };
  const result = evaluateRecheck([base, other, base], { responseStatus: 500 });
  assert.equal(result.verdict, 'inconsistent');
  assert.equal(result.checks.find((c) => c.name === 'conclusion-similarity').ok, false);
});

test('rejected hypotheses are compared across runs', () => {
  const withHypothesis = {
    ...base,
    rejectedHypotheses: [{
      hypothesis: '库存不足导致下单失败',
      refutedBy: [{ type: 'log', ref: 'logs.records[0]' }],
      reason: '日志显示库存充足',
    }],
  };
  const consistent = evaluateRecheck([withHypothesis, { ...withHypothesis }], { responseStatus: 500 });
  assert.equal(consistent.verdict, 'consistent');
  assert.equal(consistent.checks.find((c) => c.name === 'rejected-hypotheses').ok, true);

  const divergent = {
    ...base,
    rejectedHypotheses: [{
      hypothesis: '前端参数校验失败',
      refutedBy: [{ type: 'thread', ref: 'threads' }],
      reason: '请求已到达后端',
    }],
  };
  const result = evaluateRecheck([withHypothesis, divergent], { responseStatus: 500 });
  assert.equal(result.verdict, 'inconsistent');
  assert.equal(result.checks.find((c) => c.name === 'rejected-hypotheses').ok, false);
});
