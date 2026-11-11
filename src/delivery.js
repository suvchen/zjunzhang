// T-008 第 2 层：投递状态机与 SLA 台账。
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { randomUUID } from 'node:crypto';
import { order } from './core.js';
import { appendEvent } from './events.js';

class DeliveryError extends Error {
  constructor(code, message) {
    super(message || code);
    this.name = 'DeliveryError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new DeliveryError(code, message);
}

function ok(payload = {}) {
  return { ok: true, ...payload };
}

function wrap(fn) {
  try {
    return fn();
  } catch (error) {
    return error instanceof DeliveryError
      ? { ok: false, code: error.code, message: error.message }
      : { ok: false, code: 'INTERNAL', message: String(error && error.message ? error.message : error) };
  }
}

function homeDir(home) {
  return path.resolve(home || process.env.ZJZ_HOME || process.cwd());
}

function stateFile(home) {
  return path.join(homeDir(home), 'data', 'delivery', 'state.json');
}

function readState(home) {
  try {
    const state = JSON.parse(fs.readFileSync(stateFile(home), 'utf8'));
    return Array.isArray(state.records) ? state : { records: [] };
  } catch {
    return { records: [] };
  }
}

function atomicJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, file);
}

function saveState(home, state) {
  atomicJson(stateFile(home), state);
}

function parseTime(value, name) {
  const time = typeof value === 'number' ? value : Date.parse(value);
  if (!Number.isFinite(time)) fail('BAD_INPUT', `${name} 必须是可解析时间`);
  return time;
}

function findRecord(state, deliveryId) {
  const record = state.records.find((row) => row.delivery_id === deliveryId);
  if (!record) fail('NOT_FOUND', '投递记录不存在');
  return record;
}

function findRecordByMessage(state, options = {}) {
  const roomId = String(options.room_id || '').trim();
  const msgId = String(options.msg_id || '').trim();
  const recipient = String(options.recipient || '').trim();
  return state.records.find((row) => row.room_id === roomId && row.msg_id === msgId && row.recipient === recipient) || null;
}

function createRecord(roomId, msgId, sender, recipient, at) {
  return {
    delivery_id: `del_${randomUUID()}`,
    room_id: roomId,
    msg_id: msgId,
    sender,
    recipient,
    status: 'posted',
    posted_at: at,
    pushed_at: null,
    read_at: null,
    answered_at: null,
    read_late: false,
    answered_late: false,
    order_id: null,
  };
}

function transition(record, next, at) {
  const allowed = {
    posted: ['pushed', 'read'],
    pushed: ['read'],
    read: ['answered'],
  };
  if (!allowed[record.status]?.includes(next)) fail('BAD_STATE', `${record.status} 不可转 ${next}`);
  record.status = next;
  record[`${next}_at`] = at;
}

export function post(home, options = {}) {
  return wrap(() => {
    const roomId = String(options.room_id || '').trim();
    const msgId = String(options.msg_id || '').trim();
    const sender = String(options.sender || '').trim();
    const recipient = String(options.recipient || '').trim();
    if (!roomId || !msgId || !sender || !recipient) fail('BAD_INPUT', 'room_id/msg_id/sender/recipient 必填');
    const at = new Date(parseTime(options.at ?? Date.now(), 'at')).toISOString();
    const state = readState(home);
    const record = {
      delivery_id: `del_${randomUUID()}`,
      room_id: roomId,
      msg_id: msgId,
      sender,
      recipient,
      status: 'posted',
      posted_at: at,
      pushed_at: null,
      read_at: null,
      answered_at: null,
      read_late: false,
      answered_late: false,
      order_id: null,
    };
    state.records.push(record);
    saveState(home, state);
    return ok({ ...record });
  });
}

function mark(home, deliveryId, next, at) {
  return wrap(() => {
    const state = readState(home);
    const record = findRecord(state, deliveryId);
    transition(record, next, new Date(parseTime(at ?? Date.now(), 'at')).toISOString());
    saveState(home, state);
    return ok({ ...record });
  });
}

export function markPushed(home, options = {}) {
  return mark(home, options.delivery_id, 'pushed', options.at);
}

export function markRead(home, options = {}) {
  return mark(home, options.delivery_id, 'read', options.at);
}

export function markAnswered(home, options = {}) {
  return mark(home, options.delivery_id, 'answered', options.at);
}

function markByMessage(home, options = {}, next) {
  return wrap(() => {
    const roomId = String(options.room_id || '').trim();
    const msgId = String(options.msg_id || '').trim();
    const recipient = String(options.recipient || '').trim();
    const sender = String(options.sender || '').trim();
    if (!roomId || !msgId || !recipient) fail('BAD_INPUT', 'room_id/msg_id/recipient 必填');
    const at = new Date(parseTime(options.at ?? Date.now(), 'at')).toISOString();
    const state = readState(home);
    let record = findRecordByMessage(state, { room_id: roomId, msg_id: msgId, recipient });
    if (!record && next === 'pushed') {
      record = createRecord(roomId, msgId, sender, recipient, at);
      state.records.push(record);
    }
    if (!record) fail('NOT_FOUND', '投递记录不存在');
    if (record.status !== next) transition(record, next, at);
    saveState(home, state);
    return ok({ ...record });
  });
}

export function markPushedByMessage(home, options = {}) {
  return markByMessage(home, options, 'pushed');
}

export function markReadByMessage(home, options = {}) {
  return markByMessage(home, options, 'read');
}

export function markAnsweredByAuthor(home, options = {}) {
  return wrap(() => {
    const author = String(options.author || '').trim();
    if (!author) fail('BAD_INPUT', 'author 必填');
    const at = new Date(parseTime(options.at ?? Date.now(), 'at')).toISOString();
    const state = readState(home);
    const changed = [];
    for (const record of state.records) {
      if (record.recipient !== author || record.status === 'answered') continue;
      // E22：回帖＝已读的铁证。pushed 就直接回帖时也要补 read_at 再转 answered，
      // 否则 replied 却仍 pushed，read_at/answered_at 永不写（实弹：66s 已回帖，台账两字段仍 null）。
      // pushed 未写：记录可能停在 posted（markPushed 只在 HTTP 发/唤醒投递写），也要补 read→answered，否则三字段全空。
      if (record.status === 'posted' || record.status === 'pushed') transition(record, 'read', at);
      if (record.status === 'read') {
        transition(record, 'answered', at);
        changed.push(record);
      }
    }
    saveState(home, state);
    return ok({ author, updated: changed.length, records: changed });
  });
}

export function tick(home, options = {}) {
  return wrap(() => {
    const now = parseTime(options.now ?? Date.now(), 'now');
    const readTimeout = Number(options.read_timeout_ms ?? 10 * 60 * 1000);
    const answeredTimeout = Number(options.answered_timeout_ms ?? 10 * 60 * 1000);
    if (!Number.isFinite(readTimeout) || readTimeout <= 0 || !Number.isFinite(answeredTimeout) || answeredTimeout <= 0) {
      fail('BAD_INPUT', 'timeout_ms 必须是正数');
    }
    const state = readState(home);
    const late = [];
    const orders = [];
    for (const record of state.records) {
      if (!record.read_late && (record.status === 'posted' || record.status === 'pushed') && now - Date.parse(record.posted_at) > readTimeout) {
        record.read_late = true;
        const event = appendEvent(home, {
          project: 'delivery',
          type: 'delivery_late',
          actor: 'delivery',
          subject: record.delivery_id,
          payload: { phase: 'read', room_id: record.room_id, msg_id: record.msg_id, recipient: record.recipient, age_ms: now - Date.parse(record.posted_at) },
        });
        late.push({ delivery_id: record.delivery_id, phase: 'read', event_id: event.ok ? event.event.id : null });
      }
      if (!record.answered_late && record.status === 'read' && now - Date.parse(record.read_at) > answeredTimeout) {
        record.answered_late = true;
        const dispatched = order.dispatch(home, record.sender, {
          project: 'delivery',
          title: `值班工单：${record.recipient} 未回复 ${record.msg_id}`,
          deliverables: '完成消息回复并推进投递状态',
          acceptance: '本人发言出现且投递状态转 answered',
          note: `delivery_id=${record.delivery_id}`,
        });
        if (dispatched.ok) {
          record.order_id = dispatched.order_id;
          orders.push(dispatched);
        }
        const event = appendEvent(home, {
          project: 'delivery',
          type: 'delivery_late',
          actor: 'delivery',
          subject: record.delivery_id,
          payload: { phase: 'answered', room_id: record.room_id, msg_id: record.msg_id, recipient: record.recipient, order_id: record.order_id, age_ms: now - Date.parse(record.read_at) },
        });
        late.push({ delivery_id: record.delivery_id, phase: 'answered', event_id: event.ok ? event.event.id : null, order_id: record.order_id });
      }
    }
    saveState(home, state);
    return ok({ late, orders, records: state.records });
  });
}

export function board(home, options = {}) {
  return wrap(() => {
    const now = parseTime(options.now ?? Date.now(), 'now');
    const state = readState(home);
    const rows = state.records.map((record) => ({
      ...record,
      age_ms: Math.max(0, now - Date.parse(record.posted_at)),
      phase: record.status,
    }));
    return ok({ rows });
  });
}

export const delivery = { post, markPushed, markRead, markAnswered, markPushedByMessage, markReadByMessage, markAnsweredByAuthor, tick, board };
export default delivery;
