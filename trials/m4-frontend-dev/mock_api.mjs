// M4 前端 dev 桩（总管）：按 Codex 冻结契约实现 /api/*＋SSE，喂真实语料库样本。
// 用途＝前端自检与截图取证；后端 serve 落地后即可删（不进产品路径）。
// 用法：node mock_api.mjs [port]，然后浏览器开 http://127.0.0.1:8790/
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PUB = path.join(HERE, '..', '..', 'public');
const PORT = Number(process.argv[2] || 8790);

// 从真实语料库取两房样本（含导入头→display_text 场景）
const ROOMS = [
  { room_id: 'room_demo_r2', name: 'Huddo·中军帐研发', archived: false },
  { room_id: 'room_demo_r1', name: 'Huddo·四智能体协作', archived: false },
  { room_id: 'room_demo_arch', name: '旧项目房', archived: true },
];
function loadMsgs(roomId, file, author) {
  const rows = [];
  let seq = 0;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = /^#(\d+) (\S+) \| (.*?) \| (\S+) \| ([\s\S]*)$/.exec(line);
    if (!m || m[1] === '-') continue;
    seq += 1;
    const text = `[huddo:${m[2]}] ${m[5]}`;
    rows.push({ seq, msg_id: 'mock_' + seq, author: m[3].replace(/\s*\(.*\)$/, ''), ts: m[4], text, display_text: m[5], ext_id: m[2] });
    if (seq >= 40) break;
  }
  return rows;
}
const corpusDir = path.join(HERE, '..', 'huddo-real-20261109');
const MSGS = {
  room_demo_r2: loadMsgs('room_demo_r2', path.join(corpusDir, 'huddo_room2.txt')),
  room_demo_r1: loadMsgs('room_demo_r1', path.join(corpusDir, 'huddo_room1.txt')),
  room_demo_arch: [],
};

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  const send = (obj) => { res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(obj)); };
  const p = u.pathname;
  if (p === '/api/health') return send({ ok: true, serve: 'mock', duty: '未在监听：装机后由监督器自动唤醒' });
  if (p === '/api/members') return send({ ok: true, slugs: ['zjz-总管-演示', 'zjz-Codex-演示'] });
  if (p === '/api/rooms') return send({ ok: true, rooms: ROOMS.map((r) => ({ ...r, unread: r.room_id === 'room_demo_r1' ? 7 : 0 })) });
  let m = /^\/api\/rooms\/([^/]+)\/messages$/.exec(p);
  if (m && req.method === 'GET') {
    const roomId = m[1];
    if (roomId === 'room_arch_other') return send({ ok: false, code: 'NOT_MEMBER', message: '不在该房间，不能读取' });
    const after = Number(u.searchParams.get('after') || 0);
    const limit = Number(u.searchParams.get('limit') || 200);
    return send({ ok: true, room_id: roomId, messages: (MSGS[roomId] || []).filter((x) => x.seq > after).slice(0, limit) });
  }
  if (m && req.method === 'POST') {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const list = MSGS[m[1]] || (MSGS[m[1]] = []);
      const j = JSON.parse(body);
      const rec = { seq: list.length + 1, msg_id: 'mock_post_' + (list.length + 1), author: j.slug || 'anon', ts: new Date().toISOString(), text: j.text, display_text: j.text };
      list.push(rec);
      send({ ok: true, seq: rec.seq, id: rec.msg_id });
    });
    return;
  }
  m = /^\/api\/rooms\/([^/]+)\/stream$/.exec(p);
  if (m) {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
    res.write(': mock stream ok\n\n');
    const t = setInterval(() => res.write(': ping\n\n'), 5000);
    req.on('close', () => clearInterval(t));
    return;
  }
  if (p === '/api/search') {
    const q = u.searchParams.get('q') || '';
    const hits = [];
    for (const [roomId, list] of Object.entries(MSGS)) {
      for (const msg of list) {
        if ((msg.display_text || msg.text).includes(q)) hits.push({ ...msg, room_id: roomId });
        if (hits.length >= 20) break;
      }
    }
    return send({ ok: true, q, total: hits.length, hits });
  }
  if (p === '/api/skills') return send({ ok: true, cards: [] });
  if (p === '/api/duty/board') return send({ ok: true, members: [{ slug: 'zjz-总管-演示', listening: true, pending_unread: 0, sla: '' }, { slug: 'zjz-Codex-演示', listening: false, pending_unread: 3, sla: 'late' }], orders: [{ order_id: 'ord_demo', status: 'open', title: 'T-008 I46 serve 骨架' }] });
  // 静态
  const file = p === '/' ? 'index.html' : p.slice(1);
  try {
    const body = fs.readFileSync(path.join(PUB, file));
    res.writeHead(200, { 'Content-Type': file.endsWith('.html') ? 'text/html; charset=utf-8' : 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404); res.end('not found');
  }
});
server.listen(PORT, '127.0.0.1', () => console.log(`mock api on http://127.0.0.1:${PORT}/ (loopback only)`));
