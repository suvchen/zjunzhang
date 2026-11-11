import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { delivery } from '../src/delivery.js';

function tmpHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'zjz-deliv-'));
}
function must(res, where) {
  assert.equal(res && res.ok, true, `${where} 应成功，实际 ${JSON.stringify(res)}`);
  return res;
}

test('E22-C markAnsweredByAuthor：回帖时 record 还在 pushed，也必须补 read_at 并转 answered', () => {
  const home = tmpHome();
  must(delivery.post(home, { room_id: 'r1', msg_id: 'm1', sender: '提问人', recipient: '分身甲' }), 'post');
  must(delivery.markPushedByMessage(home, { room_id: 'r1', msg_id: 'm1', recipient: '分身甲', sender: '提问人' }), 'pushed');

  const r = must(delivery.markAnsweredByAuthor(home, { author: '分身甲' }), 'answered');
  assert.equal(r.updated, 1);
  const row = r.records[0];
  assert.equal(row.status, 'answered');
  assert.ok(row.read_at, `回帖即已读，read_at 必须补，实际 ${JSON.stringify(row)}`);
  assert.ok(row.answered_at, 'answered_at 必须写');

  // 幂等：再答一次不重复转
  const r2 = must(delivery.markAnsweredByAuthor(home, { author: '分身甲' }), 'answered 2');
  assert.equal(r2.updated, 0);
});