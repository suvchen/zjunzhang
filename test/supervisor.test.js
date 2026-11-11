// 哨兵 · 监督官（团队第六角色）——独立验收、干和查分离
// 判"能不能用/要改/不能用"，给改进建议，替主人把关。
import test from 'node:test';
import assert from 'node:assert/strict';
import { supervisor } from '../src/supervisor.js';

test('监督官：有结果+没失败=通过（能用），但带细审建议', () => {
  const r = supervisor.review({ title: '做图', acceptance: '图清晰能用', result: { file: 'a.png' } });
  assert.equal(r.verdict, 'pass');
  assert.ok(r.suggestions.some((s) => /细审|验收/.test(s)), '提示要细审');
});

test('监督官：结果标记失败/卡住=要改（needs_work）', () => {
  const r = supervisor.review({ title: '写文案', acceptance: '', result: { code: 'NO_AGENT', message: '无人可派' } });
  assert.equal(r.verdict, 'needs_work');
  assert.ok(r.issues.length >= 1, '带卡点');
  assert.ok(r.suggestions.some((s) => /重试|换智能体/.test(s)), '给改进建议');
});

test('监督官：没结果=不能用（fail）', () => {
  const r = supervisor.review({ title: '做功能', acceptance: '功能跑通', result: null });
  assert.equal(r.verdict, 'fail');
  assert.ok(r.issues.some((x) => /没有产出/.test(x)));
});

test('监督官：执行中任务即使有派发结果也不能判通过', () => {
  const r = supervisor.review({
    title: '写报告',
    acceptance: '有报告',
    status: 'dispatched',
    result: { slug: '甲', spawn: 'spawned' },
  });
  assert.equal(r.verdict, 'needs_work');
  assert.ok(r.issues.some((x) => /执行中/.test(x)));
});

test('监督官：失败/超时任务不得因 result 非空而判通过', () => {
  for (const status of ['failed', 'timeout']) {
    const r = supervisor.review({
      title: '做功能',
      acceptance: '跑通',
      status,
      result: { note: '有中间产物' },
    });
    assert.equal(r.verdict, 'needs_work', status);
    assert.ok(r.issues.length >= 1);
  }
});

test('监督官：有 needs_work 时整体不能用，不能只看 fail=0', () => {
  const plan = {
    plan_id: 'p_needs_work',
    goal: '做一份报告',
    tasks: [
      { id: 't1', title: '调研', acceptance: '有要点', status: 'done', result: { data: 'x' } },
      { id: 't2', title: '写报告', acceptance: '有报告', status: 'dispatched', result: { slug: '甲' } },
    ],
  };
  const r = supervisor.reviewPlan(plan);
  assert.equal(r.summary.needs_work, 1);
  assert.equal(r.summary.fail, 0);
  assert.equal(r.usable, false);
  assert.match(supervisor.reviewText(plan), /暂不能用/);
});

test('监督官：审整个 plan，出"能用吗+要改哪"，只报关键', () => {
  const plan = {
    plan_id: 'p1', goal: '做一份报告',
    tasks: [
      { id: 't1', title: '调研', acceptance: '有要点', result: { data: 'x' } },
      { id: 't2', title: '写报告', acceptance: '有报告', result: { code: 'NO_AGENT', message: '无人可派' } },
      { id: 't3', title: '排版', acceptance: '排好', result: null },
    ],
  };
  const r = supervisor.reviewPlan(plan);
  assert.equal(r.summary.total, 3);
  assert.equal(r.summary.pass, 1);
  assert.equal(r.usable, false, '有不通过的就不算整体能用');
  assert.equal(r.fixNeeded.length, 2, '要改的=needs_work+fail');
  const txt = supervisor.reviewText(plan);
  assert.match(txt, /监督官验收/);
  assert.match(txt, /暂不能用/);
  assert.match(txt, /要改的/);
});

test('监督官：全部通过时如实报"整体能用"，不硬挑刺', () => {
  const plan = {
    plan_id: 'p2', goal: '做个图',
    tasks: [{ id: 't1', title: '画图', acceptance: '能用', result: { file: 'x.png' } }],
  };
  const r = supervisor.reviewPlan(plan);
  assert.equal(r.usable, true);
  assert.match(supervisor.reviewText(plan), /整体能用/);
});

test('交叉监督：两个智能体互查，验收人≠干活人，不自己查自己', () => {
  const tasks = [
    { id: 't1', title: '调研', assignee: '甲' },
    { id: 't2', title: '写报告', assignee: '乙' },
  ];
  const r = supervisor.crossReviewPlan({ plan_id: 'p', goal: 'x', tasks }, ['甲', '乙']);
  assert.equal(r.mutual, true, '两个智能体可互查');
  assert.equal(r.check_ok, true, '每条都有非本人验收人');
  for (const t of r.tasks) {
    assert.ok(t.reviewer, '有验收人');
    assert.notEqual(t.reviewer, t.assignee, '验收人≠干活人（不自己查自己）');
    assert.equal(t.cross_checked, true);
  }
});

test('交叉监督：三智能体轮转分摊验收，谁的活都由别人查', () => {
  const tasks = [
    { id: 't1', title: 'a', assignee: '甲' },
    { id: 't2', title: 'b', assignee: '乙' },
    { id: 't3', title: 'c', assignee: '丙' },
  ];
  const r = supervisor.crossReviewPlan({ plan_id: 'p', goal: 'x', tasks }, ['甲', '乙', '丙']);
  assert.equal(r.check_ok, true);
  assert.ok(r.tasks.every((t) => t.reviewer !== t.assignee), '都非自查');
});

test('交叉监督：只有一个智能体时如实标"无交叉"，不假装有人查', () => {
  const tasks = [{ id: 't1', title: 'a', assignee: '甲' }];
  const r = supervisor.crossReviewPlan({ plan_id: 'p', goal: 'x', tasks }, ['甲']);
  assert.equal(r.mutual, false, '单人不能互查');
  assert.equal(r.no_cross_count, 1, '如实标无交叉');
  assert.equal(r.tasks[0].cross_checked, false);
});
