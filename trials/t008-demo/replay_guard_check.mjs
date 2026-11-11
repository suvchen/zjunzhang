// I48 加厚哨兵（总管）：跨唤醒周期重放防护——必须防在 wake 层，不能靠分身自觉 wait。
// 夹具＝fake_responder（只回帖、不 wait＝不消费游标，模拟不守协议的真宿主）。
// 判据：租约 TTL（≥60s）过期后再 wake，若无新消息必须 idle；再 spawn＝重放坐实＝FAIL。
// 当前预期如实红（wake.exec 不消费游标）；Codex 修法须守三对齐②：游标推进点在 answered/ack，不得投递即 read。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(HERE, '..', '..', 'bin', 'zjz.mjs');
const FAKE = path.join(HERE, 'fake_responder.mjs');

function cli(args, env = {}) {
  const r = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', maxBuffer: 32e6, env: { ...process.env, ...env } });
  try { return JSON.parse(r.stdout); } catch { return { ok: false, raw: String(r.stdout || r.stderr || '').slice(0, 200) }; }
}
function sleep(ms) { spawnSync(process.execPath, ['-e', `Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,${ms})`]); }

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'zjz-replay-'));
const H = ['--home', home];
const a = cli([...H, 'identity', 'new', '--name', '发帖甲']);
const b = cli([...H, 'identity', 'new', '--name', '分身乙']);
const room = cli([...H, 'new', '--name', '重放哨兵房', '--slug', a.slug]);
cli([...H, 'join', room.invite_code, '--slug', b.slug]);
cli([...H, 'send', '重放哨兵：必须出现在任务里', '--room', room.room_id, '--slug', a.slug, '--mention', b.slug]);

const reg = cli([...H, 'member', 'set', '--slug', b.slug, '--adapter-kind', 'spawn',
  '--adapter', JSON.stringify([process.execPath, FAKE, '{task_file}']), '--cooldown-ms', '0', '--max-consecutive', '5']);
if (!reg.ok) { console.log('判定: FAIL（建档失败）' + JSON.stringify(reg).slice(0, 200)); process.exit(1); }

const w1 = cli([...H, 'wake', b.slug], { ZJZ_DEMO_HOME: home, ZJZ_DEMO_SLUG: b.slug });
console.log('wake1=' + JSON.stringify(w1).slice(0, 90));

sleep(65000); // 租约 TTL（≥60s）过期＝进入下一唤醒周期

const w2 = cli([...H, 'wake', b.slug], { ZJZ_DEMO_HOME: home, ZJZ_DEMO_SLUG: b.slug });
console.log('wake2=' + JSON.stringify(w2).slice(0, 90));

const msgs = cli([...H, 'read', '--room', room.room_id, '--slug', a.slug, '--limit', '50']);
const replies = (msgs.messages || []).filter((x) => x.author === b.slug).length;
console.log('分身回帖数=' + replies + '（应恰 1；无新消息的第二周期不得再拉）');
const pass = replies === 1 && (w2.status === 'idle' || w2.ok === false);
console.log('判定: ' + (pass ? 'PASS（wake 层自防重放，无需分身自觉）' : 'FAIL（跨周期重放坐实：防靠分身自觉 wait，违产品口径）'));
process.exit(pass ? 0 : 1);
