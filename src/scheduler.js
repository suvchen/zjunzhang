// 中军帐 · 参谋长（会员版）——调度层（scheduler）v1
// 把 planner 拆出的子任务，派给合适的智能体执行，回收状态。
// 复用现有件：adapter.run（派活执行）+ member.providers（选人）。
// 原则：① 选人不猜——按任务 assign 类型匹配在岗智能体，选不到如实报，不乱派。
//       ② 逐条派发、逐条落状态（dispatched/failed），供汇总层与用户查。
import { adapter } from './adapter.js';
import { member } from './member.js';
import { planner } from './planner.js';

// —— 选人：按任务 assign 类型，在在岗智能体里挑一个 ——
// assign：code/writing/qa/local/auto。v1 简单映射：优先 provider=remote 的通用智能体，其次任意 spawn 智能体。
function pickAgent(providersRows, assign) {
  // notify（写 inbox 通知）也是合法派活目标，不排除；spawn/api/notify 都可派
  const usable = providersRows.filter((r) => ['spawn', 'api', 'notify'].includes(r.adapter_kind));
  if (usable.length === 0) return null;
  // 简单策略：code/writing 优先云端(remote，能力通用)，qa/local 优先本地(local，快)。auto 取第一个。
  const preferLocal = (assign === 'qa' || assign === 'local');
  const local = usable.find((r) => r.provider === 'local');
  const remote = usable.find((r) => r.provider === 'remote');
  if (preferLocal && local) return local;
  return remote || local || usable[0];
}

// —— 调度一个 plan 的所有 pending 任务 ——
export function dispatchPlan(home, plan) {
  const initial = planner.savePlan(home, plan);
  if (!initial.ok) return initial;
  const pv = member.providers(home);
  const rows = (pv.ok && pv.members) || [];
  const dispatched = [];
  for (const task of plan.tasks) {
    if (task.status !== 'pending') continue;
    const agent = pickAgent(rows, task.assign);
    if (!agent) {
      task.status = 'failed';
      task.result = { code: 'NO_AGENT', message: '没有在岗智能体可派（先请智能体进帐）' };
      dispatched.push({ id: task.id, status: 'failed', reason: 'NO_AGENT' });
      continue;
    }
    // 把子任务喂给智能体（assign 到具体 slug，任务体含目标背景）
    const taskText = `【参谋长派活】目标：${plan.goal}\n子任务：${task.title}\n验收：${task.acceptance || '完成即可'}\n完成后回帖说明结果。`;
    const res = adapter.run(home, { slug: agent.slug, task: taskText });
    if (res && res.ok) {
      task.status = 'dispatched';
      task.result = { slug: agent.slug, spawn: res.status, at: new Date().toISOString() };
      dispatched.push({ id: task.id, status: 'dispatched', slug: agent.slug, spawn: res.status });
    } else {
      task.status = 'failed';
      task.result = { slug: agent.slug, code: res && res.code, message: res && res.message };
      dispatched.push({ id: task.id, status: 'failed', slug: agent.slug, code: res && res.code });
    }
  }
  const saved = planner.savePlan(home, plan);
  return { ok: saved.ok, plan_id: plan.plan_id, dispatched, plan, saved };
}

// —— 一键：目标 → 拆解 → 派发（参谋长 v1 主入口）——
export function runGoal(home, goal) {
  const plan = planner.plan_v1(goal);
  const d = dispatchPlan(home, plan);
  if (!d.ok) return d;
  return { ok: true, plan_id: plan.plan_id, plan, dispatched: d.dispatched };
}

export const scheduler = { dispatchPlan, runGoal, pickAgent };
export default scheduler;
