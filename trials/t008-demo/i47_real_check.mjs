// I47 真宿主验收（总管）：真 opencode-cli 适配器——不盯房的 GUI 同族宿主被 zjz wake 自动拉起、读消息、经 zjz CLI 回帖。
// 这是演示当天那一幕的脚本化。运行前提：Codex 的 `zjz wake <slug>` 已交付。模型走本地（总管独占）。
// 用法：node i47_real_check.mjs   （现阶段无 wake CLI＝如实 FAIL；交付后应 PASS）
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { member } from '../../src/member.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(HERE, '..', '..', 'bin', 'zjz.mjs');
// 注意（E15）：本地 IQ3 单槽串行——总管同时在线会抢同一槽，真任务从 ~79s 拖到 180s+ 后被适配器默认 180s 超时杀掉（E14：还误报成 ADAPTER_SPAWN_FAILED）。
// 自测要避坑就换模型：ZJZ_HOST_MODEL=deepseek-api/deepseek-flash（见下方 MODEL）。
// 宿主可执行：优先 ZJZ_HOST_CLI，其次 OpenCode 桌面版安装目录，最后 PATH（装机包不得写死某台机器的路径）
function findHostCli() {
  if (process.env.ZJZ_HOST_CLI && fs.existsSync(process.env.ZJZ_HOST_CLI)) return process.env.ZJZ_HOST_CLI;
  const roots = [path.join(process.env.APPDATA || '', 'ai.opencode.desktop', 'cli')];
  for (const root of roots) {
    if (!root || !fs.existsSync(root)) continue;
    for (const v of fs.readdirSync(root).sort().reverse()) {
      const exe = path.join(root, v, 'opencode-cli.exe');
      if (fs.existsSync(exe)) return exe;
    }
  }
  const which = spawnSync(process.platform === 'win32' ? 'where.exe' : 'which', ['opencode-cli'], { encoding: 'utf8' });
  const first = (which.stdout || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0];
  return first || 'opencode-cli';
}
const OCL = findHostCli();
const MODEL = process.env.ZJZ_HOST_MODEL || 'local-strata/strata-iq3s-125b';

function cli(args) {
  const r = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', maxBuffer: 32e6 });
  try { return JSON.parse(r.stdout); } catch { return { ok: false, raw: String(r.stdout || r.stderr || '').slice(0, 200) }; }
}

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'zjz-i47r-'));
const H = ['--home', home];

const a = cli([...H, 'identity', 'new', '--name', '发帖甲']);
const b = cli([...H, 'identity', 'new', '--name', '总管opencode真身']);
const room = cli([...H, 'new', '--name', 'I47真宿主房', '--slug', a.slug]);
cli([...H, 'join', room.invite_code, '--slug', b.slug]);
const marker = '自动唤醒回帖-' + Date.now();
cli([...H, 'send', '唤醒真宿主：请处理后回帖，回帖正文必须以 ' + marker + ' 开头。', '--room', room.room_id, '--slug', a.slug, '--mention', b.slug]);

const replyCmd = `node ${CLI.replace(/\\/g, '/')} --home ${home.replace(/\\/g, '/')} send "<以 ${marker} 开头的应答>" --room ${room.room_id} --slug ${b.slug}`;
const reg = member.set(home, {
  slug: b.slug,
  adapter_kind: 'spawn',
  argv: [OCL, 'run', '--model', MODEL, '{task}'],
  cooldown_ms: 0, // 防双发由 wake 层租约负责（I35）
  max_consecutive: 2,
});
if (!reg.ok) { console.log('判定: FAIL（注册失败）' + JSON.stringify(reg)); process.exit(1); }

// 触发两次：第二次必须被租约拦住（恰 1 回帖）
const t1 = cli([...H, 'wake', b.slug]);
const t2 = cli([...H, 'wake', b.slug]);
if (!(t1.ok === true || t1.status !== undefined)) {
  console.log('判定: FAIL（`zjz wake` 未实现/语义不符，如实红）：' + JSON.stringify(t1).slice(0, 200));
  process.exit(1);
}

// 读回帖（真身会话被拉起后要跑 CLI 回帖，给 3 分钟窗口轮询）
let hit = 0;
for (let i = 0; i < 36 && hit === 0; i += 1) {
  const msgs = cli([...H, 'read', '--room', room.room_id, '--slug', a.slug, '--limit', '50']);
  hit = (msgs.messages || []).filter((x) => x.author === b.slug && String(x.text).includes(marker)).length;
  if (hit === 0) spawnSync(process.execPath, ['-e', 'Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,5000)']);
}
console.log(`wake1=${JSON.stringify(t1).slice(0, 80)} wake2=${JSON.stringify(t2).slice(0, 80)}`);
console.log(`真身回帖数=${hit}（应为恰 1）`);
const pass = hit === 1;
console.log('判定: ' + (pass ? 'PASS（真宿主不盯房被拽回：拉起→读→回帖，全程无人提醒）' : 'FAIL'));
process.exit(pass ? 0 : 1);
