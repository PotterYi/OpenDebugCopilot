import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildEvidenceRefIndex,
  validateEvidenceRef,
  validateEvidenceRefs,
} from '../../src/core/evidence-refs.mjs';

const evidence = {
  request: { method: 'POST', url: 'http://localhost/api/order', headers: {}, body: '{"qty":2}' },
  response: { status: 500, body: '{"error":"inventory"}' },
  logs: { records: [{ level: 'ERROR', message: 'inventory not enough' }] },
  source: { files: [{ path: 'com/demo/OrderService.java', content: 'class OrderService' }] },
  threads: { total: 1, threads: [{ name: 'http-nio-8080-exec-1' }] },
  element: { selector: '#app', text: '用户列表' },
};

const index = buildEvidenceRefIndex(evidence);

test('accepts existing evidence refs for each allowed type', () => {
  for (const ref of [
    { type: 'request', ref: 'request' },
    { type: 'response', ref: 'response.status' },
    { type: 'log', ref: 'logs.records[0]' },
    { type: 'source', ref: 'source.files[0].content' },
    { type: 'thread', ref: 'threads.threads[0].name' },
    { type: 'element', ref: 'element.selector' },
  ]) {
    const result = validateEvidenceRef(index, ref);
    assert.equal(result.ok, true, JSON.stringify(ref));
  }
});

test('rejects missing paths and type/ref mismatches', () => {
  assert.deepEqual(validateEvidenceRef(index, { type: 'log', ref: 'logs.records[99]' }), {
    ok: false,
    reason: 'missing',
  });
  assert.equal(validateEvidenceRef(index, { type: 'source', ref: 'logs.records[0]' }).reason, 'type-mismatch');
  assert.equal(validateEvidenceRef(index, { type: 'logs', ref: 'logs.records[0]' }).reason, 'type');
  assert.equal(validateEvidenceRef(index, { type: 'request' }).reason, 'shape');
});

test('reports every invalid ref in a list', () => {
  const result = validateEvidenceRefs(index, [
    { type: 'request', ref: 'request' },
    { type: 'log', ref: 'logs.records[42]' },
    { type: 'element', ref: 'element.nope' },
  ]);
  assert.equal(result.ok, false);
  assert.equal(result.invalid.length, 2);
});
