import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeLocalhost,
  matchRule,
  buildRedirectUrl,
  applyCorsHeaders,
  Router,
} from '../../src/app/electron/routing.mjs';

const rules = [
  {
    id: 'local-order',
    enabled: true,
    match: { host: 'api.example.com', prefix: '/api/order' },
    target: { kind: 'local', baseUrl: 'http://127.0.0.1:8080' },
  },
  {
    id: 'sit-user',
    enabled: true,
    match: { host: 'api.example.com', prefix: '/api/user' },
    target: { kind: 'sit', baseUrl: 'https://sit.example.com' },
  },
];

test('normalizes loopback hosts to localhost', () => {
  assert.equal(normalizeLocalhost('http://127.0.0.1:5173/a?b=1'), 'http://localhost:5173/a?b=1');
  assert.equal(normalizeLocalhost('http://[::1]:8080/'), 'http://localhost:8080/');
  assert.equal(normalizeLocalhost('https://example.com/'), 'https://example.com/');
});

test('matches rules by host and prefix', () => {
  assert.equal(matchRule(rules, 'https://api.example.com/api/order/1')?.id, 'local-order');
  assert.equal(matchRule(rules, 'https://api.example.com/api/user/1')?.id, 'sit-user');
  assert.equal(matchRule(rules, 'https://api.example.com/api/other'), null);
  assert.equal(matchRule(rules, 'https://other.example.com/api/order'), null);
  assert.equal(matchRule([{ ...rules[0], enabled: false }], 'https://api.example.com/api/order'), null);
});

test('builds redirect URLs with path, query and localhost normalization', () => {
  const url = buildRedirectUrl(rules[0], 'https://api.example.com/api/order/1?x=1');
  assert.equal(url, 'http://localhost:8080/api/order/1?x=1');
  const sit = buildRedirectUrl(rules[1], 'https://api.example.com/api/user/2');
  assert.equal(sit, 'https://sit.example.com/api/user/2');
});

test('adds CORS headers for local responses', () => {
  const headers = applyCorsHeaders(
    { 'content-type': ['application/json'] },
    {
      origin: 'http://localhost:5173',
      requestHeaders: {
        'access-control-request-method': ['POST'],
        'access-control-request-headers': ['content-type'],
      },
    },
  );
  assert.deepEqual(headers['Access-Control-Allow-Origin'], ['http://localhost:5173']);
  assert.deepEqual(headers['Access-Control-Allow-Methods'], ['POST']);
  assert.deepEqual(headers['Access-Control-Allow-Headers'], ['content-type']);
  assert.deepEqual(headers['Access-Control-Allow-Credentials'], ['true']);
  assert.deepEqual(headers['Access-Control-Max-Age'], ['0']);
  assert.deepEqual(headers['content-type'], ['application/json']);
});

test('router redirects actual requests, keeps OPTIONS and adds CORS', () => {
  const handlers = {};
  const session = {
    webRequest: {
      onBeforeRequest: (_filter, listener) => { handlers.before = listener ?? null; },
      onBeforeSendHeaders: (_filter, listener) => { handlers.send = listener ?? null; },
      onHeadersReceived: (_filter, listener) => { handlers.headers = listener ?? null; },
      onCompleted: (_filter, listener) => { handlers.completed = listener ?? null; },
      onErrorOccurred: (_filter, listener) => { handlers.error = listener ?? null; },
    },
  };
  const hits = [];
  const router = new Router({
    session,
    getRules: () => rules,
    getPageOrigin: () => 'http://localhost:5173',
    onHit: (event) => hits.push(event),
  });

  let docRedirect = null;
  handlers.before(
    { id: 9, url: 'https://api.example.com/api/order/1', method: 'GET', resourceType: 'mainFrame' },
    (result) => { docRedirect = result; },
  );
  assert.deepEqual(docRedirect, {});

  let redirect = null;
  handlers.before(
    { id: 1, url: 'https://api.example.com/api/order/1?x=1', method: 'POST', resourceType: 'xhr' },
    (result) => { redirect = result; },
  );
  assert.equal(redirect.redirectURL, 'http://localhost:8080/api/order/1?x=1');
  assert.equal(hits[0].rule, 'local-order');

  let sent = null;
  handlers.send(
    { id: 1, requestHeaders: { Origin: 'https://api.example.com' } },
    (result) => { sent = result; },
  );
  assert.equal(sent.requestHeaders.Origin, 'http://localhost:5173');

  let received = null;
  handlers.headers(
    { id: 1, method: 'POST', responseHeaders: { 'content-type': ['application/json'] } },
    (result) => { received = result; },
  );
  assert.deepEqual(received.responseHeaders['Access-Control-Allow-Origin'], ['http://localhost:5173']);

  let optionsResult = null;
  handlers.before(
    { id: 2, url: 'https://api.example.com/api/order/1', method: 'OPTIONS', resourceType: 'xhr' },
    (result) => { optionsResult = result; },
  );
  assert.deepEqual(optionsResult, {});
  let optionsHeaders = null;
  handlers.headers(
    { id: 2, method: 'OPTIONS', responseHeaders: {} },
    (result) => { optionsHeaders = result; },
  );
  assert.deepEqual(optionsHeaders.responseHeaders['Access-Control-Allow-Origin'], ['http://localhost:5173']);

  router.dispose();
  assert.equal(handlers.before, null);
});
