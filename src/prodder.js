// 中军帐 · 参谋长（会员版）——心跳督战模块（prodder）
// 职责（参谋长第五能力「持续督战」）：盯住每个智能体，停了就催、就拉起，让整个团队转个不停。
// 技术真相（主人点破）：智能体干几分钟就停，我们能连续工作是"心跳机制"在促成。
// 复用现有件：wake（拉起/唤醒）、member（谁在岗）、delivery（谁没回执）。
// 边界：只"催活/督战"，不自动处置别的产品；催办在后台，不弹主人。
//
// 判定顺序（缺一条就会变成骚扰或双发）：
//   1. 还有活没干吗？——没有未回执投递 = 不催（否则每个空闲智能体每轮都被催）。
//   2. 子进程还活着吗？——活着 = 还在干，不催。
//   3. 冷却到了吗？——同一个智能体催过就记账，冷却期内不重复催；连续催不起来则指数退避。
//   4. 拉不起来就如实报 blocked（缺适配器/身份），不假装催过。
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { member } from './member.js';
import { wake } from './wake.js';
import { delivery } from './delivery.js';

function homeDir(home) {
  return path.resolve(home || process.env.ZJZ_HOME || process.cwd());
}

function stateFile(home) {
  return path.join(homeDir(home), 'data', 'prodder', 'state.json');
}

function readState(home) {
  try {
    const state = JSON.parse(fs.readFileSync(stateFile(home), 'utf8'));
    return state && typeof state === 'object' && state.nudges && typeof state.nudges === 'object'
      ? state
      : { nudges: {} };
  } catch {
    return { nudges: {} };
  }
}

function saveState(home, state) {
  const file = stateFile(home);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, file);
}

// —— 这个智能体还有没有活没干 ——
// 未回执 = 投递台账里 recipient 是它、状态还没到 answered。
export function pendingFor(home, slug) {
  const board = delivery.board(home);
  const rows = (board && board.ok && board.rows) || [];
  return rows.filter((row) => row.recipient === slug && row.status !== 'answered');
}

function lastNudge(state, slug) {
  return state.nudges[slug] || null;
}

// 连续催不起来的退避：cooldown × 2^min(failures,3)，封顶 30 分钟。
export function cooldownFor(state, slug, baseCooldownMs) {
  const last = lastNudge(state, slug);
  if (!last) return baseCooldownMs;
  const failures = Number(last.failures || 0);
  const factor = 2 ** Math.min(failures, 3);
  return Math.min(baseCooldownMs * factor, 30 * 60 * 1000);
}

// —— 判定一个智能体该不该被催 ——
export function needsNudge(home, slug, opts = {}) {
  const now = Number(opts.now ?? Date.now());
  const baseCooldown = Number(opts.cooldown_ms ?? 5 * 60 * 1000);
  if (!Number.isFinite(baseCooldown) || baseCooldown <= 0) return { nudge: false, reason: 'bad_cooldown' };

  // 1. 没活不催。
  const pending = pendingFor(home, slug);
  if (pending.length === 0) return { nudge: false, reason: 'no_work' };

  // 2. 子进程还活着 = 正在干，不催。wakeChildAlive 返回 {ok,alive}，判 .alive。
  try {
    const alive = wake.wakeChildAlive && wake.wakeChildAlive(home, slug);
    if (alive && alive.ok && alive.alive) return { nudge: false, reason: 'alive', pending: pending.length };
  } catch { /* 查不到就往下判 */ }

  // 3. 冷却。
  const state = readState(home);
  const last = lastNudge(state, slug);
  const cooldown = cooldownFor(state, slug, baseCooldown);
  if (last && Number.isFinite(Date.parse(last.last_at)) && now - Date.parse(last.last_at) < cooldown) {
    return { nudge: false, reason: 'cooling', pending: pending.length, left_ms: cooldown - (now - Date.parse(last.last_at)) };
  }

  const oldest = pending.reduce((min, row) => {
    const at = Date.parse(row.posted_at);
    return Number.isFinite(at) ? Math.min(min, at) : min;
  }, now);
  return { nudge: true, reason: 'idle', pending: pending.length, oldest_age_ms: Math.max(0, now - oldest), cooldown_ms: cooldown };
}

// —— 催一次（拉起让它继续干）——
function nudge(home, slug, opts = {}) {
  if (typeof opts.nudge_fn === 'function') {
    const custom = opts.nudge_fn(home, slug) || {};
    return { ok: custom.ok !== false, via: 'nudge_fn', status: custom.status || 'custom', message: custom.message };
  }
  try {
    const res = wake.exec(home, { slug, force: true });
    if (!res || res.ok === false) {
      return { ok: false, via: 'wake.exec', status: 'failed', message: (res && res.message) || 'wake.exec 失败' };
    }
    if (res.status === 'not_wirable') {
      // 有活但根本拉不起来（缺适配器/身份）＝如实报，不算催过。
      return { ok: true, via: 'wake.exec', status: 'not_wirable', blocked: true, message: res.reason };
    }
    if (res.status === 'batch_open') {
      return { ok: true, via: 'wake.exec', status: 'batch_open', blocked: true, message: '已有唤醒批次在飞，不重复拉起' };
    }
    return { ok: true, via: 'wake.exec', status: res.status || 'ok' };
  } catch (e) {
    return { ok: false, via: 'wake.exec', status: 'failed', message: String(e && e.message ? e.message : e) };
  }
}

function record(state, slug, result, now) {
  const prev = lastNudge(state, slug) || {};
  const ok = result.ok === true && !result.blocked;
  state.nudges[slug] = {
    last_at: new Date(now).toISOString(),
    last_status: result.status || (ok ? 'ok' : 'failed'),
    attempts: Number(prev.attempts || 0) + 1,
    failures: ok ? 0 : Number(prev.failures || 0) + 1,
    message: result.message || null,
  };
}

// —— 督战一轮：扫所有在岗智能体，该催的催 ——
export function tick(home, options = {}) {
  const now = Number(options.now ?? Date.now());
  const listed = member.list(home);
  const agents = (listed && listed.ok && Array.isArray(listed.members)) ? listed.members : [];
  const report = { total: agents.length, nudged: [], blocked: [], failed: [], skipped: [] };
  const state = readState(home);
  for (const agent of agents) {
    const slug = String((agent && agent.slug) || '').trim();
    if (!slug) continue;
    const need = needsNudge(home, slug, { ...options, now });
    if (!need.nudge) { report.skipped.push({ slug, reason: need.reason, pending: need.pending ?? 0 }); continue; }
    const result = nudge(home, slug, options);
    record(state, slug, result, now);
    if (result.blocked) report.blocked.push({ slug, status: result.status, reason: result.message });
    else if (result.ok) report.nudged.push({ slug, via: result.via, pending: need.pending });
    else report.failed.push({ slug, message: result.message });
  }
  saveState(home, state);
  return { ok: true, at: new Date(now).toISOString(), ...report };
}

export const prodder = { needsNudge, tick, pendingFor, cooldownFor };
export default prodder;
