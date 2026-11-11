// 中军帐 M2 哨兵测试：I8-I12
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as zjz from '../src/core.js';

function tmpHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'zjz-m2-'));
}

function must(res, where) {
  assert.equal(res && res.ok, true, `${where} 应成功，实际 ${JSON.stringify(res)}`);
  return res;
}

function assertCode(res, code, where) {
  assert.equal(res && res.ok, false, `${where} 应失败，实际 ${JSON.stringify(res)}`);
  assert.equal(res.code, code, `${where} 错误码应为 ${code}，实际 ${res.code}`);
}

function setup() {
  const home = tmpHome();
  const id = must(zjz.identity.create(home, '工单员'), 'identity');
  return { home, id };
}

// ---------- T8 I8 ----------
test('T8 I8 工单状态机非法跃迁一律拒绝', () => {
  const { home, id } = setup();
  const order = must(zjz.order.dispatch(home, id.slug, {
    project: 'T-001',
    title: '段05 渲染',
    deliverables: 'seg05.mp4',
    acceptance: '五条自检全过',
  }), 'dispatch');
  assert.equal(order.status, 'dispatched');

  assertCode(zjz.order.accept(home, id.slug, order.order_id), 'BAD_STATE', 'dispatched 直接 accept');
  assertCode(zjz.order.deliver(home, id.slug, order.order_id), 'BAD_STATE', 'dispatched 直接 deliver');
  assertCode(zjz.order.close(home, id.slug, order.order_id), 'BAD_STATE', 'dispatched 直接 close');

  const claimed = must(zjz.order.claim(home, id.slug, order.order_id), 'claim');
  assert.equal(claimed.status, 'claimed');
  assert.equal(claimed.claim_seq, 1);

  assertCode(zjz.order.accept(home, id.slug, order.order_id), 'BAD_STATE', 'claimed 直接 accept');
  const delivered = must(zjz.order.deliver(home, id.slug, order.order_id, '已出片'), 'deliver');
  assert.equal(delivered.status, 'delivered');
  assertCode(zjz.order.close(home, id.slug, order.order_id), 'BAD_STATE', 'delivered 直接 close');

  const accepted = must(zjz.order.accept(home, id.slug, order.order_id, '验收通过'), 'accept');
  assert.equal(accepted.status, 'accepted');
  const closed = must(zjz.order.close(home, id.slug, order.order_id, '结单'), 'close');
  assert.equal(closed.status, 'closed');

  const history = must(zjz.order.get(home, order.order_id), 'get').order.history;
  assert.deepEqual(history.map((h) => h.action), ['dispatch', 'claim', 'deliver', 'accept', 'close']);
});

// ---------- T9 I9 ----------
test('T9 I9 双人认领以 claim_seq 小者胜，后到者自动驳回', () => {
  const home = tmpHome();
  const first = must(zjz.identity.create(home, '先到'), 'id1');
  const second = must(zjz.identity.create(home, '后到'), 'id2');
  const order = must(zjz.order.dispatch(home, first.slug, {
    project: 'T-001',
    title: '抢单仲裁',
  }), 'dispatch');

  const win = must(zjz.order.claim(home, first.slug, order.order_id), 'first claim');
  assert.equal(win.claim_seq, 1);
  assert.equal(win.assignee, first.slug);

  const lose = zjz.order.claim(home, second.slug, order.order_id);
  assert.equal(lose.ok, false);
  assert.equal(lose.code, 'CLAIM_LOST');
  assert.equal(lose.assignee, first.slug);
  assert.ok(lose.claim_seq > win.claim_seq);

  assertCode(zjz.order.deliver(home, second.slug, order.order_id), 'NOT_ASSIGNEE', '非认领人交付');
  must(zjz.order.deliver(home, first.slug, order.order_id), '认领人交付');
});

// ---------- T10 I10 ----------
test('T10 I10 换班 checkpoint 恢复后无重复无遗漏', () => {
  const home = tmpHome();
  const day = must(zjz.identity.create(home, '白班'), 'day');
  const night = must(zjz.identity.create(home, '夜班'), 'night');
  const room = must(zjz.room.create(home, day.slug, '值班房'), 'room');
  must(zjz.room.join(home, night.slug, room.invite_code), 'join');

  for (const t of ['1', '2', '3']) must(zjz.msg.send(home, day.slug, room.room_id, t), 'send 1-3');
  const before = must(zjz.msg.wait(home, day.slug, { timeout_ms: 50 }), 'day wait');
  assert.deepEqual(before.messages.map((m) => m.seq), [1, 2, 3]);
  for (const t of ['4', '5']) must(zjz.msg.send(home, day.slug, room.room_id, t), 'send 4-5');

  must(zjz.duty.set(home, day.slug, { mode: 'oncall' }), 'duty day');
  must(zjz.duty.set(home, night.slug, { mode: 'listen' }), 'duty night');
  const shift = must(zjz.duty.shift(home, day.slug, { to: night.slug }), 'shift');
  assert.equal(shift.checkpoint.rooms[room.room_id], 3);
  assert.deepEqual(shift.applied_rooms, [room.room_id]);

  const handover = must(zjz.msg.wait(home, night.slug, { timeout_ms: 50 }), 'night wait');
  assert.deepEqual(handover.messages.map((m) => m.seq), [4, 5], '接班者只收到 checkpoint 之后');

  const back = must(zjz.duty.shift(home, night.slug, {
    to: day.slug,
    checkpoint: { rooms: { [room.room_id]: 5 } },
  }), 'shift back');
  assert.equal(back.checkpoint.rooms[room.room_id], 5);

  const none = must(zjz.msg.wait(home, day.slug, { timeout_ms: 30 }), 'day wait after back');
  assert.deepEqual(none.messages, [], '换回后不应重播旧消息');

  must(zjz.msg.send(home, night.slug, room.room_id, '6'), 'send 6');
  const next = must(zjz.msg.wait(home, day.slug, { timeout_ms: 50 }), 'day wait next');
  assert.deepEqual(next.messages.map((m) => m.seq), [6]);
});

// ---------- T11 I11 ----------
test('T11 I11 daemon 唤醒即时且不重复投递', async () => {
  delete process.env.ZJZ_DAEMON;
  const { home, id } = setup();
  const room = must(zjz.room.create(home, id.slug, 'daemon 房'), 'room');

  const timer = setTimeout(() => {
    zjz.msg.send(home, id.slug, room.room_id, 'daemon 唤醒');
  }, 300);
  const startedAt = Date.now();
  const first = await zjz.msg.waitAsync(home, id.slug, { timeout_ms: 3000 });
  const elapsed = Date.now() - startedAt;
  clearTimeout(timer);

  assert.equal(first.ok, true, JSON.stringify(first));
  assert.deepEqual(first.messages.map((m) => m.text), ['daemon 唤醒']);
  assert.ok(elapsed < 1200, `daemon 应在 1.2s 内唤醒，实际 ${elapsed}ms`);

  const second = await zjz.msg.waitAsync(home, id.slug, { timeout_ms: 60 });
  assert.deepEqual(second.messages, [], '第二次不应重复投递');
});

test('T11b I11 ZJZ_DAEMON=0 回退轮询，语义不变', async () => {
  process.env.ZJZ_DAEMON = '0';
  try {
    const { home, id } = setup();
    const room = must(zjz.room.create(home, id.slug, '轮询房'), 'room');
    must(zjz.msg.send(home, id.slug, room.room_id, '轮询投递'), 'send');
    const first = await zjz.msg.waitAsync(home, id.slug, { timeout_ms: 1000 });
    assert.deepEqual(first.messages.map((m) => m.text), ['轮询投递']);
    const second = await zjz.msg.waitAsync(home, id.slug, { timeout_ms: 50 });
    assert.deepEqual(second.messages, []);
  } finally {
    delete process.env.ZJZ_DAEMON;
  }
});

// ---------- T12 I12 ----------
test('T12 I12 order.list 按 project 过滤，跨项目零串', () => {
  const { home, id } = setup();
  const madeA = [];
  const madeB = [];
  for (let i = 1; i <= 3; i += 1) {
    madeA.push(must(zjz.order.dispatch(home, id.slug, { project: 'proj-A', title: `A${i}` }), 'dispatch A').order_id);
  }
  for (let i = 1; i <= 2; i += 1) {
    madeB.push(must(zjz.order.dispatch(home, id.slug, { project: 'proj-B', title: `B${i}` }), 'dispatch B').order_id);
  }

  const listA = must(zjz.order.list(home, { project: 'proj-A' }), 'list A');
  const listB = must(zjz.order.list(home, { project: 'proj-B' }), 'list B');
  const listAll = must(zjz.order.list(home, {}), 'list all');
  assert.deepEqual(listA.orders.map((o) => o.order_id).sort(), [...madeA].sort());
  assert.deepEqual(listB.orders.map((o) => o.order_id).sort(), [...madeB].sort());
  assert.equal(listA.orders.every((o) => o.project === 'proj-A'), true);
  assert.equal(listB.orders.every((o) => o.project === 'proj-B'), true);
  assert.equal(listAll.orders.length, 5);

  const listBDispatched = must(zjz.order.list(home, { project: 'proj-B', status: 'dispatched' }), 'list B dispatched');
  assert.equal(listBDispatched.orders.length, 2);
  const listBNone = must(zjz.order.list(home, { project: 'proj-B', status: 'closed' }), 'list B closed');
  assert.equal(listBNone.orders.length, 0);
});