// 中军帐 · 参谋长（会员版）——监督官（supervisor）v1
// 职责（团队第六角色）：审成果、判能不能用、提改进、定验收。替主人把关，让主人不检查。
// 架构原则：干和查分离——干活的智能体不验收自己，监督官独立判。
// 对应真参谋部的监察官/验收参谋。复用 qc 质检模块（src/qc.js）的裁决口径。
// 边界：判不过退回给干活智能体改，不打扰主人；只在反复不过/重大质量问题才请示。

// 裁决口径（对齐 qc）：pass=能用 / needs_work=要改 / fail=不能用
const VERDICTS = ['pass', 'needs_work', 'fail'];

// —— 审一条成果（对照它的验收标准）——
// 输入：task（含 title/acceptance/result），产出：裁决 + 改进建议。
// v1 规则化审查（不依赖大模型，保证能跑）：看结果在不在、验收达没达。
// 后续可升级为大模型审查（懂质量、给更准的改进建议）。
export function review(task) {
  const issues = [];
  const suggestions = [];
  const acceptance = String(task.acceptance || '').trim();
  const result = task.result;

  if (task.status === 'dispatched') {
    issues.push('任务仍在执行中，尚无最终交付');
    suggestions.push('等待执行回执后再验收');
    return verdict('needs_work', issues, suggestions);
  }
  if (task.status === 'failed' || task.status === 'timeout') {
    issues.push('任务状态为' + (task.status === 'timeout' ? '超时' : '失败'));
    suggestions.push('查失败原因、换智能体或补资源重试');
    return verdict('needs_work', issues, suggestions);
  }

  // 1) 有没有结果
  if (!result) {
    issues.push('没有产出结果');
    suggestions.push('让干活智能体补交结果');
    return verdict('fail', issues, suggestions);
  }
  // 2) 结果是否标记失败/卡住
  if (result.code || result.message && /失败|超时|无人|NO_AGENT|error/i.test(String(result.message))) {
    issues.push('结果标记为失败/卡住：' + (result.message || result.code));
    suggestions.push('查失败原因、换智能体或补资源重试');
    return verdict('needs_work', issues, suggestions);
  }
  // 3) 对照验收标准（有 acceptance 就要看到对应交付物迹象）
  if (acceptance) {
    const resultText = typeof result === 'string' ? result : JSON.stringify(result);
    // v1 保守：结果非空即认为"有交付"，但提示要人工/大模型细审
    if (!resultText || resultText === '{}' || resultText === 'null') {
      issues.push('结果为空，验收标准「' + acceptance + '」未见达成');
      suggestions.push('按验收标准补足交付物');
      return verdict('needs_work', issues, suggestions);
    }
    // 有结果但未逐条验（v1 不会细审）→ 提示需细审
    suggestions.push('对照验收标准「' + acceptance + '」人工/大模型细审');
  }

  // 4) 默认：有结果、没失败 → 通过（但带细审建议）
  return verdict('pass', issues, suggestions);
}

function verdict(v, issues, suggestions) {
  return { verdict: v, issues, suggestions, reviewed_at: new Date().toISOString() };
}

// —— 审一个 plan 的所有子任务，出监督报告 ——
export function reviewPlan(plan) {
  const rows = (plan.tasks || []).map((t) => ({ id: t.id, title: t.title, ...review(t) }));
  const passed = rows.filter((r) => r.verdict === 'pass');
  const needsWork = rows.filter((r) => r.verdict === 'needs_work');
  const failed = rows.filter((r) => r.verdict === 'fail');
  return {
    ok: true,
    plan_id: plan.plan_id,
    goal: plan.goal,
    summary: { total: rows.length, pass: passed.length, needs_work: needsWork.length, fail: failed.length },
    rows,
    // 主人只看这段：能用吗 + 要改哪
    usable: failed.length === 0 && needsWork.length === 0,
    fixNeeded: [...needsWork, ...failed].map((r) => ({ title: r.title, issues: r.issues, suggestions: r.suggestions })),
  };
}

// —— 给主人的一句话验收（替主人把关，打扰最小）——
export function reviewText(plan) {
  const r = reviewPlan(plan);
  const L = [];
  L.push(`【监督官验收】${r.goal}`);
  L.push(`结论：${r.usable ? '整体能用' : '暂不能用'}（${r.summary.pass} 通过 / ${r.summary.needs_work} 要改 / ${r.summary.fail} 不通过，共 ${r.summary.total}）`);
  if (r.fixNeeded.length) {
    L.push('要改的：');
    for (const f of r.fixNeeded) L.push(`· ${f.title}——${f.issues.join('；')}（${f.suggestions.join('；')}）`);
  }
  return L.join('\n');
}

// —— 交叉检查分配（主人补充：哪怕只有两个智能体也要互相监督，不许自己查自己）——
// 给每个任务分配一个"验收人"，验收人 ≠ 干活人。两个智能体就 A 查 B、B 查 A。
// 干和查分离的最小落地：team 内互相兜底，不靠单一监督官。
export function crossAssign(tasks, agents) {
  const pool = (agents || []).map((s) => String(s)).filter(Boolean);
  if (pool.length === 0) return (tasks || []).map((t) => ({ ...t, reviewer: null }));
  let i = 0;
  return (tasks || []).map((t) => {
    const doer = t.assignee || t.slug || null;
    // 选一个不是干活人的当验收人；轮转分摊
    let reviewer = null;
    for (let k = 0; k < pool.length; k++) {
      const cand = pool[(i + k) % pool.length];
      if (cand !== doer) { reviewer = cand; i = (i + k + 1) % pool.length; break; }
    }
    // 只有一个智能体时退化为"无交叉"（如实标注，不假装有人查）
    return { ...t, reviewer: reviewer || null, cross_checked: Boolean(reviewer) };
  });
}

// —— 整个 plan 交叉分配：谁干的活由别人验收 ——
export function crossReviewPlan(plan, agents) {
  const tasks = crossAssign(plan.tasks || [], agents);
  const noCross = tasks.filter((t) => !t.cross_checked).length;
  return {
    ok: true,
    plan_id: plan.plan_id,
    goal: plan.goal,
    tasks,
    agents,
    mutual: agents && agents.length >= 2, // 至少两个才能互查
    no_cross_count: noCross,
    // 两个及以上智能体时，必须每条都有非本人验收人
    check_ok: (agents && agents.length >= 2) ? tasks.every((t) => t.cross_checked) : true,
  };
}

export const supervisor = { review, reviewPlan, reviewText, crossAssign, crossReviewPlan, VERDICTS };
export default supervisor;
