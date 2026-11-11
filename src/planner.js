// 中军帐 · 参谋长（会员版）——任务清单数据结构 + 拆解层（planner）v1
// 立项研究：把一个"目标"拆成结构化子任务，供调度层派给智能体。
// 设计原则：① 数据结构先定死（Codex 调度层好接）② planner v1 先模板化（不强依赖大模型，保证能跑通），后续可换大模型拆解。
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

// —— 任务清单数据结构（参谋长的中间产物，调度层/汇总层都吃这个）——
// 一个 Plan = 一个目标拆成的若干子任务。
// 子任务字段：
//   id          唯一标识
//   title       做什么（一句话）
//   assign      派给谁（智能体类型提示：code/writing/qa/local，或具体 slug）
//   acceptance  验收标准（做到什么算完成）
//   status      pending | dispatched | done | failed | timeout
//   result      执行结果（汇总层填）

export function makePlan(goal) {
  return {
    plan_id: 'plan_' + randomUUID().replace(/-/g, ''),
    goal: String(goal || '').trim(),
    created_at: new Date().toISOString(),
    tasks: [],
  };
}

export function makeTask({ title, assign = 'auto', acceptance = '' }) {
  return {
    id: 'task_' + randomUUID().replace(/-/g, '').slice(0, 12),
    title: String(title || '').trim(),
    assign, // code | writing | qa | local | auto
    acceptance: String(acceptance || '').trim(),
    status: 'pending',
    result: null,
  };
}

// —— 智能体类型 → 派给谁（依据 member.providers 的简单映射，调度层可扩展）——
const ASSIGN_HINT = {
  code: '代码开发（Codex/本地）',
  writing: '文案写作（Claude）',
  qa: '答疑/校对（本地）',
  local: '本地快速处理',
  auto: '参谋长自动判定',
};

// —— planner v1：模板化拆解（不依赖大模型，保证能跑）——
// 策略：把目标按"通用三段式"拆——调研/规划 → 执行 → 校验汇总。
// 这是保守可靠的兜底；后续可升级为大模型按目标内容拆。
export function plan_v1(goal) {
  const plan = makePlan(goal);
  const g = plan.goal;
  plan.tasks = [
    makeTask({
      title: `拆解与调研：明确「${g}」的范围、要点、约束`,
      assign: 'qa',
      acceptance: '产出要点清单与边界（做什么/不做什么）',
    }),
    makeTask({
      title: `主执行：完成「${g}」的核心工作`,
      assign: 'auto',
      acceptance: '核心交付物完成，符合要点清单',
    }),
    makeTask({
      title: `校验与汇总：检查「${g}」结果、整理成报告`,
      assign: 'writing',
      acceptance: '产出"做到哪/卡在哪/下一步"三段汇总',
    }),
  ];
  return plan;
}

// —— 任务清单的落盘/读取（data/plans/<plan_id>.json）——
function plansDir(home) {
  return path.join(path.resolve(home || '.'), 'data', 'plans');
}
function safePlanId(value) {
  const id = String(value || '').trim();
  return /^plan_[a-z0-9_-]+$/.test(id) ? id : null;
}
export function savePlan(home, plan) {
  if (!plan || !Array.isArray(plan.tasks)) {
    return { ok: false, code: 'BAD_INPUT', message: 'plan 必须包含 tasks 数组' };
  }
  const planId = safePlanId(plan.plan_id);
  if (!planId) {
    return { ok: false, code: 'BAD_INPUT', message: 'plan_id 只能包含 plan_ 后的字母、数字、下划线或连字符' };
  }
  fs.mkdirSync(plansDir(home), { recursive: true });
  const file = path.join(plansDir(home), `${planId}.json`);
  fs.writeFileSync(file, JSON.stringify(plan, null, 2), 'utf8');
  return { ok: true, path: file, plan_id: planId, tasks: plan.tasks.length };
}
export function loadPlan(home, planId) {
  const id = safePlanId(planId);
  if (!id) {
    return { ok: false, code: 'BAD_INPUT', message: 'plan_id 只能包含 plan_ 后的字母、数字、下划线或连字符' };
  }
  const file = path.join(plansDir(home), `${id}.json`);
  try { return { ok: true, plan: JSON.parse(fs.readFileSync(file, 'utf8')) }; }
  catch (e) { return { ok: false, code: 'NOT_FOUND', message: String(e.message) }; }
}

export function listPlans(home) {
  const dir = plansDir(home);
  if (!fs.existsSync(dir)) return { ok: true, plans: [] };
  const plans = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const match = entry.name.match(/^(plan_[a-z0-9_-]+)\.json$/);
    if (!match) continue;
    const loaded = loadPlan(home, match[1]);
    if (!loaded.ok) continue;
    plans.push({
      plan_id: loaded.plan.plan_id,
      goal: loaded.plan.goal,
      created_at: loaded.plan.created_at,
      tasks: loaded.plan.tasks.length,
    });
  }
  plans.sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')));
  return { ok: true, plans };
}

export const planner = { makePlan, makeTask, plan_v1, savePlan, loadPlan, listPlans, ASSIGN_HINT };
export default planner;
