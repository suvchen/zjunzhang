import test from 'node:test';
import assert from 'node:assert/strict';
import { adapter } from '../src/adapter.js';

// E21：回帖必须署自己的名。任务里要给确切命令（带 --slug），否则 agent 用默认身份发，署成别人。
test('E21 任务文本必须带署名用的回帖命令（--slug/--room）', () => {
  const task = adapter.composeTask({
    messages: [{ room_id: 'room_x', id: 'm1', seq: 1, author: 'zjz-房主', text: '在吗', ts: '2026-11-10T10:00:00.000Z' }],
    head: '测试任务',
    slug: 'zjz-分身甲',
    room_id: 'room_x',
  });
  assert.ok(task.includes('--slug zjz-分身甲'), `必须带 --slug 署名，实际：${task}`);
  assert.ok(task.includes('--room room_x'), `必须带 --room 回对房，实际：${task}`);
  assert.ok(task.includes('send'), '必须给出回帖命令');
  assert.ok(task.includes('回复于'), '首行时间标记仍在（M55 不破）');
});

test('E21-B 旧调用（不传 slug/room）不得崩，只是回帖命令里少这两段', () => {
  const task = adapter.composeTask({ messages: [], head: 'x' });
  assert.ok(typeof task === 'string' && task.length > 0);
  assert.ok(task.includes('send'), '仍要给回帖命令');
});