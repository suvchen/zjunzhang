// 中军帐 T-007-A 检索模块（src/search.js）
// 两层召回（实现前实测结论钉死，见 T-007-acceptance.md）：
//   ① 召回底线＝norm 列（NFKC → 小写 → 去空白标点）做子串核实 —— 中文二字词也 100% 召回
//   ② 速度预筛＝FTS5(trigram) 只对规范化后 ≥3 字符的查询取候选 rowid，再回 norm 核实（预筛只许减候选、不许减召回）
// 增量：按房 jsonl 记 byte offset，只吃新追加的完整行（I24）；文件变短＝整房重投（防幽灵条目）。
// 对账：audit() 以磁盘 jsonl 为权威做全量 reconcile，顺手清幽灵/去重/补漏，再报数（I23）。
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { DatabaseSync } from 'node:sqlite';
import { mapping as ingestMapping, stripHeader } from './ingest.js';

const DEFAULT_LIMIT = 100;

class SearchError extends Error {
  constructor(code, message = code) {
    super(message);
    this.name = 'SearchError';
    this.code = code;
  }
}

function fail(code, message = code) {
  throw new SearchError(code, message);
}

function ok(payload = {}) {
  return { ok: true, ...payload };
}

function wrap(fn) {
  try {
    return fn();
  } catch (error) {
    if (error instanceof SearchError) return { ok: false, code: error.code, message: error.message };
    return { ok: false, code: 'INTERNAL', message: String(error && error.message ? error.message : error) };
  }
}

function requireString(value, name) {
  if (typeof value !== 'string' || value.trim() === '') fail('BAD_INPUT', `${name} 必须是非空字符串`);
  return value.trim();
}

// ---------- 路径（与 core.js 同构：data/rooms/<room_id>/messages.jsonl）----------

function homeDir(home) {
  if (home !== undefined && home !== null && typeof home !== 'string') fail('BAD_INPUT', 'home 必须是字符串');
  return path.resolve(home || process.env.ZJZ_HOME || process.cwd());
}

function dataDir(home) {
  return path.join(homeDir(home), 'data');
}

function roomsDir(home) {
  return path.join(dataDir(home), 'rooms');
}

function dbFile(home) {
  return path.join(dataDir(home), 'search.sqlite');
}

function messageFile(home, roomId) {
  return path.join(roomsDir(home), roomId, 'messages.jsonl');
}

function listRooms(home) {
  let entries = [];
  try {
    entries = fs.readdirSync(roomsDir(home), { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((roomId) => fs.existsSync(path.join(roomsDir(home), roomId, 'meta.json')));
}

function isMember(home, roomId, slug) {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(roomsDir(home), roomId, 'members.json'), 'utf8'));
    return Array.isArray(raw) && raw.some((member) => member && member.slug === slug);
  } catch {
    return false;
  }
}

// ---------- 规范化 ----------

export function normalizeText(value) {
  return String(value).normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
}

function escapeLike(value) {
  return value.replace(/[\\%_[\]]/g, (ch) => `\\${ch}`);
}

function validTime(value, name) {
  if (typeof value !== 'string' || value.trim() === '' || Number.isNaN(Date.parse(value))) {
    fail('BAD_INPUT', `${name} 必须是可解析的时间字符串`);
  }
  return value.trim();
}

// ---------- 库 ----------

const SCHEMA = `
CREATE TABLE IF NOT EXISTS docs (
  msg_id TEXT NOT NULL,
  room_id TEXT NOT NULL,
  author TEXT NOT NULL,
  ts TEXT NOT NULL,
  seq INTEGER NOT NULL,
  text TEXT NOT NULL,
  norm TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'msg'
);
CREATE INDEX IF NOT EXISTS docs_msg ON docs(msg_id);
CREATE INDEX IF NOT EXISTS docs_room_seq ON docs(room_id, seq);
CREATE INDEX IF NOT EXISTS docs_kind ON docs(kind);
CREATE TABLE IF NOT EXISTS sync_state (room_id TEXT PRIMARY KEY, bytes INTEGER NOT NULL);
`;

function openDb(home) {
  fs.mkdirSync(dataDir(home), { recursive: true });
  const db = new DatabaseSync(dbFile(home));
  db.exec('PRAGMA journal_mode=WAL;');
  db.exec('PRAGMA busy_timeout=3000;');
  db.exec(SCHEMA);
  const cols = db.prepare('PRAGMA table_info(docs)').all().map((col) => col.name);
  if (!cols.includes('kind')) db.exec("ALTER TABLE docs ADD COLUMN kind TEXT NOT NULL DEFAULT 'msg'"); // 旧库升级：技能卡与消息同索引分流
  let ftsReady = true;
  try {
    db.exec("CREATE VIRTUAL TABLE IF NOT EXISTS docs_fts USING fts5(norm, tokenize='trigram');");
  } catch {
    ftsReady = false; // 无 trigram 时退回全扫（召回不受影响，只是慢）
  }
  return { db, ftsReady };
}

function closeDb({ db }) {
  try {
    db.close();
  } catch {
    /* 忽略关闭异常 */
  }
}

function purgeRoom(db, roomId) {
  const rows = db.prepare('SELECT rowid AS rid FROM docs WHERE room_id = ?').all(roomId);
  const delFts = db.prepare('DELETE FROM docs_fts WHERE rowid = ?');
  for (const row of rows) delFts.run(row.rid);
  db.prepare('DELETE FROM docs WHERE room_id = ?').run(roomId);
}

function insertDoc(db, roomId, record, kind = 'msg') {
  if (!record || typeof record.id !== 'string' || record.id === '') return 'corrupt';
  if (!Number.isInteger(record.seq) || typeof record.text !== 'string') return 'corrupt';
  if (db.prepare('SELECT 1 FROM docs WHERE room_id = ? AND msg_id = ? AND kind = ?').get(roomId, record.id, kind)) return 'dup';
  const norm = normalizeText(record.text);
  const info = db
    .prepare('INSERT INTO docs (msg_id, room_id, author, ts, seq, text, norm, kind) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(record.id, roomId, String(record.author ?? ''), String(record.ts ?? ''), record.seq, record.text, norm, kind);
  try {
    db.prepare('INSERT INTO docs_fts (rowid, norm) VALUES (?, ?)').run(info.lastInsertRowid, norm);
  } catch {
    /* 预筛表缺条目只影响速度，不影响召回 */
  }
  return 'added';
}

// 只吃「完整行」的增量；末尾半行不消费，留给下一轮（防并发写半截）
function readCompleteChunk(file, fromBytes) {
  let size = fromBytes;
  let text = '';
  try {
    const fd = fs.openSync(file, 'r');
    try {
      size = fs.fstatSync(fd).size;
      if (size > fromBytes) {
        const buf = Buffer.alloc(size - fromBytes);
        fs.readSync(fd, buf, 0, buf.length, fromBytes);
        text = buf.toString('utf8');
      }
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return { lines: [], consumed: fromBytes, size };
  }
  const cut = text.lastIndexOf('\n');
  if (cut === -1) return { lines: [], consumed: fromBytes, size };
  const complete = text.slice(0, cut);
  const consumed = fromBytes + Buffer.byteLength(complete, 'utf8') + 1;
  return { lines: complete.split('\n').filter((line) => line.trim() !== ''), consumed, size };
}

function syncInto(handle, home) {
  const { db } = handle;
  const stats = { added: 0, duplicates: 0, corrupt: 0, resynced: 0, rooms: 0 };
  const getState = db.prepare('SELECT bytes FROM sync_state WHERE room_id = ?');
  const setState = db
    .prepare('INSERT INTO sync_state (room_id, bytes) VALUES (?, ?) ON CONFLICT(room_id) DO UPDATE SET bytes = excluded.bytes');
  for (const roomId of listRooms(home)) {
    stats.rooms += 1;
    const file = messageFile(home, roomId);
    let size = 0;
    try {
      size = fs.statSync(file).size;
    } catch {
      size = 0;
    }
    const row = getState.get(roomId);
    let prev = row ? Number(row.bytes) : 0;
    if (size < prev) {
      purgeRoom(db, roomId);
      prev = 0;
      stats.resynced += 1;
    }
    const { lines, consumed } = readCompleteChunk(file, prev);
    db.exec('BEGIN');
    try {
      for (const line of lines) {
        let record = null;
        try {
          record = JSON.parse(line);
        } catch {
          stats.corrupt += 1;
          continue;
        }
        const result = insertDoc(db, roomId, record);
        if (result === 'added') stats.added += 1;
        else if (result === 'dup') stats.duplicates += 1;
        else stats.corrupt += 1;
      }
      setState.run(roomId, consumed);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      fail('INTERNAL', `增量索引失败：${error.message}`);
    }
  }
  return stats;
}

function markSynced(db, home) {
  const setState = db
    .prepare('INSERT INTO sync_state (room_id, bytes) VALUES (?, ?) ON CONFLICT(room_id) DO UPDATE SET bytes = excluded.bytes');
  for (const roomId of listRooms(home)) {
    let bytes = 0;
    try {
      const text = fs.readFileSync(messageFile(home, roomId), 'utf8');
      const cut = text.lastIndexOf('\n');
      bytes = cut === -1 ? 0 : Buffer.byteLength(text.slice(0, cut + 1), 'utf8');
    } catch {
      bytes = 0;
    }
    setState.run(roomId, bytes);
  }
}

function readDiskRecords(home) {
  const disk = [];
  let corrupt = 0;
  for (const roomId of listRooms(home)) {
    let text = '';
    try {
      text = fs.readFileSync(messageFile(home, roomId), 'utf8');
    } catch {
      continue;
    }
    for (const line of text.split('\n')) {
      if (line.trim() === '') continue;
      let record = null;
      try {
        record = JSON.parse(line);
      } catch {
        corrupt += 1;
        continue;
      }
      if (!record || typeof record.id !== 'string' || !Number.isInteger(record.seq) || typeof record.text !== 'string') {
        corrupt += 1;
        continue;
      }
      disk.push({ roomId, record });
    }
  }
  return { disk, corrupt };
}

// ---------- 对外 API ----------

export function index(home) {
  return wrap(() => {
    const handle = openDb(home);
    try {
      return ok({ ...syncInto(handle, home), mode: 'incremental' });
    } finally {
      closeDb(handle);
    }
  });
}

export function reindex(home) {
  return wrap(() => {
    const handle = openDb(home);
    try {
      const { db } = handle;
      db.exec('DELETE FROM docs;');
      db.exec('DELETE FROM docs_fts;');
      db.exec('DELETE FROM sync_state;');
      return ok({ ...syncInto(handle, home), mode: 'full' });
    } finally {
      closeDb(handle);
    }
  });
}

export function audit(home) {
  return wrap(() => {
    const handle = openDb(home);
    try {
      const { db } = handle;
      const { disk, corrupt } = readDiskRecords(home);
      const authoritative = new Set(disk.map((item) => `${item.roomId}\u0000${item.record.id}`));
      const delFts = db.prepare('DELETE FROM docs_fts WHERE rowid = ?');
      const delDoc = db.prepare('DELETE FROM docs WHERE rowid = ?');
      const repaired = { ghosts: 0, duplicates: 0, added: 0 };
      const kept = new Set();
      db.exec('BEGIN');
      try {
        for (const row of db.prepare("SELECT rowid AS rid, room_id, msg_id FROM docs WHERE kind = 'msg' ORDER BY rowid").all()) {
          const key = `${row.room_id}\u0000${row.msg_id}`;
          if (!authoritative.has(key)) {
            delFts.run(row.rid);
            delDoc.run(row.rid);
            repaired.ghosts += 1;
            continue;
          }
          if (kept.has(key)) {
            delFts.run(row.rid);
            delDoc.run(row.rid);
            repaired.duplicates += 1;
            continue;
          }
          kept.add(key);
        }
        for (const item of disk) {
          if (kept.has(`${item.roomId}\u0000${item.record.id}`)) continue;
          if (insertDoc(db, item.roomId, item.record) === 'added') {
            repaired.added += 1;
            kept.add(`${item.roomId}\u0000${item.record.id}`);
          }
        }
        markSynced(db, home);
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        fail('INTERNAL', `对账失败：${error.message}`);
      }
      const indexed = Number(db.prepare("SELECT COUNT(*) AS c FROM docs WHERE kind = 'msg'").get().c);
      const cards = Number(db.prepare("SELECT COUNT(*) AS c FROM docs WHERE kind = 'skill'").get().c);
      const messages = disk.length;
      const duplicates = Number(
        db.prepare("SELECT COUNT(*) AS c FROM (SELECT room_id, msg_id FROM docs WHERE kind = 'msg' GROUP BY room_id, msg_id HAVING COUNT(*) > 1)").get().c,
      );
      const ghosts = Number(
        db.prepare("SELECT COUNT(*) AS c FROM docs WHERE kind = 'msg' AND room_id NOT IN (SELECT room_id FROM sync_state)").get().c,
      );
      return ok({
        messages,
        indexed,
        cards,
        duplicates,
        missing: Math.max(0, messages - indexed),
        ghosts,
        intact: messages === indexed && duplicates === 0 && ghosts === 0,
        repaired,
        corrupt,
      });
    } finally {
      closeDb(handle);
    }
  });
}

export function query(home, options = {}) {
  return wrap(() => {
    const started = Date.now();
    const opts = options && typeof options === 'object' ? options : {};
    const q = requireString(opts.q, 'q');
    const normQ = normalizeText(q);
    if (normQ === '') fail('BAD_INPUT', 'q 规范化后为空');

    const since = opts.since === undefined ? null : validTime(opts.since, 'since');
    const until = opts.until === undefined ? null : validTime(opts.until, 'until');

    let limit = opts.limit === undefined ? DEFAULT_LIMIT : opts.limit;
    if (!Number.isInteger(limit) || limit < 1) fail('BAD_INPUT', 'limit 必须是正整数');

    let senders = null;
    if (opts.sender !== undefined) {
      senders = Array.isArray(opts.sender) ? opts.sender : [opts.sender];
      if (senders.length === 0) fail('BAD_INPUT', 'sender 不得为空数组');
      senders = senders.map((sender) => requireString(sender, 'sender'));
    }

    const slug = opts.slug === undefined ? null : requireString(opts.slug, 'slug');
    const roomId = opts.room_id === undefined ? null : requireString(opts.room_id, 'room_id');
    if (roomId && !fs.existsSync(path.join(roomsDir(home), roomId, 'meta.json'))) fail('NOT_FOUND', '房间不存在');

    let allowedRooms = null;
    if (slug !== null) {
      allowedRooms = new Set(listRooms(home).filter((room) => isMember(home, room, slug)));
      if (roomId !== null && !allowedRooms.has(roomId)) fail('NOT_MEMBER', '该成员不是此房成员');
    }

    const handle = openDb(home);
    try {
      syncInto(handle, home); // 增量补投：满足「send 后 2 秒内可检索」
      const { db, ftsReady } = handle;
      const mapped = ingestMapping(home, {});
      const extByMsg = new Map();
      if (mapped.ok) {
        for (const row of mapped.mapping) extByMsg.set(`${row.room_id}\u0000${row.msg_id}`, row.ext_id);
      }

      const kind = opts.kind === undefined ? 'msg' : String(opts.kind);
      if (!['msg', 'skill', 'all'].includes(kind)) fail('BAD_INPUT', 'kind 只能是 msg / skill / all');
      let rowids;
      if (ftsReady && [...normQ].length >= 3) {
        const phrase = `"${normQ.replace(/"/g, '""')}"`;
        let sql = 'SELECT d.rowid AS rid FROM docs_fts f JOIN docs d ON d.rowid = f.rowid WHERE docs_fts MATCH ?';
        const params = [phrase];
        if (roomId !== null) {
          sql += ' AND d.room_id = ?';
          params.push(roomId);
        }
        if (kind !== 'all') {
          sql += ' AND d.kind = ?';
          params.push(kind);
        }
        rowids = db.prepare(sql).all(...params).map((row) => row.rid);
      } else {
        let sql = "SELECT rowid AS rid FROM docs d WHERE norm LIKE ? ESCAPE '\\'";
        const params = [`%${escapeLike(normQ)}%`];
        if (roomId !== null) {
          sql += ' AND d.room_id = ?';
          params.push(roomId);
        }
        if (kind !== 'all') {
          sql += ' AND d.kind = ?';
          params.push(kind);
        }
        rowids = db.prepare(sql).all(...params).map((row) => row.rid);
      }

      const fetchRow = db.prepare('SELECT rowid AS rid, msg_id, room_id, author, ts, seq, text, norm, kind FROM docs WHERE rowid = ?');
      const matched = [];
      for (const rid of rowids) {
        const row = fetchRow.get(rid);
        if (!row) continue;
        if (!String(row.norm).includes(normQ)) continue; // 核实：预筛不得放宽精度，也不得漏召回
        if (allowedRooms !== null && !allowedRooms.has(row.room_id)) continue;
        if (senders !== null && !senders.includes(row.author)) continue;
        if (since !== null && row.ts < since) continue;
        if (until !== null && row.ts > until) continue;
        matched.push(row);
      }
      matched.sort((a, b) => (a.ts === b.ts ? (a.room_id === b.room_id ? a.seq - b.seq : a.room_id < b.room_id ? -1 : 1) : a.ts < b.ts ? -1 : 1));

      const beforeStmt = db.prepare('SELECT msg_id, seq, author, ts, text FROM docs WHERE room_id = ? AND seq < ? ORDER BY seq DESC LIMIT 1');
      const afterStmt = db.prepare('SELECT msg_id, seq, author, ts, text FROM docs WHERE room_id = ? AND seq > ? ORDER BY seq ASC LIMIT 1');
      const hits = matched.slice(0, limit).map((row) => {
        const before = beforeStmt.get(row.room_id, row.seq);
        const after = afterStmt.get(row.room_id, row.seq);
        const extId = row.kind === 'msg' ? extByMsg.get(`${row.room_id}\u0000${row.msg_id}`) || null : null;
        return {
          msg_id: row.msg_id,
          room_id: row.room_id,
          author: row.author,
          ts: row.ts,
          seq: row.seq,
          text: row.text,
          display_text: extId ? stripHeader(row.text) : row.text,
          ext_id: extId,
          kind: row.kind,
          context: {
            before: before ? [before] : [],
            after: after ? [after] : [],
          },
        };
      });
      return ok({ query: q, normalized: normQ, total: matched.length, limit, hits, took_ms: Date.now() - started });
    } finally {
      closeDb(handle);
    }
  });
}

// 供上层模块（技能库等）复用同一索引：kind 分流，audit 的消息对账只认 kind='msg'
export function indexDoc(home, doc) {
  return wrap(() => {
    const handle = openDb(home);
    try {
      const kind = doc.kind === 'skill' ? 'skill' : 'msg';
      const record = {
        id: String(doc.msg_id),
        seq: Number(doc.seq),
        text: String(doc.text),
        author: doc.author,
        ts: doc.ts,
      };
      const result = insertDoc(handle.db, String(doc.room_id), record, kind);
      return ok({ inserted: result === 'added', result });
    } finally {
      closeDb(handle);
    }
  });
}

export function removeDoc(home, kind, msgId) {
  return wrap(() => {
    const handle = openDb(home);
    try {
      const rows = handle.db.prepare('SELECT rowid AS rid FROM docs WHERE kind = ? AND msg_id = ?').all(String(kind), String(msgId));
      const delFts = handle.db.prepare('DELETE FROM docs_fts WHERE rowid = ?');
      for (const row of rows) delFts.run(row.rid);
      const info = handle.db.prepare('DELETE FROM docs WHERE kind = ? AND msg_id = ?').run(String(kind), String(msgId));
      return ok({ removed: Number(info.changes) });
    } finally {
      closeDb(handle);
    }
  });
}

export function listDocs(home, kind = 'msg') {
  return wrap(() => {
    const normalizedKind = String(kind);
    if (!['msg', 'skill', 'all'].includes(normalizedKind)) fail('BAD_INPUT', 'kind 只能是 msg / skill / all');
    const handle = openDb(home);
    try {
      const sql = normalizedKind === 'all'
        ? 'SELECT rowid AS rid, msg_id, room_id, author, ts, seq, text, norm, kind FROM docs ORDER BY rowid'
        : 'SELECT rowid AS rid, msg_id, room_id, author, ts, seq, text, norm, kind FROM docs WHERE kind = ? ORDER BY rowid';
      const rows = normalizedKind === 'all'
        ? handle.db.prepare(sql).all()
        : handle.db.prepare(sql).all(normalizedKind);
      return ok({ total: rows.length, docs: rows });
    } finally {
      closeDb(handle);
    }
  });
}

export const search = { index, reindex, audit, query, normalizeText, indexDoc, removeDoc, listDocs };
export default search;
