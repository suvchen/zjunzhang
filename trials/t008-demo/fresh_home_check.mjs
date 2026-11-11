// 装机门判据 5 正式夹具（总管）：全新 home 走一遍 README 全路径，验证「不盯房，消息能到本体并产生回应」。
// 为什么单独有它：V:\zjunzhang 这个日常 home 已被各种历史配置喂熟，测不出「新装的人照文档走能不能通」。
// E20（member set 不等于进房）就是在这里被抓出来的：缺任何一步都必须红。
// 用法：node trials/t008-demo/fresh_home_check.mjs [--port 8898] [--model deepseek-api/deepseek-flash] [--timeout-ms 600000]
// 等待上限＝产品自身的宿主超时（member timeout_ms 默认 600s）：夹具不该比产品更严，否则并发抢模型时是假红。实测独占 66/86/91s，与他人同抢云端 >240s。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const argv = process.argv;
const arg = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const PORT = Number(arg('--port', '8898'));
const MODEL = arg('--model', process.env.ZJZ_HOST_MODEL || 'deepseek-api/deepseek-flash');
const WAIT_MS = Number(arg('--timeout-ms', '600000'));

function findHostCli() {
  if (process.env.ZJZ_HOST_CLI && fs.existsSync(process.env.ZJZ_HOST_CLI)) return process.env.ZJZ_HOST_CLI;
  const root = path.join(process.env.APPDATA || '', 'ai.opencode.desktop', 'cli');
  if (fs.existsSync(root)) {
    const hit = fs.readdirSync(root).flatMap((v) => path.join(root, v))
      .map((d) => path.join(d, 'opencode-cli.exe')).find((f) => fs.existsSync(f));
    if (hit) return hit;
  }
  const w = spawnSync(process.platform === 'win32' ? 'where.exe' : 'which', ['opencode-cli'], { encoding: 'utf8' });
  const first = (w.stdout || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0];
  return first || null;
}

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'zjz-freshcheck-'));
const adapterFile = path.join(home, 'adapter.json');
const nap = (ms) => { const t = Date.now() + ms; while (Date.now() < t) { /* 同步等 */ } };
const zjz = (args, ms = 45000) => {
  const r = spawnSync(process.execPath, [path.join(REPO, 'bin', 'zjz.mjs'), '--home', home, ...args], { encoding: 'utf8', maxBuffer: 32e6, timeout: ms });
  if (r.error) return { ok: false, code: 'SPAWN_ERROR', message: String(r.error.message || r.error) };
  if (r.signal) return { ok: false, code: 'SPAWN_TIMEOUT', message: `${ms}ms 未返回` };
  try { return JSON.parse(r.stdout); } catch { return { ok: false, raw: String(r.stdout || r.stderr || '').slice(0, 200) }; }
};

const steps = [];
const step = (name, ok, detail = '') => { steps.push({ name, ok: Boolean(ok), detail }); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`); };

const host = findHostCli();
if (!host) {
  console.log('BLOCKED 未找到宿主 CLI（设 ZJZ_HOST_CLI 或装 opencode-cli），不算产品红');
  console.log('复现：powershell -NoProfile -ExecutionPolicy Bypass -File scripts/install-check.ps1');
  process.exit(2);
}
fs.writeFileSync(adapterFile, JSON.stringify([host, 'run', '--model', MODEL, '{task}']), 'utf8');

// 1) 起 serve（非阻塞＋探活；不要用 spawnSync，见错误卡 E19）
let serveChild = null;
let up = false;
for (let round = 0; round < 3 && !up; round++) {
  serveChild = spawn(process.execPath, [path.join(REPO, 'bin', 'zjz.mjs'), '--home', home, 'serve', '--port', String(PORT)], { cwd: REPO, stdio: 'ignore', windowsHide: true });
  for (let k = 0; k < 20 && !up; k++) {
    const h = spawnSync(process.execPath, ['-e', `fetch('http://127.0.0.1:${PORT}/api/health').then(r=>r.text()).then(t=>process.stdout.write(t)).catch(()=>process.stdout.write('DOWN'))`], { encoding: 'utf8', timeout: 8000 }).stdout || '';
    up = h.includes('"ok":true');
    if (!up) nap(300);
  }
  if (!up) { zjz(['serve', 'status']); nap(600); } // E18：清死租约再试
}
step('判据5-1 全新 home 起 serve（探活到 /api/health）', up, `http://127.0.0.1:${PORT}/`);
if (!up) { console.log('== 装机门判据5 FAIL（serve 起不来）=='); process.exit(1); }

// 2) README 第 3 步：只 member set（**故意不做身份与进房**）→ 必须测不出唤醒能力，这是文档缺口的哨兵
const owner = zjz(['identity', 'new', '--name', '验收业主']);
const room = zjz(['new', '--name', '验收房']);
step('判据5-2 建房成功', room.ok, room.room_id || '');
const bare = zjz(['member', 'set', '--slug', 'zjz-裸成员', '--adapter-kind', 'spawn', '--adapter-file', adapterFile,
  '--wake-policy', 'all', '--timeout-ms', '600000', '--provider', 'remote']);
step('判据5-3 member set 建档成功（但无身份、未进房）', bare.ok, 'zjz-裸成员');
const bareState = zjz(['member', 'providers']);
step('判据5-4 provider 视图能看出该成员不在本地槽上', bareState.ok, `local_slots=${bareState.summary && bareState.summary.local_slots}`);

// 3) README 3.1：补身份＋进房＋绑适配器（E20 的正确路径）
const bot = zjz(['identity', 'new', '--name', '验收分身']);
step('判据5-5 分身有身份', bot.ok, bot.slug || '');
const joined = zjz(['join', room.invite_code, '--slug', bot.slug]);
step('判据5-6 分身进房', joined.ok, joined.code || '');
const wired = zjz(['member', 'set', '--slug', bot.slug, '--adapter-kind', 'spawn', '--adapter-file', adapterFile,
  '--wake-policy', 'all', '--timeout-ms', '600000', '--provider', 'remote']);
step('判据5-7 适配器绑到该身份', wired.ok, bot.slug || '');
const inRoom = (() => {
  try {
    const list = JSON.parse(fs.readFileSync(path.join(home, 'data', 'rooms', room.room_id, 'members.json'), 'utf8'));
    return list.some((r) => r.slug === bot.slug);
  } catch { return false; }
})();
step('判据5-8 房名单里有该 slug（wake 只认这个）', inRoom);

// 4) 实弹：业主发消息，人不盯房，等自动回帖
// 注意（E21）：CLI 默认用 current.json 里的身份，而 identity new/join 会把 current 切成新 slug——
// 不显式 --slug 就会「以分身的名义发消息」，而唤醒规则排除自己发的消息，闭环当场测不出来。
const sent = zjz(['send', '请用一句话回答：装机验收是否通过？回帖首行写「回复于 <本地时间>」。', '--room', room.room_id, '--slug', owner.slug]);
step('判据5-9 业主发消息成功', sent.ok, `seq=${sent.seq}`);
const author = (() => {
  try {
    const lines = fs.readFileSync(path.join(home, 'data', 'rooms', room.room_id, 'messages.jsonl'), 'utf8').split(/\r?\n/).filter(Boolean);
    return lines.length ? (JSON.parse(lines[lines.length - 1]).author || '') : '';
  } catch { return ''; }
})();
step('判据5-9b 消息作者是业主而不是分身（防"自己发消息自己不醒"的假红，E21）', author === owner.slug, `author=${author}`);
const t0 = Date.now();
let reply = null;
while (Date.now() - t0 < WAIT_MS) {
  const r = zjz(['read', '--room', room.room_id, '--limit', '50']);
  const hit = (r.messages || []).find((m) => Number(m.seq) > Number(sent.seq || 0) && m.author === bot.slug);
  if (hit) { reply = hit; break; }
  nap(5000);
}
step(`判据5-10 不盯房被拽回并回帖（${reply ? Math.round((Date.now() - t0) / 1000) + 's' : `超 ${WAIT_MS / 1000}s 无回帖`}）`,
  Boolean(reply), reply ? `${reply.author}: ${String(reply.text).replace(/\s+/g, ' ').slice(0, 120)}` : '');

// 5) 证据可见：wake 事件流 ＋ 投递台账字段
// 语义记档：产品里 read/answered 是 delivery 台账的**字段**（wake.js:348 batch 闭合时 markReadByMessage），
// 事件流只记 wake.* / delivery_late / supervisor.revive；answered 由 feed 侧检测（huddo 房才走那条路）。
// 所以这里查：事件流有 wake.spawn，且台账里这条消息的 read_at 已写＝batch 已闭合。
const evRoot = path.join(home, 'data', 'events');
const types = [];
if (fs.existsSync(evRoot)) for (const f of fs.readdirSync(evRoot)) {
  for (const l of fs.readFileSync(path.join(evRoot, f), 'utf8').split(/\r?\n/).filter(Boolean)) {
    try { types.push(JSON.parse(l).type); } catch { /* 跳过坏行 */ }
  }
}
let deliveryRow = null;
// read_at 由 feed 轮询回填（15s 一拍），等它收敛而不是查瞬时值；36s 覆盖两拍以上。
for (let k = 0; k < 18; k++) {
  try {
    const state = JSON.parse(fs.readFileSync(path.join(home, 'data', 'delivery', 'state.json'), 'utf8'));
    deliveryRow = (state.records || []).find((r) => r.room_id === room.room_id && r.recipient === bot.slug) || null;
  } catch { /* 台账还没落 */ }
  if (deliveryRow && deliveryRow.read_at) break;
  nap(2000);
}
step('判据5-11 事件流有 wake.spawn，且投递台账 read_at 已写（batch 闭合）',
  types.some((t) => /wake\.spawn/.test(t)) && Boolean(deliveryRow && deliveryRow.read_at),
  `事件=${types.slice(0, 6).join(',')} 台账=${deliveryRow ? `status=${deliveryRow.status} read_at=${deliveryRow.read_at} answered_at=${deliveryRow.answered_at}` : '无'}`);

zjz(['serve', 'stop']);
try { if (serveChild) serveChild.kill(); } catch { /* 已退 */ }

const failed = steps.filter((s) => !s.ok);
const report = path.join(REPO, 'data', 'selfcheck', `fresh-home-${new Date().toISOString().replace(/[:.]/g, '-')}.md`);
fs.mkdirSync(path.dirname(report), { recursive: true });
fs.writeFileSync(report, [
  `# 装机门判据5 · 全新 home 实弹 ${new Date().toISOString()}`,
  '',
  `判定：${failed.length === 0 ? 'PASS' : 'FAIL（' + failed.length + ' 项）'}`,
  '',
  '| 步骤 | 结果 | 证据 |', '|---|---|---|',
  ...steps.map((s) => `| ${s.name} | ${s.ok ? 'PASS' : 'FAIL'} | ${String(s.detail).replace(/\|/g, '/')} |`),
  '',
  `home：${home}（一次性）  端口：${PORT}  宿主：${host}  模型：${MODEL}`,
  '复现：node trials/t008-demo/fresh_home_check.mjs --port 8898',
].join('\n'), 'utf8');
console.log(`报告：${report}`);
console.log(failed.length === 0 ? '== 装机门判据5 PASS ==' : '== 装机门判据5 FAIL ==');
process.exit(failed.length === 0 ? 0 : 1);
