// T-007 I35：共享资源租约与排队。claim 以文件锁串行，活动租约单活。
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { createHash } from 'node:crypto';

class ResourceError extends Error {
  constructor(code, message) {
    super(message || code);
    this.name = 'ResourceError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new ResourceError(code, message);
}

function ok(payload = {}) {
  return { ok: true, ...payload };
}

function wrap(fn) {
  try {
    return fn();
  } catch (error) {
    return error instanceof ResourceError
      ? { ...error.extra, ok: false, code: error.code, message: error.message }
      : { ok: false, code: 'INTERNAL', message: String(error && error.message ? error.message : error) };
  }
}

function homeDir(home) {
  return path.resolve(home || process.env.ZJZ_HOME || process.cwd());
}

function resourcesDir(home) {
  return path.join(homeDir(home), 'data', 'resources');
}

function keyOf(resource) {
  return createHash('sha256').update(String(resource)).digest('hex').slice(0, 24);
}

function recordFile(home, resource) {
  return path.join(resourcesDir(home), `${keyOf(resource)}.json`);
}

function lockFile(home) {
  return path.join(resourcesDir(home), 'resource.lock');
}

function requireString(value, name) {
  if (typeof value !== 'string' || value.trim() === '') fail('BAD_INPUT', `${name} 必须是非空字符串`);
  return value.trim();
}

function readRecord(home, resource) {
  try {
    return JSON.parse(fs.readFileSync(recordFile(home, resource), 'utf8'));
  } catch {
    return null;
  }
}

function atomicJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, file);
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.max(1, ms));
}

function withLock(fn, timeoutMs = 5000) {
  const file = lockFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const started = Date.now();
  let fd = null;
  for (;;) {
    try {
      fd = fs.openSync(file, 'wx');
      break;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if (Date.now() - started >= timeoutMs) fail('LOCK_TIMEOUT', '获取资源锁超时');
      sleepSync(10);
    }
  }
  try {
    return fn();
  } finally {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch { /* ignore */ }
    }
    try { fs.unlinkSync(file); } catch { /* ignore */ }
  }
}

export function claim(home, options = {}) {
  return wrap(() => {
    const resource = requireString(options.resource, 'resource');
    const slug = requireString(options.slug, 'slug');
    const ttlMs = Number(options.ttl_ms);
    if (!Number.isFinite(ttlMs) || ttlMs <= 0) fail('BAD_INPUT', 'ttl_ms 必须是正数');
    return withLock(() => {
      const now = Date.now();
      const existing = readRecord(home, resource);
      if (existing && Date.parse(existing.expires_at) > now) {
        const error = new ResourceError('RESOURCE_HELD', `资源由 ${existing.holder} 持有`);
        error.extra = {
          resource,
          holder: existing.holder,
          queue_position: 1,
          hold_remaining_ms: Date.parse(existing.expires_at) - now,
          claim_seq: existing.claim_seq,
        };
        throw error;
      }
      const record = {
        resource,
        holder: slug,
        claim_seq: (Number(existing && existing.claim_seq) || 0) + 1,
        epoch: (Number(existing && existing.epoch) || 0) + 1,
        ttl_ms: ttlMs,
        claimed_at: new Date(now).toISOString(),
        expires_at: new Date(now + ttlMs).toISOString(),
      };
      atomicJson(recordFile(home, resource), record);
      return ok({ ...record, hold_remaining_ms: ttlMs, queue_position: 0 });
    });
  });
}

export function status(home, options = {}) {
  return wrap(() => {
    const resource = requireString(options.resource, 'resource');
    const record = readRecord(home, resource);
    const now = Date.now();
    const held = Boolean(record && Date.parse(record.expires_at) > now);
    return ok({
      resource,
      held,
      holder: held ? record.holder : null,
      hold_remaining_ms: held ? Date.parse(record.expires_at) - now : 0,
      record: held ? record : null,
    });
  });
}

export function release(home, options = {}) {
  return wrap(() => {
    const resource = requireString(options.resource, 'resource');
    const slug = requireString(options.slug, 'slug');
    return withLock(() => {
      const record = readRecord(home, resource);
      if (!record || Date.parse(record.expires_at) <= Date.now()) return ok({ resource, released: false });
      if (record.holder !== slug) fail('NOT_HOLDER', `资源由 ${record.holder} 持有`);
      atomicJson(recordFile(home, resource), { ...record, released_at: new Date().toISOString(), expires_at: new Date(0).toISOString() });
      return ok({ resource, released: true, holder: slug });
    });
  });
}

export function list(home) {
  return wrap(() => {
    const dir = resourcesDir(home);
    const resources = [];
    if (fs.existsSync(dir)) {
      for (const name of fs.readdirSync(dir)) {
        if (!name.endsWith('.json')) continue;
        try {
          const record = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
          if (record && record.resource) {
            const current = status(home, { resource: record.resource });
            resources.push(current.ok ? current : record);
          }
        } catch { /* skip corrupt */ }
      }
    }
    return ok({ resources });
  });
}

export const resource = { claim, status, release, list };
export default resource;
