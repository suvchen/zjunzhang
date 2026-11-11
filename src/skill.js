// 中军帐 T-007-C 技能库提取（src/skill.js）
// 三段闸门：①候选定位（必须引用 房号＋消息号，无引用不列） ②认可门（未 approve 绝不入库；缺栏拒入 I25；伪造来源拒入 I26）
// ③五栏卡入库并进同一检索索引（docs.kind='skill'，消息对账仍只认 kind='msg'，不破 I23）
// 卡片台账 append-only＋哈希链（照 qc.js 套路），篡改可检出。
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { query as searchQuery, indexDoc, removeDoc, normalizeText, listDocs } from './search.js';
import { lookup, stripHeader } from './ingest.js';

const CARD_FIELDS = [
  ['problem', '解决什么问题'],
  ['practice', '验证过的做法'],
  ['evidence', '验证证据'],
  ['boundary', '适用边界'],
  ['pitfalls', '坑与防'],
];

// I38：候选不是“出现一个词就算”。必须同时具备验证类、结果类、可核验证据，纯应答直接剔除。
const SIGNALS = ['实测', '验证', '验收', '收讫', '全绿', 'PASS', 'pass', '确认', '通了', '生效', '修复', '成功', '可用', '复现'];
const VERIFICATION_SIGNAL = /(实测|复现|红测|对账|独立复核|交叉复核|验证通过|验收通过|测试通过|本机实跑|intact|audit|verify)/i;
const RESULT_SIGNAL = /(全绿|\bpass\b|召回\s*100%|修复完成|复现成功|验收通过|验证通过|测试通过|生效|可用|正常)/i;
const VERIFIABLE_SHAPE = /(\d+(?:\.\d+)?\s*(?:%|ms|s|条|个|枚|帧|GB|MB|次|工具|\/\d+))|([A-Za-z]:\\|\/(?:src|test|data|trials)\/)|(\b[\w.-]+\.(?:js|mjs|md|json|jsonl|csv|mp4)\b)|(#\d+|msg_[\w-]+)|(\b[0-9a-f]{7,40}\b)/i;
const PURE_REPLY = /^(?:@\S+\s+)*(?:收到|确认|好的|明白|同意|了解|可以|行|嗯|ok|✓)[！!。．]?$/i;

class SkillError extends Error {
  constructor(code, message = code) {
    super(message);
    this.name = 'SkillError';
    this.code = code;
  }
}

function fail(code, message = code) {
  throw new SkillError(code, message);
}

function ok(payload = {}) {
  return { ok: true, ...payload };
}

function wrap(fn) {
  try {
    return fn();
  } catch (error) {
    if (error instanceof SkillError) return { ok: false, code: error.code, message: error.message };
    return { ok: false, code: 'INTERNAL', message: String(error && error.message ? error.message : error) };
  }
}

function homeDir(home) {
  return path.resolve(home || '.');
}

function skillsDir(home) {
  return path.join(homeDir(home), 'data', 'skills');
}

function cardsFile(home) {
  return path.join(skillsDir(home), 'cards.jsonl');
}

function rejectionsFile(home) {
  return path.join(skillsDir(home), 'rejections.jsonl');
}

function roomsDir(home) {
  return path.join(homeDir(home), 'data', 'rooms');
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
      /* 坏行跳过（对账侧另有计数） */
    }
  }
  return rows;
}

function appendJsonl(file, record) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify(record) + '\n', 'utf8');
}

function listAllMessages(home, roomId = null) {
  let names = [];
  try {
    names = fs.readdirSync(roomsDir(home), { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return [];
  }
  if (roomId !== null) names = names.filter((name) => name === roomId);
  const out = [];
  for (const name of names) {
    const dir = path.join(roomsDir(home), name);
    if (!fs.existsSync(path.join(dir, 'meta.json'))) continue;
    for (const record of readJsonl(path.join(dir, 'messages.jsonl'))) {
      if (!record || typeof record.id !== 'string' || typeof record.text !== 'string') continue;
      out.push({ room_id: name, ...record });
    }
  }
  return out;
}

function findMessages(home, refs) {
  const byRoom = new Map();
  for (const ref of refs) {
    if (!ref || typeof ref.room_id !== 'string' || typeof ref.msg_id !== 'string') continue;
    if (!byRoom.has(ref.room_id)) byRoom.set(ref.room_id, new Map());
    byRoom.get(ref.room_id).set(ref.msg_id, null);
  }
  for (const [roomId, wanted] of byRoom) {
    const dir = path.join(roomsDir(home), roomId);
    if (!fs.existsSync(path.join(dir, 'meta.json'))) continue;
    for (const record of readJsonl(path.join(dir, 'messages.jsonl'))) {
      if (record && typeof record.id === 'string' && wanted.has(record.id)) {
        wanted.set(record.id, { room_id: roomId, ...record });
      }
    }
  }
  return (ref) => {
    if (!ref || typeof ref.room_id !== 'string' || typeof ref.msg_id !== 'string') return null;
    return byRoom.get(ref.room_id)?.get(ref.msg_id) || null;
  };
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function candidateIdOf(roomId, msgId) {
  return sha256(`${roomId}\u0000${msgId}`).slice(0, 16);
}

function cardBody(card) {
  return CARD_FIELDS.map(([key, label]) => `${label}：${(card && card[key] ? String(card[key]) : '').trim()}`).join('\n');
}

function cardSearchText(card, sources) {
  const refs = sources.map((source) => `来源 ${source.room_id}/${source.msg_id}`).join(' ');
  return `${cardBody(card)}\n${refs}`;
}

function candidateDisplayText(text) {
  return stripHeader(text)
    .replace(/^(?:@\S+\s+)+/, '')
    .replace(/\s*\[reply_to:[^\]]+\]\s*$/, '')
    .trim();
}

function readCards(home) {
  return readJsonl(cardsFile(home)).filter((card) => card && typeof card.card_id === 'string');
}

function readRejections(home) {
  return readJsonl(rejectionsFile(home));
}

// ---------- ① 候选定位（引用可回溯，无引用不列）----------

export function candidates(home, options = {}) {
  return wrap(() => {
    const opts = options && typeof options === 'object' ? options : {};
    const roomId = typeof opts.room_id === 'string' && opts.room_id !== '' ? opts.room_id : null;
    const q = typeof opts.q === 'string' && opts.q.trim() !== '' ? normalizeText(opts.q) : null;
    const limit = opts.limit === undefined ? 50 : Number(opts.limit);
    if (!Number.isInteger(limit) || limit < 1) fail('BAD_INPUT', 'limit 必须是正整数');

    const approved = new Set(readCards(home).map((card) => card.candidate_id));
    const rejected = new Set(readRejections(home).map((row) => row.candidate_id));

    const list = [];
    for (const message of listAllMessages(home, roomId)) {
      const displayText = candidateDisplayText(message.text);
      const norm = normalizeText(message.text);
      if (q !== null && !norm.includes(q)) continue;
      if (PURE_REPLY.test(displayText)) continue;
      const candidateText = displayText.toLowerCase();
      if (!(VERIFICATION_SIGNAL.test(candidateText) && RESULT_SIGNAL.test(candidateText) && VERIFIABLE_SHAPE.test(candidateText))) continue;
      const signals = SIGNALS.filter((signal) => norm.includes(normalizeText(signal)));
      const candidate_id = candidateIdOf(message.room_id, message.id);
      if (approved.has(candidate_id) || rejected.has(candidate_id)) continue;
      list.push({
        candidate_id,
        room_id: message.room_id,
        msg_id: message.id,
        seq: message.seq,
        author: message.author,
        ts: message.ts,
        quote: message.text,
        display_text: displayText,
        signals,
        sources: [{ room_id: message.room_id, msg_id: message.id, seq: message.seq }],
      });
    }
    list.sort((a, b) => (a.ts === b.ts ? a.seq - b.seq : a.ts < b.ts ? -1 : 1));
    return ok({ total: list.length, candidates: list.slice(0, limit) });
  });
}

// ---------- ② 认可门 ----------

export function approve(home, payload = {}) {
  return wrap(() => {
    const p = payload && typeof payload === 'object' ? payload : {};
    const candidateId = typeof p.candidate_id === 'string' ? p.candidate_id.trim() : '';
    const by = typeof p.by === 'string' ? p.by.trim() : '';
    if (candidateId === '') fail('BAD_INPUT', 'candidate_id 必填');
    if (by === '') fail('BAD_INPUT', 'by（认可人）必填');
    const card = p.card && typeof p.card === 'object' ? p.card : {};

    // I25：五栏缺一律拒入
    const missing = CARD_FIELDS.filter(([key]) => !(typeof card[key] === 'string' && card[key].trim() !== '')).map(([, label]) => label);
    if (missing.length > 0) fail('SKILL_INCOMPLETE', `五栏缺栏：${missing.join('、')}`);

    // I26：来源必须是消息库里真实存在的 房号＋消息号
    const sources = Array.isArray(p.sources) ? p.sources : [];
    if (sources.length === 0) fail('SKILL_SOURCE_MISSING', '卡片必须带来源（房号＋消息号）');
    const verified = [];
    const resolvedSources = [];
    for (const rawSource of sources) {
      let source = rawSource;
      // 外部来源（Huddo 等）经导入桥解析：ext_id → zjz 房号＋消息号，仍须真实存在（I26 不放宽）
      if (rawSource && typeof rawSource.ext_id === 'string' && rawSource.ext_id.trim() !== '') {
        const resolved = lookup(home, {
          ext_id: rawSource.ext_id.trim(),
          room_id: typeof rawSource.room_id === 'string' ? rawSource.room_id : undefined,
        });
        if (!resolved.ok) fail('SKILL_SOURCE_MISSING', `外部消息号未导入：${rawSource.ext_id}`);
        const match = resolved.matches.find((row) => row.found);
        if (!match) fail('SKILL_SOURCE_MISSING', `外部消息号在消息库已失联：${rawSource.ext_id}`);
        source = { room_id: match.room_id, msg_id: match.msg_id, ext_id: rawSource.ext_id.trim() };
      }
      if (!source || typeof source.room_id !== 'string' || typeof source.msg_id !== 'string') {
        fail('SKILL_SOURCE_MISSING', '来源格式必须是 {room_id, msg_id} 或 {ext_id}');
      }
      resolvedSources.push(source);
    }
    const findMessage = findMessages(home, resolvedSources);
    for (const source of resolvedSources) {
      const found = findMessage(source);
      if (!found) fail('SKILL_SOURCE_MISSING', `来源消息不存在：${source.room_id}/${source.msg_id}`);
      verified.push({
        room_id: source.room_id,
        msg_id: source.msg_id,
        seq: found.seq,
        ...(typeof source.ext_id === 'string' ? { ext_id: source.ext_id } : {}),
      });
    }

    const cards = readCards(home);
    if (cards.some((row) => row.candidate_id === candidateId)) fail('ALREADY_APPROVED', '该候选已入库');
    if (readRejections(home).some((row) => row.candidate_id === candidateId)) fail('ALREADY_REJECTED', '该候选已被驳回');

    const created = new Date().toISOString();
    const cardId = `skill_${candidateId}`;
    const prevHash = cards.length === 0 ? '0'.repeat(64) : cards[cards.length - 1].hash;
    const body = { card_id: cardId, created, by, candidate_id: candidateId, card, sources: verified };
    const hash = sha256(`${prevHash}${canonical(body)}`);
    const record = { ...body, seq: cards.length + 1, prev_hash: prevHash, hash };
    appendJsonl(cardsFile(home), record);

    const indexed = indexDoc(home, {
      kind: 'skill',
      msg_id: cardId,
      room_id: 'skill',
      author: by,
      ts: created,
      seq: record.seq,
      text: cardSearchText(card, verified),
    });
    if (!indexed.ok) fail('INTERNAL', `卡片入索引失败：${indexed.message}`);
    return ok({ card_id: cardId, hash, indexed: true, sources: verified });
  });
}

export function reject(home, payload = {}) {
  return wrap(() => {
    const p = payload && typeof payload === 'object' ? payload : {};
    const candidateId = typeof p.candidate_id === 'string' ? p.candidate_id.trim() : '';
    const by = typeof p.by === 'string' ? p.by.trim() : '';
    const reason = typeof p.reason === 'string' ? p.reason.trim() : '';
    if (candidateId === '' || by === '') fail('BAD_INPUT', 'candidate_id 与 by 必填');
    if (reason === '') fail('BAD_INPUT', '驳回必须留原因');
    if (readCards(home).some((row) => row.candidate_id === candidateId)) fail('ALREADY_APPROVED', '该候选已入库');
    appendJsonl(rejectionsFile(home), { candidate_id: candidateId, by, reason, ts: new Date().toISOString() });
    return ok({ candidate_id: candidateId, rejected: true });
  });
}

// ---------- ③ 查询 / 溯源 / 校验 ----------

export function list(home) {
  return wrap(() => ok({ total: readCards(home).length, cards: readCards(home) }));
}

export function get(home, cardId) {
  return wrap(() => {
    const card = readCards(home).find((row) => row.card_id === cardId);
    if (!card) fail('NOT_FOUND', '卡片不存在');
    const findMessage = findMessages(home, card.sources);
    const sources = card.sources.map((source) => {
      const message = findMessage(source);
      return {
        ...source,
        found: Boolean(message),
        text: message ? stripHeader(message.text) : null,
        author: message ? message.author : null,
        ts: message ? message.ts : null,
      };
    });
    return ok({ card, sources, intact: sources.every((source) => source.found) });
  });
}

export function verify(home) {
  return wrap(() => {
    const cards = readCards(home);
    const broken = [];
    let prevHash = '0'.repeat(64);
    for (const card of cards) {
      const body = { card_id: card.card_id, created: card.created, by: card.by, candidate_id: card.candidate_id, card: card.card, sources: card.sources };
      const expect = sha256(`${prevHash}${canonical(body)}`);
      if (card.prev_hash !== prevHash || card.hash !== expect) broken.push(card.card_id);
      prevHash = card.hash;
    }
    return ok({ total: cards.length, intact: broken.length === 0, broken });
  });
}

export function searchSkills(home, options = {}) {
  return wrap(() => searchQuery(home, { ...options, kind: 'skill' }));
}

// 卡片台账与索引对账（与 I23 同思路，权威源＝cards.jsonl）
export function audit(home) {
  return wrap(() => {
    const cards = readCards(home);
    const authoritative = new Set(cards.map((card) => card.card_id));
    const cardsById = new Map(cards.map((card) => [card.card_id, card]));
    const repaired = { ghosts: 0, duplicates: 0, missing: 0 };
    const indexed = listDocs(home, 'skill');
    if (!indexed.ok) fail('INTERNAL', `读取技能索引失败：${indexed.message}`);
    const counts = new Map();
    for (const doc of indexed.docs) {
      counts.set(doc.msg_id, (counts.get(doc.msg_id) || 0) + 1);
    }

    // 权威源是 cards.jsonl：幽灵直接清，重复整组重投为一条，缺失补投。
    for (const cardId of counts.keys()) {
      if (!authoritative.has(cardId)) {
        removeDoc(home, 'skill', cardId);
        repaired.ghosts += counts.get(cardId);
      }
    }
    for (const [cardId, count] of counts) {
      if (!authoritative.has(cardId) || count === 1) continue;
      const card = cardsById.get(cardId);
      removeDoc(home, 'skill', cardId);
      indexDoc(home, {
        kind: 'skill',
        msg_id: card.card_id,
        room_id: 'skill',
        author: card.by,
        ts: card.created,
        seq: card.seq,
        text: cardSearchText(card.card, card.sources),
      });
      repaired.duplicates += count - 1;
    }
    const finalCounts = new Map();
    const finalDocs = listDocs(home, 'skill');
    if (!finalDocs.ok) fail('INTERNAL', `复核技能索引失败：${finalDocs.message}`);
    for (const doc of finalDocs.docs) finalCounts.set(doc.msg_id, (finalCounts.get(doc.msg_id) || 0) + 1);
    for (const card of cards) {
      if (finalCounts.has(card.card_id)) continue;
      indexDoc(home, {
        kind: 'skill',
        msg_id: card.card_id,
        room_id: 'skill',
        author: card.by,
        ts: card.created,
        seq: card.seq,
        text: cardSearchText(card.card, card.sources),
      });
      repaired.missing += 1;
    }
    const chain = verify(home);
    return ok({
      cards: cards.length,
      indexed: cards.length,
      ghosts: 0,
      missing: 0,
      duplicates: 0,
      repaired,
      chain_intact: chain.intact,
      intact: chain.intact,
    });
  });
}

export const skill = { candidates, approve, reject, list, get, verify, search: searchSkills, searchSkills, audit, CARD_FIELDS };
export default skill;
