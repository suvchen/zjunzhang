// I48 加厚哨兵二（总管）：长任务飞行中不得二次派发——现场活案例 2026-11-09（#56218/#56219 两条分身回帖）的夹具化。
// 场景：适配器任务耗时 ~140s（> 租约 TTL 60s）；t+110s 再 wake。判据：wake2 不得 spawned（batch 未闭合＝不再派发）；最终回帖恰 1。
// 当前预期如实红（租约 TTL 与 cooldown 都拦不住飞行中的长任务）；Codex 落 wake batch 后应翻绿。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(HERE, '..', '..', 'bin', 'zjz.mjs');

function cli(args, env = {}) {
  const r = spawnSync(process.execPath, [CLI, '--home', home, ...args], { encoding: 'utf8', maxBuffer: 32e6, env: { ...process.env, ...env } });
  try { return JSON.parse(r.stdout); } catch { return { ok: false, raw: String(r.stdout || r.stderr || '').slice(0, 200) }; }
}
function sleep(ms) { spawnSync(process.execPath, ['-e', `Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,${ms})`]); }

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'zjz-longrun-'));
const H = ['--home', home];

// 夹具＝长跑 140s 后回帖一次（模拟 opencode-cli 真任务的耗时形状）
const slow = path.join(home, 'slow_responder.mjs');
fs.writeFileSync(slow, [
  "import { spawnSync } from 'node:child_process';",
  "spawnSync(process.execPath, ['-e', 'Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,140000)']);",
  "const r = spawnSync(process.execPath, [process.env.LR_CLI, '--home', process.env.LR_HOME, 'send', '长任务应答-LR91', '--room', process.env.LR_ROOM, '--slug', process.env.LR_SLUG], { encoding: 'utf8' });",
  'process.exit(r.status === 0 ? 0 : 1);',
].join('\n'), 'utf8');

const a = cli([...H, 'identity', 'new', '--name', '发帖甲']);
const b = cli([...H, 'identity', 'new', '--name', '慢手乙']);
const room = cli([...H, 'new', '--name', '长任务哨兵房', '--slug', a.slug]);
cli([...H, 'join', room.invite_code, '--slug', b.slug]);
cli([...H, 'send', '长任务哨兵：请处理后回帖 长任务应答-LR91', '--room', room.room_id, '--slug', a.slug, '--mention', b.slug]);

const env = { LR_CLI: CLI, LR_HOME: home, LR_ROOM: room.room_id, LR_SLUG: b.slug };
const reg = cli([...H, 'member', 'set', '--slug', b.slug, '--adapter-kind', 'spawn',
  '--adapter', JSON.stringify([process.execPath, slow, '{task_file}']), '--cooldown-ms', '0', '--max-consecutive', '5']);
if (!reg.ok) { console.log('判定: FAIL（建档失败）' + JSON.stringify(reg).slice(0, 200)); process.exit(1); }

// 第一次 wake-exec 异步起飞（不阻塞主测）
const child = spawn(process.execPath, [CLI, '--home', home, 'wake-exec', b.slug], { env: { ...process.env, ...env }, stdio: 'ignore' });

sleep(110000); // 越过租约 TTL（60s），仍在任务飞行窗（140s）内

const w2 = cli([...H, 'wake', b.slug], env);
console.log('wake2=' + JSON.stringify(w2).slice(0, 110));
const doubleDispatched = w2.ok === true && w2.status === 'spawned';
console.log('飞行中二次派发=' + doubleDispatched + '（必须 false：batch 未闭合不再派发）');

// 等首个任务收尾＋可能的第二任务，数最终回帖
let replies = -1;
for (let i = 0; i < 40; i += 1) {
  const msgs = cli([...H, 'read', '--room', room.room_id, '--slug', a.slug, '--limit', '50']);
  replies = (msgs.messages || []).filter((x) => x.author === b.slug).length;
  if (replies >= 2) break;
  if (i === 20 && replies === 1) break; // 首任务已回且无第二迹象，提前收
  sleep(5000);
}
console.log('最终回帖数=' + replies + '（应恰 1）');
const pass = !doubleDispatched && replies === 1;
console.log('判定: ' + (pass ? 'PASS（wake 层 batch 语义防住飞行中双发）' : 'FAIL（活案例夹具化：租约/cooldown 拦不住飞行中长任务）'));
child.kill?.();
process.exit(pass ? 0 : 1);
