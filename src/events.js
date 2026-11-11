// 中军帐 M3：项目级 append-only 事件流（seq 连续 + 哈希链）
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const LOCK_TIMEOUT_MS = 5000;
const LOCK_POLL_MS = 10;

class EventError extends Error {
  constructor(code, message) {
    super(message || code);
    this.name = 'EventError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new EventError(code, message);
}

function ok(payload = {}) {
  return { ok: true, ...payload };
}

function homeDir(home) {
  return path.resolve(home || process.env.ZJZ_HOME || process.cwd());
}

function eventsDir(home) {
  return path.join(homeDir(home), 'data', 'events');
}

function projectHash(project) {
  return createHash('sha256').update(String(project)).digest('hex').slice(0, 16);
}

function fileFor(home, project) {
  return path.join(eventsDir(home), `${projectHash(project)}.jsonl`);
}

function metaFile(home, project) {
  return path.join(eventsDir(home), `${projectHash(project)}.meta.json`);
}

function lockFile(home, project) {
  return path.join(eventsDir(home), `${projectHash(project)}.lock`);
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

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = stable(value[key]);
    return out;
  }
  return value;
}

function canonical(record) {
  return [record.seq, record.at, record.project, record.type, record.actor, record.subject === undefined ? null : record.subject, JSON.stringify(stable(record.payload || {}))].join('|');
}

function digest(prevHash, record) {
  return createHash('sha256').update(`${prevHash}|${canonical(record)}`).digest('hex');
}

function readMeta(home, project) {
  const file = metaFile(home, project);
  if (!fs.existsSync(file)) return { project, last_seq: 0, last_hash: 'genesis' };
  const meta = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (meta.project !== project) fail('EVENT_PROJECT_MISMATCH', '事件流 meta 项目不匹配');
  return meta;
}

function append(home, options = {}) {
  try {
    const h = homeDir(home);
    const project = requireString(options.project, 'project');
    const type = requireString(options.type, 'type');
    const actor = requireString(options.actor, 'actor');
    const subject = options.subject === undefined || options.subject === null ? null : String(options.subject);
    const payload = options.payload && typeof options.payload === 'object' && !Array.isArray(options.payload) ? options.payload : {};
    return withLock(lockFile(h, project), () => {
      const meta = readMeta(h, project);
      const existing = readEvents(h, project);
      if (existing.length > 0) {
        const tail = existing[existing.length - 1];
        if (Number(tail.seq) >= Number(meta.last_seq)) {
          meta.last_seq = Number(tail.seq);
          meta.last_hash = tail.hash;
        }
      }
      const seq = Number(meta.last_seq) + 1;
      const at = new Date().toISOString();
      const record = {
        id: randomUUID(),
        seq,
        at,
        project,
        type,
        actor,
        subject,
        payload,
        prev_hash: meta.last_hash,
      };
      record.hash = digest(record.prev_hash, record);
      fs.mkdirSync(eventsDir(h), { recursive: true });
      fs.appendFileSync(fileFor(h, project), JSON.stringify(record) + '\n', 'utf8');
      atomicJson(metaFile(h, project), {
        project,
        last_seq: seq,
        last_hash: record.hash,
        updated_at: at,
      });
      return ok({ event: record });
    });
  } catch (error) {
    if (error instanceof EventError) {
      return { ok: false, code: error.code, message: error.message };
    }
    return { ok: false, code: 'EVENT_APPEND_FAILED', message: String(error && error.message ? error.message : error) };
  }
}

function requireString(value, name) {
  if (typeof value !== 'string' || value.trim() === '') fail('BAD_INPUT', `${name} 必须是非空字符串`);
  return value.trim();
}

function readEvents(home, project) {
  const file = fileFor(home, project);
  if (!fs.existsSync(file)) return [];
  const events = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    events.push(JSON.parse(line));
  }
  return events;
}

function list(home, options = {}) {
  try {
    const h = homeDir(home);
    const project = requireString(options.project, 'project');
    const after = options.after === undefined ? 0 : Number(options.after);
    const limit = options.limit === undefined ? 1000 : Number(options.limit);
    if (!Number.isFinite(after) || after < 0) fail('BAD_INPUT', 'after 必须是非负数字');
    if (!Number.isFinite(limit) || limit <= 0) fail('BAD_INPUT', 'limit 必须是正数');
    const events = readEvents(h, project)
      .filter((event) => event.project === project && event.seq > after)
      .slice(0, limit);
    return ok({ project, events, last_seq: events.length > 0 ? events[events.length - 1].seq : after });
  } catch (error) {
    return error instanceof EventError
      ? { ok: false, code: error.code, message: error.message }
      : { ok: false, code: 'INTERNAL', message: String(error && error.message ? error.message : error) };
  }
}

function verify(home, project) {
  try {
    const h = homeDir(home);
    const name = requireString(project, 'project');
    const events = readEvents(h, name);
    let prev = 'genesis';
    for (const record of events) {
      if (record.project !== name) return ok({ project: name, intact: false, broken_at: record.seq, reason: 'project-mismatch', events: events.length });
      if (record.prev_hash !== prev) return ok({ project: name, intact: false, broken_at: record.seq, reason: 'prev-hash', events: events.length });
      if (digest(prev, record) !== record.hash) return ok({ project: name, intact: false, broken_at: record.seq, reason: 'hash', events: events.length });
      prev = record.hash;
    }
    return ok({ project: name, intact: true, events: events.length, last_seq: events.length > 0 ? events[events.length - 1].seq : 0, last_hash: prev });
  } catch (error) {
    return error instanceof EventError
      ? { ok: false, code: error.code, message: error.message }
      : { ok: false, code: 'INTERNAL', message: String(error && error.message ? error.message : error) };
  }
}

function projects(home) {
  try {
    const h = homeDir(home);
    const dir = eventsDir(h);
    if (!fs.existsSync(dir)) return ok({ projects: [] });
    const result = [];
    for (const name of fs.readdirSync(dir)) {
      if (!name.endsWith('.meta.json')) continue;
      try {
        const meta = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
        result.push({ project: meta.project, file: `${projectHash(meta.project)}.jsonl`, last_seq: meta.last_seq, last_hash: meta.last_hash, updated_at: meta.updated_at });
      } catch { /* skip corrupt meta */ }
    }
    return ok({ projects: result });
  } catch (error) {
    return { ok: false, code: 'INTERNAL', message: String(error && error.message ? error.message : error) };
  }
}

export const event = {
  append,
  list,
  verify,
  projects,
  file: fileFor,
};

export { append as appendEvent };

