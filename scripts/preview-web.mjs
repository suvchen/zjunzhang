// 中军帐 装机演示用 Web 前挂（总管，scripts/preview-web.mjs）
// 为什么单独有它：T-005-m4-spec.md 要求 serve.js 带静态路由，但 serve.js 归 Codex（工单 #56259 在途）。
// 装机测试不能等：本脚本只做两件事——发 public/ 静态文件 ＋ 把 /api 与 SSE 原样代理到 zjz serve。不改产品一行代码。
// 用法：node scripts/preview-web.mjs [--port 8890] [--api http://127.0.0.1:8888]
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const argv = process.argv;
const arg = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const PORT = Number(arg('--port', '8890'));
const API = new URL(arg('--api', 'http://127.0.0.1:8888'));

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml; charset=utf-8',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
};

function serveStatic(request, response, pathname) {
  if (request.method !== 'GET' && request.method !== 'HEAD') return false;
  const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  if (!rel || rel.includes('\0')) return false;
  const abs = path.resolve(ROOT, rel);
  if (!abs.startsWith(ROOT + path.sep)) {
    response.writeHead(403, { 'content-type': 'application/json; charset=utf-8' });
    response.end(JSON.stringify({ ok: false, code: 'STATIC_FORBIDDEN', message: '静态路径越界' }));
    return true;
  }
  if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) return false;
  response.writeHead(200, {
    'content-type': MIME[path.extname(abs).toLowerCase()] || 'application/octet-stream',
    'cache-control': 'no-store',
  });
  response.end(request.method === 'HEAD' ? undefined : fs.readFileSync(abs));
  return true;
}

function proxy(request, response) {
  const target = new URL(request.url, API.origin);
  const upstream = http.request(
    {
      hostname: API.hostname,
      port: API.port,
      path: target.pathname + target.search,
      method: request.method,
      headers: { ...request.headers, host: API.host },
    },
    (up) => {
      response.writeHead(up.statusCode || 502, up.headers);
      up.pipe(response);
    },
  );
  upstream.on('error', (error) => {
    response.writeHead(502, { 'content-type': 'application/json; charset=utf-8' });
    response.end(JSON.stringify({ ok: false, code: 'API_DOWN', message: String(error.message || error), hint: `zjz serve 没在 ${API.origin} 上：node bin/zjz.mjs --home <HOME> serve --port 8888` }));
  });
  request.pipe(upstream);
}

const server = http.createServer((request, response) => {
  const url = new URL(request.url, 'http://127.0.0.1');
  if (url.pathname.startsWith('/api/')) return proxy(request, response);
  if (serveStatic(request, response, url.pathname)) return;
  response.writeHead(404, { 'content-type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify({ ok: false, code: 'NOT_FOUND', message: '不是静态文件也不是 /api' }));
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(JSON.stringify({ ok: true, web: `http://127.0.0.1:${PORT}/`, api: API.origin, root: ROOT }));
});
