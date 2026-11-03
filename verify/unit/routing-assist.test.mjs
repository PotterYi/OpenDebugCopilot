import test from 'node:test';
import assert from 'node:assert/strict';
import { deriveCandidateRules } from '../../src/ui/routing-assist.mjs';

const requests = [
  { url: 'http://localhost:5173/api/order/1', method: 'POST', resourceType: 'Fetch' },
  { url: 'http://localhost:5173/api/order/2', method: 'GET', resourceType: 'XHR' },
  { url: 'http://localhost:5173/api/user/1', method: 'GET', resourceType: 'Fetch' },
  { url: 'http://localhost:5173/static/app.js', method: 'GET', resourceType: 'Script' },
  { url: 'http://localhost:5173/api/order/3', method: 'GET', resourceType: 'mainFrame' },
];

test('derives rules by host and first path segment', () => {
  const rules = deriveCandidateRules(requests, { defaultBaseUrl: 'http://localhost:8080' });
  assert.equal(rules.length, 2);
  const order = rules.find((rule) => rule.match.prefix === '/api/order');
  assert.ok(order);
  assert.equal(order.match.host, 'localhost');
  assert.equal(order.target.kind, 'local');
  assert.equal(order.target.baseUrl, 'http://localhost:8080');
  assert.equal(order.assistant.count, 2);
  assert.deepEqual(order.assistant.methods.sort(), ['GET', 'POST']);
  const user = rules.find((rule) => rule.match.prefix === '/api/user');
  assert.equal(user.assistant.count, 1);
});

test('skips prefixes already covered by existing rules', () => {
  const rules = deriveCandidateRules(requests, {
    existingRules: [{ match: { host: 'localhost', prefix: '/api' } }],
  });
  assert.equal(rules.length, 0);
});

test('handles empty or invalid input', () => {
  assert.deepEqual(deriveCandidateRules([], {}), []);
  assert.deepEqual(deriveCandidateRules([{ url: 'not a url', resourceType: 'Fetch' }], {}), []);
});
