// M55 哨兵：房讯进任务文本必须带可读时间戳（主人 11-09 反馈「房间里的信息没有时间」）。
// 断言：①每条消息段都带 ISO 原值 ②带本地可读 YYYY-MM-DD HH:MM:SS ③ts 缺失不崩溃、标「时间未知」
// ④旧解析器对位不破：`^--- room #seq ` 前缀仍成立（trials fake_responder 依赖它）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { adapter } from '../src/adapter.js';

const task = adapter.composeTask({
  head: '中军帐检测到你有未读房讯，现由系统自动唤醒。',
  messages: [
    { room_id: 'room_a', seq: 7, author: 'zjz-甲', ts: '2026-11-09T12:45:03.000Z', text: '第一句' },
    { room_id: 'room_b', seq: 9, author: 'zjz-乙', text: '没有 ts' },
  ],
});

test('M55 任务文本带时间戳', () => {
  assert.match(task, /2026-11-09T12:45:03\.000Z/, 'ISO 原值必须在场');
  assert.match(task, /\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}（UTC[+-]\d{2}:\d{2}/, '本地可读时间＋时区偏移');
  assert.match(task, /时间未知/, '缺 ts 也要显式标注，不能空白');
  assert.match(task, /^--- room_a #7 zjz-甲 \| /m, '旧对位前缀不破');
  assert.match(task, /^--- room_b #9 zjz-乙 \| 时间未知 ---$/m, '缺 ts 行形状固定');
});
