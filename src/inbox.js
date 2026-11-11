// 中军帐 T-008 第 0.5 层 · 被动带出（src/inbox.js）
// 目的：Agent 干活必然调工具——把「哪个房几条没读、谁 @ 它、它的监听停了多久」塞进每次工具返回，
//       房讯自己骑到脸上，零自觉要求。I45。
// 纪律：只读游标对账，绝不推进游标（I27）；数据源＝members.json 的 cursor 与 messages.jsonl，纯本地。
import fs from 'node:fs';
import path from 'node:path';
import { listen } from './listen.js';

class InboxError extends Error {
  constructor(code, message = code) {
    super(message);
    this.name = 'InboxError';
    this.code = code;
  }
}

function fail(code, message = code) {
  throw new InboxError(code, message);
}

function ok(payload = {}) {
  return { ok: true, ...payload };
}

function wrap(fn) {
  try {
    return fn();
  } catch (error) {
    if (error instanceof InboxError) return { ok: false, code: error.code, message: error.message };
    return { ok: false, code: 'INTERNAL', message: String(error && error.message ? error.message : error) };
  }
}

function homeDir(home) {
  return path.resolve(home || '.');
}

function roomsDir(home) {
  return path.join(homeDir(home), 'data', 'rooms');
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function readJsonl(file) {
  let text = '';
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const rows = [];
  for (const line of text.split(/\r?\n/)) {
    if (line.trim() === '') continue;
    try {
      rows.push(JSON.parse(line));
    } catch {
      /* 坏行跳过（消息侧另有对账） */
    }
  }
  return rows;
}

function dutyLine(home, now) {
  const st = listen.status(home);
  if (st.ok && st.running) return '在岗（监听租约新鲜）';
  const lease = st && st.lease;
  if (!lease) return '未在监听：请调用 wait 或 listen start（产品会经监督器自动唤醒你）';
  const at = Date.parse(lease.updated_at || lease.acquired_at || '') || Date.parse(lease.expires_at || '') || now;
  const stoppedMin = Math.max(0, Math.round((now - at) / 60000));
  return `监听已停 ${stoppedMin} 分钟（请续 wait）`;
}

// compose：给 MCP/CLI 接线层用的横幅数据。不写任何状态。
export function compose(home, options = {}) {
  return wrap(() => {
    const opts = options && typeof options === 'object' ? options : {};
    const slug = typeof opts.slug === 'string' ? opts.slug.trim() : '';
    if (slug === '') fail('BAD_INPUT', 'slug 必填');
    const mentionLimit = opts.mention_limit === undefined ? 3 : Number(opts.mention_limit);
    const now = opts.now === undefined ? Date.now() : new Date(opts.now).getTime();

    const pendingRooms = [];
    const mentionMe = [];
    let names = [];
    try {
      names = fs.readdirSync(roomsDir(home), { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
    } catch {
      names = [];
    }
    for (const roomId of names) {
      const dir = path.join(roomsDir(home), roomId);
      const members = readJson(path.join(dir, 'members.json'));
      if (!Array.isArray(members)) continue;
      const member = members.find((row) => row && row.slug === slug);
      if (!member) continue; // 非成员房不进 inbox（I43 同口径）
      const cursor = Number(member.cursor) || 0;
      const messages = readJsonl(path.join(dir, 'messages.jsonl')).filter((record) => record && Number.isInteger(record.seq));
      const fresh = messages.filter((record) => record.seq > cursor);
      if (fresh.length > 0) {
        pendingRooms.push({
          room_id: roomId,
          unread_count: fresh.length,
          latest_ts: String(fresh[fresh.length - 1].ts ?? ''),
        });
        for (const record of fresh) {
          const mentions = Array.isArray(record.mentions) ? record.mentions : [];
          if (mentions.includes(slug)) {
            mentionMe.push({
              room_id: roomId,
              msg_id: record.id,
              seq: record.seq,
              snippet: String(record.text ?? '').slice(0, 40),
            });
          }
        }
      }
    }
    mentionMe.sort((a, b) => b.seq - a.seq);
    return ok({
      pending_rooms: pendingRooms,
      mention_me: mentionMe.slice(0, mentionLimit),
      duty: dutyLine(home, now),
      generated_at: new Date(now).toISOString(),
    });
  });
}

export const inbox = { compose };
export default inbox;
