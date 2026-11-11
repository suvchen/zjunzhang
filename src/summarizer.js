// 中军帐 · 参谋长（会员版）——汇总层（summarizer）v1
// 把一个 plan 的各子任务结果，回收整理成结构化汇报："做到哪/卡在哪/下一步"。
// 对应真参谋长职责之三"掌握全局、盯进度、报情况"。
// 只汇总已落的状态（dispatched/done/failed/timeout），不编造未完成的事。

// —— 单条状态转成人话 ——
const STATUS_TEXT = {
  pending: '待派',
  dispatched: '已派（执行中）',
  done: '已完成',
  failed: '失败',
  timeout: '超时',
};

// —— 汇总一个 plan ——
export function summarize(plan) {
  const tasks = plan.tasks || [];
  const done = tasks.filter((t) => t.status === 'done');
  const failed = tasks.filter((t) => t.status === 'failed');
  const timeout = tasks.filter((t) => t.status === 'timeout');
  const dispatched = tasks.filter((t) => t.status === 'dispatched');
  const pending = tasks.filter((t) => t.status === 'pending');

  // 做到哪：已完成 + 在做
  const achieved = done.map((t) => t.title);
  const inFlight = dispatched.map((t) => t.title);

  // 卡在哪：失败 + 超时（带原因）
  const stuck = [...failed, ...timeout].map((t) => ({
    title: t.title,
    why: (t.result && (t.result.message || t.result.code)) || STATUS_TEXT[t.status],
  }));

  // 下一步：还没派的 + 卡住要重试/补人的
  const next = [
    ...pending.map((t) => `派发并执行：${t.title}`),
    ...stuck.map((s) => `处理卡点：${s.title}（${s.why}）`),
    ...(dispatched.length ? [`等 ${dispatched.length} 条执行中任务回执`] : []),
  ];

  return {
    ok: true,
    plan_id: plan.plan_id,
    goal: plan.goal,
    progress: {
      total: tasks.length,
      done: done.length,
      dispatched: dispatched.length,
      failed: failed.length,
      timeout: timeout.length,
      pending: pending.length,
    },
    achieved,   // 做到哪
    inFlight,   // 在做
    stuck,      // 卡在哪
    next,       // 下一步
  };
}

// —— 汇总成一段可读文本（给用户/值班板）——
export function summarizeText(plan) {
  const s = summarize(plan);
  const L = [];
  L.push(`【参谋长汇报】目标：${s.goal}`);
  L.push(`进度：${s.progress.done} 完成 / ${s.progress.dispatched} 执行中 / ${s.progress.failed + s.progress.timeout} 卡住 / ${s.progress.pending} 待派（共 ${s.progress.total}）`);
  if (s.achieved.length) L.push(`做到哪：${s.achieved.map((x) => '· ' + x).join('；')}`);
  if (s.inFlight.length) L.push(`在做：${s.inFlight.map((x) => '· ' + x).join('；')}`);
  if (s.stuck.length) L.push(`卡在哪：${s.stuck.map((x) => `· ${x.title}（${x.why}）`).join('；')}`);
  if (s.next.length) L.push(`下一步：${s.next.map((x) => '· ' + x).join('；')}`);
  return L.join('\n');
}

export const summarizer = { summarize, summarizeText, STATUS_TEXT };
export default summarizer;
