// 中军帐 T-007-A 检索哨兵：I23 索引对账 / I24 增量索引不重投 / I3 跨房隔离 / 过滤与召回
// 纪律：先红后绿。src/search.js 不存在时这些测试必须全红。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as zjz from '../src/core.js';

let search = null;
try {
  ({ search } = await import('../src/search.js'));
} catch {
  search = null;
}

function tmpHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'zjz-t007-'));
}

function must(res, where) {
  assert.equal(res && res.ok, true, `${where} 应成功，实际 ${JSON.stringify(res)}`);
  return res;
}

function assertCode(res, code, where) {
  assert.equal(res && res.ok, false, `${where} 应失败，实际 ${JSON.stringify(res)}`);
  assert.equal(res.code, code, `${where} 错误码应为 ${code}，实际 ${res.code}`);
}

// 语料：每条自带必检关键词（手算期望，召回门 100%）
const CORPUS = [
  ['工单已派发，请认领', '工单'],
  ['换班 checkpoint 已捕获', '换班'],
  ['哈希链断裂在 seq 6', '哈希链'],
  ['克隆声线渲染四段全绿', '克隆声线'],
  ['质检台账四栏缺一律拒', '台账'],
  ['看门狗超龄自动换班一次', '看门狗'],
  ['并发追加 seq 1..15 连续', '并发追加'],
  ['篡改一条后 verify 报 intact=false', '篡改'],
  ['租约半写导致双活', '租约'],
  ['身份串号根因是缺 home 环境变量', '身份串号'],
  ['邀请码是入房唯一入口', '邀请码'],
  ['游标单调不重复投递', '游标'],
  ['FTS5 trigram 对两字中文词漏检', 'trigram'],
  ['索引与消息库对账二十条', '对账'],
  ['技能卡五栏缺栏拒绝入库', '技能卡'],
  ['双台账 event_id 互指', '互指'],
  ['认领仲裁先到者胜 claim_seq', 'claim_seq'],
  ['监听不消费消息', '监听'],
  ['sqlite FTS5 起步不上网络', 'sqlite'],
  ['中文短语与子串都要召回', '子串'],
  ['CRLF 脚本连挂十一次', 'CRLF'],
  ['心跳超龄换班幂等 CAS', 'CAS'],
];

function seedRoom(home, slug, roomId, from = 0, count = CORPUS.length) {
  const sent = [];
  for (let i = from; i < Math.min(from + count, CORPUS.length); i += 1) {
    const msg = must(zjz.msg.send(home, slug, roomId, CORPUS[i][0]), `send "${CORPUS[i][0]}"`);
    sent.push({ index: i, text: CORPUS[i][0], keyword: CORPUS[i][1], msg_id: msg.id, seq: msg.seq });
  }
  return sent;
}

// ---------- T26 I23 索引与消息库对账 ----------
test('T26 I23 索引条数与消息库对账；随机 20 条按自身关键词必命中；增删后重跑对账', () => {
  assert.ok(search, 'src/search.js 未实现（红测）');
  const home = tmpHome();
  const id = must(zjz.identity.create(home, '检索官'), 'identity');
  const made = must(zjz.room.create(home, id.slug, '甲房'), 'room');
  const sentA = seedRoom(home, id.slug, made.room_id);

  must(search.reindex(home), 'reindex');
  let audit = must(search.audit(home), 'audit');
  assert.equal(audit.messages, sentA.length, '消息库条数');
  assert.equal(audit.indexed, sentA.length, '索引条数应等于消息库条数');
  assert.equal(audit.duplicates, 0, '索引不得有重复条目');
  assert.equal(audit.missing, 0, '不得有未索引消息');
  assert.equal(audit.ghosts, 0, '不得有幽灵索引条目');
  assert.equal(audit.intact, true, '对账应 intact');

  // 固定种子抽 20 条（可复现）：每条按其自身关键词检索必须命中自身
  let seed = 20261109;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
  const picked = sentA.map((entry) => ({ entry, key: rand() })).sort((a, b) => a.key - b.key).slice(0, 20).map((x) => x.entry);
  assert.equal(picked.length, 20);
  const missed = [];
  for (const entry of picked) {
    const found = must(search.query(home, { q: entry.keyword }), `query "${entry.keyword}"`);
    if (!found.hits.some((hit) => hit.msg_id === entry.msg_id)) missed.push(entry.keyword);
  }
  assert.deepEqual(missed, [], '漏检＝红线：随机 20 条必须全部被自身关键词命中');

  // 新增消息 → 增量索引 → 对账仍 intact
  sayMore(home, id.slug, made.room_id, '新增一条：检索对账增量');
  must(search.index(home), 'incremental index');
  audit = must(search.audit(home), 'audit after add');
  assert.equal(audit.messages, sentA.length + 1);
  assert.equal(audit.indexed, sentA.length + 1);
  assert.equal(audit.duplicates, 0);
  assert.equal(audit.intact, true);

  // 删除消息（重写 jsonl）→ 对账必须发现并清掉幽灵条目
  const file = path.join(home, 'data', 'rooms', made.room_id, 'messages.jsonl');
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter((line) => line.trim() !== '');
  fs.writeFileSync(file, lines.slice(0, 5).join('\n') + '\n', 'utf8');
  audit = must(search.audit(home), 'audit after truncate');
  assert.equal(audit.messages, 5, '消息库应为 5 条');
  assert.equal(audit.indexed, 5, '索引不得留幽灵条目');
  assert.equal(audit.ghosts, 0);
  assert.equal(audit.intact, true, '删消息后对账仍须 intact');
});

function sayMore(home, slug, roomId, text) {
  return must(zjz.msg.send(home, slug, roomId, text), `send "${text}"`);
}

// ---------- T27 I24 增量索引、不重投 ----------
test('T27 I24 send 后 2 秒内可检索；wait 重放与反复同步不产生重复索引', () => {
  assert.ok(search, 'src/search.js 未实现（红测）');
  const home = tmpHome();
  const owner = must(zjz.identity.create(home, '发单方'), 'owner');
  const waiter = must(zjz.identity.create(home, '值班员'), 'waiter');
  const made = must(zjz.room.create(home, owner.slug, '增量房'), 'room');
  must(zjz.room.join(home, waiter.slug, made.invite_code), 'join');

  must(search.index(home), 'initial index');
  assert.equal(must(search.audit(home), 'audit empty').indexed, 0, '空房索引应为 0');

  const sent = sayMore(home, owner.slug, made.room_id, '增量索引：新消息一句话 换班');
  const started = Date.now();
  let hit = null;
  while (Date.now() - started <= 2000 && !hit) {
    const found = must(search.query(home, { q: '新消息一句话' }), 'query after send');
    hit = found.hits.find((item) => item.msg_id === sent.id) || null;
    if (!hit) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 40);
  }
  assert.ok(hit, 'send 后 2 秒内必须可检索（增量索引）');
  const elapsed = Date.now() - started;
  assert.ok(elapsed <= 2000, `检索时延应 <=2000ms，实际 ${elapsed}ms`);

  // wait 重放：游标推进后二次 wait 无新消息（I4），反复索引不得重投
  const first = must(zjz.msg.wait(home, waiter.slug, { timeout_ms: 1000 }), 'wait 1');
  assert.equal(first.messages.length, 1, 'wait 应拿到 1 条');
  const replay = must(zjz.msg.wait(home, waiter.slug, { timeout_ms: 200 }), 'wait 2');
  assert.equal(replay.messages.length, 0, '游标已推进，不得重复投递');

  for (let round = 0; round < 5; round += 1) must(search.index(home), `index round ${round}`);
  const audit = must(search.audit(home), 'audit after repeat');
  assert.equal(audit.duplicates, 0, '反复同步不得产生重复索引条目');
  assert.equal(audit.indexed, audit.messages, '索引条数仍须等于消息条数');
  const found = must(search.query(home, { q: '新消息一句话' }), 'query once');
  assert.equal(found.hits.length, 1, '同一条消息只得一条命中');
});

// ---------- T28 I3 跨房隔离（延续）----------
test('T28 I3 跨房隔离：A 房消息绝不进 B 房检索；成员作用域不外泄', () => {
  assert.ok(search, 'src/search.js 未实现（红测）');
  const home = tmpHome();
  const onlyA = must(zjz.identity.create(home, '甲房独占'), 'onlyA');
  const both = must(zjz.identity.create(home, '两房成员'), 'both');
  const roomA = must(zjz.room.create(home, onlyA.slug, '隔离甲'), 'roomA');
  const roomB = must(zjz.room.create(home, both.slug, '隔离乙'), 'roomB');
  must(zjz.room.join(home, both.slug, roomA.invite_code), 'both join A');

  seedRoom(home, onlyA.slug, roomA.room_id, 0, 8); // 仅 A 房
  seedRoom(home, both.slug, roomB.room_id, 9, 5); // 仅 B 房（不同语料段）

  must(search.reindex(home), 'reindex');

  // 1) 按房检索：B 房结果里绝不含 A 房消息号
  const inB = must(search.query(home, { q: '工单', room_id: roomB.room_id }), 'B scoped');
  const inA = must(search.query(home, { q: '工单', room_id: roomA.room_id }), 'A scoped');
  assert.ok(inA.hits.length >= 1, 'A 房应命中「工单」');
  assert.equal(inB.hits.length, 0, '「工单」只存在于 A 房，B 房检索必须零命中');
  const bIds = new Set(inB.hits.map((hit) => hit.msg_id));
  const aIds = new Set(inA.hits.map((hit) => hit.msg_id));
  for (const id of bIds) assert.ok(!aIds.has(id), 'A 房消息号不得出现在 B 房结果');
  assert.ok(inA.hits.every((hit) => hit.room_id === roomA.room_id), 'A scoped 结果房号必须全为 A');

  // 2) 全量检索里，每条命中都带正确房号，且按房过滤是子集
  const all = must(search.query(home, { q: '换班' }), 'all rooms');
  const scopedA = must(search.query(home, { q: '换班', room_id: roomA.room_id }), 'A scoped 换班');
  const scopedB = must(search.query(home, { q: '换班', room_id: roomB.room_id }), 'B scoped 换班');
  assert.equal(all.hits.length, scopedA.hits.length + scopedB.hits.length, '两房子集之和应等于全量');
  assert.ok(all.hits.every((hit) => hit.room_id === roomA.room_id || hit.room_id === roomB.room_id));

  // 3) 成员作用域：onlyA 不是 B 房成员 → 带 slug 的检索不得漏出 B 房消息
  const asA = must(search.query(home, { q: '哈希链', slug: onlyA.slug }), 'as onlyA');
  assert.ok(asA.hits.every((hit) => hit.room_id !== roomB.room_id), '非成员不得看到 B 房消息');
  const asBoth = must(search.query(home, { q: '哈希链', slug: both.slug }), 'as both');
  const asAIds = new Set(asA.hits.map((hit) => hit.msg_id));
  for (const hit of asBoth.hits) {
    if (hit.room_id === roomB.room_id) assert.ok(!asAIds.has(hit.msg_id), 'B 房消息不得出现在 onlyA 结果里');
  }
  assert.ok(asBoth.hits.length >= asA.hits.length, '两房成员可见数应不少于单房成员');

  // 4) 非成员按房检索一律拒绝
  assertCode(search.query(home, { q: '哈希链', room_id: roomB.room_id, slug: onlyA.slug }), 'NOT_MEMBER', '非成员按房检索');
});

// ---------- T29 过滤组合（关键词 × 时间 × 发送者，手算硬编码期望）----------
test('T29 过滤组合：关键词 × 时间区间 × 发送者 与/或结果与手算期望一致', () => {
  assert.ok(search, 'src/search.js 未实现（红测）');
  const home = tmpHome();
  const a = must(zjz.identity.create(home, '甲'), 'a');
  const b = must(zjz.identity.create(home, '乙'), 'b');
  const room = must(zjz.room.create(home, a.slug, '过滤房'), 'room');
  must(zjz.room.join(home, b.slug, room.invite_code), 'join');

  // 手算 fixture：3 笔小样本 + 干扰项
  const m1 = sayMore(home, a.slug, room.room_id, '换班 一号'); // 甲
  const m2 = sayMore(home, b.slug, room.room_id, '换班 二号'); // 乙
  const m3 = sayMore(home, a.slug, room.room_id, '换班 三号'); // 甲
  const m4 = sayMore(home, b.slug, room.room_id, '派单 四号'); // 乙，不含「换班」
  const ids = { m1: m1.id, m2: m2.id, m3: m3.id, m4: m4.id };

  must(search.index(home), 'index');
  const expect = (res, list, where) => {
    assert.deepEqual(res.hits.map((hit) => hit.msg_id).sort(), list.map((k) => ids[k]).sort(), where);
  };

  expect(must(search.query(home, { q: '换班' }), 'kw only'), ['m1', 'm2', 'm3'], '仅关键词');
  expect(must(search.query(home, { q: '换班', sender: a.slug }), 'kw+sender'), ['m1', 'm3'], '关键词×发送者');
  expect(must(search.query(home, { q: '换班', sender: b.slug }), 'kw+sender b'), ['m2'], '关键词×发送者(乙)');

  // 时间：以 m2 的 ts 为界（since/until 含端点）
  const ts2 = must(zjz.msg.read(home, a.slug, room.room_id), 'read').messages.find((m) => m.id === ids.m2).ts;
  expect(must(search.query(home, { q: '换班', until: ts2 }), 'until'), ['m1', 'm2'], '关键词×时间(<=m2)');
  expect(must(search.query(home, { q: '换班', since: ts2 }), 'since'), ['m2', 'm3'], '关键词×时间(>=m2)');
  expect(must(search.query(home, { q: '换班', since: ts2, until: ts2, sender: b.slug }), 'three-way AND'), ['m2'], '三条件与');
  expect(must(search.query(home, { q: '换班', since: ts2, until: ts2, sender: a.slug }), 'empty AND'), [], '三条件与(空集)');

  // 多发送者（或）
  expect(must(search.query(home, { q: '换班', sender: [a.slug, b.slug] }), 'senders or'), ['m1', 'm2', 'm3'], '发送者列表(或)');

  // 干扰项确认：搜「派单」只命中 m4
  expect(must(search.query(home, { q: '派单' }), 'only m4'), ['m4'], '干扰项隔离');

  // 上下文：命中前后各 >=1 条
  const withCtx = must(search.query(home, { q: '二号' }), 'ctx');
  assert.equal(withCtx.hits.length, 1);
  assert.ok(withCtx.hits[0].context.before.length >= 1, '上下文前 >=1 条');
  assert.ok(withCtx.hits[0].context.after.length >= 1, '上下文后 >=1 条');
  assert.deepEqual(withCtx.hits[0].context.before.map((m) => m.msg_id), [ids.m1], '前文应为 m1');
  assert.deepEqual(withCtx.hits[0].context.after.map((m) => m.msg_id), [ids.m3], '后文应为 m3');
  // 返回项带房号/发送者/时间/消息号
  const hit = withCtx.hits[0];
  assert.equal(hit.room_id, room.room_id);
  assert.equal(hit.author, b.slug);
  assert.equal(hit.ts, ts2);
  assert.equal(typeof hit.seq, 'number');
});

// ---------- T30 召回门：短语与子串、大小写/标点/全半角兜底 ----------
test('T30 召回门 100%：全语料逐关键词必命中；短语与子串、大小写、标点空白均不致漏检', () => {
  assert.ok(search, 'src/search.js 未实现（红测）');
  const home = tmpHome();
  const id = must(zjz.identity.create(home, '召回门'), 'identity');
  const made = must(zjz.room.create(home, id.slug, '召回房'), 'room');
  const sent = seedRoom(home, id.slug, made.room_id);
  must(search.reindex(home), 'reindex');

  const missed = [];
  for (let i = 0; i < CORPUS.length; i += 1) {
    const found = must(search.query(home, { q: CORPUS[i][1], room_id: made.room_id }), `q=${CORPUS[i][1]}`);
    if (!found.hits.some((hit) => hit.msg_id === sent[i].msg_id)) missed.push(CORPUS[i][1]);
  }
  const recall = ((CORPUS.length - missed.length) / CORPUS.length) * 100;
  assert.equal(recall, 100, `fixture 召回必须 100%，漏检：${missed.join(',')}`);

  // 子串/前缀：短语的一部分也要召回
  for (const [text, partial] of [
    ['哈希链断裂在 seq 6', '哈希'],
    ['哈希链断裂在 seq 6', '链断裂'],
    ['哈希链断裂在 seq 6', 'seq 6'],
    ['换班 checkpoint 已捕获', 'checkpoint'],
    ['换班 checkpoint 已捕获', 'CHECKPOINT'],
    ['并发追加 seq 1..15 连续', '1..15'],
    ['并发追加 seq 1..15 连续', 'seq1'],
    ['sqlite FTS5 起步不上网络', 'FTS5 起步'],
  ]) {
    void text;
    const found = must(search.query(home, { q: partial, room_id: made.room_id }), `partial "${partial}"`);
    assert.ok(found.hits.some((hit) => hit.text === text), `子串/大小写兜底漏检：${partial}`);
  }

  // 精度抽查：不存在的词必须零命中（不得把无关消息塞进来）
  for (const q of ['紫禁城', 'zzz-不存在的词', '换班 派单']) {
    const found = must(search.query(home, { q, room_id: made.room_id }), `neg "${q}"`);
    assert.equal(found.hits.length, 0, `「${q}」应零命中（精度）`);
  }
});

// ---------- T31 空输入/异常输入不崩溃（I6 延续）----------
test('T31 检索空输入与坏输入一律结构化错误，不裸抛', () => {
  assert.ok(search, 'src/search.js 未实现（红测）');
  const home = tmpHome();
  assertCode(search.query(home, {}), 'BAD_INPUT', '空查询');
  assertCode(search.query(home, { q: '   ' }), 'BAD_INPUT', '空白查询');
  assertCode(search.query(home, { q: '换班', since: 'not-a-time' }), 'BAD_INPUT', '坏时间');
  assertCode(search.query(home, { q: '换班', limit: 0 }), 'BAD_INPUT', 'limit 0');
  assertCode(search.query(home, { q: '换班', room_id: 'room_不存在' }), 'NOT_FOUND', '不存在房间');
  const audit = must(search.audit(home), 'audit empty home');
  assert.equal(audit.messages, 0);
  assert.equal(audit.indexed, 0);
  assert.equal(audit.intact, true);
  const empty = must(search.query(home, { q: '换班' }), 'query empty home');
  assert.equal(empty.hits.length, 0);
});
