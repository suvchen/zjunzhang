// T-008 I48：投递 SLA 台账与超时工单。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as zjz from '../src/core.js';

let delivery = null;
try {
  ({ delivery } = await import('../src/delivery.js'));
} catch {
  delivery = null;
}

function tmpHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'zjz-t008-'));
}

function must(result, where) {
  assert.equal(result && result.ok, true, `${where} 应成功，实际 ${JSON.stringify(result)}`);
  return result;
}

function iso(ms) {
  return new Date(ms).toISOString();
}

test('I48 read/answered 超时产生 delivery_late 与值班工单，board 点名到人到条', () => {
  assert.ok(delivery, 'src/delivery.js 未实现（红测）');
  const home = tmpHome();
  const sender = must(zjz.identity.create(home, '投递发送方'), 'sender');
  const recipient = must(zjz.identity.create(home, '投递接收方'), 'recipient');
  const room = must(zjz.room.create(home, sender.slug, '投递房'), 'room');
  const message = must(zjz.msg.send(home, sender.slug, room.room_id, '需要被回复的投递消息'), 'send');
  const postedAt = Date.parse('2026-11-09T00:00:00.000Z');
  const record = must(delivery.post(home, {
    room_id: room.room_id,
    msg_id: message.id,
    sender: sender.slug,
    recipient: recipient.slug,
    at: iso(postedAt),
  }), 'post');
  must(delivery.markPushed(home, { delivery_id: record.delivery_id, at: iso(postedAt + 10) }), 'pushed');

  const readLate = must(delivery.tick(home, {
    now: iso(postedAt + 11 * 60 * 1000),
    read_timeout_ms: 10 * 60 * 1000,
    answered_timeout_ms: 10 * 60 * 1000,
  }), 'read timeout');
  assert.equal(readLate.late.length, 1);
  assert.equal(readLate.late[0].phase, 'read');
  const boardAfterRead = must(delivery.board(home, { now: iso(postedAt + 11 * 60 * 1000) }), 'board read late');
  assert.equal(boardAfterRead.rows[0].recipient, recipient.slug);
  assert.equal(boardAfterRead.rows[0].read_late, true);

  must(delivery.markRead(home, { delivery_id: record.delivery_id, at: iso(postedAt + 12 * 60 * 1000) }), 'read');
  const answeredLate = must(delivery.tick(home, {
    now: iso(postedAt + 23 * 60 * 1000),
    read_timeout_ms: 10 * 60 * 1000,
    answered_timeout_ms: 10 * 60 * 1000,
  }), 'answered timeout');
  assert.equal(answeredLate.late.length, 1);
  assert.equal(answeredLate.late[0].phase, 'answered');
  assert.ok(answeredLate.orders.length === 1 && answeredLate.orders[0].order_id, '超时必须自动开工单');
  const board = must(delivery.board(home, { now: iso(postedAt + 23 * 60 * 1000) }), 'board answered late');
  assert.equal(board.rows[0].answered_late, true);
  assert.equal(board.rows[0].order_id, answeredLate.orders[0].order_id);
  const orders = must(zjz.order.list(home, { project: 'delivery' }), 'orders');
  assert.equal(orders.orders.length, 1);
});
