// 中军帐 T-008 · huddo 房讯直播进唤醒器（src/feed.js）（总管）
// 目的：房②这类 huddo 房的新消息 → 导入 zjz（走 ingest 桥，I36/I37 同路）→ 产出 wake 决策层可消费的 pending/mentions。
// 分工：本模块只取数与对账（幂等、游标持久）；何时唤、唤谁的决策在 Codex 的 wake/serve 监督环里调 feed.poll 即可。
// 纪律：外部 huddo 取数走 huddo_cmd（默认上游 CLI），坏行跳过不炸；游标存 data/feed/cursors.json，重跑不重报。
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { room } from './core.js';
import { ingest } from './ingest.js';

class FeedError extends Error {
  constructor(code, message = code) {
    super(message);
    this.name = 'FeedError';
    this.code = code;
  }
}

function ok(payload = {}) {
  return { ok: true, ...payload };
}

function wrap(fn) {
  try {
    return fn();
  } catch (error) {
    if (error instanceof FeedError) return { ok: false, code: error.code, message: error.message };
    return { ok: false, code: 'INTERNAL', message: String(error && error.message ? error.message : error) };
  }
}

function homeDir(home) {
  return path.resolve(home || '.');
}

function cursorFile(home) {
  return path.join(homeDir(home), 'data', 'feed', 'cursors.json');
}

function bindingFile(home) {
  return path.join(homeDir(home), 'data', 'feed', 'bindings.json');
}

function readBindings(home) {
  try {
    return JSON.parse(fs.readFileSync(bindingFile(home), 'utf8'));
  } catch {
    return {};
  }
}

function writeBindings(home, bindings) {
  fs.mkdirSync(path.dirname(bindingFile(home)), { recursive: true });
  fs.writeFileSync(bindingFile(home), JSON.stringify(bindings, null, 2) + '\n', 'utf8');
}

// bind：装机对表——为 huddo 房建 zjz 镜像房（导入身份 slug 为成员）。演示/生产中每房一次。
export function bind(home, options = {}) {
  return wrap(() => {
    const o = options && typeof options === 'object' ? options : {};
    const huddoRoom = typeof o.huddo_room === 'string' ? o.huddo_room.trim() : '';
    const slug = typeof o.slug === 'string' ? o.slug.trim() : '';
    const name = typeof o.name === 'string' && o.name.trim() !== '' ? o.name.trim() : `huddo:${huddoRoom.slice(0, 12)}`;
    if (huddoRoom === '' || slug === '') throw new FeedError('BAD_INPUT', 'huddo_room 与 slug 必填');
    const bindings = readBindings(home);
    if (bindings[huddoRoom]) return ok({ bound: bindings[huddoRoom], existed: true });
    const created = room.create(home, slug, name);
    if (!created.ok) throw new FeedError(created.code || 'ROOM_FAILED', created.message);
    const entry = { zjz_room: created.room_id, slug, name, huddo_home: typeof o.huddo_home === 'string' ? o.huddo_home : null };
    bindings[huddoRoom] = entry;
    writeBindings(home, bindings);
    return ok({ bound: entry, existed: false });
  });
}

export function bindings(home) {
  return wrap(() => ok({ bindings: readBindings(home) }));
}

function readCursors(home) {
  try {
    return JSON.parse(fs.readFileSync(cursorFile(home), 'utf8'));
  } catch {
    return {};
  }
}

function writeCursors(home, cursors) {
  fs.mkdirSync(path.dirname(cursorFile(home)), { recursive: true });
  const tmp = `${cursorFile(home)}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(cursors, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, cursorFile(home));
}

// huddo read 行格式：#<seq> <msg_id> | <handle> (<显示名>) | <ts> | <text（可含 \n 转义）>
const LINE_RE = /^#(\d+)\s+(\S+)\s+\|\s+(\S+)(?:\s+\((.*?)\))?\s+\|\s+(\S+)\s+\|\s+([\s\S]*)$/;

function parseRecords(stdoutBuf) {
  const text = stdoutBuf.toString('utf8');
  const records = [];
  // 行边界＝以 #<num> 开头的消息头；其余行并入上一条（huddo 导出多行消息把换行显示为 \n 字面，保守起见都并）
  for (const line of text.split(/\r?\n/)) {
    const m = LINE_RE.exec(line);
    if (m) {
      records.push({ seq: Number(m[1]), ext_id: m[2], handle: m[3], display: m[4] || '', ts: m[5], text: m[6] });
    } else if (records.length > 0 && line.trim() !== '') {
      records[records.length - 1].text += '\n' + line;
    }
  }
  return records;
}

// poll：逐房读 huddo（原始 Buffer，防 PowerShell 二次编码坑）→ 只处理 seq>游标 → ingest 入 zjz → 更新游标。
// options: {rooms?: [huddo_room_id]（缺省＝全部 bindings）, huddo_cmd: [node, huddo.mjs], huddo_home, limit}
export function poll(home, options = {}) {
  return wrap(() => {
    const opts = options && typeof options === 'object' ? options : {};
    const binds = readBindings(home);
    const rooms = Array.isArray(opts.rooms) && opts.rooms.length > 0 ? opts.rooms : Object.keys(binds);
    if (rooms.length === 0) throw new FeedError('BAD_INPUT', '无绑定房且未传 rooms（先 feed.bind）');
    const cmd = Array.isArray(opts.huddo_cmd) ? opts.huddo_cmd : [process.execPath, 'D:\\huddo\\mcp\\node_modules\\huddoai\\huddo.mjs'];
    const limit = opts.limit === undefined ? 50 : Number(opts.limit);

    const cursors = readCursors(home);
    const freshAll = [];
    const perRoom = [];
    for (const roomId of rooms) {
      const b = binds[roomId];
      const hH = (b && b.huddo_home) || opts.huddo_home || null;
      const env = { ...process.env, ...(hH ? { HUDDO_HOME: hH } : {}) };
      const res = spawnSync(cmd[0], [...cmd.slice(1), 'read', '--room', roomId, '--limit', String(limit)], { env, maxBuffer: 64 * 1024 * 1024, windowsHide: true });
      if (res.error || res.status !== 0) {
        perRoom.push({ room_id: roomId, ok: false, code: 'HUDDO_READ_FAILED', message: String((res.error && res.error.message) || res.stderr || '').slice(0, 200) });
        continue;
      }
      const parsed = parseRecords(res.stdout || Buffer.alloc(0));
      const binding = binds[roomId];
      if (!binding) { perRoom.push({ room_id: roomId, ok: false, code: 'NOT_BOUND', message: 'huddo 房未绑定 zjz 镜像房（先 feed.bind）', fetched: parsed.length }); continue; }
      const cursor = Number(cursors[roomId] || 0);
      const fresh = parsed.filter((r) => r.seq > cursor);
      if (fresh.length > 0) {
        // 走导入桥入 zjz（ext_id 幂等 I36；房号映射 I37）
        const ing = ingest.records(home, { room_id: binding.zjz_room, slug: binding.slug, source: 'huddo', records: fresh.map((r) => ({ ext_id: r.ext_id, seq: r.seq, author: r.handle, ts: r.ts, text: r.text })) });
        if (!ing.ok) { perRoom.push({ room_id: roomId, ok: false, code: ing.code, message: ing.message }); continue; }
        cursors[roomId] = fresh[fresh.length - 1].seq;
        freshAll.push(...fresh.map((r) => ({ ...r, room_id: roomId })));
      }
      perRoom.push({ room_id: roomId, ok: true, fetched: parsed.length, fresh: fresh.length });
    }
    writeCursors(home, cursors);
    // mentions：文本里 @handle 的简单抽取（huddo 提及语法）；wake 决策层据此点名成员适配器
    const mentions = freshAll
      .map((r) => ({ room_id: r.room_id, ext_id: r.ext_id, seq: r.seq, from: r.handle, ts: r.ts, at: (r.text.match(/@[\w.-]+/g) || []) }))
      .filter((r) => r.at.length > 0);
    return ok({ rooms: perRoom, fresh: freshAll.length, new_records: freshAll.map((r) => ({ room_id: r.room_id, ext_id: r.ext_id, seq: r.seq, from: r.handle })), mentions });
  });
}

export const feed = { bind, bindings, poll };
export default feed;
