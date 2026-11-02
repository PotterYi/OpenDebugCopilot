import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { parseScenario } from '../../src/core/scenario.mjs';
import { fire } from '../../src/driver/http.mjs';

async function startServer() {
  const received = [];
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString('utf8');
    received.push({ method: req.method, url: req.url, headers: req.headers, raw });
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ ok: true, echoed: raw }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();
  return { server, received, baseUrl: `http://127.0.0.1:${port}` };
}

test('http driver injects marker into header', async () => {
  const { server, received, baseUrl } = await startServer();
  try {
    const scenario = parseScenario({
      name: 'header-marker',
      baseUrl,
      method: 'POST',
      path: '/echo',
      body: { qty: 2 },
      marker: { mode: 'header' },
    });
    const result = await fire(scenario);
    assert.equal(received.length, 1);
    const header = received[0].headers['x-dc-probe'];
    assert.match(header, /^dcprobe[0-9a-f]{16}$/);
    assert.equal(result.marker.value, header);
    assert.equal(result.marker.injected, true);
    assert.equal(result.marker.targets.header, true);
    assert.equal(result.response.status, 200);
    assert.equal(received[0].headers['x-dc-probe'], result.marker.value);
  } finally {
    server.close();
  }
});

test('http driver injects marker into JSON body field', async () => {
  const { server, received, baseUrl } = await startServer();
  try {
    const scenario = parseScenario({
      name: 'body-marker',
      baseUrl,
      method: 'POST',
      path: '/echo',
      body: { qty: 2 },
      marker: { mode: 'body', bodyField: 'traceNo' },
    });
    const result = await fire(scenario);
    const sent = JSON.parse(received[0].raw);
    assert.equal(sent.qty, 2);
    assert.match(sent.traceNo, /^dcprobe[0-9a-f]{16}$/);
    assert.equal(sent.traceNo, result.marker.value);
    assert.equal(result.marker.targets.body, true);
    assert.equal(result.request.headers['X-DC-Probe'], undefined);
  } finally {
    server.close();
  }
});

test('http driver leaves request untouched when marker is disabled', async () => {
  const { server, received, baseUrl } = await startServer();
  try {
    const scenario = parseScenario({
      name: 'no-marker',
      baseUrl,
      method: 'POST',
      path: '/echo',
      body: { qty: 2 },
      marker: { mode: 'none' },
    });
    const result = await fire(scenario);
    const sent = JSON.parse(received[0].raw);
    assert.deepEqual(sent, { qty: 2 });
    assert.equal(received[0].headers['x-dc-probe'], undefined);
    assert.equal(result.marker.injected, false);
  } finally {
    server.close();
  }
});
