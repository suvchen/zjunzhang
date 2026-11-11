// 中军帐 T-007-D 导入桥（src/ingest.js）
// 目的：把外部聊天记录（Huddo 房消息等）导入 zjz 消息库，并保留 ext_id → zjz_msg_id 映射，
//       让技能卡可以引用「外部原始消息号」且仍可回溯验真（I26 不放宽，只多一条解析路径）。
// 铁律：①导入幂等（同 ext_id 不得产生第二条消息，I36）②映射与消息库对账（I37）③不改写原文、不伪造签名（消息由导入者正常签名，原文与原作者/原时间戳存映射侧）。
import fs from 'node:fs';
import path from 'node:path';
import { msg } from './core.js';

class IngestError extends Error {
  constructor(code, message = code) {
    super(message);
    this.name = 'IngestError';
    this.code = code;
  }
}

function fail(code, message = code) {
  throw new IngestError(code, message);
}

function ok(payload = {}) {
  return { ok: true, ...payload };
}

function wrap(fn) {
  try {
    return fn();
  } catch (error) {
    if (error instanceof IngestError) return { ok: false, code: error.code, message: error.message };
    return { ok: false, code: 'INTERNAL', message: String(error && error.message ? error.message : error) };
  }
}

function homeDir(home) {
  return path.resolve(home || '.');
}

function ingestDir(home) {
  return path.join(homeDir(home), 'data', 'ingest');
}

function mapFile(home, roomId) {
  return path.join(ingestDir(home), `${roomId}.jsonl`);
}

function readJsonl(file) {
  let text = '';
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const rows = [];
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    try {
      rows.push(JSON.parse(line));
    } catch {
      /* 坏行跳过 */
    }
  }
  return rows;
}

function listRoomIds(home) {
  const rooms = path.join(homeDir(home), 'data', 'rooms');
  try {
    return fs
      .readdirSync(rooms, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

function readRoomMessages(home, roomId) {
  const file = path.join(homeDir(home), 'data', 'rooms', roomId, 'messages.jsonl');
  return readJsonl(file).filter((record) => record && typeof record.id === 'string');
}

function allMappings(home) {
  const out = [];
  for (const roomId of listRoomIds(home)) {
    for (const row of readJsonl(mapFile(home, roomId))) {
      if (row && typeof row.ext_id === 'string') out.push({ room_id: roomId, ...row });
    }
  }
  return out;
}

// ---------- 导入 ----------

export function records(home, payload = {}) {
  return wrap(() => {
    const p = payload && typeof payload === 'object' ? payload : {};
    const roomId = typeof p.room_id === 'string' ? p.room_id.trim() : '';
    const slug = typeof p.slug === 'string' ? p.slug.trim() : '';
    const source = typeof p.source === 'string' && p.source.trim() !== '' ? p.source.trim() : 'external';
    const list = Array.isArray(p.records) ? p.records : [];
    if (roomId === '' || slug === '') fail('BAD_INPUT', 'room_id 与 slug 必填');
    if (list.length === 0) fail('BAD_INPUT', 'records 不得为空');
    if (!fs.existsSync(path.join(homeDir(home), 'data', 'rooms', roomId, 'meta.json'))) fail('NOT_FOUND', '房间不存在');

    const existing = new Map(readJsonl(mapFile(home, roomId)).map((row) => [row.ext_id, row]));
    const imported = [];
    const skipped = [];
    fs.mkdirSync(ingestDir(home), { recursive: true });
    const fd = fs.openSync(mapFile(home, roomId), 'a');
    try {
      for (const record of list) {
        if (!record || typeof record.ext_id !== 'string' || record.ext_id.trim() === '' || typeof record.text !== 'string') {
          fail('BAD_INPUT', '每条记录必须有 ext_id 与 text');
        }
        const extId = record.ext_id.trim();
        if (existing.has(extId)) {
          skipped.push({ ext_id: extId, msg_id: existing.get(extId).msg_id }); // I36：幂等，不重投
          continue;
        }
        const header = `[${source}:${extId}]`;
        const sent = msg.send(home, slug, roomId, `${header} ${record.text}`);
        if (!sent.ok) fail(sent.code || 'SEND_FAILED', sent.message || '导入写入失败');
        const row = {
          ext_id: extId,
          source,
          msg_id: sent.id,
          seq: sent.seq,
          author_ext: typeof record.author === 'string' ? record.author : null,
          ts_ext: typeof record.ts === 'string' ? record.ts : null,
          imported_by: slug,
          imported_at: new Date().toISOString(),
        };
        fs.writeSync(fd, JSON.stringify(row) + '\n');
        existing.set(extId, row);
        imported.push(row);
      }
    } finally {
      fs.closeSync(fd);
    }
    return ok({ room_id: roomId, imported: imported.length, skipped: skipped.length, mapping: imported, skipped_list: skipped });
  });
}

// ---------- 溯源查询 ----------

export function lookup(home, payload = {}) {
  return wrap(() => {
    const p = payload && typeof payload === 'object' ? payload : {};
    const extId = typeof p.ext_id === 'string' ? p.ext_id.trim() : '';
    if (extId === '') fail('BAD_INPUT', 'ext_id 必填');
    const rows = allMappings(home).filter((row) => row.ext_id === extId && (p.room_id ? row.room_id === p.room_id : true));
    if (rows.length === 0) fail('NOT_FOUND', '该外部消息号未导入');
    const originals = [];
    for (const row of rows) {
      const message = readRoomMessages(home, row.room_id).find((record) => record.id === row.msg_id);
      if (!message) {
        originals.push({ ...row, found: false, text: null });
        continue;
      }
      originals.push({ ...row, found: true, text: stripHeader(message.text), author: row.author_ext || message.author, ts: row.ts_ext || message.ts });
    }
    return ok({ ext_id: extId, matches: originals, intact: originals.every((row) => row.found) });
  });
}

export function mapping(home, options = {}) {
  return wrap(() => {
    const opts = options && typeof options === 'object' ? options : {};
    const rows = allMappings(home).filter((row) => (opts.room_id ? row.room_id === opts.room_id : true));
    return ok({ total: rows.length, mapping: rows });
  });
}

export function stripHeader(text) {
  return typeof text === 'string' ? text.replace(/^\[[^\]]+:[^\]]+\]\s?/, '') : text;
}

// ---------- I37 对账：映射 ↔ 消息库 ----------

export function audit(home) {
  return wrap(() => {
    const rows = allMappings(home);
    const perRoom = new Map();
    const report = { mapped: rows.length, ghosts: 0, orphan_msgs: 0, duplicates: 0, rooms: 0 };
    const seenExt = new Set();
    for (const row of rows) {
      if (seenExt.has(`${row.room_id}\u0000${row.ext_id}`)) report.duplicates += 1;
      seenExt.add(`${row.room_id}\u0000${row.ext_id}`);
      if (!perRoom.has(row.room_id)) perRoom.set(row.room_id, new Set(readRoomMessages(home, row.room_id).map((record) => record.id)));
      if (!perRoom.get(row.room_id).has(row.msg_id)) report.ghosts += 1;
    }
    // 反向：带导入头的消息若没有映射，也算对账不平（防手工塞记录）
    for (const roomId of listRoomIds(home)) {
      report.rooms += 1;
      const mapped = new Set(rows.filter((row) => row.room_id === roomId).map((row) => row.msg_id));
      for (const record of readRoomMessages(home, roomId)) {
        if (/^\[[^[\]]+:[^[\]]+\]\s/.test(record.text) && !mapped.has(record.id)) report.orphan_msgs += 1;
      }
    }
    return ok({ ...report, intact: report.ghosts === 0 && report.duplicates === 0 && report.orphan_msgs === 0 });
  });
}

export const ingest = { records, lookup, mapping, audit, stripHeader };
export default ingest;
