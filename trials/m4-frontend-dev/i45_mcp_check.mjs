// I45 验收脚本（总管）：真 MCP 客户端 stdio 连 bin/zjz-mcp.mjs，调非 wait 工具，断言返回自带 inbox
// 用法：node i45_mcp_check.mjs <HOME>（HOME 需已有身份与房；不存在会先造）
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CLI = path.join(ROOT, 'bin', 'zjz.mjs');
const MCP = path.join(ROOT, 'bin', 'zjz-mcp.mjs');
const HOME = process.argv[2] || fs.mkdtempSync(path.join(os.tmpdir(), 'zjz-i45-'));

function cli(args) {
  const r = spawnSync(process.execPath, [CLI, '--home', HOME, ...args], { maxBuffer: 16 * 1024 * 1024, encoding: 'utf8' });
  try { return JSON.parse(r.stdout); } catch { return { ok: false, raw: r.stdout } }
}

// 布景：甲建房发 2 条（其中 1 条 @ 乙），乙入房；乙的游标停在加入时刻
const a = cli(['identity', 'new', '--name', '甲']);
const b = cli(['identity', 'new', '--name', '收件乙']);
const room = cli(['new', '--name', 'I45验收房', '--slug', a.slug]);
const invite = cli(['members', '--room', room.room_id, '--slug', a.slug]); // 只为稳序
const inv = cli(['join', '', '--slug', b.slug]); // 占位防参数差异：真正入房用下面 invite
let joined = { ok: false };
if (!joined.ok) {
  // 用 zjz 正规路径：房主生成邀请（new 已返回 invite_code）
  joined = cli(['join', room.invite_code, '--slug', b.slug]);
}
cli(['send', '普通消息一条', '--room', room.room_id, '--slug', a.slug]);
cli(['send', '点名乙来验收', '--room', room.room_id, '--slug', a.slug, '--mention', b.slug]);

// MCP 子进程
const child = spawn(process.execPath, [MCP, '--home', HOME], { stdio: ['pipe', 'pipe', 'pipe'] });
const rl = readline.createInterface({ input: child.stdout });
const waiters = [];
rl.on('line', (line) => {
  let msg; try { msg = JSON.parse(line); } catch { return; }
  if (waiters.length) waiters.shift()(msg);
});
let id = 0;
function rpc(method, params) {
  const myId = ++id;
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: myId, method, params }) + '\n');
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('MCP 超时: ' + method)), 8000);
    waiters.push((m) => { clearTimeout(timer); resolve(m); });
  });
}

const init = await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'i45-check' } });
child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
if (!init.result) throw new Error('initialize 失败: ' + JSON.stringify(init));

// 关键一调：与消息毫无关系的工具（工单列表），返回里必须带 inbox 横幅
const out = await rpc('tools/call', { name: 'zjz_order_list', arguments: { slug: b.slug } });
const payload = JSON.parse(out.result.content[0].text);
const inbox = payload.inbox;
console.log('== I45 MCP 现场 ==');
console.log('tool=zjz_order_list joined=' + JSON.stringify(joined.ok));
console.log('inbox 存在=' + Boolean(inbox));
if (inbox) {
  console.log('pending_rooms=' + JSON.stringify(inbox.pending_rooms));
  console.log('mention_me=' + JSON.stringify(inbox.mention_me));
  console.log('duty=' + inbox.duty);
  const pr = (inbox.pending_rooms || []).find((x) => x.room_id === room.room_id);
  console.log('判定: ' + (pr && pr.unread_count === 2 && (inbox.mention_me || []).length === 1 && inbox.duty ? 'PASS' : 'FAIL(计数/摘要/健康行不全)'));
} else {
  console.log('判定: FAIL（工具返回不带 inbox——I45 未接线）');
}
child.kill();
