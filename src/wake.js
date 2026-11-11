// T-008 第 1/3 层：离线唤醒决策、wake-exec 一次性子进程、资源租约与 .wake 留痕。
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { member } from './member.js';
import { adapter } from './adapter.js';
import { inbox } from './inbox.js';
import { resource } from './resource.js';
import { delivery } from './delivery.js';
import { appendEvent } from './events.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(HERE, '..', 'bin', 'zjz.mjs');
const inflight = new Set();

function batchFile(home) {
  return path.join(homeDir(home), 'data', 'wake', 'batches.json');
}

function answeredFile(home) {
  return path.join(homeDir(home), 'data', 'wake', 'answered_ext.json');
}

function readAnsweredExt(home) {
  try {
    const state = JSON.parse(fs.readFileSync(answeredFile(home), 'utf8'));
    return new Set(Array.isArray(state.ext_ids) ? state.ext_ids : []);
  } catch {
    return new Set();
  }
}

function writeAnsweredExt(home, extIds) {
  fs.mkdirSync(path.dirname(answeredFile(home)), { recursive: true });
  const tmp = `${answeredFile(home)}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ ext_ids: [...extIds] }, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, answeredFile(home));
}

function extIdOf(message) {
  const match = /^\[huddo:([^\]]+)\]/.exec(String(message.text || ''));
  return match ? match[1] : null;
}

function readBatches(home) {
  try {
    const state = JSON.parse(fs.readFileSync(batchFile(home), 'utf8'));
    return Array.isArray(state.records) ? state.records : [];
  } catch {
    return [];
  }
}

function writeBatches(home, records) {
  fs.mkdirSync(path.dirname(batchFile(home)), { recursive: true });
  const tmp = `${batchFile(home)}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ records }, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, batchFile(home));
}

function openBatch(home, slug, messages) {
  const records = readBatches(home);
  const record = {
    batch_id: `wakebatch_${randomUUID()}`,
    slug,
    status: 'open',
    opened_at: new Date().toISOString(),
    closed_at: null,
    expires_at: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
    messages: messages.map((row) => ({ room_id: row.room_id, msg_id: row.id, seq: Number(row.seq) })),
  };
  records.push(record);
  writeBatches(home, records);
  return record;
}

function openBatchFor(home, slug) {
  return readBatches(home).find((row) => row.slug === slug && row.status === 'open') || null;
}

function advanceBatchCursors(home, batch) {
  const byRoom = new Map();
  for (const row of batch.messages || []) {
    const seq = Number(row.seq);
    if (Number.isInteger(seq)) byRoom.set(row.room_id, Math.max(Number(byRoom.get(row.room_id) || 0), seq));
  }
  for (const [roomId, maxSeq] of byRoom) {
    const file = path.join(homeDir(home), 'data', 'rooms', roomId, 'members.json');
    try {
      const members = JSON.parse(fs.readFileSync(file, 'utf8'));
      const row = Array.isArray(members) ? members.find((item) => item && item.slug === batch.slug) : null;
      if (row && Number(row.cursor || 0) < maxSeq) {
        row.cursor = maxSeq;
        const tmp = `${file}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify(members, null, 2) + '\n', 'utf8');
        fs.renameSync(tmp, file);
      }
    } catch { /* 无房/坏文件留给对账 */ }
  }
}

function closeBatch(home, batchId, status = 'closed') {
  const records = readBatches(home);
  const batch = records.find((row) => row.batch_id === batchId);
  if (!batch) return null;
  batch.status = status;
  batch.closed_at = new Date().toISOString();
  advanceBatchCursors(home, batch);
  writeBatches(home, records);
  return batch;
}

class WakeError extends Error {
  constructor(code, message) {
    super(message || code);
    this.name = 'WakeError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new WakeError(code, message);
}

function ok(payload = {}) {
  return { ok: true, ...payload };
}

function wrap(fn) {
  try {
    return fn();
  } catch (error) {
    return error instanceof WakeError
      ? { ok: false, code: error.code, message: error.message }
      : { ok: false, code: 'INTERNAL', message: String(error && error.message ? error.message : error) };
  }
}

function homeDir(home) {
  return path.resolve(home || process.env.ZJZ_HOME || process.cwd());
}

function readJsonl(file) {
  try {
    return fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function pendingMessages(home, slug) {
  const roomsRoot = path.join(homeDir(home), 'data', 'rooms');
  const out = [];
  let rooms = [];
  try {
    rooms = fs.readdirSync(roomsRoot, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch {
    return out;
  }
  for (const roomId of rooms) {
    const dir = path.join(roomsRoot, roomId);
    const members = readJson(path.join(dir, 'members.json'));
    const row = Array.isArray(members) ? members.find((item) => item && item.slug === slug) : null;
    if (!row) continue;
    const cursor = Number(row.cursor) || 0;
    const answeredExt = readAnsweredExt(home);
    for (const message of readJsonl(path.join(dir, 'messages.jsonl'))) {
      const extId = extIdOf(message);
      if (Number(message.seq) > cursor && message.author !== slug && (!extId || !answeredExt.has(extId))) {
        out.push({ ...message, room_id: roomId, ext_id: extId });
      }
    }
  }
  return out.sort((a, b) => Number(a.seq) - Number(b.seq));
}

// wake_policy=mention：只有点名到它的消息才唤醒/入任务体（防误拉与旧消息堆积）；缺省 all。
// 关键路径越权补丁（exec 与 tick 同一口径），Codex 可重构但两处必须一致。
function filterByWakePolicy(registered, slug, messages) {
  if (!registered || registered.wake_policy !== 'mention') return messages;
  const handles = Array.isArray(registered.mention_handles) && registered.mention_handles.length > 0 ? registered.mention_handles : [slug];
  return messages.filter((m) => {
    const text = String(m.text || '');
    return handles.some((h) => text.includes(`@${h}`) || text.includes(h));
  });
}

function event(home, type, slug, payload) {
  const result = appendEvent(home, {
    project: 'wake',
    type,
    actor: 'wake',
    subject: slug,
    payload,
  });
  return result.ok ? result.event : null;
}

function leaseResource(slug) {
  return `wake:${slug}`;
}

function claimWake(home, slug, ttlMs) {
  return resource.claim(home, { resource: leaseResource(slug), slug, ttl_ms: ttlMs });
}

function channelActive(home, slug) {
  const file = path.join(homeDir(home), 'data', 'wake', 'channels.json');
  const state = readJson(file) || {};
  const last = Number(state[slug] || 0);
  return last > 0 && Date.now() - last < 30000;
}

export function touchChannel(home, slug) {
  return wrap(() => {
    const file = path.join(homeDir(home), 'data', 'wake', 'channels.json');
    const state = readJson(file) || {};
    state[slug] = Date.now();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(state, null, 2) + '\n', 'utf8');
    return ok({ slug, active_until: state[slug] + 30000 });
  });
}

export function clearChannel(home, slug) {
  return wrap(() => {
    const file = path.join(homeDir(home), 'data', 'wake', 'channels.json');
    const state = readJson(file) || {};
    delete state[slug];
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(state, null, 2) + '\n', 'utf8');
    return ok({ slug, active: false });
  });
}

// ---- E16 看护红线：wake 子进程归属登记＋pid/命令行前缀校验（禁按进程名杀、禁模糊匹配杀） ----
function childRegistryFile(home) {
  return path.join(homeDir(home), 'data', 'wake', 'children.json');
}

function readChildren(home) {
  return readJson(childRegistryFile(home)) || {};
}

function writeChildren(home, state) {
  fs.mkdirSync(path.dirname(childRegistryFile(home)), { recursive: true });
  fs.writeFileSync(childRegistryFile(home), JSON.stringify(state, null, 2) + '\n', 'utf8');
}

export function registerWakeChild(home, slug, pid, prefix) {
  return wrap(() => {
    const state = readChildren(home);
    state[slug] = { pid: Number(pid), prefix: Array.isArray(prefix) ? prefix.map(String) : [], started_at: new Date().toISOString() };
    writeChildren(home, state);
    return ok({ slug, pid: Number(pid) });
  });
}

export function clearWakeChild(home, slug, pid) {
  return wrap(() => {
    const state = readChildren(home);
    const row = state[slug];
    const cleared = row && Number(row.pid) === Number(pid);
    if (cleared) delete state[slug];
    writeChildren(home, state);
    return ok({ slug, cleared: Boolean(cleared) });
  });
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return Boolean(error && error.code === 'EPERM'); }
}

function readProcessCommandLine(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return '';
  if (process.platform === 'win32') {
    const res = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`], { encoding: 'utf8', windowsHide: true, timeout: 5000 });
    return String(res.stdout || '').trim();
  }
  try { return fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0/g, ' ').trim(); } catch { return ''; }
}

// 只问"登记的子进程还在不在"，不读命令行——reconcile 每秒跑，不能用 spawnSync 卡监督环（I46 延迟实弹被它拖红）。
export function wakeChildAlive(home, slug) {
  return wrap(() => {
    const row = readChildren(home)[slug] || null;
    if (!row) return ok({ slug, registered: false, alive: false });
    return ok({ slug, registered: true, pid: row.pid, alive: pidAlive(Number(row.pid)) });
  });
}
export function wakeChildStatus(home, slug) {
  return wrap(() => {
    const row = readChildren(home)[slug] || null;
    if (!row) return ok({ slug, registered: false, alive: false, matched: false });
    const alive = pidAlive(Number(row.pid));
    const cmdline = alive ? readProcessCommandLine(Number(row.pid)) : '';
    const matched = alive && Array.isArray(row.prefix) && row.prefix.length > 0 && row.prefix.every((token) => cmdline.includes(token));
    return ok({ slug, registered: true, pid: row.pid, alive, matched, cmdline_tail: cmdline.slice(-200) });
  });
}
// E22：答完一条后被隐形锁死——batch 只在 wake-exec 子进程里 closeBatch，子进程先被杀/退出即永久 open。
// 对账：open batch 但自己登记的子进程已经不在（或已过期）＝孤儿，就地收口并补 read_at，不让用户等一个租期。
export function reconcileBatches(home) {
  return wrap(() => {
    const closed = [];
    for (const batch of readBatches(home)) {
      if (batch.status !== 'open') continue;
      const child = wakeChildAlive(home, batch.slug);
      const alive = Boolean(child.ok && child.registered && child.alive);
      const expired = Boolean(batch.expires_at) && Date.parse(batch.expires_at) < Date.now();
      if (alive && !expired) continue;
      const done = closeBatch(home, batch.batch_id, alive ? 'expired' : 'child_gone');
      if (!done) continue;
      for (const row of batch.messages || []) {
        delivery.markReadByMessage(home, { room_id: row.room_id, msg_id: row.msg_id, recipient: batch.slug });
      }
      event(home, 'wake.batch_reconciled', batch.slug, {
        batch_id: batch.batch_id,
        status: done.status,
        reason: alive ? 'expired' : 'child_gone',
        messages: (batch.messages || []).length,
      });
      closed.push({ batch_id: batch.batch_id, slug: batch.slug, status: done.status });
    }
    return ok({ reconciled: closed.length, closed });
  });
}
export function noteAnsweredExt(home, extIds) {
  return wrap(() => {
    const values = (Array.isArray(extIds) ? extIds : [extIds]).map((value) => String(value || '').trim()).filter(Boolean);
    const answered = readAnsweredExt(home);
    for (const value of values) answered.add(value);
    writeAnsweredExt(home, answered);
    return ok({ added: values.length, total: answered.size, ext_ids: values });
  });
}

export function exec(home, options = {}) {
  return wrap(() => {
    const slug = String(options.slug || '').trim();
    if (!slug) fail('BAD_INPUT', 'slug 必填');
    const registered = member.get(home, slug);
    if (!registered.ok) return registered;
    // E22 第4条：没绑适配器／没身份的 slug 不开 batch——开了就是隐形锁死，白挂一个租期。
    const memberRecord = registered.member || {};
    if (!['spawn', 'notify', 'api'].includes(memberRecord.adapter_kind)) {
      return ok({ status: 'not_wirable', spawned: false, messages: 0, reason: '未绑适配器（member set --adapter-kind spawn|notify|api）' });
    }
    if (!fs.existsSync(path.join(homeDir(home), 'data', 'identities', slug, 'key.json'))) {
      return ok({ status: 'not_wirable', spawned: false, messages: 0, reason: '无身份（zjz member wire --slug ... --room ...）' });
    }
    const messages = filterByWakePolicy(registered.member, slug, pendingMessages(home, slug));
    if (messages.length === 0 && options.force !== true) return ok({ status: 'idle', spawned: false, messages: 0 });
    const open = openBatchFor(home, slug);
    if (open) return ok({ status: 'batch_open', spawned: false, batch_id: open.batch_id, messages: open.messages.length });
    const ttl = Number(options.lease_ttl_ms ?? Math.max(60000, Number(registered.member.cooldown_ms || 0)));
    const claimed = claimWake(home, slug, ttl);
    if (!claimed.ok) return claimed;
    const batch = openBatch(home, slug, messages);
    for (const message of messages) {
      delivery.markPushedByMessage(home, {
        room_id: message.room_id,
        msg_id: message.id,
        sender: message.author,
        recipient: slug,
      });
    }
    // E21：把『它自己是谁』和『回哪个房』写进任务，回帖命令带 --slug，署名才是它自己（不然署成默认身份）。
    const task = adapter.composeTask({
      messages,
      head: '中军帐检测到你有未读房讯，现由系统自动唤醒。',
      slug,
      room_id: (messages[0] && messages[0].room_id) || '',
    });
    const wakeEvent = event(home, 'wake.spawn', slug, {
      batch_id: batch.batch_id,
      room_ids: [...new Set(messages.map((row) => row.room_id))],
      message_ids: messages.map((row) => row.id),
      adapter_kind: registered.member.adapter_kind,
      lease: leaseResource(slug),
    });
    const result = adapter.run(home, { slug, task });
    closeBatch(home, batch.batch_id, result.ok ? 'closed' : 'failed');
    for (const message of messages) {
      delivery.markReadByMessage(home, {
        room_id: message.room_id,
        msg_id: message.id,
        recipient: slug,
      });
    }
    if (!result.ok) {
      event(home, 'wake.failed', slug, { batch_id: batch.batch_id, code: result.code, message: result.message });
      return result;
    }
    event(home, result.status === 'spawn_failed' || result.status === 'api_failed' ? 'wake.failed' : 'wake.delivered', slug, {
      batch_id: batch.batch_id,
      status: result.status,
      task_file: result.task_file,
      spawned: result.spawned,
      exit: result.exit ?? null,
      http: result.http ?? null,
      previous_event: wakeEvent ? wakeEvent.id : null,
    });
    return ok({ ...result, messages: messages.length, batch_id: batch.batch_id, wake_event_id: wakeEvent ? wakeEvent.id : null, lease: leaseResource(slug) });
  });
}

export function dispatchSync(home, options = {}) {
  const slug = String(options.slug || '').trim();
  const args = [CLI, '--home', homeDir(home), 'wake-exec', slug];
  if (options.force === true) args.push('--force');
  const result = spawnSync(process.execPath, args, {
    cwd: path.dirname(CLI),
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    windowsHide: true,
    timeout: Number(options.timeout_ms ?? 240000),
  });
  try {
    return JSON.parse(String(result.stdout || '{}'));
  } catch {
    return { ok: false, code: 'WAKE_EXEC_FAILED', message: String(result.stderr || result.stdout || 'wake-exec output invalid') };
  }
}

export function dispatchAsync(home, options = {}) {
  const slug = String(options.slug || '').trim();
  if (inflight.has(slug)) return null;
  const args = [CLI, '--home', homeDir(home), 'wake-exec', slug];
  if (options.force === true) args.push('--force');
  const child = spawn(process.execPath, args, {
    cwd: path.dirname(CLI),
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: process.env,
  });
  inflight.add(slug);
  registerWakeChild(home, slug, child.pid, [process.execPath, ...args]);
  const clear = () => { inflight.delete(slug); clearWakeChild(home, slug, child.pid); };
  child.once('exit', clear);
  child.once('error', clear);
  return child;
}

export function tick(home, options = {}) {
  return wrap(() => {
    reconcileBatches(home); // E22：先对账孤儿 batch，再决定派发——否则 open batch 会把该成员锁死一个租期
    const listed = member.list(home);
    if (!listed.ok) return listed;
    const launched = [];
    for (const registered of listed.members) {
      const slug = registered.slug;
      if (!options.force && channelActive(home, slug)) continue;
      if (inflight.has(slug)) continue;
      if (openBatchFor(home, slug)) continue;
      const lease = resource.status(home, { resource: leaseResource(slug) });
      if (lease.ok && lease.held) continue;
      // 熔断闩锁＝停止派发（防监督环空转风暴）；升级开单归值班板（I48）。关键路径越权补丁，Codex 可重构但语义须在。
      const adState = adapter.state(home, { slug });
      if (adState.ok && adState.latched) continue;
      const messages = filterByWakePolicy(registered, slug, pendingMessages(home, slug));
      if (messages.length === 0) continue;
      const child = dispatchAsync(home, { slug, force: true, timeout_ms: options.timeout_ms });
      if (child) launched.push({ slug, pid: child.pid, messages: messages.length });
    }
    return ok({ launched });
  });
}

export const wake = { exec, dispatchSync, dispatchAsync, tick, touchChannel, clearChannel, channelActive, openBatchFor, closeBatch, noteAnsweredExt, reconcileBatches, wakeChildAlive };
export default wake;
