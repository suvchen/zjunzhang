// I47 演示验收探针（总管）：发帖 → 不盯房成员被监督器自动拉起并回帖。
// 运行：node i47_wake_check.mjs
// 当前预期＝如实 FAIL（wake/serve 未实现）。Codex 交付 `zjz wake <slug>`（或 `zjz spawn <slug>`）后应翻 PASS。
// 分层归因：先看「任务文件已落盘？」＝我层（member/adapter 就绪）；再看「回帖出现？」＝他层（wake 决策＋触发）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { member } from '../../src/member.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(HERE, '..', '..', 'bin', 'zjz.mjs');
const FAKE = path.join(HERE, 'fake_responder.mjs');

function cli(args) {
  const r = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', maxBuffer: 32e6 });
  try { return JSON.parse(r.stdout); } catch { return { ok: false, raw: String(r.stdout || r.stderr || '').slice(0, 200) }; }
}

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'zjz-i47-'));
const H = ['--home', home];

// 布景：甲发帖点名乙；乙＝不盯房成员（绝不 wait），注册假 spawn 适配器
const a = cli([...H, 'identity', 'new', '--name', '发帖甲']);
const b = cli([...H, 'identity', 'new', '--name', '沉睡乙']);
const room = cli([...H, 'new', '--name', 'I47演示房', '--slug', a.slug]);
cli([...H, 'join', room.invite_code, '--slug', b.slug]);
cli([...H, 'send', '这条 pending 必须出现在任务里：乙请自动回帖。', '--room', room.room_id, '--slug', a.slug, '--mention', b.slug]);

const reg = member.set(home, {
  slug: b.slug,
  adapter_kind: 'spawn',
  argv: [process.execPath, FAKE, '{task_file}'],
  env: { ZJZ_DEMO_HOME: home, ZJZ_DEMO_SLUG: b.slug },
  cooldown_ms: 0, // 故意不设冷却：防双发是 wake 层租约（I35）的职责，不是我层的
  max_consecutive: 5,
});
if (!reg.ok) { console.log('判定: FAIL（注册失败：' + JSON.stringify(reg) + '）'); process.exit(1); }

// 触发：按 Codex 契约（#55261 CLI＝wake；#55216 提过 spawn）。两次连发＝测防双发。
let triggered = null;
for (const cmd of ['wake', 'spawn']) {
  const t1 = cli([...H, cmd, b.slug]);
  // 真实现的判据：ok:true 或带 status；BAD_INPUT/未知命令不算（CLI 会把未知子命令漏进默认路径——11-09 实踩）
  if (t1.ok === true || t1.status !== undefined) { triggered = cmd; break; }
}
if (!triggered) {
  console.log('判定: FAIL（`zjz wake <slug>`/`zjz spawn <slug>` 均未实现——监督器未交付，如实红）');
  process.exit(1);
}
const t2 = cli([...H, triggered, b.slug]); // 第二次：应被租约/防双发拦住

// 断言 1（我层）：任务文件已落盘且含正文＋resume 协议
const taskFile = path.join(home, 'data', 'adapters', `${b.slug}.task.md`);
const taskOk = fs.existsSync(taskFile);
const taskText = taskOk ? fs.readFileSync(taskFile, 'utf8') : '';
// 断言 2（他层）：乙（不盯房）在房里有回帖
const msgs = cli([...H, 'read', '--room', room.room_id, '--slug', a.slug, '--limit', '50']);
const replies = ((msgs.messages || [])).filter((x) => x.author === b.slug);
// 断言 3（他层）：.wake 事件留痕（扫 home/data 下任何 json/jsonl 含 wake 与 slug）
let wakeEvent = false;
const stack = [path.join(home, 'data')];
while (stack.length && !wakeEvent) {
  const dir = stack.pop();
  let names = [];
  try { names = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
  for (const e of names) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { stack.push(p); continue; }
    if (/\.(json|jsonl|md)$/.test(e.name)) {
      const t = fs.readFileSync(p, 'utf8');
      if (t.includes('wake') && t.includes(b.slug)) { wakeEvent = true; break; }
    }
  }
}

console.log('trigger=' + triggered + ' 二次触发=' + JSON.stringify({ ok: t2.ok, status: t2.status, code: t2.code }));
console.log('我层 任务文件=' + taskOk + ' 含正文=' + taskText.includes('必须出现在任务里') + ' 含resume=' + taskText.includes('zjz.mjs resume'));
console.log('他层 乙回帖数=' + replies.length + '（应为 1，防双发）  .wake事件=' + wakeEvent);
const pass = taskOk && taskText.includes('必须出现在任务里') && taskText.includes('zjz.mjs resume') && replies.length === 1 && wakeEvent;
console.log('判定: ' + (pass ? 'PASS（不盯房被拽回 端到端成立）' : 'FAIL（见上分层归因）'));
process.exit(pass ? 0 : 1);
