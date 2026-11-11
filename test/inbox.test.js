// 中军帐 T-008 第 0.5 层哨兵：I45 被动带出（任何工具返回都自带房讯横幅）
// 核心模块 src/inbox.js 未实现时本文件必须全红。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as zjz from '../src/core.js';
import { listen } from '../src/listen.js';

let inbox = null;
try {
  ({ inbox } = await import('../src/inbox.js'));
} catch {
  inbox = null;
}

function tmpHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'zjz-inbox-'));
}
function must(res, where) {
  assert.equal(res && res.ok, true, `${where} 应成功，实际 ${JSON.stringify(res)}`);
  return res;
}

function seedTwoRooms() {
  const home = tmpHome();
  const a = must(zjz.identity.create(home, '消息甲'), 'idA');
  const b = must(zjz.identity.create(home, '收件人'), 'idB');
  const r1 = must(zjz.room.create(home, a.slug, '房一'), 'r1');
  const r2 = must(zjz.room.create(home, a.slug, '房二'), 'r2');
  must(zjz.room.join(home, b.slug, r2.invite_code), 'join r2');
  // 收件人加入时游标＝当时最新，之后新发的才算未读
  const m1 = must(zjz.msg.send(home, a.slug, r1.room_id, '房一不该出现在收件人 inbox（非成员）'), 'm1');
  const m2 = must(zjz.msg.send(home, a.slug, r2.room_id, '给收件人的普通消息'), 'm2');
  const m3 = must(zjz.msg.send(home, a.slug, r2.room_id, '点名内容', { mentions: [b.slug] }), 'm3');
  return { home, a, b, r1, r2, m2, m3 };
}

// ---- I45 主断言 ----
test('I45-1 compose 返回 pending_rooms＝逐房未读数（游标对账），且不为成员推进游标', () => {
  assert.ok(inbox, 'src/inbox.js 未实现（红测）');
  const { home, b, r2 } = seedTwoRooms();
  const res = must(inbox.compose(home, { slug: b.slug }), 'compose');
  assert.equal(res.pending_rooms.length, 1, '只列成员所在的房');
  const room = res.pending_rooms[0];
  assert.equal(room.room_id, r2.room_id);
  assert.equal(room.unread_count, 2, '加入后新发的两条都算未读');
  assert.ok(typeof room.latest_ts === 'string' && room.latest_ts.length > 0);

  // 不消费游标：连读两次计数不变；成员自己 wait 取信才清零（read 不动游标，wait 才动）
  const again = must(inbox.compose(home, { slug: b.slug }), 'compose again');
  assert.equal(again.pending_rooms[0].unread_count, 2, 'compose 绝不推进游标（I27 纪律）');
  const waited = must(zjz.msg.wait(home, b.slug, { timeout_ms: 1000 }), 'member wait');
  assert.equal(waited.messages.length, 2, 'wait 应取到两条');
  const after = must(inbox.compose(home, { slug: b.slug }), 'compose after read');
  assert.equal(after.pending_rooms.length, 0, '成员自取后横幅应清零');
});

test('I45-2 mention_me 带最近 @我 摘要（房号＋消息号＋前 40 字）', () => {
  assert.ok(inbox, 'src/inbox.js 未实现（红测）');
  const { home, b, r2, m3 } = seedTwoRooms();
  const res = must(inbox.compose(home, { slug: b.slug }), 'compose');
  assert.equal(res.mention_me.length, 1);
  assert.equal(res.mention_me[0].msg_id, m3.id);
  assert.equal(res.mention_me[0].room_id, r2.room_id);
  assert.ok(res.mention_me[0].snippet.includes('点名内容'));
});

test('I45-3 duty 健康行：监听租约过期时点名『已停 X 分钟』，新鲜时 running', () => {
  assert.ok(inbox, 'src/inbox.js 未实现（红测）');
  const { home, b } = seedTwoRooms();
  const idle = must(inbox.compose(home, { slug: b.slug }), 'compose idle');
  assert.match(String(idle.duty), /(停|未|无|过期|no|lost)/i, '无监听时必须给失岗提示');

  const st = must(listen.start(home, { ttl_ms: 240000, heartbeat_ms: 30000 }), 'listen start');
  assert.equal(st.ok, true);
  const live = must(inbox.compose(home, { slug: b.slug }), 'compose live');
  assert.match(String(live.duty), /在岗|running|listening|fresh/i, '租约新鲜时应报在岗');
  must(listen.stop(home, { force: true }), 'listen stop');
});

test('I45-4 非成员房不进 inbox；无房成员返回空结构不崩溃', () => {
  assert.ok(inbox, 'src/inbox.js 未实现（红测）');
  const { home, r1 } = seedTwoRooms();
  const stranger = must(zjz.identity.create(home, '路人'), 'stranger');
  const res = must(inbox.compose(home, { slug: stranger.slug }), 'compose stranger');
  assert.deepEqual(res.pending_rooms, []);
  assert.deepEqual(res.mention_me, []);
  const roomIds = inbox.compose(home, { slug: stranger.slug }).pending_rooms.map((x) => x.room_id);
  assert.ok(!roomIds.includes(r1.room_id));
});
