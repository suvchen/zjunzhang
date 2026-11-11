// 哨兵 · 参谋长心跳督战（持续督战/第五能力）
// 盯住每个智能体：有活没干才催、活着不催、催过要冷却、拉不起来如实报——既不停摆，也不骚扰。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { member } from '../src/member.js';
import { delivery } from '../src/delivery.js';
import { registerWakeChild } from '../src/wake.js';
import { prodder } from '../src/prodder.js';

function tmpHome() { return fs.mkdtempSync(path.join(os.tmpdir(), 'zjz-prod-')); }

function seedDelivery(home, recipient, msgId = 'msg_1') {
  return delivery.post(home, {
    room_id: 'room_1',
    msg_id: msgId,
    sender: '房主',
    recipient,
    at: '2026-11-10T12:00:00.000Z',
  });
}

test('心跳督战：没有智能体时不崩、空转', () => {
  const home = tmpHome();
  const r = prodder.tick(home);
  assert.equal(r.ok, true);
  assert.equal(r.total, 0);
  assert.equal(r.nudged.length, 0);
  assert.equal(r.blocked.length, 0);
});

test('心跳督战：空闲（没有未回执投递）的智能体不催，如实报 no_work', () => {
  const home = tmpHome();
  member.set(home, { slug: '闲将', adapter_kind: 'notify', wake_policy: 'all' });
  const r = prodder.tick(home, { nudge_fn: () => { throw new Error('不该催'); } });
  assert.equal(r.ok, true);
  assert.equal(r.total, 1);
  assert.equal(r.nudged.length, 0);
  assert.equal(r.skipped[0].reason, 'no_work');
});

test('心跳督战：有活没干就催；催过在冷却期内不重复催（防连环轰炸）', () => {
  const home = tmpHome();
  member.set(home, { slug: '干将', adapter_kind: 'notify', wake_policy: 'all' });
  seedDelivery(home, '干将');
  let calls = 0;
  const opts = { now: Date.parse('2026-11-10T12:05:00.000Z'), nudge_fn: () => { calls += 1; return { ok: true, status: 'spawned' }; } };

  const first = prodder.tick(home, opts);
  assert.equal(first.nudged.length, 1, '有未回执投递＝该催');
  assert.equal(first.nudged[0].pending, 1);

  const second = prodder.tick(home, { ...opts, now: opts.now + 60 * 1000 });
  assert.equal(second.nudged.length, 0, '冷却期内不重复催');
  assert.equal(second.skipped[0].reason, 'cooling');
  assert.equal(calls, 1, '实际只催了一次');
});

test('心跳督战：已回执（answered）的不再催', () => {
  const home = tmpHome();
  member.set(home, { slug: '回将', adapter_kind: 'notify', wake_policy: 'all' });
  seedDelivery(home, '回将');
  // 回帖即已读：作者名下未 answered 的记录一律推到 answered（posted 也补 read→answered）。
  const marked = delivery.markAnsweredByAuthor(home, { author: '回将' });
  assert.equal(marked.ok, true);
  const r = prodder.tick(home, { nudge_fn: () => { throw new Error('不该催'); } });
  assert.equal(r.nudged.length, 0);
  assert.equal(r.skipped[0].reason, 'no_work');
});

test('心跳督战：子进程活着＝正在干，不催', () => {
  const home = tmpHome();
  member.set(home, { slug: '忙将', adapter_kind: 'notify', wake_policy: 'all' });
  seedDelivery(home, '忙将');
  registerWakeChild(home, '忙将', process.pid, ['node']);
  const r = prodder.tick(home, { nudge_fn: () => { throw new Error('不该催'); } });
  assert.equal(r.nudged.length, 0);
  assert.equal(r.skipped[0].reason, 'alive');
});

test('心跳督战：有活但拉不起来（无适配器/身份）如实报 blocked，不假装催过', () => {
  const home = tmpHome();
  // 只登记成员、不绑适配器/身份：wake.exec 会返回 not_wirable
  fs.mkdirSync(path.join(home, 'data', 'members'), { recursive: true });
  fs.writeFileSync(path.join(home, 'data', 'members', '缺装将.json'), JSON.stringify({ slug: '缺装将', rooms: [] }), 'utf8');
  seedDelivery(home, '缺装将');
  const r = prodder.tick(home);
  assert.equal(r.total, 1);
  assert.equal(r.nudged.length, 0);
  assert.equal(r.blocked.length, 1);
  assert.equal(r.blocked[0].status, 'not_wirable');
  assert.ok(r.blocked[0].reason, '要给出拉不起来的原因');
});

test('心跳督战：连催不起来就退避（冷却时间翻倍，封顶 30 分钟）', () => {
  const home = tmpHome();
  const state = { nudges: { 干将: { last_at: '2026-11-10T12:00:00.000Z', failures: 2 } } };
  assert.equal(prodder.cooldownFor(state, '干将', 60 * 1000), 4 * 60 * 1000);
  assert.equal(prodder.cooldownFor({ nudges: {} }, '新将', 60 * 1000), 60 * 1000);
  assert.equal(
    prodder.cooldownFor({ nudges: { 干将: { last_at: '2026-11-10T12:00:00.000Z', failures: 2 } } }, '干将', 10 * 60 * 1000),
    30 * 60 * 1000,
    '退避封顶 30 分钟',
  );
});
