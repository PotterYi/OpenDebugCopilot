import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { AppError } from '../core/errors.mjs';
import { log } from '../core/logger.mjs';

const MIME = Object.freeze({
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
});

const MAX_BODY_BYTES = 1024 * 1024;

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(body);
}

function httpStatusFor(err) {
  if (!(err instanceof AppError)) return 500;
  if ([
    'CONFIG_INVALID',
    'RUN_ID_INVALID',
    'BODY_INVALID_JSON',
    'BODY_TOO_LARGE',
    'PROFILE_NAME_REQUIRED',
    'DATABASE_CONFIG_INVALID',
    'DB_SECRET_UNAVAILABLE',
  ].includes(err.code)) return 400;
  if (['RUN_NOT_FOUND', 'PROFILE_NOT_FOUND'].includes(err.code)) return 404;
  return 500;
}

async function readJsonBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      throw new AppError('BODY_TOO_LARGE', 'Request body exceeds 1MB', { exitCode: 2 });
    }
    chunks.push(chunk);
  }
  if (size === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch (err) {
    throw new AppError('BODY_INVALID_JSON', 'Request body is not valid JSON', { exitCode: 2, cause: err });
  }
}

async function serveStatic(res, uiDir, pathname) {
  const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const file = path.resolve(uiDir, relative);
  const base = path.resolve(uiDir) + path.sep;
  if (file !== path.resolve(uiDir, 'index.html') && !file.startsWith(base)) {
    sendJson(res, 404, { error: 'not_found' });
    return;
  }
  let content;
  try {
    content = await readFile(file);
  } catch {
    sendJson(res, 404, { error: 'not_found' });
    return;
  }
  res.writeHead(200, {
    'Content-Type': MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream',
    'Content-Length': content.length,
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(content);
}

/**
 * @param {{ service: any, uiDir: string, host?: string, port?: number }} options
 */
export async function startServer({ service, uiDir, host = '127.0.0.1', port = 7080 }) {
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://${host}`);
      const { pathname } = url;

      if (pathname === '/api/health') {
        sendJson(res, 200, { ok: true, name: 'debugcopilot', time: Date.now() });
        return;
      }
      if (pathname === '/api/config') {
        if (req.method === 'GET') {
          sendJson(res, 200, await service.getConfig());
          return;
        }
        if (req.method === 'PUT') {
          sendJson(res, 200, await service.saveConfig(await readJsonBody(req)));
          return;
        }
        sendJson(res, 405, { error: 'method_not_allowed' });
        return;
      }
      if (pathname === '/api/profiles') {
        if (req.method === 'GET') {
          sendJson(res, 200, await service.listProfiles());
          return;
        }
        if (req.method === 'POST') {
          const body = await readJsonBody(req);
          await service.createProfile(body?.name, {
            workspace: body?.workspace,
            routing: body?.routing,
          });
          sendJson(res, 200, { config: await service.getConfig(), profiles: await service.listProfiles() });
          return;
        }
        sendJson(res, 405, { error: 'method_not_allowed' });
        return;
      }
      const profileMatch = pathname.match(/^\/api\/profiles\/([^/]+)(\/activate)?$/);
      if (profileMatch) {
        const profileId = decodeURIComponent(profileMatch[1]);
        if (req.method === 'POST' && profileMatch[2]) {
          await service.switchProfile(profileId);
          sendJson(res, 200, { config: await service.getConfig(), profiles: await service.listProfiles() });
          return;
        }
        if (req.method === 'PATCH') {
          const body = await readJsonBody(req);
          await service.renameProfile(profileId, body?.name);
          sendJson(res, 200, { config: await service.getConfig(), profiles: await service.listProfiles() });
          return;
        }
        if (req.method === 'DELETE') {
          await service.deleteProfile(profileId);
          sendJson(res, 200, { config: await service.getConfig(), profiles: await service.listProfiles() });
          return;
        }
      }
      if (pathname === '/api/databases') {
        if (req.method === 'GET') {
          sendJson(res, 200, await service.getDatabaseConfig());
          return;
        }
        if (req.method === 'PUT') {
          sendJson(res, 200, await service.saveDatabaseConfig(await readJsonBody(req)));
          return;
        }
        sendJson(res, 405, { error: 'method_not_allowed' });
        return;
      }
      if (pathname === '/api/databases/test' && req.method === 'POST') {
        const body = await readJsonBody(req);
        sendJson(res, 200, await service.testDatabase(body?.connection ?? body));
        return;
      }
      if (pathname === '/api/runs' && req.method === 'GET') {
        sendJson(res, 200, { runs: await service.listRuns() });
        return;
      }
      const runMatch = pathname.match(/^\/api\/runs\/([^/]+)$/);
      if (runMatch && req.method === 'GET') {
        sendJson(res, 200, await service.getRun(decodeURIComponent(runMatch[1])));
        return;
      }
      if (runMatch && req.method === 'DELETE') {
        sendJson(res, 200, await service.deleteRun(decodeURIComponent(runMatch[1])));
        return;
      }
      if (pathname.startsWith('/api/')) {
        sendJson(res, 404, { error: 'not_found' });
        return;
      }

      await serveStatic(res, uiDir, decodeURIComponent(pathname));
    } catch (err) {
      const status = httpStatusFor(err);
      if (status >= 500) log.error('[web]', err);
      sendJson(res, status, {
        error: err instanceof AppError ? err.code : 'internal_error',
        message: err?.message ?? String(err),
      });
    }
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });
  const actualPort = server.address().port;
  return {
    server,
    host,
    port: actualPort,
    url: `http://${host}:${actualPort}`,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
