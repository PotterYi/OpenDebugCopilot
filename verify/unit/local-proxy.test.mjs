import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { startLocalProxy } from '../../src/app/electron/local-proxy.mjs';

test('local proxy answers preflight and forwards requests', async (t) => {
  let backendOptions = 0;
  let backendPosts = 0;
  let receivedBody = '';
  const backend = http.createServer(async (req, res) => {
    if (req.method === 'OPTIONS') {
      backendOptions += 1;
      res.statusCode = 404;
      res.end('no preflight support');
      return;
    }
    if (req.url.startsWith('/api/order')) {
      backendPosts += 1;
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      receivedBody = Buffer.concat(chunks).toString('utf8');
      res.statusCode = 201;
      res.setHeader('Content-Type', 'application/json');
      res.end('{"from":"backend"}');
      return;
    }
    res.statusCode = 404;
    res.end('not found');
  });
  backend.listen(0);
  await once(backend, 'listening');
  t.after(() => new Promise((resolve) => backend.close(resolve)));

  const proxy = await startLocalProxy();
  t.after(() => proxy.close());

  const target = `http://127.0.0.1:${backend.address().port}`;
  const proxyUrl = `${proxy.url}/__dcproxy?target=${encodeURIComponent(target)}&url=${encodeURIComponent('/api/order?x=1')}`;

  const preflight = await fetch(proxyUrl, {
    method: 'OPTIONS',
    headers: {
      Origin: 'http://localhost:5173',
      'Access-Control-Request-Method': 'POST',
      'Access-Control-Request-Headers': 'content-type',
    },
  });
  assert.equal(preflight.status, 204);
  assert.deepEqual(preflight.headers.get('access-control-allow-origin'), 'http://localhost:5173');
  assert.deepEqual(preflight.headers.get('access-control-max-age'), '0');
  assert.equal(backendOptions, 0, 'backend must not receive OPTIONS');

  const response = await fetch(proxyUrl, {
    method: 'POST',
    headers: { Origin: 'http://localhost:5173', 'Content-Type': 'application/json' },
    body: '{"qty":2}',
  });
  assert.equal(response.status, 201);
  assert.deepEqual(response.headers.get('access-control-allow-origin'), 'http://localhost:5173');
  assert.equal(backendPosts, 1);
  assert.equal(receivedBody, '{"qty":2}');
  assert.equal(await response.json().then((body) => body.from), 'backend');

  const invalid = await fetch(`${proxy.url}/__dcproxy?target=${encodeURIComponent('https://example.com')}&url=/`, {
    method: 'GET',
  });
  assert.equal(invalid.status, 400);
});
