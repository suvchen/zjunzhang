// 哨兵 · 参谋长调度层 v1
// 目标能一路拆解→选人→派发→落状态（拆→派这条闭环）。
// 没有在岗智能体时如实报 NO_AGENT，不乱派、不崩。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { member } from '../src/member.js';
import { scheduler } from '../src/scheduler.js';
import { planner } from '../src/planner.js';

function tmpHome() { return fs.mkdtempSync(path.join(os.tmpdir(), 'zjz-sched-')); }

test('参谋长调度：有在岗智能体时，目标→拆解→派发（状态落 dispatched）', () => {
  const home = tmpHome();
  // 造一个 notify 智能体（不真起进程，adapter.run 会走 notified，安全可测）
  member.set(home, { slug: '参谋甲', adapter_kind: 'notify', wake_policy: 'all' });
  const r = scheduler.runGoal(home, '做一个登录页');
  assert.equal(r.ok, true);
  assert.ok(r.plan_id);
  assert.ok(r.plan.tasks.length >= 3);
  assert.ok(r.dispatched.length >= 3, '每条子任务都处理了');
  // 至少第一条派出去了（有智能体在）
  const dispatched = r.plan.tasks.filter((t) => t.status === 'dispatched');
  assert.ok(dispatched.length >= 1, '至少一条派发成功');
  assert.ok(dispatched[0].result && dispatched[0].result.slug === '参谋甲', '派给了在岗智能体');
});

test('参谋长调度：没有智能体时如实报 NO_AGENT，不崩、不乱派', () => {
  const home = tmpHome(); // 空 home，无智能体
  const r = scheduler.runGoal(home, '做一份报告');
  assert.equal(r.ok, true);
  const failed = r.plan.tasks.filter((t) => t.status === 'failed');
  assert.equal(failed.length, r.plan.tasks.length, '全部标失败（无人可派）');
  assert.equal(failed[0].result.code, 'NO_AGENT');
  assert.match(failed[0].result.message, /没有在岗智能体/);
});

test('参谋长调度：选人按 assign 类型（qa/local 偏本地，其余偏云端）', () => {
  const home = tmpHome();
  member.set(home, { slug: '本地快', adapter_kind: 'notify', provider: 'local' });
  member.set(home, { slug: '云端强', adapter_kind: 'notify', provider: 'remote' });
  const rows = member.providers(home).members;
  assert.equal(scheduler.pickAgent(rows, 'qa').slug, '本地快', 'qa 偏本地');
  assert.equal(scheduler.pickAgent(rows, 'writing').slug, '云端强', 'writing 偏云端');
});

test('参谋长调度：派发状态和结果必须回写 plan 落盘', () => {
  const home = tmpHome();
  member.set(home, { slug: '参谋甲', adapter_kind: 'notify', wake_policy: 'all' });
  const r = scheduler.runGoal(home, '做一个登录页');
  assert.equal(r.ok, true);
  const loaded = planner.loadPlan(home, r.plan_id);
  assert.equal(loaded.ok, true);
  assert.ok(loaded.plan.tasks.every((task) => task.status === 'dispatched'));
  assert.ok(loaded.plan.tasks.every((task) => task.result && task.result.slug === '参谋甲'));
});
