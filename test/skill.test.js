// 中军帐 T-007-C 技能库哨兵：I25 认可门（缺栏拒入）/ I26 溯源（伪造来源拒入＋哈希链防篡改）/ 候选闸门 / 与检索同索引
// 纪律：先红后绿。src/skill.js 不存在时这些测试必须全红。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as zjz from '../src/core.js';

let skill = null;
try {
  ({ skill } = await import('../src/skill.js'));
} catch {
  skill = null;
}
import { search } from '../src/search.js';

function tmpHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'zjz-skill-'));
}

function must(res, where) {
  assert.equal(res && res.ok, true, `${where} 应成功，实际 ${JSON.stringify(res)}`);
  return res;
}

function assertCode(res, code, where) {
  assert.equal(res && res.ok, false, `${where} 应失败，实际 ${JSON.stringify(res)}`);
  assert.equal(res.code, code, `${where} 错误码应为 ${code}，实际 ${res.code}`);
}

function seed(home, texts) {
  const id = must(zjz.identity.create(home, '经验官'), 'identity');
  const room = must(zjz.room.create(home, id.slug, '经验房'), 'room');
  const sent = texts.map((text) => ({ text, msg: must(zjz.msg.send(home, id.slug, room.room_id, text), `send ${text}`) }));
  return { slug: id.slug, room_id: room.room_id, sent };
}

const FULL_CARD = {
  problem: '中文关键词检索用 FTS5 trigram 会漏二字词',
  practice: 'norm 规范化子串兜底＋FTS5 只做 ≥3 字符预筛',
  evidence: '2026-11-09 红测 T30 语料 22 条滑窗召回 100%，trigram 对「工单」零命中实测',
  boundary: '本地单机 sqlite，万条量级；不做同义词',
  pitfalls: '别用 unicode61 分词；改语义先改红测',
};

// ---------- T32 I25 认可门 ----------
test('T32 I25 五栏缺栏一律拒入（无「验证证据」不得入库，卡片也不进索引）', () => {
  assert.ok(skill, 'src/skill.js 未实现（红测）');
  const home = tmpHome();
  const ctx = seed(home, ['实测：换班 checkpoint 对账后全绿 40/40（src/core.js）', '今天午饭吃什么']);

  const cand = must(skill.candidates(home, {}), 'candidates');
  assert.equal(cand.candidates.length, 1, '无信号词的消息不得成为候选（无引用不列）');
  assert.equal(cand.candidates[0].msg_id, ctx.sent[0].msg.id, '候选必须引用消息号');
  assert.equal(cand.candidates[0].room_id, ctx.room_id, '候选必须引用房号');

  const noEvidence = { ...FULL_CARD };
  delete noEvidence.evidence;
  assertCode(skill.approve(home, { candidate_id: cand.candidates[0].candidate_id, by: ctx.slug, card: noEvidence, sources: cand.candidates[0].sources }), 'SKILL_INCOMPLETE', '缺「验证证据」栏');

  const emptyPitfalls = { ...FULL_CARD, pitfalls: '   ' };
  assertCode(skill.approve(home, { candidate_id: cand.candidates[0].candidate_id, by: ctx.slug, card: emptyPitfalls, sources: cand.candidates[0].sources }), 'SKILL_INCOMPLETE', '空白栏等同缺栏');

  assert.equal(must(skill.list(home), 'list').total, 0, '被拒的候选绝不得入库');
  assert.equal(must(skill.searchSkills(home, { q: 'trigram' }), 'searchSkills').hits.length, 0, '未入库不得进索引');
});

// ---------- T33 I26 溯源 ----------
test('T33 I26 伪造来源拒入；入库卡片可溯源到原文（房号＋消息号）', () => {
  assert.ok(skill, 'src/skill.js 未实现（红测）');
  const home = tmpHome();
  const ctx = seed(home, ['验证通过：租约半写导致双活，复现 2 次后全绿（src/core.js）']);
  const cand = must(skill.candidates(home, {}), 'candidates').candidates[0];

  assertCode(skill.approve(home, { candidate_id: cand.candidate_id, by: ctx.slug, card: FULL_CARD, sources: [] }), 'SKILL_SOURCE_MISSING', '无来源拒入');
  assertCode(
    skill.approve(home, { candidate_id: cand.candidate_id, by: ctx.slug, card: FULL_CARD, sources: [{ room_id: ctx.room_id, msg_id: 'msg_不存在' }] }),
    'SKILL_SOURCE_MISSING',
    '伪造消息号拒入',
  );

  const approved = must(skill.approve(home, { candidate_id: cand.candidate_id, by: ctx.slug, card: FULL_CARD, sources: cand.sources }), 'approve');
  assert.match(approved.card_id, /^skill_/);
  const got = must(skill.get(home, approved.card_id), 'get');
  assert.equal(got.intact, true, '来源消息必须真实存在');
  assert.equal(got.sources[0].text, ctx.sent[0].text, '溯源必须回到原文');
  assert.equal(got.sources[0].room_id, ctx.room_id);
  const chain = must(skill.verify(home), 'verify');
  assert.equal(chain.intact, true, '哈希链必须完整');
});

// ---------- T34 与检索同索引＋防篡改 ----------
test('T34 卡片进同一索引：搜卡片关键词召回卡；默认消息检索不含卡；篡改卡后 verify 检出', () => {
  assert.ok(skill, 'src/skill.js 未实现（红测）');
  const home = tmpHome();
  const ctx = seed(home, ['实测：FTS5 trigram 对二字中文词零命中，改两层召回后召回 100%（src/search.js）']);
  const cand = must(skill.candidates(home, {}), 'candidates').candidates[0];
  const approved = must(skill.approve(home, { candidate_id: cand.candidate_id, by: ctx.slug, card: FULL_CARD, sources: cand.sources }), 'approve');

  const cards = must(skill.searchSkills(home, { q: '会漏二字词' }), 'searchSkills');
  assert.ok(cards.hits.some((hit) => hit.msg_id === approved.card_id), '搜卡片关键词必须召回该卡');

  const msgs = must(search.query(home, { q: 'trigram' }), 'msg-only query');
  assert.ok(msgs.hits.length >= 1 && msgs.hits.every((hit) => hit.kind === 'msg'), '默认检索只回消息，不得混入卡片');
  const both = must(search.query(home, { q: 'trigram', kind: 'all' }), 'kind=all query');
  assert.ok(both.hits.some((hit) => hit.kind === 'skill'), 'kind=all 应同时看到消息与卡片');

  // 消息↔消息库对账不得被卡片污染（I23 口径）
  const audit = must(search.audit(home), 'search.audit');
  assert.equal(audit.intact, true, '卡片入库后 I23 对账仍须 intact');
  assert.equal(audit.indexed, audit.messages, 'indexed 只认消息条目');

  // 篡改检测：直接改 cards.jsonl 正文
  const file = path.join(home, 'data', 'skills', 'cards.jsonl');
  const rows = fs.readFileSync(file, 'utf8').split('\n').filter((line) => line.trim() !== '').map((line) => JSON.parse(line));
  rows[0].card.evidence = '随手改写的证据';
  fs.writeFileSync(file, rows.map((row) => JSON.stringify(row)).join('\n') + '\n', 'utf8');
  const broken = must(skill.verify(home), 'verify after tamper');
  assert.equal(broken.intact, false, '篡改必须检出');
  assert.deepEqual(broken.broken, [approved.card_id]);
});

// ---------- T35 候选闸门＋驳回台账 ----------
test('T35 候选必须有信号词与引用；驳回留原因台账且不再出现在候选', () => {
  assert.ok(skill, 'src/skill.js 未实现（红测）');
  const home = tmpHome();
  const ctx = seed(home, ['工单已派，请接手。', '验收通过：哈希链连续，npm test 40/40 全绿（src/qc.js）']);
  const all = must(skill.candidates(home, {}), 'candidates');
  assert.equal(all.candidates.length, 1, '普通陈述不得成为候选');
  assert.equal(all.candidates[0].msg_id, ctx.sent[1].msg.id);

  assertCode(skill.reject(home, { candidate_id: 'c_x', by: ctx.slug, reason: '' }), 'BAD_INPUT', '驳回必须留原因');
  must(skill.reject(home, { candidate_id: all.candidates[0].candidate_id, by: ctx.slug, reason: '只是状态汇报，不是可复用经验' }), 'reject');
  assert.equal(must(skill.candidates(home, {}), 'candidates after reject').candidates.length, 0, '驳回后不再列为候选');
  assertCode(skill.approve(home, { candidate_id: all.candidates[0].candidate_id, by: ctx.slug, card: FULL_CARD, sources: all.candidates[0].sources }), 'ALREADY_REJECTED', '已驳回的候选不得再入库');
});

// ---------- T36 幂等＋卡片对账 ----------
test('T36 同一候选重复 approve 拒绝；skill.audit 卡片↔索引对账 intact', () => {
  assert.ok(skill, 'src/skill.js 未实现（红测）');
  const home = tmpHome();
  const ctx = seed(home, ['复现成功：看门狗按 session=0 超龄换班幂等，npm test 40/40 全绿（src/watchdog.js）']);
  const cand = must(skill.candidates(home, {}), 'candidates').candidates[0];
  const first = must(skill.approve(home, { candidate_id: cand.candidate_id, by: ctx.slug, card: FULL_CARD, sources: cand.sources }), 'approve');
  assertCode(skill.approve(home, { candidate_id: cand.candidate_id, by: ctx.slug, card: FULL_CARD, sources: cand.sources }), 'ALREADY_APPROVED', '重复入库必须拒绝');

  must(search.indexDoc(home, {
    kind: 'skill',
    msg_id: 'skill_ghost_without_source_keyword',
    room_id: 'skill',
    author: '幽灵',
    ts: new Date().toISOString(),
    seq: 999,
    text: '幽灵卡片正文不含固定检索词',
  }), '注入幽灵技能索引');
  const audit = must(skill.audit(home), 'skill.audit');
  assert.equal(audit.intact, true, '卡片对账须 intact');
  assert.equal(audit.cards, 1);
  assert.equal(audit.ghosts, 0);
  assert.equal(audit.missing, 0);
  assert.equal(audit.repaired.ghosts, 1, 'audit 必须枚举清幽灵，不靠“来源”关键词');
  assert.equal(must(skill.searchSkills(home, { q: '幽灵卡片正文' }), '幽灵复查').total, 0);
  assert.equal(must(skill.searchSkills(home, { q: '预筛' }), 'searchSkills').hits[0].msg_id, first.card_id);
});
