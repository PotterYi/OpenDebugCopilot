import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { parseScenario } from '../../src/core/scenario.mjs';
import { fire } from '../../src/driver/browser.mjs';

const EDGE_PATHS = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
];
const edgeAvailable = EDGE_PATHS.some((candidate) => existsSync(candidate));

const PAGE = `<!doctype html>
<html><body>
  <input id="qty" />
  <button id="go">go</button>
  <script>
    document.getElementById('go').addEventListener('click', () => {
      const qty = document.getElementById('qty').value;
      fetch('/api/ping', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ qty }),
      });
    });
  </script>
</body></html>`;

async function startServer() {
  const bodies = [];
  const server = http.createServer(async (req, res) => {
    if (req.url === '/' && req.method === 'GET') {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end(PAGE);
      return;
    }
    if (req.url === '/api/ping' && req.method === 'POST') {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const raw = Buffer.concat(chunks).toString('utf8');
      bodies.push(JSON.parse(raw));
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ ok: true, echoed: JSON.parse(raw) }));
      return;
    }
    res.statusCode = 404;
    res.end('not found');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();
  return { server, bodies, baseUrl: `http://127.0.0.1:${port}` };
}

test('browser driver runs actions, captures request and injects marker', {
  skip: edgeAvailable ? false : 'Microsoft Edge is not installed',
  timeout: 60_000,
}, async () => {
  const { server, bodies, baseUrl } = await startServer();
  try {
    const scenario = parseScenario({
      name: 'browser-marker',
      baseUrl,
      browser: {
        path: '/',
        match: '/api/ping',
        actions: [
          { fill: { selector: '#qty', value: '5' } },
          { click: '#go' },
        ],
      },
      marker: { mode: 'body', bodyField: 'traceNo' },
    });
    const result = await fire(scenario, { headless: true, networkIdleTimeoutMs: 3000 });
    assert.equal(bodies.length, 1);
    assert.equal(bodies[0].qty, '5');
    assert.match(bodies[0].traceNo, /^dcprobe[0-9a-f]{16}$/);
    assert.equal(result.marker.injected, true);
    assert.equal(result.marker.targets.body, true);
    assert.equal(bodies[0].traceNo, result.marker.value);
    assert.match(result.request.url, /\/api\/ping$/);
    assert.equal(result.request.method, 'POST');
    assert.equal(result.response.status, 200);
    assert.match(result.response.body, /"ok":true/);
  } finally {
    server.close();
  }
});
