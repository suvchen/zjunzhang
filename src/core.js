// 中军帐 M1 核心库：identity / room / msg
// 零外部依赖：Node 内置 node:crypto Ed25519 + 纯文件存储。
import {
  randomBytes,
  randomUUID,
  generateKeyPairSync,
  sign as cryptoSign,
  verify as cryptoVerify,
} from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { appendEvent } from './events.js';

const LOCK_TIMEOUT_MS = 5000;
const LOCK_POLL_MS = 10;
const DEFAULT_WAIT_MS = 30000;

class ZjzError extends Error {
  constructor(code, message) {
    super(message || code);
    this.name = 'ZjzError';
    this.code = code;
  }
}

function fail(code, message = code) {
  throw new ZjzError(code, message);
}

function ok(payload = {}) {
  return { ok: true, ...payload };
}

function normalize(fn) {
  try {
    return fn();
  } catch (error) {
    if (error instanceof ZjzError) {
      return { ok: false, code: error.code, message: error.message };
    }
    return { ok: false, code: 'INTERNAL', message: String(error && error.message ? error.message : error) };
  }
}

function requireString(value, name) {
  if (typeof value !== 'string' || value.trim() === '') {
    fail('BAD_INPUT', `${name} 必须是非空字符串`);
  }
  return value.trim();
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.max(1, ms));
}

// ---------- 路径 ----------

function homeDir(home) {
  if (home !== undefined && home !== null && typeof home !== 'string') {
    fail('BAD_INPUT', 'home 必须是字符串');
  }
  return path.resolve(home || process.env.ZJZ_HOME || process.cwd());
}

function dataDir(home) {
  return path.join(homeDir(home), 'data');
}

function identitiesDir(home) {
  return path.join(dataDir(home), 'identities');
}

function roomsDir(home) {
  return path.join(dataDir(home), 'rooms');
}

function roomDir(home, roomId) {
  return path.join(roomsDir(home), requireString(roomId, 'room_id'));
}

function indexFile(home) {
  return path.join(dataDir(home), 'index.json');
}

function indexLock(home) {
  return path.join(dataDir(home), 'index.lock');
}

// ---------- 原子写 / 锁 ----------

function atomicJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, file);
}

function withLock(lockPath, fn, timeoutMs = LOCK_TIMEOUT_MS) {
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  const started = Date.now();
  let fd = null;
  for (;;) {
    try {
      fd = fs.openSync(lockPath, 'wx');
      break;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if (Date.now() - started >= timeoutMs) fail('LOCK_TIMEOUT', `获取锁超时：${lockPath}`);
      sleepSync(LOCK_POLL_MS);
    }
  }
  try {
    return fn();
  } finally {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch { /* ignore */ }
    }
    try { fs.unlinkSync(lockPath); } catch { /* ignore */ }
  }
}

function readJsonFile(file, corruptCode) {
  if (!fs.existsSync(file)) fail('NOT_FOUND', `${path.basename(file)} 不存在`);
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    fail(corruptCode || 'CORRUPT_JSON', `${path.basename(file)} 损坏`);
  }
}

// ---------- index ----------

function readIndex(home) {
  const file = indexFile(home);
  if (!fs.existsSync(file)) return { identities: {}, rooms: {} };
  const raw = readJsonFile(file, 'CORRUPT_INDEX');
  return { identities: raw.identities || {}, rooms: raw.rooms || {} };
}

function writeIndex(home, index) {
  atomicJson(indexFile(home), index);
}

// ---------- identity ----------

function slugify(name) {
  const base = name
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32);
  return base || 'agent';
}

function publicIdentity(identity) {
  return { slug: identity.slug, name: identity.name, created: identity.created };
}

function loadIdentityOrFail(home, slug) {
  const id = requireString(slug, 'slug');
  const dir = path.join(identitiesDir(home), id);
  const keyPath = path.join(dir, 'key.json');
  if (!fs.existsSync(keyPath)) fail('NOT_FOUND', 'identity 不存在');
  const key = readJsonFile(keyPath, 'CORRUPT_IDENTITY');
  const profile = readJsonFile(path.join(dir, 'profile.json'), 'CORRUPT_IDENTITY');
  return {
    slug: id,
    name: profile.name,
    created: profile.created,
    dir,
    publicKey: key.public_key,
    privateKey: key.private_key,
  };
}

function createIdentity(home, name) {
  return normalize(() => {
    const displayName = requireString(name, 'name');
    const h = homeDir(home);
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const pub = publicKey.export({ type: 'spki', format: 'pem' });
    const priv = privateKey.export({ type: 'pkcs8', format: 'pem' });
    const created = new Date().toISOString();
    const base = slugify(displayName);

    return withLock(indexLock(h), () => {
      const index = readIndex(h);
      let slug = null;
      for (let attempt = 0; attempt < 64; attempt += 1) {
        const candidate = `zjz-${base}-${randomBytes(4).toString('hex')}`;
        if (!index.identities[candidate] && !fs.existsSync(path.join(identitiesDir(h), candidate))) {
          slug = candidate;
          break;
        }
      }
      if (!slug) fail('SLUG_COLLISION', '无法分配唯一 slug');
      const dir = path.join(identitiesDir(h), slug);
      fs.mkdirSync(dir, { recursive: true });
      atomicJson(path.join(dir, 'key.json'), {
        slug,
        algorithm: 'ed25519',
        public_key: pub,
        private_key: priv,
        created,
      });
      atomicJson(path.join(dir, 'profile.json'), { slug, name: displayName, created });
      index.identities[slug] = { name: displayName, created };
      writeIndex(h, index);
      return ok({ slug, keypair: { publicKey: pub, privateKey: priv } });
    });
  });
}

function loadIdentity(home, slug) {
  return normalize(() => {
    const h = homeDir(home);
    const identity = loadIdentityOrFail(h, slug);
    return ok({ ...publicIdentity(identity), public_key: identity.publicKey });
  });
}

function whoami(home, slug) {
  return normalize(() => {
    const h = homeDir(home);
    const identity = loadIdentityOrFail(h, slug);
    return ok({ ...publicIdentity(identity), rooms: listRoomsRaw(h, identity.slug) });
  });
}

export const identity = {
  create: createIdentity,
  load: loadIdentity,
  whoami,
};

// ---------- room ----------

function readMeta(home, roomId) {
  return readJsonFile(path.join(roomDir(home, roomId), 'meta.json'), 'CORRUPT_ROOM');
}

function readMembers(dir) {
  const file = path.join(dir, 'members.json');
  if (!fs.existsSync(file)) return [];
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    fail('CORRUPT_ROOM', 'members.json 损坏');
  }
  if (!Array.isArray(raw)) fail('CORRUPT_ROOM', 'members.json 非数组');
  return raw;
}

function writeMembers(dir, members) {
  atomicJson(path.join(dir, 'members.json'), members);
}

function memberOf(members, slug) {
  return members.find((member) => member.slug === slug);
}

function publicMember(member) {
  return { slug: member.slug, role: member.role, joined: member.joined };
}

function readRawMessages(dir) {
  const file = path.join(dir, 'messages.jsonl');
  if (!fs.existsSync(file)) return [];
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter((line) => line.trim() !== '');
  return lines.map((line, index) => {
    try {
      return JSON.parse(line);
    } catch {
      fail('CORRUPT_MESSAGE', `messages.jsonl 第 ${index + 1} 行损坏`);
    }
  });
}

function lastSeq(dir) {
  const messages = readRawMessages(dir);
  if (messages.length === 0) return 0;
  return messages[messages.length - 1].seq;
}

function normalizeInvite(invite) {
  return invite.trim().toUpperCase();
}

function findRoomByInvite(home, invite) {
  const root = roomsDir(home);
  if (!fs.existsSync(root)) fail('NOT_FOUND', '邀请码无效');
  const dirs = fs.readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory());
  for (const entry of dirs) {
    const metaFile = path.join(root, entry.name, 'meta.json');
    if (!fs.existsSync(metaFile)) continue;
    let meta;
    try {
      meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
    } catch {
      continue;
    }
    if (normalizeInvite(String(meta.invite || '')) === invite) return meta;
  }
  fail('NOT_FOUND', '邀请码无效');
}

function createRoom(home, slug, name) {
  return normalize(() => {
    const roomName = requireString(name, 'name');
    const h = homeDir(home);
    const owner = loadIdentityOrFail(h, slug);
    const created = new Date().toISOString();

    return withLock(indexLock(h), () => {
      const index = readIndex(h);
      let roomId = null;
      for (let attempt = 0; attempt < 64; attempt += 1) {
        const candidate = `room_${randomBytes(8).toString('hex')}`;
        if (!index.rooms[candidate] && !fs.existsSync(path.join(roomsDir(h), candidate))) {
          roomId = candidate;
          break;
        }
      }
      if (!roomId) fail('ROOM_ID_COLLISION', '无法分配唯一 room_id');
      const inviteCode = 'ZJZ-' + randomBytes(4).toString('hex').toUpperCase().match(/.{4}/g).join('-');
      const dir = roomDir(h, roomId);
      fs.mkdirSync(dir, { recursive: true });
      atomicJson(path.join(dir, 'meta.json'), {
        room_id: roomId,
        name: roomName,
        owner: owner.slug,
        invite: inviteCode,
        archived: false,
        created,
      });
      atomicJson(path.join(dir, 'members.json'), [
        { slug: owner.slug, role: 'owner', joined: created, cursor: 0 },
      ]);
      fs.writeFileSync(path.join(dir, 'messages.jsonl'), '', 'utf8');
      index.rooms[roomId] = { name: roomName, owner: owner.slug, archived: false, created };
      writeIndex(h, index);
      return ok({ room_id: roomId, invite_code: inviteCode });
    });
  });
}

function joinRoom(home, slug, invite) {
  return normalize(() => {
    const code = normalizeInvite(requireString(invite, 'invite'));
    const h = homeDir(home);
    const identityRecord = loadIdentityOrFail(h, slug);
    const meta = findRoomByInvite(h, code);
    if (meta.archived) fail('ROOM_ARCHIVED', '房间已归档，不能加入');
    const dir = roomDir(h, meta.room_id);

    return withLock(path.join(dir, '.lock'), () => {
      const members = readMembers(dir);
      const existing = memberOf(members, identityRecord.slug);
      if (existing) {
        return ok({ room_id: meta.room_id, member: publicMember(existing), already_member: true });
      }
      const member = {
        slug: identityRecord.slug,
        role: 'member',
        joined: new Date().toISOString(),
        cursor: lastSeq(dir),
      };
      members.push(member);
      writeMembers(dir, members);
      return ok({ room_id: meta.room_id, member: publicMember(member) });
    });
  });
}

function archiveRoom(home, slug, roomId) {
  return normalize(() => {
    const h = homeDir(home);
    const identityRecord = loadIdentityOrFail(h, slug);
    const dir = roomDir(h, roomId);

    return withLock(path.join(dir, '.lock'), () => {
      const meta = readMeta(h, roomId);
      if (meta.owner !== identityRecord.slug) fail('NOT_OWNER', '仅房主可归档');
      if (!meta.archived) {
        meta.archived = true;
        meta.archived_at = new Date().toISOString();
        atomicJson(path.join(dir, 'meta.json'), meta);
        withLock(indexLock(h), () => {
          const index = readIndex(h);
          if (index.rooms[roomId]) {
            index.rooms[roomId].archived = true;
            writeIndex(h, index);
          }
        });
      }
      return ok({ room_id: roomId, archived: true });
    });
  });
}

function membersOfRoom(home, slug, roomId) {
  return normalize(() => {
    const h = homeDir(home);
    const identityRecord = loadIdentityOrFail(h, slug);
    const dir = roomDir(h, roomId);
    const members = readMembers(dir);
    if (!memberOf(members, identityRecord.slug)) fail('NOT_MEMBER', '不在该房间');
    return ok({
      room_id: roomId,
      members: members.map((member) => ({
        ...publicMember(member),
        unread: countUnread(dir, member.cursor),
      })),
    });
  });
}

function listRoomsRaw(home, slug) {
  const root = roomsDir(home);
  if (!fs.existsSync(root)) return [];
  const result = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(root, entry.name);
    const metaFile = path.join(dir, 'meta.json');
    if (!fs.existsSync(metaFile)) continue;
    let meta;
    let members;
    try {
      meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
      members = readMembers(dir);
    } catch {
      continue;
    }
    const member = memberOf(members, slug);
    if (!member) continue;
    result.push({
      room_id: meta.room_id,
      name: meta.name,
      owner: meta.owner,
      archived: Boolean(meta.archived),
      role: member.role,
      unread: countUnread(dir, member.cursor),
    });
  }
  result.sort((a, b) => String(a.room_id).localeCompare(String(b.room_id)));
  return result;
}

function listRooms(home, slug) {
  return normalize(() => {
    const h = homeDir(home);
    const identityRecord = loadIdentityOrFail(h, slug);
    return ok({ rooms: listRoomsRaw(h, identityRecord.slug) });
  });
}

export const room = {
  create: createRoom,
  join: joinRoom,
  archive: archiveRoom,
  members: membersOfRoom,
  list: listRooms,
};

// ---------- message ----------

function payloadOf(roomId, seq, text) {
  return `${roomId}|${seq}|${text}`;
}

function audit(home, roomId, record, code) {
  try {
    const file = path.join(dataDir(home), 'audit.jsonl');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, JSON.stringify({
      ts: new Date().toISOString(),
      room_id: roomId,
      seq: record && record.seq,
      author: record && record.author,
      code,
    }) + '\n', 'utf8');
  } catch {
    // 审计写失败不掩盖主错误
  }
}

function verifyMessage(home, roomId, record) {
  let authorKey;
  try {
    authorKey = loadIdentityOrFail(home, record.author).publicKey;
  } catch {
    return false;
  }
  if (typeof record.sig !== 'string') return false;
  try {
    return cryptoVerify(
      null,
      Buffer.from(payloadOf(roomId, record.seq, record.text), 'utf8'),
      authorKey,
      Buffer.from(record.sig, 'base64'),
    );
  } catch {
    return false;
  }
}

function assertSignatureChain(home, roomId, records) {
  for (const record of records) {
    if (!verifyMessage(home, roomId, record)) {
      audit(home, roomId, record, 'SIGNATURE_INVALID');
      fail('SIGNATURE_INVALID', `seq ${record.seq} 签名校验失败`);
    }
  }
}

function countUnread(dir, cursor) {
  const messages = readRawMessages(dir);
  return messages.filter((record) => record.seq > cursor).length;
}

function sendMessage(home, slug, roomId, text, options = {}) {
  return normalize(() => {
    const body = requireString(text, 'text');
    const h = homeDir(home);
    const identityRecord = loadIdentityOrFail(h, slug);
    const dir = roomDir(h, roomId);

    return withLock(path.join(dir, '.lock'), () => {
      const meta = readMeta(h, roomId);
      if (meta.archived) fail('ROOM_ARCHIVED', '房间已归档，拒收新消息');
      const members = readMembers(dir);
      if (!memberOf(members, identityRecord.slug)) fail('NOT_MEMBER', '不在该房间，不能发送');
      const seq = lastSeq(dir) + 1;
      const id = `msg_${randomUUID()}`;
      const ts = new Date().toISOString();
      const sig = cryptoSign(
        null,
        Buffer.from(payloadOf(meta.room_id, seq, body), 'utf8'),
        identityRecord.privateKey,
      ).toString('base64');
      const record = { seq, id, author: identityRecord.slug, ts, text: body, sig };
      if (options && options.reply_to) record.reply_to = String(options.reply_to);
      if (options && Array.isArray(options.mentions) && options.mentions.length > 0) {
        record.mentions = options.mentions.map((mention) => String(mention));
      }
      fs.appendFileSync(path.join(dir, 'messages.jsonl'), JSON.stringify(record) + '\n', 'utf8');
      return ok({ seq, id });
    });
  });
}

function readMessages(home, slug, roomId, options = {}) {
  return normalize(() => {
    const h = homeDir(home);
    const identityRecord = loadIdentityOrFail(h, slug);
    const dir = roomDir(h, roomId);
    const members = readMembers(dir);
    if (!memberOf(members, identityRecord.slug)) fail('NOT_MEMBER', '不在该房间，不能读取');

    const after = options.after === undefined ? undefined : Number(options.after);
    const before = options.before === undefined ? undefined : Number(options.before);
    const limit = options.limit === undefined ? undefined : Number(options.limit);
    if (after !== undefined && (!Number.isInteger(after) || after < 0)) fail('BAD_INPUT', 'after 必须是非负整数');
    if (before !== undefined && (!Number.isInteger(before) || before < 0)) fail('BAD_INPUT', 'before 必须是非负整数');
    if (limit !== undefined && (!Number.isInteger(limit) || limit <= 0)) fail('BAD_INPUT', 'limit 必须是正整数');

    const records = readRawMessages(dir);
    assertSignatureChain(h, roomId, records);
    let list = records;
    if (after !== undefined) list = list.filter((record) => record.seq > after);
    if (before !== undefined) list = list.filter((record) => record.seq < before);
    if (limit !== undefined) list = list.slice(-limit);
    return ok({
      room_id: roomId,
      messages: list.map((record) => ({ ...record, room_id: roomId })),
    });
  });
}

function collectUnread(home, slug) {
  const rooms = listRoomsRaw(home, slug);
  const batch = [];
  const touched = [];
  for (const entry of rooms) {
    const dir = path.join(roomsDir(home), entry.room_id);
    const members = readMembers(dir);
    const member = memberOf(members, slug);
    if (!member) continue;
    const fresh = readRawMessages(dir).filter((record) => record.seq > member.cursor);
    if (fresh.length === 0) continue;
    assertSignatureChain(home, entry.room_id, fresh);
    touched.push({ room_id: entry.room_id, maxSeq: fresh[fresh.length - 1].seq });
    for (const record of fresh) batch.push({ ...record, room_id: entry.room_id });
  }
  batch.sort((a, b) => {
    if (a.seq !== b.seq) return a.seq - b.seq;
    return String(a.room_id).localeCompare(String(b.room_id));
  });
  return { messages: batch, touched };
}

function advanceCursors(home, slug, touched) {
  for (const entry of touched) {
    const dir = path.join(roomsDir(home), entry.room_id);
    withLock(path.join(dir, '.lock'), () => {
      const members = readMembers(dir);
      const member = memberOf(members, slug);
      if (!member) return;
      if (entry.maxSeq > member.cursor) {
        member.cursor = entry.maxSeq;
        writeMembers(dir, members);
      }
    });
  }
}

function collectAndAdvanceUnread(home, slug) {
  const rooms = listRoomsRaw(home, slug);
  const batch = [];
  const touched = [];
  for (const entry of rooms) {
    const dir = path.join(roomsDir(home), entry.room_id);
    withLock(path.join(dir, '.lock'), () => {
      const members = readMembers(dir);
      const member = memberOf(members, slug);
      if (!member) return;
      const fresh = readRawMessages(dir).filter((record) => record.seq > member.cursor);
      if (fresh.length === 0) return;
      assertSignatureChain(home, entry.room_id, fresh);
      const maxSeq = fresh[fresh.length - 1].seq;
      touched.push({ room_id: entry.room_id, maxSeq });
      for (const record of fresh) batch.push({ ...record, room_id: entry.room_id });
      member.cursor = maxSeq;
      writeMembers(dir, members);
    });
  }
  batch.sort((a, b) => {
    if (a.seq !== b.seq) return a.seq - b.seq;
    return String(a.room_id).localeCompare(String(b.room_id));
  });
  return { messages: batch, touched };
}

function waitMessages(home, slug, options = {}) {
  return normalize(() => {
    const h = homeDir(home);
    const identityRecord = loadIdentityOrFail(h, slug);
    const timeout = options.timeout_ms === undefined ? DEFAULT_WAIT_MS : Number(options.timeout_ms);
    if (!Number.isFinite(timeout) || timeout < 0) fail('BAD_INPUT', 'timeout_ms 必须是非负数字');

    const deadline = Date.now() + timeout;
    for (;;) {
      const batch = collectAndAdvanceUnread(h, identityRecord.slug);
      if (batch.messages.length > 0) {
        return ok({
          messages: batch.messages,
          rooms: [...new Set(batch.messages.map((record) => record.room_id))],
        });
      }
      if (Date.now() >= deadline) return ok({ messages: [], rooms: [], timeout: true });
      sleepSync(Math.min(50, Math.max(1, deadline - Date.now())));
    }
  });
}

export const msg = {
  send: sendMessage,
  read: readMessages,
  wait: waitMessages,
};

// 兼容直接调用（单函数导出）
export {
  createIdentity,
  loadIdentity,
  whoami,
  createRoom,
  joinRoom,
  archiveRoom,
  membersOfRoom,
  listRooms,
  sendMessage,
  readMessages,
  waitMessages,
};
// ---------- M2 工单系统 ----------

const ORDER_STATUSES = ['dispatched', 'claimed', 'delivered', 'accepted', 'rejected', 'closed'];

function ordersDir(home) {
  return path.join(dataDir(home), 'orders');
}

function orderFile(home, orderId) {
  return path.join(ordersDir(home), `${requireString(orderId, 'order_id')}.json`);
}

function readOrder(home, orderId) {
  const file = orderFile(home, orderId);
  if (!fs.existsSync(file)) fail('NOT_FOUND', '工单不存在');
  return readJsonFile(file, 'CORRUPT_ORDER');
}

function writeOrder(home, order) {
  atomicJson(orderFile(home, order.order_id), order);
}

function recordOrderEvent(home, order, type, actorSlug, note, extra = {}) {
  const recorded = appendEvent(home, {
    project: order.project || 'default',
    type,
    actor: actorSlug,
    subject: order.order_id,
    payload: { status: order.status, note: String(note || ''), ...extra },
  });
  return {
    event: recorded.ok ? recorded.event : null,
    event_error: recorded.ok ? null : recorded.code,
  };
}

function dispatchOrder(home, slug, spec = {}) {
  return normalize(() => {
    const h = homeDir(home);
    const actor = loadIdentityOrFail(h, slug);
    const project = requireString(spec.project, 'project');
    const title = requireString(spec.title, 'title');
    const at = new Date().toISOString();
    const orderId = `ord_${randomBytes(8).toString('hex')}`;
    const order = {
      order_id: orderId,
      project,
      title,
      deliverables: spec.deliverables === undefined ? '' : String(spec.deliverables),
      acceptance: spec.acceptance === undefined ? '' : String(spec.acceptance),
      status: 'dispatched',
      dispatched_by: actor.slug,
      dispatched_at: at,
      assignee: null,
      claim_seq: 0,
      claim_attempts: 0,
      history: [{ at, action: 'dispatch', by: actor.slug, from: null, to: 'dispatched', note: spec.note === undefined ? '' : String(spec.note) }],
    };
    fs.mkdirSync(ordersDir(h), { recursive: true });
    atomicJson(orderFile(h, orderId), order);
    return ok({ order_id: orderId, project, title, status: order.status, ...recordOrderEvent(h, order, 'order.dispatch', actor.slug, spec.note, { title }) });
  });
}

function claimOrder(home, slug, orderId) {
  return normalize(() => {
    const h = homeDir(home);
    const actor = loadIdentityOrFail(h, slug);
    const lockPath = `${orderFile(h, orderId)}.lock`;
    return withLock(lockPath, () => {
      const order = readOrder(h, orderId);
      const at = new Date().toISOString();
      if (order.status === 'claimed') {
        order.claim_attempts = (order.claim_attempts || 0) + 1;
        order.history.push({
          at,
          action: 'claim_lost',
          by: actor.slug,
          from: 'claimed',
          to: 'claimed',
          note: `claim_seq=${order.claim_attempts}`,
        });
        writeOrder(h, order);
        return { ok: false, code: 'CLAIM_LOST', message: '工单已被先到者认领', assignee: order.assignee, claim_seq: order.claim_attempts };
      }
      if (order.status !== 'dispatched') fail('BAD_STATE', `当前状态 ${order.status} 不可认领`);
      order.claim_attempts = (order.claim_attempts || 0) + 1;
      order.claim_seq = order.claim_attempts;
      order.assignee = actor.slug;
      order.status = 'claimed';
      order.claimed_at = at;
      order.history.push({
        at,
        action: 'claim',
        by: actor.slug,
        from: 'dispatched',
        to: 'claimed',
        note: `claim_seq=${order.claim_seq}`,
      });
      writeOrder(h, order);
      return ok({ order_id: order.order_id, status: order.status, assignee: order.assignee, claim_seq: order.claim_seq, ...recordOrderEvent(h, order, 'order.claim', actor.slug, '', { claim_seq: order.claim_seq }) });
    });
  });
}

function deliverOrder(home, slug, orderId, note = '') {
  return normalize(() => {
    const h = homeDir(home);
    const actor = loadIdentityOrFail(h, slug);
    return withLock(`${orderFile(h, orderId)}.lock`, () => {
      const order = readOrder(h, orderId);
      if (order.status !== 'claimed') fail('BAD_STATE', `当前状态 ${order.status} 不可交付`);
      if (order.assignee !== actor.slug) fail('NOT_ASSIGNEE', '仅认领人可交付');
      const at = new Date().toISOString();
      order.status = 'delivered';
      order.delivered_at = at;
      order.history.push({ at, action: 'deliver', by: actor.slug, from: 'claimed', to: 'delivered', note: String(note || '') });
      writeOrder(h, order);
      return ok({ order_id: order.order_id, status: order.status, assignee: order.assignee, ...recordOrderEvent(h, order, 'order.deliver', actor.slug, note) });
    });
  });
}

function acceptOrder(home, slug, orderId, note = '') {
  return normalize(() => {
    const h = homeDir(home);
    const actor = loadIdentityOrFail(h, slug);
    return withLock(`${orderFile(h, orderId)}.lock`, () => {
      const order = readOrder(h, orderId);
      if (order.status !== 'delivered') fail('BAD_STATE', `当前状态 ${order.status} 不可验收`);
      if (order.dispatched_by !== actor.slug) fail('NOT_DISPATCHER', '仅派单人可验收');
      const at = new Date().toISOString();
      order.status = 'accepted';
      order.accepted_at = at;
      order.history.push({ at, action: 'accept', by: actor.slug, from: 'delivered', to: 'accepted', note: String(note || '') });
      writeOrder(h, order);
      return ok({ order_id: order.order_id, status: order.status, ...recordOrderEvent(h, order, 'order.accept', actor.slug, note) });
    });
  });
}

function rejectOrder(home, slug, orderId, note = '') {
  return normalize(() => {
    const h = homeDir(home);
    const actor = loadIdentityOrFail(h, slug);
    return withLock(`${orderFile(h, orderId)}.lock`, () => {
      const order = readOrder(h, orderId);
      if (order.status !== 'delivered') fail('BAD_STATE', `当前状态 ${order.status} 不可驳回`);
      if (order.dispatched_by !== actor.slug) fail('NOT_DISPATCHER', '仅派单人可驳回');
      const at = new Date().toISOString();
      order.status = 'rejected';
      order.rejected_at = at;
      order.history.push({ at, action: 'reject', by: actor.slug, from: 'delivered', to: 'rejected', note: String(note || '') });
      writeOrder(h, order);
      return ok({ order_id: order.order_id, status: order.status, ...recordOrderEvent(h, order, 'order.reject', actor.slug, note) });
    });
  });
}

function closeOrder(home, slug, orderId, note = '') {
  return normalize(() => {
    const h = homeDir(home);
    const actor = loadIdentityOrFail(h, slug);
    return withLock(`${orderFile(h, orderId)}.lock`, () => {
      const order = readOrder(h, orderId);
      if (order.status !== 'accepted' && order.status !== 'rejected') {
        fail('BAD_STATE', `当前状态 ${order.status} 不可结单`);
      }
      if (order.dispatched_by !== actor.slug) fail('NOT_DISPATCHER', '仅派单人可结单');
      const at = new Date().toISOString();
      const from = order.status;
      order.status = 'closed';
      order.closed_at = at;
      order.history.push({ at, action: 'close', by: actor.slug, from, to: 'closed', note: String(note || '') });
      writeOrder(h, order);
      return ok({ order_id: order.order_id, status: order.status, ...recordOrderEvent(h, order, 'order.close', actor.slug, note) });
    });
  });
}

function getOrder(home, orderId) {
  return normalize(() => {
    const h = homeDir(home);
    const order = readOrder(h, orderId);
    return ok({ order });
  });
}

function listOrders(home, filters = {}) {
  return normalize(() => {
    const h = homeDir(home);
    const root = ordersDir(h);
    if (!fs.existsSync(root)) return ok({ orders: [] });
    const project = filters.project === undefined || filters.project === '' ? null : String(filters.project);
    const status = filters.status === undefined || filters.status === '' ? null : String(filters.status);
    const assignee = filters.assignee === undefined || filters.assignee === '' ? null : String(filters.assignee);
    if (status && !ORDER_STATUSES.includes(status)) fail('BAD_INPUT', `未知状态 ${status}`);
    const orders = [];
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
      let order;
      try {
        order = JSON.parse(fs.readFileSync(path.join(root, entry.name), 'utf8'));
      } catch {
        continue;
      }
      if (project && order.project !== project) continue;
      if (status && order.status !== status) continue;
      if (assignee && order.assignee !== assignee) continue;
      orders.push(order);
    }
    orders.sort((a, b) => {
      const ta = String(a.dispatched_at || '');
      const tb = String(b.dispatched_at || '');
      if (ta !== tb) return ta < tb ? -1 : 1;
      return String(a.order_id).localeCompare(String(b.order_id));
    });
    return ok({ orders });
  });
}

export const order = {
  dispatch: dispatchOrder,
  claim: claimOrder,
  deliver: deliverOrder,
  accept: acceptOrder,
  reject: rejectOrder,
  close: closeOrder,
  get: getOrder,
  list: listOrders,
};

// ---------- M2 值班与换班 ----------

function dutyDir(home) {
  return path.join(dataDir(home), 'duty');
}

function dutyFile(home, slug) {
  return path.join(dutyDir(home), `${requireString(slug, 'slug')}.json`);
}

function defaultDuty(slug) {
  return { slug, mode: 'off', project: 'default', schedule: [], checkpoint: null, heartbeat_at: null, watchdog: null, shift_log: [], updated_at: null };
}

function readDutyOrDefault(home, slug) {
  const file = dutyFile(home, slug);
  if (!fs.existsSync(file)) return defaultDuty(slug);
  return readJsonFile(file, 'CORRUPT_DUTY');
}

function normalizeWatchdog(value) {
  if (value === null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) fail('BAD_INPUT', 'watchdog 必须是对象或 null');
  const maxAge = value.max_age_ms === undefined ? null : Number(value.max_age_ms);
  if (maxAge !== null && (!Number.isFinite(maxAge) || maxAge <= 0)) fail('BAD_INPUT', 'watchdog.max_age_ms 必须是正数');
  const checkMs = value.check_ms === undefined ? null : Number(value.check_ms);
  if (checkMs !== null && (!Number.isFinite(checkMs) || checkMs <= 0)) fail('BAD_INPUT', 'watchdog.check_ms 必须是正数');
  const successor = value.successor === undefined || value.successor === null ? null : requireString(value.successor, 'watchdog.successor');
  const enabled = value.enabled === undefined ? Boolean(successor) : Boolean(value.enabled);
  if (enabled && !successor) fail('BAD_INPUT', 'watchdog.enabled 必须配置 successor');
  return { enabled, successor, max_age_ms: maxAge, check_ms: checkMs };
}

function setDuty(home, slug, options = {}) {
  return normalize(() => {
    const h = homeDir(home);
    const actor = loadIdentityOrFail(h, slug);
    const mode = options.mode === undefined ? 'listen' : String(options.mode);
    if (!['listen', 'oncall', 'off'].includes(mode)) fail('BAD_INPUT', 'mode 只能是 listen/oncall/off');
    const existing = readDutyOrDefault(h, actor.slug);
    const now = new Date().toISOString();
    const record = {
      slug: actor.slug,
      mode,
      project: options.project === undefined ? (existing.project || 'default') : requireString(options.project, 'project'),
      schedule: options.schedule === undefined ? existing.schedule : options.schedule,
      checkpoint: existing.checkpoint,
      heartbeat_at: existing.heartbeat_at || null,
      watchdog: options.watchdog === undefined ? (existing.watchdog || null) : normalizeWatchdog(options.watchdog),
      shift_log: existing.shift_log,
      updated_at: now,
    };
    if (existing.mode !== mode) record.heartbeat_at = now;
    atomicJson(dutyFile(h, actor.slug), record);
    return ok({ slug: record.slug, mode: record.mode, project: record.project, schedule: record.schedule, checkpoint: record.checkpoint, watchdog: record.watchdog, heartbeat_at: record.heartbeat_at });
  });
}

function getDuty(home, slug) {
  return normalize(() => {
    const h = homeDir(home);
    const actor = loadIdentityOrFail(h, slug);
    const record = readDutyOrDefault(h, actor.slug);
    return ok({ duty: record });
  });
}

function heartbeatDuty(home, slug) {
  return normalize(() => {
    const h = homeDir(home);
    const actor = loadIdentityOrFail(h, slug);
    const file = dutyFile(h, actor.slug);
    if (!fs.existsSync(file)) fail('NOT_FOUND', 'duty 记录不存在，先 duty.set');
    const record = readDutyOrDefault(h, actor.slug);
    const at = new Date().toISOString();
    record.heartbeat_at = at;
    record.updated_at = at;
    atomicJson(file, record);
    return ok({ slug: record.slug, heartbeat_at: at, mode: record.mode });
  });
}

function captureCheckpoint(home, slug) {
  const rooms = listRoomsRaw(home, slug);
  const map = {};
  for (const entry of rooms) {
    const dir = path.join(roomsDir(home), entry.room_id);
    const members = readMembers(dir);
    const member = memberOf(members, slug);
    if (member) map[entry.room_id] = Number(member.cursor) || 0;
  }
  return { rooms: map, ts: new Date().toISOString() };
}

function shiftDuty(home, slug, options = {}) {
  return normalize(() => {
    const h = homeDir(home);
    const from = loadIdentityOrFail(h, slug);
    const to = loadIdentityOrFail(h, requireString(options.to, 'to'));

    let checkpoint;
    if (options.checkpoint) {
      const rawRooms = options.checkpoint.rooms || options.checkpoint;
      const rooms = {};
      for (const [roomId, cursor] of Object.entries(rawRooms)) {
        const value = Number(cursor);
        if (!Number.isInteger(value) || value < 0) fail('BAD_INPUT', `checkpoint 游标非法：${roomId}`);
        rooms[roomId] = value;
      }
      checkpoint = { rooms, ts: new Date().toISOString(), from: from.slug };
    } else {
      checkpoint = { ...captureCheckpoint(h, from.slug), from: from.slug };
    }

    const applied = [];
    for (const [roomId, cursor] of Object.entries(checkpoint.rooms)) {
      const dir = path.join(roomsDir(h), roomId);
      if (!fs.existsSync(path.join(dir, 'members.json'))) continue;
      withLock(path.join(dir, '.lock'), () => {
        const members = readMembers(dir);
        const member = memberOf(members, to.slug);
        if (!member) return;
        if (cursor > member.cursor) {
          member.cursor = cursor;
          writeMembers(dir, members);
        }
        applied.push(roomId);
      });
    }

    const at = new Date().toISOString();
    const fromRecord = readDutyOrDefault(h, from.slug);
    fromRecord.mode = 'off';
    fromRecord.heartbeat_at = at;
    fromRecord.shift_log.push({
      at,
      action: 'shift_out',
      to: to.slug,
      reason: options.reason === undefined ? 'manual' : String(options.reason),
      previous_heartbeat_at: fromRecord.heartbeat_at,
      checkpoint,
    });
    fromRecord.updated_at = at;
    atomicJson(dutyFile(h, from.slug), fromRecord);

    const toRecord = readDutyOrDefault(h, to.slug);
    toRecord.mode = 'oncall';
    toRecord.project = fromRecord.project || 'default';
    toRecord.checkpoint = checkpoint;
    toRecord.heartbeat_at = at;
    toRecord.shift_log.push({
      at,
      action: 'shift_in',
      from: from.slug,
      reason: options.reason === undefined ? 'manual' : String(options.reason),
      checkpoint,
    });
    toRecord.updated_at = at;
    atomicJson(dutyFile(h, to.slug), toRecord);

    const recorded = appendEvent(h, {
      project: fromRecord.project || 'default',
      type: 'duty.shift',
      actor: from.slug,
      subject: from.slug,
      payload: { from: from.slug, to: to.slug, reason: options.reason === undefined ? 'manual' : String(options.reason), checkpoint: checkpoint.rooms, applied_rooms: applied },
    });
    return ok({
      from: from.slug,
      to: to.slug,
      checkpoint,
      applied_rooms: applied,
      event: recorded.ok ? recorded.event : null,
      event_error: recorded.ok ? null : recorded.code,
    });
  });
}

export const duty = {
  set: setDuty,
  get: getDuty,
  heartbeat: heartbeatDuty,
  shift: shiftDuty,
};

// ---------- M2 wait daemon（即时唤醒，ZJZ_DAEMON=0 回退轮询） ----------

const daemonRegistry = new Map();

function daemonEnabled() {
  return process.env.ZJZ_DAEMON !== '0';
}

function ensureDaemon(home) {
  const existing = daemonRegistry.get(home);
  if (existing) {
    existing.refs += 1;
    return existing;
  }
  const root = roomsDir(home);
  fs.mkdirSync(root, { recursive: true });
  const entry = { refs: 1, listeners: new Set(), watchers: [], timer: null, degraded: false };
  const fire = () => {
    if (entry.timer) return;
    entry.timer = setTimeout(() => {
      entry.timer = null;
      for (const listener of [...entry.listeners]) listener();
    }, 10);
  };
  try {
    entry.watchers.push(fs.watch(root, { recursive: true }, fire));
  } catch {
    try {
      entry.watchers.push(fs.watch(root, fire));
    } catch {
      entry.degraded = true;
    }
  }
  daemonRegistry.set(home, entry);
  return entry;
}

function releaseDaemon(home) {
  const entry = daemonRegistry.get(home);
  if (!entry) return;
  entry.refs -= 1;
  if (entry.refs > 0) return;
  for (const watcher of entry.watchers) {
    try { watcher.close(); } catch { /* ignore */ }
  }
  if (entry.timer) {
    clearTimeout(entry.timer);
    entry.timer = null;
  }
  daemonRegistry.delete(home);
}

function waitForSignal(entry, ms, wake) {
  return new Promise((resolve) => {
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      if (entry) entry.listeners.delete(onEvent);
      clearTimeout(timer);
      resolve();
    };
    const onEvent = () => done();
    const timer = setTimeout(done, ms);
    if (entry) entry.listeners.add(onEvent);
    if (typeof wake === 'function') {
      try {
        Promise.resolve(wake(ms)).then(done, done);
      } catch {
        done();
      }
    }
  });
}

async function waitMessagesAsync(home, slug, options = {}) {
  let h;
  let identityRecord;
  let timeout;
  try {
    h = homeDir(home);
    identityRecord = loadIdentityOrFail(h, slug);
    timeout = options.timeout_ms === undefined ? DEFAULT_WAIT_MS : Number(options.timeout_ms);
    if (!Number.isFinite(timeout) || timeout < 0) fail('BAD_INPUT', 'timeout_ms 必须是非负数字');
  } catch (error) {
    return error instanceof ZjzError
      ? { ok: false, code: error.code, message: error.message }
      : { ok: false, code: 'INTERNAL', message: String(error && error.message ? error.message : error) };
  }

  const useDaemon = daemonEnabled();
  const entry = useDaemon ? ensureDaemon(h) : null;
  const pollMs = useDaemon ? (entry.watchers.length > 0 ? 2000 : 250) : 100;
  const wake = typeof options.wake === 'function' ? options.wake : null;
  try {
    const deadline = Date.now() + timeout;
    for (;;) {
      let batch;
      try {
        batch = collectAndAdvanceUnread(h, identityRecord.slug);
      } catch (error) {
        return normalize(() => { throw error; });
      }
      if (batch.messages.length > 0) {
        return ok({
          messages: batch.messages,
          rooms: [...new Set(batch.messages.map((record) => record.room_id))],
          daemon: useDaemon,
        });
      }
      const remain = deadline - Date.now();
      if (remain <= 0) return ok({ messages: [], rooms: [], timeout: true, daemon: useDaemon });
      await waitForSignal(entry, Math.min(pollMs, remain), wake);
    }
  } finally {
    if (entry) releaseDaemon(h);
  }
}

msg.waitAsync = waitMessagesAsync;

export {
  dispatchOrder,
  claimOrder,
  deliverOrder,
  acceptOrder,
  rejectOrder,
  closeOrder,
  getOrder,
  listOrders,
  setDuty,
  getDuty,
  heartbeatDuty,
  shiftDuty,
  waitMessagesAsync,
};




