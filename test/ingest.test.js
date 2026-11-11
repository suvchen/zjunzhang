// 中军帐 T-007-D 导入桥哨兵：I36 导入幂等 / I37 映射↔消息库对账 / 外部来源技能卡仍可溯源（I26 不放宽）
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as zjz from '../src/core.js';
import { ingest } from '../src/ingest.js';
import { skill } from '../src/skill.js';

function tmpHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'zjz-ingest-'));
}

function must(res, where) {
  assert.equal(res && res.ok, true, `${where} 应成功，实际 ${JSON.stringify(res)}`);
  return res;
}

function assertCode(res, code, where) {
  assert.equal(res && res.ok, false, `${where} 应失败，实际 ${JSON.stringify(res)}`);
  assert.equal(res.code, code, `${where} 错误码应为 ${code}，实际 ${res.code}`);
}

function makeRoom(home) {
  const id = must(zjz.identity.create(home, '导入官'), 'identity');
  const room = must(zjz.room.create(home, id.slug, '导入房'), 'room');
  return { slug: id.slug, room_id: room.room_id };
}

const EXT = [
  { ext_id: 'msg_54902', author: 'agent-a', ts: '2026-11-09T00:20:00.000Z', text: '【T-007 开工单】三大需求：Huddo 问题产品化、检索、技能库。' },
  { ext_id: 'msg_54962', author: 'agent-a', ts: '2026-11-09T00:41:00.000Z', text: '实测：FTS5 trigram 对二字中文词零命中，改两层召回后召回 100%。' },
  { ext_id: 'msg_54977', author: 'agent-b', ts: '2026-11-09T00:49:00.000Z', text: '已按新会话协议完成三步恢复：PROGRESS.md、error-cards.md、git log。' },
];

// ---------- T37 I36 导入幂等 ----------
test('T37 I36 导入幂等：同 ext_id 重复导入不得产生第二条消息', () => {
  const home = tmpHome();
  const { slug, room_id } = makeRoom(home);

  const first = must(ingest.records(home, { room_id, slug, source: 'huddo', records: EXT }), 'first import');
  assert.equal(first.imported, 3);
  assert.equal(first.skipped, 0);

  const again = must(ingest.records(home, { room_id, slug, source: 'huddo', records: EXT }), 'second import');
  assert.equal(again.imported, 0, '重复导入必须零新增');
  assert.equal(again.skipped, 3);

  const read = must(zjz.msg.read(home, slug, room_id), 'read');
  assert.equal(read.messages.length, 3, '消息库不得出现重复条目');

  const audit = must(ingest.audit(home), 'audit');
  assert.equal(audit.mapped, 3);
  assert.equal(audit.duplicates, 0);
  assert.equal(audit.intact, true);

  assertCode(ingest.records(home, { room_id, slug, records: [{ text: '没有 ext_id' }] }), 'BAD_INPUT', '缺 ext_id');
  assertCode(ingest.records(home, { room_id: 'room_不存在', slug, records: EXT }), 'NOT_FOUND', '房间不存在');
});

// ---------- T38 I37 溯源对账 ----------
test('T38 I37 映射↔消息库对账：原文可回溯、删消息检出幽灵、手工塞入检出孤儿', () => {
  const home = tmpHome();
  const { slug, room_id } = makeRoom(home);
  must(ingest.records(home, { room_id, slug, source: 'huddo', records: EXT }), 'import');

  const one = must(ingest.lookup(home, { ext_id: 'msg_54962' }), 'lookup');
  assert.equal(one.matches.length, 1);
  assert.equal(one.intact, true);
  assert.equal(one.matches[0].text, EXT[1].text, '回溯必须剥掉导入头、还原原文');
  assert.equal(one.matches[0].author_ext, EXT[1].author, '原作者必须留在映射侧');
  assertCode(ingest.lookup(home, { ext_id: 'msg_不存在' }), 'NOT_FOUND', '未导入的外部号必须明说');

  // 删掉一条消息 → 映射侧必须检出幽灵
  const file = path.join(home, 'data', 'rooms', room_id, 'messages.jsonl');
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter((line) => line.trim() !== '');
  fs.writeFileSync(file, lines.slice(0, 2).join('\n') + '\n', 'utf8');
  const afterDelete = must(ingest.audit(home), 'audit after delete');
  assert.equal(afterDelete.ghosts, 1, '映射指向已消失消息必须检出');
  assert.equal(afterDelete.intact, false);

  // 手工往 jsonl 塞一条带导入头但没有映射的消息 → 检出孤儿
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8') + JSON.stringify({ seq: 99, id: 'msg_manual', author: slug, ts: new Date().toISOString(), text: '[huddo:msg_fake] 手工塞入', sig: 'z'.repeat(64) }) + '\n', 'utf8');
  const afterManual = must(ingest.audit(home), 'audit after manual');
  assert.equal(afterManual.orphan_msgs, 1, '无映射的导入风格消息必须检出');
  assert.equal(afterManual.intact, false);
});

// ---------- T39 外部来源技能卡（打通 I26） ----------
test('T39 技能卡来源可写外部消息号：解析后仍可溯源，伪造外部号拒入', () => {
  const home = tmpHome();
  const { slug, room_id } = makeRoom(home);
  must(ingest.records(home, { room_id, slug, source: 'huddo', records: EXT }), 'import');

  const cand = must(skill.candidates(home, {}), 'candidates').candidates.find((row) => row.msg_id);
  assert.ok(cand, '导入的消息应能成为经验候选');

  const card = {
    problem: '中文二字关键词用 FTS5 trigram 检索漏检',
    practice: 'norm 规范化子串兜底＋FTS5 只做 ≥3 字符预筛',
    evidence: '红测 T30 语料滑窗召回 100%，trigram 对「工单」零命中实测',
    boundary: '本地单机 sqlite，万条量级',
    pitfalls: '别用 unicode61；改语义先改红测',
  };

  assertCode(
    skill.approve(home, { candidate_id: 'c_ext_1', by: slug, card, sources: [{ ext_id: 'msg_不存在' }] }),
    'SKILL_SOURCE_MISSING',
    '伪造外部消息号必须拒入',
  );

  const approved = must(skill.approve(home, { candidate_id: 'c_ext_1', by: slug, card, sources: [{ ext_id: 'msg_54962' }] }), 'approve with ext source');
  const got = must(skill.get(home, approved.card_id), 'get');
  assert.equal(got.intact, true, '外部来源解析后必须能在消息库回溯到原文');
  assert.equal(got.sources[0].ext_id, 'msg_54962', '卡片应保留外部原始消息号');
  assert.equal(got.sources[0].text, EXT[1].text, '点来源必须回到原文');
  const chain = must(skill.verify(home), 'verify');
  assert.equal(chain.intact, true);
});
