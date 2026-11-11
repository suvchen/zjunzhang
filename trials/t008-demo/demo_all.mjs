// T-008 演示收口一键脚本（总管，Codex 工单 #55522）：逐项 PASS/FAIL，不依赖任何外部计划任务（I49 硬判据）。
// 用法：node demo_all.mjs [--port 8788]
// 现阶段预期：I45 PASS（已接线）；I46/I47/I48/I49 如实红（serve/wake 未交付＝Codex 在途）。全绿＝演示可收口。
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const portIndex = process.argv.indexOf('--port');
const PORT = Number(portIndex >= 0 ? process.argv[portIndex + 1] : 8788);
const slugIndex = process.argv.indexOf('--slug');
const SLUG = slugIndex >= 0 ? process.argv[slugIndex + 1] : '';
const BASE = `http://127.0.0.1:${PORT}`;
const homeIndex = process.argv.indexOf('--home');
const HOME = homeIndex >= 0 ? process.argv[homeIndex + 1] : (process.env.ZJZ_HOME || path.join(HERE, '..', '..'));
const CLI = path.join(HERE, '..', '..', 'bin', 'zjz.mjs');
function zjz(args, slug) {
  const r = spawnSync(process.execPath, [CLI, '--home', HOME, ...args], { encoding: 'utf8', maxBuffer: 32e6, timeout: 60000, env: { ...process.env, ...(slug ? { ZJZ_SLUG: slug } : {}) } });
  const out = (r.stdout || '').trim();
  const start = out.indexOf('{');
  try { return JSON.parse(start >= 0 ? out.slice(start) : '{}'); } catch { return { ok: false, code: 'CLI_BAD_OUTPUT', message: (r.stderr || out).slice(0, 200) }; }
}
const results = [];
const T = (name, pass, detail = '') => { results.push({ name, pass, detail }); console.log(`${pass ? 'PASS' : 'FAIL'} ${name}${detail ? ' [' + detail + ']' : ''}`); };

function runScript(rel, args = []) {
  const r = spawnSync(process.execPath, [path.join(HERE, rel), ...args], { encoding: 'utf8', maxBuffer: 32e6, timeout: 300000 });
  return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
}

async function httpJson(p, opt = {}, timeoutMs = 4000) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const r = await fetch(BASE + p, { ...opt, signal: ac.signal });
    return await r.json();
  } catch (e) {
    return { ok: false, code: 'SERVE_DOWN', message: String(e.message || e) };
  } finally { clearTimeout(t); }
}

// ---- I45 被动带出（已有独立探针，复用） ----
{
  const r = runScript('../m4-frontend-dev/i45_mcp_check.mjs');
  T('I45 工具返回自带 inbox 横幅', r.code === 0, r.out.split('\n').filter((l) => /判定/.test(l)).join(' ').slice(0, 80));
}

// ---- serve 在场性（I46/I48/I49 共同前置）----
// 前置不满足时不算产品红：重试 5 秒后直接退出并给出确切启动命令（夜巡/装机自测据此分辨「没人起服务」与「闭环坏了」）。
let health = await httpJson('/api/health');
for (let i = 0; i < 10 && health.ok !== true; i++) {
  await new Promise((r) => setTimeout(r, 500));
  health = await httpJson('/api/health');
}
const serveUp = health.ok === true;
T('前置 serve 存活 (/api/health)', serveUp, serveUp ? JSON.stringify(health).slice(0, 100) : JSON.stringify(health).slice(0, 160));
if (!serveUp) {
  console.log(`前置未就绪：先在目标 home 起服务再跑本脚本 —— node bin/zjz.mjs --home <HOME> serve --port ${PORT}`);
  console.log('== 汇总 前置未就绪（不计产品红）==');
  process.exit(2);
}

let demoRoomId = '';
if (serveUp) {
  // ---- I46 在线即推 ≤2s：B 挂 SSE，A 发帖，B 2 秒内收到 ----
  try {
    // demo_all 必须在**任何 home** 上都能跑：没房就自己从零建（装机演示从零开始）。
    let rooms = await httpJson(`/api/rooms?slug=${encodeURIComponent(SLUG || health.current_slug || '')}`);
    let roomId = (rooms.rooms || [])[0]?.room_id;
    let probeSlug = SLUG || health.current_slug || 'zjz-i46-probe';
    if (!roomId) {
      const owner = zjz(['identity', 'new', '--name', '演示业主']);
      const ownerSlug = owner.slug || '';
      const made = zjz(['new', '--name', '演示房'], ownerSlug);
      roomId = made.room_id || '';
      const wired = zjz(['member', 'wire', '--slug', probeSlug, '--room', roomId, '--name', '演示分身', '--adapter-kind', 'notify'], ownerSlug);
      if (wired.ok && wired.slug) probeSlug = wired.slug; // member wire 对无身份 slug 会生成新 slug，订阅必须用它
      rooms = await httpJson(`/api/rooms?slug=${encodeURIComponent(ownerSlug)}`);
      roomId = roomId || (rooms.rooms || [])[0]?.room_id;
      demoRoomId = roomId;
    }
    if (!roomId) throw new Error('无房可测');
    const esAc = new AbortController();
    const started = Date.now();
    const stream = await fetch(`${BASE}/api/rooms/${roomId}/stream?member=${encodeURIComponent(probeSlug)}`, { signal: esAc.signal, headers: { Accept: 'text/event-stream' } });
    if (!stream.ok || !stream.body) throw new Error('stream 状态 ' + stream.status);
    const reader = stream.body.getReader();
    const dec = new TextDecoder();
    // 先等服务端 ready 再发帖：订阅未注册就 POST 会漏推（总管 11-09 sse_probe 实测复现过这个竞态，属测试侧缺陷，不是产品缺陷）
    const readyDeadline = Date.now() + 2000;
    while (Date.now() < readyDeadline) {
      const { value, done } = await reader.read();
      if (done) break;
      if (dec.decode(value, { stream: true }).includes('ready')) break;
    }
    // 发帖（经 POST 契约）；延迟只算「发帖→收到」，不把订阅时间算进去
    const sent = Date.now();
    await httpJson(`/api/rooms/${roomId}/messages`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ slug: probeSlug, text: 'I46 延迟探针 ' + sent }) });
    let got = null;
    const deadline = Date.now() + 5000;
    while (!got && Date.now() < deadline) {
      const { value, done } = await reader.read();
      if (done) break;
      const chunk = dec.decode(value, { stream: true });
      if (chunk.includes('I46 延迟探针')) got = Date.now() - sent;
    }
    esAc.abort();
    T('I46 在线即推 ≤2s', got !== null && got <= 2000, '延迟ms=' + got);
  } catch (e) {
    T('I46 在线即推 ≤2s', false, String(e.message || e).slice(0, 120));
  }

  // ---- I48 SLA 红标：值班板点名失联成员 ----
  const board = await httpJson('/api/duty/board?slug=' + encodeURIComponent(SLUG || health.current_slug || ''));
  T('I48 值班板含失联点名', board.ok === true && Array.isArray(board.members) && board.members.some((m) => m.listening === false || m.sla === 'late' || (m.pending_unread ?? 0) > 0), JSON.stringify(board).slice(0, 140));
} else {
  T('I46 在线即推 ≤2s', false, 'serve 未交付（如实红）');
  T('I48 值班板含失联点名', false, 'serve 未交付（如实红）');
}

// ---- I47 不盯房被拽回（独立探针，复用） ----
{
  const r = runScript('i47_wake_check.mjs');
  T('I47 离线唤醒端到端', r.code === 0, r.out.split('\n').filter((l) => /判定|回帖数/.test(l)).join(' ').slice(0, 120));
}

// ---- I49 软件内自持：全程无外部计划任务参与（本脚本未注册任何 schtasks；serve 若依赖外部计划任务则此层测不出绿） ----
{
  const tasks = spawnSync('schtasks.exe', ['/query', '/fo', 'CSV'], { encoding: 'utf8' });
  const zjzTasks = String(tasks.stdout || '').split(/\r?\n/).filter((l) => /zjz|zjunzhang/i.test(l));
  T('I49 自持前提：无 zjz 相关外部计划任务', zjzTasks.length === 0, '查到 ' + zjzTasks.length + ' 条（应为 0＝产品原生自持）');
}

// ---- I50 智能体管理：只有帐主人能拉人（客户机器千差万别→探测；权限闸门必须挡住非主人）----
{
  const det = await httpJson('/api/agents/discover');
  T('I50-1 本机探测智能体', det.ok === true && Array.isArray(det.agents), `探到 ${(det.agents || []).length} 个`);

  const noBy = await httpJson('/api/agents/invite', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'x', slug: 'x', room_id: demoRoomId, adapter_kind: 'notify' }) });
  T('I50-2 无操作者身份必须被挡', noBy.ok !== true, `${noBy.code || 'ok'} ${String(noBy.message || '').slice(0, 60)}`);

  const badBy = await httpJson('/api/agents/invite', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ by: 'zjz-路人-不存在', name: 'y', slug: 'y', room_id: demoRoomId, adapter_kind: 'notify' }) });
  T('I50-3 非帐主人必须被挡', badBy.ok !== true && badBy.code === 'NOT_OPERATOR', `${badBy.code || 'ok'} ${String(badBy.message || '').slice(0, 60)}`);
}
const fails = results.filter((r) => !r.pass);
console.log(`== 汇总 ${results.length - fails.length}/${results.length} PASS ==` + (fails.length ? `（未收口项：${fails.map((f) => f.name.split(' ')[0]).join(', ')}）` : '（全部收口）'));
process.exit(fails.length ? 1 : 0);
