// 实弹预演：房②真消息 → feed.poll 导入镜像 → zjz wake ×2 → 真身应答恰 1 条（断在镜像房，可见于 M4）
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { feed } from '../../src/feed.js';

const H = process.env.ZJZ_HOME || path.resolve(import.meta.dirname, '..', '..');
const CLONE = 'zjz-代班分身-房二-49e324ef';
const MIRROR = 'room_1fd74bec46e7f70f';

function cli(args) {
  const r = spawnSync(process.execPath, [path.join(H, 'bin', 'zjz.mjs'), '--home', H, ...args], { encoding: 'utf8', maxBuffer: 32e6 });
  try { return JSON.parse(r.stdout); } catch { return { ok: false, raw: String(r.stdout || r.stderr || '').slice(0, 150) }; }
}

const p = await feed.poll(H, { huddo_home: (process.env.HUDDO_HOME || path.join(os.homedir(), '.huddo')), limit: 10 });
console.log('poll=' + JSON.stringify({ fresh: p.fresh, rooms: p.rooms.map((r) => r.fresh) }));

const w1 = cli(['wake', CLONE]);
const w2 = cli(['wake', CLONE]);
console.log('wake1=' + JSON.stringify(w1).slice(0, 120));
console.log('wake2=' + JSON.stringify(w2).slice(0, 120));

let hit = 0;
for (let i = 0; i < 36 && hit === 0; i += 1) {
  const msgs = cli(['read', '--room', MIRROR, '--slug', 'zjz-馈手-房二-f273ea7d', '--limit', '50']);
  hit = (msgs.messages || []).filter((x) => x.author === CLONE && String(x.text).includes('分身应答OK-RR831')).length;
  if (hit === 0) spawnSync(process.execPath, ['-e', 'Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,5000)']);
}
console.log('镜像房分身应答数=' + hit + '（应恰 1）');
console.log('判定: ' + (hit === 1 ? 'PASS（房②真消息→feed→wake→真身应答，全程无人提醒）' : 'FAIL'));
process.exit(hit === 1 ? 0 : 1);
