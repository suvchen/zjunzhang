// T-007 I27：零消耗检测器。只读本地元数据，不调用 read/wait，不推进任何成员游标。
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

class MonitorError extends Error {
  constructor(code, message) {
    super(message || code);
    this.name = 'MonitorError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new MonitorError(code, message);
}

function ok(payload = {}) {
  return { ok: true, ...payload };
}

function wrap(fn) {
  try {
    return fn();
  } catch (error) {
    return error instanceof MonitorError
      ? { ok: false, code: error.code, message: error.message }
      : { ok: false, code: 'INTERNAL', message: String(error && error.message ? error.message : error) };
  }
}

function homeDir(home) {
  return path.resolve(home || process.env.ZJZ_HOME || process.cwd());
}

function roomsDir(home) {
  return path.join(homeDir(home), 'data', 'rooms');
}

function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function inspectRoom(home, roomId) {
  const dir = path.join(roomsDir(home), roomId);
  const meta = readJson(path.join(dir, 'meta.json'));
  if (!meta) fail('NOT_FOUND', `房间不存在：${roomId}`);
  const file = path.join(dir, 'messages.jsonl');
  let bytes = 0;
  let messages = 0;
  let corrupt = 0;
  let lastSeq = 0;
  let lastTs = null;
  try {
    const text = fs.readFileSync(file, 'utf8');
    bytes = Buffer.byteLength(text, 'utf8');
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        const row = JSON.parse(line);
        messages += 1;
        if (Number(row.seq) > lastSeq) lastSeq = Number(row.seq);
        if (typeof row.ts === 'string') lastTs = row.ts;
      } catch {
        corrupt += 1;
      }
    }
  } catch {
    /* 空房允许没有 messages.jsonl */
  }
  const members = readJson(path.join(dir, 'members.json'), { members: [] });
  return {
    room_id: roomId,
    name: meta.name || null,
    archived: Boolean(meta.archived),
    messages,
    corrupt,
    bytes,
    last_seq: lastSeq,
    last_ts: lastTs,
    members: (members.members || []).map((member) => ({
      slug: member.slug,
      cursor: Number(member.cursor) || 0,
    })),
  };
}

function listRoomIds(home, explicit) {
  if (explicit !== undefined && explicit !== null && explicit !== '') return [String(explicit)];
  let entries = [];
  try {
    entries = fs.readdirSync(roomsDir(home), { withFileTypes: true });
  } catch {
    return [];
  }
  return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
}

export function probe(home, options = {}) {
  return wrap(() => {
    const roomId = options.room_id === undefined || options.room_id === null || options.room_id === ''
      ? null
      : String(options.room_id);
    const ids = listRoomIds(home, roomId);
    if (roomId !== null && ids.length === 0) fail('NOT_FOUND', `房间不存在：${roomId}`);
    return ok({
      zero_consume: true,
      source: 'metadata',
      observed_at: new Date().toISOString(),
      rooms: ids.map((id) => {
        try {
          return inspectRoom(home, id);
        } catch (error) {
          return { room_id: id, ok: false, code: error.code || 'INTERNAL', message: error.message };
        }
      }),
    });
  });
}

export const monitor = { probe };
export default monitor;
