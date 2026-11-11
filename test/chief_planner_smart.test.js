// 参谋长拆解升级（plan_smart / runGoalSmart）哨兵测试——先立断言再造业务码
// 核心不变量：①模型输出合法→逐字段精确映射；②模型吐垃圾/网络挂/越界→一律兜底 plan_v1 模板 3 任务；
// ③空 goal 或未配模型 URL→不发任何网络请求；④assign 非法归一 auto。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { planner } from '../src/planner.js';
import { scheduler } from '../src/scheduler.js';

const MODEL_URL = 'http://127.0.0.1:9/v1/chat/completions'; // 哑地址，测试只走注入 fetch

function fakeFetch(content) {
  return async () => ({
    ok: true,
    json: async () => ({ choices: [{ message: { content } }] }),
  });
}

// 手算 fixture：模型返回固定 2 任务，逐字段对程序输出
test('手算对照：模型返回 2 个固定任务 → 逐字段精确映射', async () => {
  const content = JSON.stringify({
    tasks: [
      { title: '写登录页', assign: 'code', acceptance: '能注册能登录' },
      { title: '写介绍文案', assign: 'writing', acceptance: '一屏讲清楚' },
    ],
  });
  const plan = await planner.plan_smart('做一个登录页', { modelUrl: MODEL_URL, fetch: fakeFetch(content) });
  assert.equal(plan.goal, '做一个登录页');
  assert.equal(plan.planned_by, 'llm');
  assert.equal(plan.tasks.length, 2);
  assert.equal(plan.tasks[0].title, '写登录页');
  assert.equal(plan.tasks[0].assign, 'code');
  assert.equal(plan.tasks[0].acceptance, '能注册能登录');
  assert.equal(plan.tasks[0].status, 'pending');
  assert.equal(plan.tasks[1].title, '写介绍文案');
  assert.equal(plan.tasks[1].assign, 'writing');
  assert.match(plan.tasks[0].id, /^task_[a-z0-9]+$/);
});

// 哨兵①：模型吐非 JSON → 兜底模板（3 任务不变量）
test('哨兵：模型输出不是 JSON → 兜底 plan_v1 模板 3 任务', async () => {
  const plan = await planner.plan_smart('做一个登录页', { modelUrl: MODEL_URL, fetch: fakeFetch('抱歉我做不到') });
  assert.equal(plan.tasks.length, 3);
  assert.equal(plan.planned_by, undefined);
  assert.equal(plan.goal, '做一个登录页');
});

// 哨兵②：fetch 抛错（网络挂）→ 不崩溃，兜底模板
test('哨兵：fetch 网络错误 → 不崩溃，兜底模板', async () => {
  const plan = await planner.plan_smart('做一个登录页', {
    modelUrl: MODEL_URL,
    fetch: async () => { throw new Error('Connection reset'); },
  });
  assert.equal(plan.tasks.length, 3);
});

// 哨兵③：空 goal / 未配 URL → 根本不发网络请求
test('哨兵：空 goal 或未配模型 URL → 零网络请求', async () => {
  let called = 0;
  const spy = async () => { called += 1; return { ok: true, json: async () => ({}) }; };
  const a = await planner.plan_smart('', { modelUrl: MODEL_URL, fetch: spy });
  const b = await planner.plan_smart('做登录页', { modelUrl: '', fetch: spy });
  assert.equal(called, 0);
  assert.equal(a.tasks.length, 3);
  assert.equal(b.tasks.length, 3);
});

// 哨兵④：assign 归一化——非法值归 auto，合法值保留
test('哨兵：assign 非法归一为 auto，合法保留', async () => {
  const content = JSON.stringify({
    tasks: [
      { title: '部署', assign: 'DevOps', acceptance: '上线' },
      { title: '写代码', assign: 'code', acceptance: '过测试' },
    ],
  });
  const plan = await planner.plan_smart('上线', { modelUrl: MODEL_URL, fetch: fakeFetch(content) });
  assert.equal(plan.tasks[0].assign, 'auto');
  assert.equal(plan.tasks[1].assign, 'code');
});

// 哨兵⑤：任务数越界（0 或 9）或缺 title → 兜底模板
test('哨兵：任务数越界或缺 title → 兜底模板', async () => {
  const zero = JSON.stringify({ tasks: [] });
  const nine = JSON.stringify({ tasks: Array.from({ length: 9 }, (_, i) => ({ title: `任务${i}` })) });
  const noTitle = JSON.stringify({ tasks: [{ acceptance: '没标题' }] });
  for (const content of [zero, nine, noTitle]) {
    const plan = await planner.plan_smart('目标', { modelUrl: MODEL_URL, fetch: fakeFetch(content) });
    assert.equal(plan.tasks.length, 3, content);
  }
});

// 容忍 ```json 包裹
test('模型输出用 ```json 包裹也能解析', async () => {
  const content = '```json\n' + JSON.stringify({ tasks: [{ title: '调研', assign: 'qa', acceptance: '出结论' }] }) + '\n```';
  const plan = await planner.plan_smart('调研市场', { modelUrl: MODEL_URL, fetch: fakeFetch(content) });
  assert.equal(plan.tasks.length, 1);
  assert.equal(plan.tasks[0].title, '调研');
});

// runGoalSmart 端到端：无成员 → 全 NO_AGENT，plan 落盘可取回
test('runGoalSmart：LLM 拆解 + 派活 + 落盘（无成员全 NO_AGENT）', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'zjz-chief-smart-'));
  const content = JSON.stringify({
    tasks: [
      { title: '写代码', assign: 'code', acceptance: '过测试' },
      { title: '写文档', assign: 'writing', acceptance: '能看懂' },
    ],
  });
  const ran = await scheduler.runGoalSmart(home, '做一个登录页', { modelUrl: MODEL_URL, fetch: fakeFetch(content) });
  assert.equal(ran.ok, true);
  assert.equal(ran.dispatched.length, 2);
  assert.ok(ran.dispatched.every((row) => row.reason === 'NO_AGENT'));
  const saved = planner.loadPlan(home, ran.plan_id);
  assert.equal(saved.ok, true);
  assert.equal(saved.plan.tasks.length, 2);
});
