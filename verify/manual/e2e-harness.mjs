import http from 'node:http';
import path from 'node:path';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdir, readFile, rm, writeFile, appendFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { log } from '../../src/core/logger.mjs';
import { pageHtml } from './page.mjs';

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const TMP = path.resolve(ROOT, '.tmp/manual-e2e');
const KEEP = process.argv.includes('--keep');
const UI_PORT = 7080;

const pad = (value, width = 2) => String(value).padStart(width, '0');
function localTimestamp() {
  const now = new Date();
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}.${pad(now.getMilliseconds(), 3)}`;
}


await rm(TMP, { recursive: true, force: true });
await mkdir(path.join(TMP, 'configs'), { recursive: true });
const logFile = path.join(TMP, 'app.log');
await writeFile(logFile, '', 'utf8');

let backendHits = 0;
let backendOptions = 0;
const backend = http.createServer(async (req, res) => {
  if (req.url === '/api/order' && req.method === 'OPTIONS') {
    backendOptions += 1;
    res.statusCode = 204;
    res.end();
    return;
  }
  if (req.url === '/api/order' && req.method === 'POST') {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    backendHits += 1;
    await appendFile(logFile, [
      `${localTimestamp()} ERROR 1 --- [http-nio-8080-exec-1] c.e.demo.OrderService : create order failed: inventory not enough orderId=${body.orderId}`,
      'java.lang.IllegalStateException: inventory not enough',
      '\tat com.demo.OrderService.create(OrderService.java:5)',
      '',
    ].join('\n'), 'utf8');
    res.statusCode = 500;
    res.setHeader('Content-Type', 'application/json');
    res.end('{"error":"inventory not enough"}');
    return;
  }
  res.statusCode = 404;
  res.end('not found');
});
backend.listen(0);
await once(backend, 'listening');
const backendUrl = `http://localhost:${backend.address().port}`;

let frontendOptions = 0;
const frontend = http.createServer((req, res) => {
  if (req.url === '/') {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(pageHtml());
    return;
  }
  if (req.url === '/api/order' && req.method === 'OPTIONS') {
    frontendOptions += 1;
    res.statusCode = 204;
    res.end();
    return;
  }
  res.statusCode = 404;
  res.end('frontend has no API; routing must redirect');
});
frontend.listen(0);
await once(frontend, 'listening');
const frontendUrl = `http://localhost:${frontend.address().port}`;

await writeFile(path.join(TMP, 'configs', 'workspace.json'), JSON.stringify({
  frontendUrl,
  backendUrl,
  logfiles: [logFile],
  sourceRoot: path.join(ROOT, 'verify/fixtures/source'),
  window: { beforeMs: 10000, afterMs: 10000 },
}, null, 2), 'utf8');
await writeFile(path.join(TMP, 'configs', 'routing.json'), JSON.stringify({
  rules: [{
    id: 'local-order',
    enabled: true,
    match: { host: 'localhost', prefix: '/api' },
    target: { kind: 'local', baseUrl: backendUrl },
  }],
}, null, 2), 'utf8');

const electronPath = require('electron');
const child = spawn(electronPath, [
  path.join(ROOT, 'src/app/electron/main.mjs'),
  `--port=${UI_PORT}`,
  '--config-dir', path.join(TMP, 'configs'),
  '--runs-dir', path.join(TMP, 'runs'),
], { stdio: 'inherit' });

log.info('');
log.info('=== DebugCopilot 手工 E2E ===');
log.info(`UI: ${`http://127.0.0.1:${UI_PORT}`}`);
log.info(`前端: ${frontendUrl}`);
log.info(`后端: ${backendUrl}`);
log.info('步骤：');
log.info('1. 窗口打开后，在“浏览器”页看到 Manual E2E Frontend，用真实鼠标点击“创建订单”');
log.info('2. 切到“请求”，确认出现 POST /api/order，状态 500，URL 指向后端端口');
log.info('3. 选中该请求，点“诊断（Mock）”，确认出现 Run ID、Gates: ok 与结论');
log.info('4. 切到“历史”，确认新增一条记录并能打开报告');
log.info('5. 关闭窗口结束（临时文件会自动清理）');
log.info('');

const code = await new Promise((resolve) => child.on('close', resolve));
log.info(`Electron 退出码: ${code}`);
log.info(`后端命中次数: ${backendHits}（期望 >= 1）；预检后端 ${backendOptions} 次 / 前端 ${frontendOptions} 次（期望 >= 1）`);
log.info(`临时目录: ${TMP}${KEEP ? '（已保留）' : ''}`);

backend.close();
frontend.close();
if (!KEEP) await rm(TMP, { recursive: true, force: true });
