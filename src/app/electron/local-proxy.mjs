import http from 'node:http';

const MAX_BODY_BYTES = 10 * 1024 * 1024;
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

function corsHeaders(origin, requestHeaders = {}) {
  const allowOrigin = origin || '*';
  const headers = {
    'Access-Control-Allow-Origin': allowOrigin,
    'Access-Control-Allow-Methods': requestHeaders['access-control-request-method'] || 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': requestHeaders['access-control-request-headers'] || 'Content-Type,Authorization,X-Requested-With',
    'Access-Control-Expose-Headers': '*',
    'Access-Control-Max-Age': '0',
    Vary: 'Origin',
  };
  if (allowOrigin !== '*') headers['Access-Control-Allow-Credentials'] = 'true';
  return headers;
}

/**
 * Local reverse proxy for routing targets.
 * - answers CORS preflight itself (204), so the real backend does not need OPTIONS support
 * - forwards other methods to the local target and adds CORS headers
 *
 * URL shape: /__dcproxy?target=<baseUrl>&url=<path+query>
 */
export async function startLocalProxy({
  host = '127.0.0.1',
  port = 0,
  isAllowedTarget = (targetUrl) => LOCAL_HOSTS.has(targetUrl.hostname),
} = {}) {
  const server = http.createServer(async (req, res) => {
    const cors = corsHeaders(req.headers.origin, req.headers);
    try {
      const entry = new URL(req.url, `http://${host}`);
      if (entry.pathname !== '/__dcproxy') {
        res.writeHead(404, cors);
        res.end('not found');
        return;
      }
      const target = entry.searchParams.get('target');
      const pathAndQuery = entry.searchParams.get('url') ?? '/';
      if (!target) {
        res.writeHead(400, cors);
        res.end('missing target');
        return;
      }
      const targetUrl = new URL(target);
      if (typeof isAllowedTarget === 'function' && !isAllowedTarget(targetUrl)) {
        res.writeHead(400, cors);
        res.end('target is not allowed by routing rules');
        return;
      }

      if (req.method === 'OPTIONS') {
        res.writeHead(204, cors);
        res.end();
        return;
      }

      const chunks = [];
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > MAX_BODY_BYTES) throw new Error('request body exceeds 10MB');
        chunks.push(chunk);
      }
      const body = chunks.length > 0 ? Buffer.concat(chunks) : undefined;

      const headers = {};
      for (const [key, value] of Object.entries(req.headers)) {
        const lower = key.toLowerCase();
        if (['host', 'connection', 'content-length', 'accept-encoding'].includes(lower)) continue;
        if (lower.startsWith('access-control-')) continue;
        headers[key] = value;
      }
      if (req.headers.origin) headers.origin = req.headers.origin;

      const upstream = await fetch(new URL(pathAndQuery, targetUrl), {
        method: req.method,
        headers,
        body,
        redirect: 'manual',
      });

      const responseHeaders = {
        ...cors,
        'Content-Type': upstream.headers.get('content-type') ?? 'application/octet-stream',
      };
      for (const [key, value] of upstream.headers) {
        const lower = key.toLowerCase();
        if (
          ['content-length', 'content-encoding', 'transfer-encoding', 'connection', 'set-cookie', 'vary'].includes(lower) ||
          lower.startsWith('access-control-')
        ) {
          continue;
        }
        responseHeaders[key] = value;
      }
      const setCookies = typeof upstream.headers.getSetCookie === 'function' ? upstream.headers.getSetCookie() : [];
      if (setCookies.length > 0) responseHeaders['set-cookie'] = setCookies;

      const buffer = Buffer.from(await upstream.arrayBuffer());
      res.writeHead(upstream.status, responseHeaders);
      res.end(buffer);
    } catch (error) {
      res.writeHead(502, { ...cors, 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'proxy_failed', message: error?.message ?? String(error) }));
    }
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });
  const actualPort = server.address().port;
  return {
    url: `http://localhost:${actualPort}`,
    port: actualPort,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
