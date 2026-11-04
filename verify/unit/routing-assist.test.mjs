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

const probeAll = async () => true;

test('requires observed prefix + declared target + successful probe', async () => {
  const result = await deriveCandidateRules(requests, {
    declaredTargets: [{ kind: 'local', baseUrl: 'http://localhost:8080', source: 'workspace.backendUrl' }],
    probe: probeAll,
  });
  assert.equal(result.rules.length, 2);
  const order = result.rules.find((rule) => rule.match.prefix === '/api/order');
  assert.equal(order.assistant.count, 2);
  assert.deepEqual(order.assistant.methods.sort(), ['GET', 'POST']);
  assert.deepEqual(order.assistant.sources, ['observed', 'declared', 'probed']);
  assert.equal(order.assistant.targetSource, 'workspace.backendUrl');
  assert.equal(order.assistant.probed, true);
  const user = result.rules.find((rule) => rule.match.prefix === '/api/user');
  assert.equal(user.assistant.count, 1);
});

test('ignores declared SIT targets (SIT is passthrough)', async () => {
  const result = await deriveCandidateRules(requests, {
    declaredTargets: [
      { kind: 'local', baseUrl: 'http://localhost:8080', source: 'workspace.backendUrl' },
      { kind: 'sit', baseUrl: 'https://sit.example.com', source: 'rule:sit' },
    ],
    probe: async (url) => url === 'https://sit.example.com',
  });
  assert.equal(result.rules.length, 0);
  assert.equal(result.unreachable.length, 2);
});

test('emits nothing when no declared target is reachable', async () => {
  const result = await deriveCandidateRules(requests, {
    declaredTargets: [{ kind: 'local', baseUrl: 'http://localhost:8080' }],
    probe: async () => false,
  });
  assert.equal(result.rules.length, 0);
  assert.equal(result.unreachable.length, 2);
  assert.deepEqual(result.unreachable[0].candidates, ['http://localhost:8080']);
});

test('does not invent targets without declarations', async () => {
  const result = await deriveCandidateRules(requests, { probe: probeAll });
  assert.equal(result.rules.length, 0);
  assert.equal(result.unreachable.length, 2);
  assert.deepEqual(result.declaredTargets, []);
});

test('skips prefixes already covered by existing rules', async () => {
  const result = await deriveCandidateRules(requests, {
    existingRules: [{
      id: 'old-order',
      enabled: true,
      match: { host: 'localhost', prefix: '/api/order' },
      target: { kind: 'local', baseUrl: 'http://localhost:8080' },
    }],
    declaredTargets: [{ kind: 'local', baseUrl: 'http://localhost:8080' }],
    probe: probeAll,
  });
  assert.equal(result.rules.length, 1);
  assert.equal(result.rules[0].match.prefix, '/api/user');
});



test('a catch-all rule does not block specific candidates', async () => {
  const result = await deriveCandidateRules(requests, {
    existingRules: [{
      id: 'catch-all',
      enabled: true,
      match: { host: 'localhost', prefix: '/' },
      target: { kind: 'local', baseUrl: 'http://localhost:8080' },
    }],
    declaredTargets: [{ kind: 'local', baseUrl: 'http://localhost:8080' }],
    probe: probeAll,
  });
  assert.equal(result.rules.length, 2);
});
