import test from 'node:test';
import assert from 'node:assert/strict';
import { detectBusinessError } from '../../src/evidence/business.mjs';

test('detects RuoYi business error codes', () => {
  assert.deepEqual(detectBusinessError('{"msg":"库存不足","code":500}'), { code: 500, message: '库存不足' });
  assert.deepEqual(detectBusinessError('{"code":200,"data":[]}'), null);
  assert.deepEqual(detectBusinessError('plain text'), null);
  assert.deepEqual(detectBusinessError('{broken'), null);
});
