// M4/T-008：单进程本地 Web 后端＋在线投递通道。只绑回环，UI/SSE 均不消费成员游标。
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import process from 'node:process';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { identity, msg, room } from './core.js';
import { search as searchApi } from './search.js';
import { skill as skillApi } from './skill.js';
import { delivery as deliveryApi } from './delivery.js';
import { wake as wakeApi } from './wake.js';
import { member as memberApi } from './member.js';
import { listen as listenApi } from './listen.js';
import { appendEvent } from './events.js';

const DEFAULT_PORT = 8788;
const POLL_MS = 100;
const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(HERE, '..', 'bin', 'zjz.mjs');

function homeDir(home) {
  return path.resolve(home || process.env.ZJZ_HOME || process.cwd());
}

function serveDir(home) {
  return path.join(homeDir(home), 'data', 'serve');
}

function leaseFile(home) {
  return path.join(serveDir(home), 'lease.json');
}

function lockFile(home) {
  return path.join(serveDir(home), 'serve.lock');
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function currentSlug(home) {
  const current = readJson(path.join(homeDir(home), 'data', 'current.json'));
  const index = readJson(path.join(homeDir(home), 'data', 'index.json'));
  const candidates = [current && current.slug, ...Object.keys((index && index.identities) || {})].filter(Boolean);
  for (const slug of candidates) {
    const listed = room.list(home, slug);
    if (listed.ok && listed.rooms && listed.rooms.length > 0) return slug;
  }
  return candidates[0] || null;
}

function atomicJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, file);
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.max(1, ms));
}

function withLock(fn, timeoutMs = 5000, home) {
  const file = lockFile(home);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const started = Date.now();
  let fd = null;
  for (;;) {
    try {
      fd = fs.openSync(file, 'wx');
      break;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if (Date.now() - started >= timeoutMs) throw new Error('serve lock timeout');
      sleepSync(10);
    }
  }
  try {
    return fn();
  } finally {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch { /* ignore */ }
    }
    try { fs.unlinkSync(file); } catch { /* ignore */ }
  }
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

function readProcessCommandLine(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return '';
  if (process.platform === 'win32') {
    const res = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`], { encoding: 'utf8', windowsHide: true, timeout: 5000 });
    return String(res.stdout || '').trim();
  }
  try { return fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0/g, ' ').trim(); } catch { return ''; }
}

// E18＋E16 同一口径：租约只认「pid 存活＋命令行仍是自己登记的那个进程」。
// 写租约时抓一份自己的外部命令行快照；pid 被回收给无关进程时命令行对不上，判陈旧。
// 旧租约没快照时回退按 zjz serve 形状判；读不到命令行时保守按存活处理，不误判、不动手。
function leaseIsLiveServe(existing) {
  const pid = Number(existing && existing.pid);
  if (!Number.isInteger(pid) || pid <= 0 || !pidAlive(pid)) return false;
  const cmdline = readProcessCommandLine(pid);
  const snapshot = typeof existing.cmdline_snapshot === 'string' ? existing.cmdline_snapshot.trim() : '';
  if (snapshot) return Boolean(cmdline) && cmdline.trim() === snapshot;
  if (!cmdline) return true;
  return /zjz\.mjs/i.test(cmdline) && /\bserve\b/i.test(cmdline);
}
function acquireLease(home) {
  return withLock(() => {
    const file = leaseFile(home);
    const existing = readJson(file);
    if (existing && leaseIsLiveServe(existing)) {
      return {
        ok: false,
        code: 'ALREADY_RUNNING',
        message: `serve 已运行：pid=${existing.pid}`,
        address: existing.port ? `http://127.0.0.1:${existing.port}` : null,
      };
    }
    // E18：死租约/pid 被回收给无关进程＝环境残骸，就地清掉继续起，不得报产品红。
    const stale_lease_cleared = Boolean(existing);
    const lease = {
      pid: process.pid,
      port: null,
      host: '127.0.0.1',
      home: homeDir(home),
      session_id: 0,
      cmdline_snapshot: readProcessCommandLine(process.pid),
      started_at: new Date().toISOString(),
    };
    atomicJson(file, lease);
    return { ok: true, lease, file, stale_lease_cleared };
  }, 5000, home);
}
function releaseLease(home) {
  withLock(() => {
    const file = leaseFile(home);
    const existing = readJson(file);
    if (existing && Number(existing.pid) === process.pid) {
      try { fs.unlinkSync(file); } catch { /* ignore */ }
    }
  }, 5000, home);
}

function status(home) {
  const lease = readJson(leaseFile(home));
  const running = Boolean(lease && Number(lease.pid) !== process.pid && pidAlive(Number(lease.pid)));
  return {
    ok: true,
    running,
    lease: running ? lease : null,
    address: running && lease.port ? `http://127.0.0.1:${lease.port}` : null,
  };
}

class Broker {
  constructor(home) {
    this.home = home;
    this.clients = new Set();
    this.timer = setInterval(() => this.scan(), POLL_MS);
    this.timer.unref?.();
    this.supervisorTimer = setInterval(() => this.supervise(), 1000);
    this.supervisorTimer.unref?.();
    // huddo 房讯直播→镜像房→即时 wake（关键路径越权代接：feed→唤醒器实弹所需，15s 节奏；Codex 可重构）。
    this.feedTimer = setInterval(() => this.feedScan(), 15000);
    // E22：serve 起来先对账孤儿 batch，别让用户等一个租期才解锁。
    try { wakeApi.reconcileBatches(home); } catch { /* 对账失败不挡启动 */ }
    this.feedTimer.unref?.();
  }

  subscribe(roomId, slug, response) {
    const initial = msg.read(this.home, slug, roomId, { after: 0 });
    if (!initial.ok) return initial;
    const cursor = initial.messages.reduce((max, row) => Math.max(max, Number(row.seq) || 0), 0);
    const client = { roomId, slug, response, cursor };
    this.clients.add(client);
    wakeApi.touchChannel(this.home, slug);
    response.on('close', () => {
      this.clients.delete(client);
      wakeApi.clearChannel(this.home, slug);
    });
    response.write('event: ready\ndata: {"ok":true}\n\n');
    return { ok: true, client };
  }

  scan() {
    for (const client of [...this.clients]) {
      try {
        const result = msg.read(this.home, client.slug, client.roomId, { after: client.cursor });
        if (!result.ok) continue;
        for (const message of result.messages) {
          client.response.write(`event: message\ndata: ${JSON.stringify(message)}\n\n`);
          client.cursor = Math.max(client.cursor, Number(message.seq) || 0);
          // E36：消息真正写到该成员的 SSE 流上＝已投递到他。这一刻记 pushed_at，
          // 覆盖「发帖时还没上线、后来才连上」的情况（总管实弹：台账 pushed 偶发未写）。
          try {
            deliveryApi.markPushedByMessage(this.home, { room_id: client.roomId, msg_id: message.id, sender: message.author, recipient: client.slug });
          } catch { /* 台账写失败不挡推送 */ }
        }
      } catch {
        this.clients.delete(client);
      }
    }
  }

  close() {
    clearInterval(this.timer);
    clearInterval(this.supervisorTimer);
    clearInterval(this.feedTimer);
    for (const client of this.clients) {
      try { client.response.end(); } catch { /* ignore */ }
    }
    this.clients.clear();
  }

  feedScan() {
    // 一次性子进程跑 feed 轮询（与 wake-exec 同型）：feed.poll 内 spawnSync 会阻塞本进程 HTTP/SSE（实弹实测卡 5s）。
    // 关键路径越权针修正，Codex 可重构但非阻塞语义必须在。
    if (this.feedBusy) return;
    this.feedBusy = true;
    const child = spawn(process.execPath, [CLI, '--home', this.home, 'feed', 'poll', '--limit', '30'], {
      cwd: path.dirname(CLI), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    child.stdout.on('data', (chunk) => { stdout += String(chunk); });
    child.on('exit', () => {
      this.feedBusy = false;
      try {
        const result = JSON.parse(stdout);
        const registered = memberApi.list(this.home);
        for (const record of result.new_records || []) {
          const handle = String(record.from || '');
          const row = registered.ok
            ? registered.members.find((item) => item.slug === handle || (Array.isArray(item.mention_handles) && item.mention_handles.includes(handle)))
            : null;
          if (row) {
            const answered = deliveryApi.markAnsweredByAuthor(this.home, { author: row.slug });
            if (answered.ok && answered.updated > 0 && record.ext_id) wakeApi.noteAnsweredExt(this.home, [record.ext_id]);
          }
        }
      } catch { /* feed 输出坏不影响 wake */ }
      try { wakeApi.tick(this.home); } catch { /* 下轮自愈 */ }
    });
    child.on('error', () => { this.feedBusy = false; });
  }

  supervise() {
    try {
      deliveryApi.tick(this.home);
      wakeApi.tick(this.home);
    } catch {
      appendEvent(this.home, {
        project: 'wake',
        type: 'supervisor.revive',
        actor: 'serve',
        subject: 'delivery-supervisor',
        payload: { session_id: 0, reason: 'tick_error', interval_ms: 1000 },
      });
    }
  }
}

function json(response, status, payload) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(payload));
}

function statusFor(code) {
  if (code === 'NOT_MEMBER') return 403;
  if (code === 'NOT_FOUND') return 404;
  if (code === 'BAD_INPUT') return 400;
  return 500;
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    let body = '';
    request.on('data', (chunk) => {
      body += chunk;
      if (body.length > 1024 * 1024) reject(new Error('body too large'));
    });
    request.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (error) {
        reject(error);
      }
    });
    request.on('error', reject);
  });
}

function contentTypeFor(file) {
  const ext = path.extname(file).toLowerCase();
  return {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon',
    '.woff2': 'font/woff2',
  }[ext] || 'application/octet-stream';
}

function serveStatic(request, response, url) {
  const rawPath = String(request.url || '').split('?')[0];
  const decodedPath = (() => {
    try { return decodeURIComponent(rawPath); } catch { return null; }
  })();
  const unsafe = decodedPath === null
    || decodedPath.includes('\0')
    || decodedPath.startsWith('//')
    || /(^|\/)\.\.(?:\/|$)/.test(decodedPath);
  if (unsafe) {
    json(response, 403, { ok: false, code: 'STATIC_FORBIDDEN', message: '静态路径越界' });
    return true;
  }
  const publicRoot = path.resolve(HERE, '..', 'public');
  const relative = decodedPath === '/' || decodedPath === '' ? 'index.html' : decodedPath.replace(/^\/+/, '');
  const file = path.resolve(publicRoot, relative);
  if (file !== publicRoot && !file.startsWith(publicRoot + path.sep)) {
    json(response, 403, { ok: false, code: 'STATIC_FORBIDDEN', message: '静态路径越界' });
    return true;
  }
  let stat;
  try { stat = fs.statSync(file); } catch { return false; }
  if (!stat.isFile()) return false;
  const headers = {
    'content-type': contentTypeFor(file),
    'content-length': String(stat.size),
  };
  if (path.extname(file).toLowerCase() === '.html') headers['cache-control'] = 'no-store';
  response.writeHead(200, headers);
  if (request.method === 'HEAD') response.end();
  else response.end(fs.readFileSync(file));
  return true;
}

function makeHandler(home, broker) {
  return async (request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    try {
      if ((request.method === 'GET' || request.method === 'HEAD') && !url.pathname.startsWith('/api/')) {
        if (serveStatic(request, response, url)) return;
        json(response, 404, { ok: false, code: 'NOT_FOUND', message: 'route not found' });
        return;
      }
      if (request.method === 'GET' && url.pathname === '/api/health') {
        json(response, 200, { ok: true, service: 'zjz-serve', host: '127.0.0.1', session_id: 0, current_slug: currentSlug(home) });
        return;
      }
      if (request.method === 'GET' && url.pathname === '/api/members') {
        const file = path.join(homeDir(home), 'data', 'index.json');
        let index = { identities: {} };
        try { index = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* empty */ }
        const current = url.searchParams.get('slug') || null;
        json(response, 200, { ok: true, current_slug: current, slugs: Object.keys(index.identities || {}) });
        return;
      }
      if (request.method === 'GET' && url.pathname === '/api/rooms') {
        const slug = url.searchParams.get('slug') || currentSlug(home);
        const result = room.list(home, slug);
        if (result.ok) result.current_slug = slug;
        json(response, result.ok ? 200 : statusFor(result.code), result);
        return;
      }
      if (request.method === 'GET' && url.pathname === '/api/search') {
        const result = searchApi.query(home, {
          q: url.searchParams.get('q') || '',
          room_id: url.searchParams.get('room_id') || undefined,
          slug: url.searchParams.get('slug') || undefined,
          sender: url.searchParams.get('sender') || undefined,
          since: url.searchParams.get('since') || undefined,
          until: url.searchParams.get('until') || undefined,
          limit: url.searchParams.get('limit') ? Number(url.searchParams.get('limit')) : undefined,
        });
        json(response, result.ok ? 200 : statusFor(result.code), result);
        return;
      }
      if (request.method === 'GET' && url.pathname === '/api/skills') {
        const q = url.searchParams.get('q');
        const result = q ? skillApi.search(home, { q }) : skillApi.list(home);
        json(response, result.ok ? 200 : statusFor(result.code), result);
        return;
      }
      // E30-B：只有帐主人（客户）能请/移出智能体——智能体不能自请、不能互相拉人。
      const requireOwner = (by, roomId) => {
        const s = String(by || '').trim();
        if (!s) return { ok: false, code: 'BAD_INPUT', message: '缺少操作者身份（by）——只有帐主人能请智能体' };
        const roster = room.members(home, s, roomId);
        if (!roster.ok) return { ok: false, code: 'NOT_OPERATOR', message: '只有本帐主人（客户）能请智能体加入' };
        const me = (roster.members || []).find((m) => m.slug === s);
        if (!me || me.role !== 'owner') return { ok: false, code: 'NOT_OPERATOR', message: '只有本帐主人（客户）能请智能体加入' };
        return { ok: true };
      };
      // E30：客户机器上千差万别——自动探测本机装了哪些智能体，不能写死路径。
      // E32：客户要看到「机器上所有项目房间」——新建的房也必须在列，否则拉人时找不到自己刚建的房。
      if (request.method === 'GET' && url.pathname === '/api/rooms/all') {
        const root = path.join(homeDir(home), 'data', 'rooms');
        const all = [];
        try {
          for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
            if (!entry.isDirectory()) continue;
            const meta = readJson(path.join(root, entry.name, 'meta.json')) || {};
            const rows = readJson(path.join(root, entry.name, 'members.json')) || [];
            all.push({
              room_id: entry.name,
              name: meta.name || entry.name,
              owner: meta.owner || null,
              members: rows.map((r) => r && r.slug).filter(Boolean),
              archived: Boolean(meta.archived),
            });
          }
        } catch { /* 没有房间 */ }
        json(response, 200, { ok: true, rooms: all });
        return;
      }
      if (request.method === 'GET' && url.pathname === '/api/agents/discover') {
        const found = [];
        const seen = new Set();
        const push = (name, exe, source) => { const key = String(exe).toLowerCase(); if (!exe || seen.has(key)) return; seen.add(key); found.push({ name, exe, source }); };
        const which = (cmd) => {
          try {
            const r = spawnSync(process.platform === 'win32' ? 'where.exe' : 'which', [cmd], { encoding: 'utf8', windowsHide: true, timeout: 5000 });
            const line = String(r.stdout || '').split(/\r?\n/).map((x) => x.trim()).filter(Boolean)[0];
            return line || '';
          } catch { return ''; }
        };
        // ① PATH 里找通用 CLI
        for (const [name, cmd] of [['OpenCode', 'opencode-cli'], ['Codex', 'codex'], ['Claude', 'claude'], ['Gemini', 'gemini'], ['Qwen', 'qwen']]) {
          const p = which(cmd); if (p) push(name, p, 'PATH');
        }
        // ② 常见安装位置（不在 PATH 的桌面版）
        const roots = [
          path.join(process.env.APPDATA || '', 'ai.opencode.desktop', 'cli'),
          path.join(process.env.LOCALAPPDATA || '', 'OpenAI', 'Codex', 'bin'),
          path.join(process.env.LOCALAPPDATA || '', 'Programs'),
          process.env.APPDATA || '',
        ];
        const probes = [['OpenCode', 'opencode-cli.exe'], ['Codex', 'codex.exe'], ['Claude', 'claude.exe']];
        for (const root of roots) {
          for (const [name, bin] of probes) {
            try {
              for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
                const p = entry.isDirectory() ? path.join(root, entry.name, bin) : path.join(root, entry.name);
                if (entry.name.toLowerCase() === bin.toLowerCase() || (entry.isDirectory() && fs.existsSync(path.join(root, entry.name, bin)))) {
                  if (fs.existsSync(p)) push(name, p, '安装目录');
                }
              }
            } catch { /* 目录不存在 */ }
          }
        }
        json(response, 200, { ok: true, agents: found, platform: process.platform });
        return;
      }
      // E29：让用户在界面上「请智能体进帐」——不用命令行，不用我代跑。
      if (request.method === 'GET' && url.pathname === '/api/agents') {
        const listed = memberApi.list(home);
        const rows = listed.ok ? listed.members : [];
        const agents = rows.map((row) => {
          const w = memberApi.wiring(home, row.slug);
          const rooms = w.ok ? w.rooms.map((item) => {
            const meta = readJson(path.join(homeDir(home), 'data', 'rooms', item.room_id, 'meta.json')) || {};
            return { ...item, owner: meta.owner || null };
          }) : [];
          return { ...row, has_identity: w.ok ? w.has_identity : false, rooms, wired: w.ok ? w.wired : false, warning: w.ok ? w.warning : null };
        });
        json(response, 200, { ok: true, agents });
        return;
      }
      // E29-B：请出去。移出房名单＋解绑适配器，让它不再被唤醒（身份保留，档案不删，随时可再请回）。
      if (request.method === 'POST' && url.pathname === '/api/agents/remove') {
        const body = await readBody(request) || {};
        const guard = requireOwner(body && body.by, body && body.room_id);
        if (!guard.ok) { json(response, 403, guard); return; }
        const s = String(body.slug || '').trim();
        const roomId = String(body.room_id || '').trim();
        if (!s) { json(response, 400, { ok: false, code: 'BAD_INPUT', message: 'slug 必填' }); return; }
        const out = { ok: true, slug: s, removed_from: [], still_in_rooms: [], adapter_unbound: false };
        if (roomId) {
          const mf = path.join(homeDir(home), 'data', 'rooms', roomId, 'members.json');
          try {
            const rows = JSON.parse(fs.readFileSync(mf, 'utf8')) || [];
            const keep = rows.filter((r) => r && r.slug !== s);
            if (keep.length !== rows.length) {
              fs.writeFileSync(mf, JSON.stringify(keep, null, 2) + '\n', 'utf8');
              out.removed_from.push(roomId);
            }
          } catch { /* 无房名单 */ }
        }
        const remaining = memberApi.wiring(home, s);
        out.still_in_rooms = remaining.ok ? remaining.rooms.map((row) => row.room_id) : [];
        const af = path.join(homeDir(home), 'data', 'members', `${s}.json`);
        if (out.still_in_rooms.length === 0 && fs.existsSync(af)) {
          fs.unlinkSync(af);
          out.adapter_unbound = true;
        }
        json(response, 200, out);
        return;
      }
      if (request.method === 'POST' && url.pathname === '/api/agents/invite') {
        const body = await readBody(request);
        const guard = requireOwner(body && body.by, body && body.room_id);
        if (!guard.ok) { json(response, 403, guard); return; }
        // 接收：slug/name/room_id/adapter_kind/argv/url/method/headers/env/timeout_ms/cooldown_ms/max_consecutive/wake_policy/mention_handles/instructions
        const result = memberApi.wire(home, body || {});
        if (result.ok && result.wiring && Array.isArray(result.wiring.rooms)) {
          result.wiring.rooms = result.wiring.rooms.map((item) => {
            const meta = readJson(path.join(homeDir(home), 'data', 'rooms', item.room_id, 'meta.json')) || {};
            return { ...item, owner: meta.owner || null };
          });
        }
        json(response, result.ok ? 200 : statusFor(result.code), result);
        return;
      }
      // 开新项目／房间：建房人即房主（客户自助，不用命令行）。
      if (request.method === 'POST' && url.pathname === '/api/rooms/create') {
        const body = await readBody(request);
        const by = String((body && body.by) || '').trim();
        if (!by) { json(response, 400, { ok: false, code: 'BAD_INPUT', message: '缺少建房人身份（by）' }); return; }
        const result = room.create(home, by, body && body.name);
        json(response, result.ok ? 200 : statusFor(result.code), result);
        return;
      }
      // 首次启动/本机单用户：创建一个可用的建房身份，避免桌面端因无身份而不能建房。
      if (request.method === 'POST' && url.pathname === '/api/identity/create') {
        const body = await readBody(request);
        const name = String((body && body.name) || '主人').trim() || '主人';
        const result = identity.create(home, name);
        json(response, result.ok ? 200 : statusFor(result.code), result);
        return;
      }
      // 参谋长（会员版）：下达目标 → 拆解 → 派活 → 汇总，把汇报发回房间（一人成军的入口）。
      if (request.method === 'POST' && url.pathname === '/api/chief') {
        const body = await readBody(request);
        const goal = String((body && body.goal) || '').replace(/^参谋长[：:]\s*/, '').trim();
        const by = String((body && body.by) || '').trim();
        const room_id = String((body && body.room_id) || '').trim();
        if (!goal) { json(response, 400, { ok: false, code: 'BAD_INPUT', message: '参谋长要一个目标（goal）' }); return; }
        if (room_id && !by) {
          json(response, 400, { ok: false, code: 'BAD_INPUT', message: '指定 room_id 时必须提供报告发送人 by' });
          return;
        }
        if (room_id) {
          const memberCheck = room.members(home, by, room_id);
          if (!memberCheck.ok) {
            json(response, statusFor(memberCheck.code), {
              ...memberCheck,
              code: memberCheck.code || 'NOT_MEMBER',
              message: '报告发送人不在目标房间，参谋长任务未启动',
            });
            return;
          }
        }
        // 会员模块按需加载：免费包不含这些文件，静态 import 会让整个 CLI/serve 起不来。
        let chief;
        try {
          const [schedulerModule, summarizerModule, supervisorModule] = await Promise.all([
            import('./scheduler.js'),
            import('./summarizer.js'),
            import('./supervisor.js'),
          ]);
          chief = {
            scheduler: schedulerModule.scheduler,
            summarizer: summarizerModule.summarizer,
            supervisor: supervisorModule.supervisor,
          };
        } catch (error) {
          json(response, 403, {
            ok: false,
            code: 'FEATURE_NOT_AVAILABLE',
            message: '当前安装包不含会员模块「参谋长」',
            detail: String(error && error.message ? error.message : error),
          });
          return;
        }
        const ran = await chief.scheduler.runGoalSmart(home, goal);
        if (!ran.ok) { json(response, 500, ran); return; }
        const report = chief.summarizer.summarizeText(ran.plan);
        const review = chief.supervisor.reviewText(ran.plan);
        const summary = `${report}\n\n${review}`;
        // 汇报发回房间（让主人在聊天流里看到，不弹窗）
        let posted = null;
        if (room_id) {
          posted = msg.send(home, by, room_id, summary, {});
          if (!posted.ok) {
            json(response, statusFor(posted.code), {
              ok: false,
              code: 'REPORT_POST_FAILED',
              message: '参谋长已执行，但报告发回房间失败',
              cause: posted,
              plan_id: ran.plan_id,
            });
            return;
          }
        }
        json(response, 200, { ok: true, plan_id: ran.plan_id, goal, dispatched: ran.dispatched, report, review, posted });
        return;
      }
      // 删房：能建就能删。仅房主可删（不可恢复，删前确认）。
      if (request.method === 'POST' && url.pathname === '/api/rooms/delete') {
        const body = await readBody(request);
        const by = String((body && body.by) || '').trim();
        const room_id = String((body && body.room_id) || '').trim();
        if (!by || !room_id) { json(response, 400, { ok: false, code: 'BAD_INPUT', message: '缺 by（操作者）或 room_id' }); return; }
        const result = room.remove(home, by, room_id);
        json(response, result.ok ? 200 : statusFor(result.code), result);
        return;
      }
      if (request.method === 'GET' && url.pathname === '/api/duty/board') {
        const delivery = deliveryApi.board(home, {});
        const registered = memberApi.list(home);
        const listenState = listenApi.status(home);
        const index = readJson(path.join(homeDir(home), 'data', 'index.json')) || { identities: {} };
        // 红靶二：identities ∪ members 并集——只有成员档案没有同名身份的 slug 也必须上板。
        const slugs = [...new Set([...Object.keys(index.identities || {}), ...((registered.ok ? registered.members : []) || []).map((row) => row.slug)])];
        const rows = delivery.ok ? delivery.rows : [];
        const members = slugs.map((slug) => {
          const row = registered.ok ? registered.members.find((item) => item.slug === slug) : null;
          const mine = rows.filter((item) => item.recipient === slug);
          const pending = mine.filter((item) => item.status === 'posted' || item.status === 'pushed');
          return {
            slug,
            // listening 必须是**成员级**：它自己的 SSE 通道在不在线，不是全局 listen 租约（全局为真会让失联成员全显示在线，I48 假绿）。
            listening: Boolean(row) && wakeApi.channelActive(home, slug),
            pending_unread: pending.length,
            sla: mine.some((item) => item.read_late || item.answered_late) ? 'late' : '',
            adapter_kind: row ? row.adapter_kind : null,
          };
        });
        const orders = rows.filter((item) => item.order_id).map((item) => ({ order_id: item.order_id, delivery_id: item.delivery_id, recipient: item.recipient, sla: item.answered_late ? 'late' : '' }));
        json(response, 200, { ok: true, listening: Boolean(listenState.ok && listenState.running), members, orders, deliveries: rows });
        return;
      }
      const messagesMatch = url.pathname.match(/^\/api\/rooms\/([^/]+)\/messages$/);
      const roomMembersMatch = url.pathname.match(/^\/api\/rooms\/([^/]+)\/members$/);
      if (roomMembersMatch && request.method === 'GET') {
        // E24：身份下拉必须只列「本房成员」，否则挑到非成员一发就 NOT_MEMBER（主人实弹：信息发不出）。
        const roomId = decodeURIComponent(roomMembersMatch[1]);
        const slug = String(url.searchParams.get('slug') || '');
        const result = room.members(home, slug, roomId);
        if (result.ok) { json(response, 200, result); return; }
        // E24-B：非成员也允许读名单——本机单用户、名单非敏感；否则身份下拉收不窄，主人又挑到发不出去的人（实弹复现）。
        try {
          const rows = readJson(path.join(homeDir(home), 'data', 'rooms', roomId, 'members.json')) || [];
          json(response, 200, { ok: true, room_id: roomId, public_read: true, members: rows.map((r) => ({ slug: r.slug, role: r.role || 'member', unread: 0 })) });
          return;
        } catch { /* 落回原错误 */ }
        json(response, statusFor(result.code), result);
        return;
      }
      if (messagesMatch && request.method === 'GET') {
        const roomId = decodeURIComponent(messagesMatch[1]);
        const slug = url.searchParams.get('slug');
        const after = url.searchParams.get('after');
        const limit = url.searchParams.get('limit');
        if (!slug) {
          // 报错点名缺哪个查询参数，别让人对着笼统 400 猜（实测客户反馈：不知道缺啥）
          json(response, 400, { ok: false, code: 'BAD_INPUT', message: '缺少查询参数 slug：GET /api/rooms/<room>/messages?slug=<你的身份> 必带 slug（当前身份是谁）', missing: 'query.slug', example: '/api/rooms/' + roomId + '/messages?slug=zjz-xxx' });
          return;
        }
        const result = msg.read(home, slug, roomId, {
          after: after === null ? undefined : Number(after),
          limit: limit === null ? undefined : Number(limit),
        });
        // E27：补可读显示名。author 只是 slug（zjz-xxx-17942...），界面上看不出是谁；
        // 从身份档案取 name，取不到就退化成「前缀 (by 尾号)」，与 Huddo 的『Codex (by 972928)』同构。
        if (result.ok && Array.isArray(result.messages)) {
          const nameCache = new Map();
          for (const row of result.messages) {
            const a = String(row.author || '');
            if (!nameCache.has(a)) {
              let display = '';
              try { display = String((readJson(path.join(homeDir(home), 'data', 'identities', a, 'profile.json')) || {}).name || ''); } catch { /* 无档案 */ }
              if (!display) {
                const parts = a.split('-');
                const tail = parts.length > 1 ? parts[parts.length - 1] : '';
                display = (parts[1] || a) + (tail ? ' (by ' + tail.slice(0, 6) + ')' : '');
              }
              nameCache.set(a, display);
            }
            row.display_name = nameCache.get(a);
          }
        }
        json(response, result.ok ? 200 : statusFor(result.code), result);
        return;
      }
      if (messagesMatch && request.method === 'POST') {
        const roomId = decodeURIComponent(messagesMatch[1]);
        const body = await readBody(request);
        const result = msg.send(home, body.slug, roomId, body.text, {
          reply_to: body.reply_to,
          mentions: body.mentions,
        });
        if (result.ok) {
          const members = room.members(home, body.slug, roomId);
          if (members.ok) {
            // E22 第3条：原生房来回也记 answered，别只挂 huddo feed 那一路。
            deliveryApi.markAnsweredByAuthor(home, { author: body.slug });
            for (const row of members.members) {
              if (row.slug === body.slug) continue;
              deliveryApi.post(home, {
                room_id: roomId,
                msg_id: result.id,
                sender: body.slug,
                recipient: row.slug,
              });
              // E31：在线即推＝已投递到该成员。台账 pushed_at 必须当场写，否则它一直挂在 posted，
              // 「投递到位」在账上看不出来（总管实弹：台账 pushed 字段未写）。离线的留给 wake 推时再记。
              if (wakeApi.channelActive(home, row.slug)) {
                deliveryApi.markPushedByMessage(home, { room_id: roomId, msg_id: result.id, sender: body.slug, recipient: row.slug });
              }
            }
          }
        }
        json(response, result.ok ? 200 : statusFor(result.code), result);
        return;
      }
      const streamMatch = url.pathname.match(/^\/api\/rooms\/([^/]+)\/stream$/);
      if (streamMatch && request.method === 'GET') {
        const roomId = decodeURIComponent(streamMatch[1]);
        const member = url.searchParams.get('member');
        const check = room.members(home, member, roomId);
        if (!check.ok) {
          json(response, statusFor(check.code), check);
          return;
        }
        response.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
        });
        broker.subscribe(roomId, member, response);
        return;
      }
      json(response, 404, { ok: false, code: 'NOT_FOUND', message: 'route not found' });
    } catch (error) {
      json(response, 500, { ok: false, code: 'INTERNAL', message: String(error && error.message ? error.message : error) });
    }
  };
}

export async function start(home, options = {}) {
  const acquired = acquireLease(home);
  if (!acquired.ok) return acquired;
  const host = '127.0.0.1';
  const port = Number(options.port ?? DEFAULT_PORT);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    releaseLease(home);
    return { ok: false, code: 'BAD_INPUT', message: 'port 必须是 0..65535 整数' };
  }
  const broker = new Broker(home);
  const server = http.createServer(makeHandler(home, broker));
  try {
    await new Promise((resolve, reject) => {
      const onError = (error) => reject(error);
      server.once('error', onError);
      server.listen(port, host, () => {
        server.off('error', onError);
        resolve();
      });
    });
  } catch (error) {
    broker.close();
    releaseLease(home);
    if (error && error.code === 'EADDRINUSE') {
      return { ok: false, code: 'ALREADY_RUNNING', message: '端口已被占用', address: `http://${host}:${port}` };
    }
    return { ok: false, code: 'INTERNAL', message: String(error && error.message ? error.message : error) };
  }
  const addressInfo = server.address();
  const actualPort = Number(addressInfo.port);
  const lease = { ...acquired.lease, port: actualPort };
  atomicJson(leaseFile(home), lease);
  return {
    ok: true,
    host,
    port: actualPort,
    address: `http://${host}:${actualPort}`,
    server,
    lease,
    stale_lease_cleared: acquired.stale_lease_cleared === true,
    close: async () => {
      broker.close();
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
      releaseLease(home);
    },
  };
}

export function stop(home) {
  const lease = readJson(leaseFile(home));
  if (!lease || !pidAlive(Number(lease.pid))) return { ok: true, stopped: false };
  if (Number(lease.pid) === process.pid) return { ok: false, code: 'BAD_INPUT', message: '不能停止当前 serve 进程自身' };
  // E16 红线：kill 前必须校验 pid+命令行是自己登记的 zjz serve，pid 被回收即不动手。
  if (!leaseIsLiveServe(lease)) {
    return { ok: false, code: 'LEASE_STALE', message: `租约陈旧：pid=${lease.pid} 已不是 zjz serve（可能被系统回收），未杀任何进程。删除 ${leaseFile(home)} 后重试即可`, stale: true };
  }
  try {
    process.kill(Number(lease.pid), 'SIGTERM');
    return { ok: true, stopped: true, pid: Number(lease.pid), address: lease.port ? `http://127.0.0.1:${lease.port}` : null };
  } catch (error) {
    return { ok: false, code: 'STOP_FAILED', message: String(error && error.message ? error.message : error) };
    return { ok: false, code: 'STOP_FAILED', message: String(error && error.message ? error.message : error) };
  }
}

export const serve = { start, status, stop };
export default serve;
