// 中军帐 M2-B：常驻监听（租约单例 + 跨进程事件广播）
// 原则：监听只广播“有变化”，不推进游标、不消费消息；消息真相仍是 members.json + msg.read。
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import process from 'node:process';

const DEFAULT_TTL_MS = 15000;
const DEFAULT_HEARTBEAT_MS = 5000;
const LOCK_TIMEOUT_MS = 5000;
const LOCK_POLL_MS = 10;
const EVENT_LOG_MAX_BYTES = 1024 * 1024;

class ListenError extends Error {
  constructor(code, message, extra = {}) {
    super(message || code);
    this.name = 'ListenError';
    this.code = code;
    this.extra = extra;
  }
}

function fail(code, message, extra) {
  throw new ListenError(code, message, extra);
}

function ok(payload = {}) {
  return { ok: true, ...payload };
}

function guard(fn) {
  try {
    return fn();
  } catch (error) {
    if (error instanceof ListenError) {
      return { ok: false, code: error.code, message: error.message, ...error.extra };
    }
    return { ok: false, code: 'INTERNAL', message: String(error && error.message ? error.message : error) };
  }
}

function homeDir(home) {
  return path.resolve(home || process.env.ZJZ_HOME || process.cwd());
}

function listenDir(home) {
  return path.join(homeDir(home), 'data', 'listen');
}

function leaseFile(home) {
  return path.join(listenDir(home), 'lease.json');
}

function epochFile(home) {
  return path.join(listenDir(home), 'epoch.json');
}

function eventFile(home) {
  return path.join(listenDir(home), 'events.jsonl');
}

function lockFile(home) {
  return path.join(listenDir(home), 'lease.lock');
}

function atomicJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, file);
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.max(1, ms));
}

function withLock(lockPath, fn, timeoutMs = LOCK_TIMEOUT_MS) {
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  const started = Date.now();
  let fd = null;
  for (;;) {
    try {
      fd = fs.openSync(lockPath, 'wx');
      break;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if (Date.now() - started >= timeoutMs) fail('LOCK_TIMEOUT', `获取锁超时：${lockPath}`);
      sleepSync(LOCK_POLL_MS);
    }
  }
  try {
    return fn();
  } finally {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch { /* ignore */ }
    }
    try { fs.unlinkSync(lockPath); } catch { /* ignore */ }
  }
}

function readLease(home) {
  const file = leaseFile(home);
  if (!fs.existsSync(file)) return null;
  try {
    const lease = readJson(file);
    if (!lease || typeof lease !== 'object' || !Number.isInteger(Number(lease.pid)) || Number(lease.pid) <= 0 || !Number.isInteger(Number(lease.epoch)) || Number(lease.epoch) <= 0) {
      return { corrupt: true };
    }
    return lease;
  } catch {
    return { corrupt: true };
  }
}

function leaseFresh(lease, now = Date.now()) {
  if (!lease || !lease.heartbeat_at) return false;
  const hb = Date.parse(lease.heartbeat_at);
  if (!Number.isFinite(hb)) return false;
  const ttl = Number(lease.ttl_ms) > 0 ? Number(lease.ttl_ms) : DEFAULT_TTL_MS;
  return now - hb < ttl;
}

function nextEpoch(home, floor = 0) {
  const file = epochFile(home);
  let current = Number(floor) > 0 ? Number(floor) : 0;
  if (fs.existsSync(file)) {
    try {
      current = Number(readJson(file).epoch) || 0;
    } catch {
      fail('CORRUPT_EPOCH', `epoch 文件损坏：${file}`);
    }
  }
  const next = current + 1;
  atomicJson(file, { epoch: next, updated_at: new Date().toISOString() });
  return next;
}

function pipeName(home) {
  const digest = createHash('sha256').update(path.resolve(home)).digest('hex').slice(0, 16);
  return `\\\\.\\pipe\\zjz-listen-${digest}`;
}

function acquire(home, options = {}) {
  return guard(() => {
    const h = homeDir(home);
    const pid = Number(options.pid);
    if (!Number.isInteger(pid) || pid <= 0) fail('BAD_INPUT', 'pid 必须是正整数');
    const ttl = Number(options.ttl_ms) > 0 ? Number(options.ttl_ms) : DEFAULT_TTL_MS;
    return withLock(lockFile(h), () => {
      const now = Date.now();
      const lease = readLease(h);
      if (lease && lease.pid === pid) {
        const renewed = {
          ...lease,
          heartbeat_at: new Date(now).toISOString(),
          ttl_ms: ttl,
          pipe: options.pipe_name || lease.pipe || pipeName(h),
        };
        atomicJson(leaseFile(h), renewed);
        return ok({ epoch: renewed.epoch, lease: renewed, renewed: true });
      }
      if (lease && leaseFresh(lease, now)) {
        return { ok: false, code: 'LEASE_HELD', message: `租约由 pid ${lease.pid} 持有`, lease };
      }
      const epoch = nextEpoch(h, lease && !lease.corrupt ? lease.epoch : 0);
      const record = {
        pid,
        epoch,
        started_at: new Date(now).toISOString(),
        heartbeat_at: new Date(now).toISOString(),
        ttl_ms: ttl,
        pipe: options.pipe_name || pipeName(h),
      };
      atomicJson(leaseFile(h), record);
      return ok({ epoch, lease: record, renewed: false, takeover: Boolean(lease) });
    });
  });
}

function release(home, options = {}) {
  return guard(() => {
    const h = homeDir(home);
    const pid = Number(options.pid);
    const epoch = Number(options.epoch);
    return withLock(lockFile(h), () => {
      const lease = readLease(h);
      if (!lease) return ok({ released: false });
      if (lease.pid !== pid || lease.epoch !== epoch) {
        return { ok: false, code: 'STALE_EPOCH', message: '租约已易主，拒绝释放', lease };
      }
      fs.unlinkSync(leaseFile(h));
      return ok({ released: true, epoch });
    });
  });
}

function status(home) {
  return guard(() => {
    const h = homeDir(home);
    const lease = readLease(h);
    if (!lease) return ok({ running: false, lease: null, epoch: 0 });
    if (lease.corrupt) return ok({ running: false, lease: null, epoch: 0, corrupt: true });
    return ok({ running: leaseFresh(lease), lease, epoch: lease.epoch });
  });
}

function appendEvent(home, event) {
  const file = eventFile(home);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  try {
    const size = fs.statSync(file).size;
    if (size > EVENT_LOG_MAX_BYTES) fs.truncateSync(file, 0);
  } catch { /* ignore */ }
  fs.appendFileSync(file, JSON.stringify(event) + '\n', 'utf8');
}

const pipeServers = new Map();

function ensurePipe(home, lease) {
  const name = lease.pipe || pipeName(home);
  const existing = pipeServers.get(name);
  if (existing) return existing;
  const server = net.createServer((socket) => {
    socket.on('error', () => { /* ignore */ });
    if (!server.zjzSockets) server.zjzSockets = new Set();
    server.zjzSockets.add(socket);
    socket.on('close', () => server.zjzSockets.delete(socket));
    socket.write(JSON.stringify({ hello: true, epoch: lease.epoch }) + '\n');
  });
  server.on('error', () => {
    pipeServers.delete(name);
  });
  try {
    server.listen(name);
  } catch {
    return null;
  }
  pipeServers.set(name, server);
  return server;
}

function broadcast(home, options = {}) {
  return guard(() => {
    const h = homeDir(home);
    const pid = Number(options.pid);
    const epoch = Number(options.epoch);
    return withLock(lockFile(h), () => {
      const lease = readLease(h);
      if (!lease || lease.epoch !== epoch || lease.pid !== pid || !leaseFresh(lease)) {
        return { ok: false, code: 'STALE_EPOCH', message: '广播 epoch 已过期', lease };
      }
      const now = new Date().toISOString();
      atomicJson(leaseFile(h), { ...lease, heartbeat_at: now });
      const event = { ts: now, epoch, pid, reason: options.reason || 'rooms-changed' };
      appendEvent(h, event);
      const server = pipeServers.get(lease.pipe || pipeName(h));
      let delivered = 0;
      if (server && server.zjzSockets) {
        const line = JSON.stringify(event) + '\n';
        for (const socket of server.zjzSockets) {
          try {
            socket.write(line);
            delivered += 1;
          } catch { /* ignore */ }
        }
      }
      return ok({ delivered, event });
    });
  });
}

const registry = new Map();

function start(home, options = {}) {
  return guard(() => {
    const h = homeDir(home);
    const existing = registry.get(h);
    if (existing) {
      return ok({ pid: process.pid, epoch: existing.epoch, watching: existing.watchers.length, reused: true });
    }
    const ttl = Number(options.ttl_ms) > 0 ? Number(options.ttl_ms) : DEFAULT_TTL_MS;
    const heartbeatMs = Number(options.heartbeat_ms) > 0 ? Number(options.heartbeat_ms) : DEFAULT_HEARTBEAT_MS;
    const acq = acquire(h, { pid: process.pid, ttl_ms: ttl, pipe_name: options.pipe_name });
    if (!acq.ok) return acq;

    const entry = { epoch: acq.epoch, watchers: [], pending: null, heartbeat: null, started_at: Date.now() };
    const fire = () => {
      if (entry.pending) return;
      entry.pending = setTimeout(() => {
        entry.pending = null;
        broadcast(h, { pid: process.pid, epoch: entry.epoch, reason: 'fs-watch' });
      }, 20);
    };
    const rooms = path.join(h, 'data', 'rooms');
    fs.mkdirSync(rooms, { recursive: true });
    try {
      entry.watchers.push(fs.watch(rooms, { recursive: true }, fire));
    } catch {
      try {
        entry.watchers.push(fs.watch(rooms, fire));
      } catch { /* 无 watcher 时仍有轮询兜底 */ }
    }
    entry.heartbeat = setInterval(() => {
      acquire(h, { pid: process.pid, ttl_ms: ttl });
    }, heartbeatMs);
    registry.set(h, entry);
    const lease = readLease(h);
    ensurePipe(h, lease);
    return ok({ pid: process.pid, epoch: entry.epoch, watching: entry.watchers.length, pipe: lease.pipe });
  });
}

function stop(home, options = {}) {
  return guard(() => {
    const h = homeDir(home);
    const entry = registry.get(h);
    if (entry) {
      if (entry.pending) clearTimeout(entry.pending);
      if (entry.heartbeat) clearInterval(entry.heartbeat);
      for (const watcher of entry.watchers) {
        try { watcher.close(); } catch { /* ignore */ }
      }
      registry.delete(h);
    }
    let lease = readLease(h);
    if (!lease) return ok({ stopped: true, released: false });
    if (lease.corrupt) {
      fs.unlinkSync(leaseFile(h));
      return ok({ stopped: true, released: true, corrupt: true });
    }
    if (lease.pid !== process.pid) {
      if (!options.force) {
        return ok({ stopped: Boolean(entry), released: false, note: '租约属于其它进程；传 force 才终止' });
      }
      if (!leaseFresh(lease)) {
        return ok({ stopped: false, released: false, note: '租约已过期，无需终止' });
      }
      try {
        process.kill(lease.pid, 'SIGTERM');
      } catch { /* 进程可能已退出 */ }
      return withLock(lockFile(h), () => {
        const current = readLease(h);
        if (current && !current.corrupt && current.pid === lease.pid && current.epoch === lease.epoch) {
          fs.unlinkSync(leaseFile(h));
          return ok({ stopped: true, released: true, killed: true, pid: lease.pid });
        }
        return ok({ stopped: true, released: false, note: '租约已被替换' });
      });
    }
    const rel = release(h, { pid: lease.pid, epoch: lease.epoch });
    const server = pipeServers.get(lease.pipe || pipeName(h));
    if (server) {
      try { server.close(); } catch { /* ignore */ }
      pipeServers.delete(lease.pipe || pipeName(h));
    }
    return ok({ stopped: true, released: rel.ok && rel.released });
  });
}

function waitForChange(home, timeoutMs = 1000) {
  const h = homeDir(home);
  const ms = Math.max(1, Number(timeoutMs) || 1000);
  return new Promise((resolve) => {
    let finished = false;
    let socket = null;
    let watcher = null;
    let timer = null;
    const finish = (changed, attached) => {
      if (finished) return;
      finished = true;
      if (timer) clearTimeout(timer);
      if (socket) {
        try { socket.destroy(); } catch { /* ignore */ }
      }
      if (watcher) {
        try { watcher.close(); } catch { /* ignore */ }
      }
      resolve({ ok: true, changed, attached });
    };
    timer = setTimeout(() => finish(false, Boolean(socket)), ms);

    const lease = readLease(h);
    if (!lease || lease.corrupt || !leaseFresh(lease)) return;

    try {
      watcher = fs.watch(eventFile(h), () => finish(true, false));
    } catch { /* 事件文件尚不存在，靠管道 */ }

    try {
      socket = net.connect(lease.pipe);
      socket.setEncoding('utf8');
      let buffer = '';
      socket.on('data', (chunk) => {
        buffer += chunk;
        let index = buffer.indexOf('\n');
        while (index >= 0) {
          const line = buffer.slice(0, index);
          buffer = buffer.slice(index + 1);
          try {
            const event = JSON.parse(line);
            if (!event.hello) finish(true, true);
          } catch { /* ignore */ }
          index = buffer.indexOf('\n');
        }
      });
      socket.on('error', () => { /* 管道不可用时靠定时器/事件文件 */ });
    } catch {
      socket = null;
    }
  });
}

export const listen = {
  acquire,
  release,
  status,
  broadcast,
  start,
  stop,
  waitForChange,
  pipeName,
  leaseFile,
};




