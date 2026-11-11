// 哨兵 · 参谋长汇总层 v1
// 把 plan 的结果收回来整理成"做到哪/卡在哪/下一步"，对应真参谋长"掌握全局、盯进度、报情况"。
// 只汇总已落状态，不编造未完成的事。
import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizer } from '../src/summarizer.js';

function planWith(tasks) {
  return { plan_id: 'p1', goal: '做一份报告', tasks };
}

test('参谋长汇总：做到哪/卡在哪/下一步 三段齐全', () => {
  const plan = planWith([
    { id: 't1', title: '调研', status: 'done', result: {} },
    { id: 't2', title: '写报告', status: 'failed', result: { code: 'NO_AGENT', message: '无人可派' } },
    { id: 't3', title: '校对', status: 'timeout', result: {} },
    { id: 't4', title: '排版', status: 'pending', result: null },
    { id: 't5', title: '配图', status: 'dispatched', result: {} },
  ]);
  const s = summarizer.summarize(plan);
  assert.equal(s.progress.total, 5);
  assert.equal(s.progress.done, 1);
  assert.equal(s.progress.failed, 1);
  assert.equal(s.progress.timeout, 1);
  assert.deepEqual(s.achieved, ['调研'], '做到哪=已完成');
  assert.equal(s.stuck.length, 2, '卡在哪=失败+超时');
  assert.equal(s.stuck[0].why, '无人可派', '卡点带原因');
  assert.ok(s.next.some((x) => /排版/.test(x)), '下一步含待派的');
  assert.ok(s.inFlight.some((x) => /配图/.test(x)), '在做=执行中');
});

test('参谋长汇总：只汇总已落状态，不编造未完成的事', () => {
  const plan = planWith([
    { id: 't1', title: '任务A', status: 'pending', result: null },
    { id: 't2', title: '任务B', status: 'dispatched', result: { slug: 'x' } },
  ]);
  const s = summarizer.summarize(plan);
  assert.equal(s.achieved.length, 0, '没完成的不进"做到哪"');
  assert.equal(s.stuck.length, 0, '没卡的不进"卡在哪"');
  assert.equal(s.progress.pending, 1);
  assert.equal(s.progress.dispatched, 1);
});

test('参谋长汇总：文本汇报含关键三段', () => {
  const plan = planWith([
    { id: 't1', title: '调研', status: 'done', result: {} },
    { id: 't2', title: '写报告', status: 'failed', result: { message: '超时未回' } },
    { id: 't3', title: '排版', status: 'pending', result: null },
  ]);
  const txt = summarizer.summarizeText(plan);
  assert.match(txt, /参谋长汇报/);
  assert.match(txt, /做到哪/);
  assert.match(txt, /卡在哪/);
  assert.match(txt, /下一步/);
  assert.match(txt, /做一份报告/);
});
