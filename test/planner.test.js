// 哨兵 · 参谋长 planner v1（立项研究的地基）
// 目标能拆成结构化子任务，能落盘/读回，数据结构稳定供调度层接。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { planner } from '../src/planner.js';

test('参谋长：目标能拆成结构化子任务（含派活/验收/状态字段）', () => {
  const plan = planner.plan_v1('做一个登录页');
  assert.equal(plan.goal, '做一个登录页');
  assert.ok(plan.tasks.length >= 3, '至少拆成 3 条子任务');
  for (const t of plan.tasks) {
    assert.ok(t.id, '子任务有 id');
    assert.ok(t.title, '子任务有 title');
    assert.ok('assign' in t && 'acceptance' in t && 'status' in t, '有派活/验收/状态字段');
    assert.equal(t.status, 'pending', '初始待派');
    assert.ok(planner.ASSIGN_HINT[t.assign], 'assign 类型可解释');
  }
});

test('参谋长：任务清单能落盘并读回（调度层吃这个）', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'zjz-plan-'));
  const plan = planner.plan_v1('做一份报告');
  const saved = planner.savePlan(home, plan);
  assert.equal(saved.ok, true);
  assert.ok(saved.tasks >= 3);
  const loaded = planner.loadPlan(home, plan.plan_id);
  assert.equal(loaded.ok, true);
  assert.equal(loaded.plan.goal, '做一份报告');
  assert.equal(loaded.plan.tasks.length, plan.tasks.length);
});

test('参谋长：读不存在的 plan 如实报 NOT_FOUND，不崩', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'zjz-plan2-'));
  const r = planner.loadPlan(home, 'plan_missing');
  assert.equal(r.ok, false);
  assert.equal(r.code, 'NOT_FOUND');
});

test('参谋长：plan_id 路径穿越一律拒绝', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'zjz-plan3-'));
  const saved = planner.savePlan(home, { plan_id: '../../escape', tasks: [] });
  assert.equal(saved.ok, false);
  assert.equal(saved.code, 'BAD_INPUT');
  const loaded = planner.loadPlan(home, '../../package');
  assert.equal(loaded.ok, false);
  assert.equal(loaded.code, 'BAD_INPUT');
});

test('参谋长：可按时间倒序列出现有计划', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'zjz-plan-list-'));
  assert.deepEqual(planner.listPlans(home), { ok: true, plans: [] });

  const first = planner.plan_v1('先做的目标');
  first.created_at = '2026-11-11T01:00:00.000Z';
  const second = planner.plan_v1('后做的目标');
  second.created_at = '2026-11-11T02:00:00.000Z';
  planner.savePlan(home, first);
  planner.savePlan(home, second);

  const listed = planner.listPlans(home);
  assert.equal(listed.ok, true);
  assert.deepEqual(listed.plans.map((item) => item.goal), ['后做的目标', '先做的目标']);
  assert.ok(listed.plans.every((item) => item.tasks === 3));
});
