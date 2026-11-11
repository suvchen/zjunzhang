// 中军帐 M2-B：换班看门狗（心跳超龄 -> duty.shift，幂等 + 台账）
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import * as zjz from './core.js';
import { appendEvent } from './events.js';

const LOCK_TIMEOUT_MS = 5000;
const LOCK_POLL_MS = 10;
const ACTION_LOG_MAX_BYTES = 1024 * 1024;
const DEFAULT_MAX_AGE_MS = 30 * 60 * 1000;

class WatchdogError extends Error {
  constructor(code, message) {
    super(message || code);
    this.name = 'WatchdogError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new WatchdogError(code, message);
}

function ok(payload = {}) {
  return { ok: true, ...payload };
}

function guard(fn) {
  try {
    return fn();
  } catch (error) {
    if (error instanceof WatchdogError) {
      return { ok: false, code: error.code, message: error.message };
    }
    return { ok: false, code: 'INTERNAL', message: String(error && error.message ? error.message : error) };
  }
}

function homeDir(home) {
  return path.resolve(home || process.env.ZJZ_HOME || process.cwd());
}

function dataDir(home) {
  return path.join(homeDir(home), 'data');
}

function dutyDir(home) {
  return path.join(dataDir(home), 'duty');
}

function actionLog(home) {
  return path.join(dataDir(home), 'watchdog', 'actions.jsonl');
}

function alertFile(home) {
  return path.join(dataDir(home), 'watchdog', 'ALERT.json');
}

function lockFile(home) {
  return path.join(dataDir(home), 'watchdog', 'watchdog.lock');
}

function epochFile(home) {
  return path.join(dataDir(home), 'watchdog', 'epoch.json');
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

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function nextActionEpoch(home) {
  const file = epochFile(home);
  let current = 0;
  if (fs.existsSync(file)) {
    try {
      current = Number(readJson(file).epoch) || 0;
    } catch {
      fail('CORRUPT_EPOCH', `watchdog epoch 文件损坏：${file}`);
    }
  }
  const next = current + 1;
  atomicJson(file, { epoch: next, updated_at: new Date().toISOString() });
  return next;
}

function appendJsonl(file, record) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  try {
    const size = fs.statSync(file).size;
    if (size > ACTION_LOG_MAX_BYTES) fs.truncateSync(file, 0);
  } catch { /* ignore */ }
  fs.appendFileSync(file, JSON.stringify(record) + '\n', 'utf8');
}

function appendWatchdogEvent(h, record, type, payload) {
  const recorded = appendEvent(h, {
    project: (record && record.project) || 'default',
    type,
    actor: 'watchdog',
    subject: record ? record.slug : null,
    payload,
  });
  return {
    event_id: recorded.ok ? recorded.event.id : null,
    event_error: recorded.ok ? null : recorded.code,
  };
}

function digestRooms(rooms) {
  const keys = Object.keys(rooms || {}).sort();
  const canonical = keys.map((key) => [key, rooms[key]]);
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

function auditContext(now, age, maxAge) {
  const configuredSession = Number.parseInt(process.env.ZJZ_SESSION_ID ?? '0', 10);
  return {
    session_id: Number.isFinite(configuredSession) ? configuredSession : 0,
    windowless: true,
    probe: {
      ok: true,
      checked_at: new Date(now).toISOString(),
      age_ms: age,
      max_age_ms: maxAge,
      source: 'watchdog',
    },
  };
}

function dutyRecords(home) {
  const dir = dutyDir(home);
  if (!fs.existsSync(dir)) return [];
  const records = [];
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith('.json')) continue;
    try {
      records.push(JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')));
    } catch { /* 损坏记录由 duty.get 负责报错，这里跳过 */ }
  }
  return records;
}

function ageMs(record, now) {
  const stamp = record.heartbeat_at || (record.shift_log && record.shift_log.length
    ? record.shift_log[record.shift_log.length - 1].at
    : record.updated_at);
  const parsed = Date.parse(stamp);
  if (!Number.isFinite(parsed)) return null;
  return Math.max(0, now - parsed);
}

function status(home, slug) {
  return guard(() => {
    const h = homeDir(home);
    const got = zjz.duty.get(h, slug);
    if (!got.ok) return got;
    const record = got.duty;
    const now = Date.now();
    const age = ageMs(record, now);
    const cfg = record.watchdog || {};
    const maxAge = Number(cfg.max_age_ms) > 0 ? Number(cfg.max_age_ms) : DEFAULT_MAX_AGE_MS;
    const lastShiftOut = [...(record.shift_log || [])].reverse().find((row) => row && row.action === 'shift_out');
    const lostByShift = Boolean(
      lastShiftOut
      && lastShiftOut.reason === 'heartbeat-timeout'
      && (!record.updated_at || String(record.updated_at) <= String(lastShiftOut.at)),
    );
    const timedOut = lostByShift || (Boolean(cfg.enabled) && age !== null && age > maxAge);
    const presence = timedOut
      ? 'LOST'
      : record.mode === 'off'
        ? 'OFF'
        : record.mode === 'listen' && Boolean(cfg.enabled)
          ? 'LISTENING'
          : 'ONLINE';
    return ok({
      duty: record,
      presence,
      listening: record.mode === 'listen' && !timedOut,
      last_seen: record.heartbeat_at || record.updated_at || null,
      last_wait_end: record.last_wait_end || record.wait_ended_at || null,
      age_ms: age,
      max_age_ms: maxAge,
      stale: timedOut,
      enabled: Boolean(cfg.enabled),
    });
  });
}

function tick(home, options = {}) {
  return guard(() => {
    const h = homeDir(home);
    const now = Number.isFinite(Number(options.now)) ? Number(options.now) : Date.now();
    return withLock(lockFile(h), () => {
      const only = options.slug ? String(options.slug) : null;
      const candidates = dutyRecords(h).filter((record) => !only || record.slug === only);
      const shifted = [];
      const alerts = [];
      let checked = 0;

      for (const record of candidates) {
        if (!record || record.mode === 'off') continue;
        const cfg = record.watchdog || {};
        if (!cfg.enabled) continue;
        checked += 1;
        const age = ageMs(record, now);
        const maxAge = Number(cfg.max_age_ms) > 0 ? Number(cfg.max_age_ms) : DEFAULT_MAX_AGE_MS;
        if (age === null || age <= maxAge) continue;

        if (!cfg.successor) {
          const epoch = nextActionEpoch(h);
          const alert = { at: new Date(now).toISOString(), epoch, action: 'alert', from: record.slug, reason: 'no-successor', age_ms: age, checkpoint_before: (record.checkpoint && record.checkpoint.rooms) || {}, ...auditContext(now, age, maxAge) };
          Object.assign(alert, appendWatchdogEvent(h, record, 'duty.watchdog_alert', {
            from: record.slug,
            reason: 'no-successor',
            epoch,
            age_ms: age,
            checkpoint_before: alert.checkpoint_before,
          }));
          atomicJson(alertFile(h), alert);
          appendJsonl(actionLog(h), alert);
          alerts.push(alert);
          continue;
        }

        const successor = zjz.identity.load(h, cfg.successor);
        if (!successor || successor.ok === false) {
          const epoch = nextActionEpoch(h);
          const alert = { at: new Date(now).toISOString(), epoch, action: 'alert', from: record.slug, to: cfg.successor, reason: 'bad-successor', age_ms: age, checkpoint_before: (record.checkpoint && record.checkpoint.rooms) || {}, ...auditContext(now, age, maxAge) };
          Object.assign(alert, appendWatchdogEvent(h, record, 'duty.watchdog_alert', {
            from: record.slug,
            to: cfg.successor,
            reason: 'bad-successor',
            epoch,
            age_ms: age,
            checkpoint_before: alert.checkpoint_before,
          }));
          atomicJson(alertFile(h), alert);
          appendJsonl(actionLog(h), alert);
          alerts.push(alert);
          continue;
        }

        const fresh = zjz.duty.get(h, record.slug);
        if (!fresh.ok || fresh.duty.mode === 'off' || fresh.duty.heartbeat_at !== record.heartbeat_at) {
          continue;
        }

        const result = zjz.duty.shift(h, record.slug, { to: cfg.successor, reason: 'heartbeat-timeout' });
        if (!result.ok) {
          const epoch = nextActionEpoch(h);
          const alert = { at: new Date(now).toISOString(), epoch, action: 'alert', from: record.slug, to: cfg.successor, reason: result.code || 'shift-failed', age_ms: age, checkpoint_before: (record.checkpoint && record.checkpoint.rooms) || {}, ...auditContext(now, age, maxAge) };
          Object.assign(alert, appendWatchdogEvent(h, record, 'duty.watchdog_alert', {
            from: record.slug,
            to: cfg.successor,
            reason: result.code || 'shift-failed',
            epoch,
            age_ms: age,
            checkpoint_before: alert.checkpoint_before,
          }));
          atomicJson(alertFile(h), alert);
          appendJsonl(actionLog(h), alert);
          alerts.push(alert);
          continue;
        }

        const epoch = nextActionEpoch(h);
        const action = {
          at: new Date(now).toISOString(),
          epoch,
          action: 'shift',
          from: record.slug,
          to: cfg.successor,
          reason: 'heartbeat-timeout',
          age_ms: age,
          max_age_ms: maxAge,
          checkpoint_before: (record.checkpoint && record.checkpoint.rooms) || {},
          checkpoint_after: result.checkpoint.rooms,
          checkpoint_digest: digestRooms(result.checkpoint.rooms),
          checkpoint: result.checkpoint.rooms,
          ...auditContext(now, age, maxAge),
        };
        Object.assign(action, appendWatchdogEvent(h, record, 'duty.watchdog_shift', {
          from: record.slug,
          to: cfg.successor,
          reason: 'heartbeat-timeout',
          epoch,
          age_ms: age,
          duty_event_id: result.event ? result.event.id : null,
          duty_event_error: result.event_error || null,
          checkpoint_digest: action.checkpoint_digest,
        }));
        appendJsonl(actionLog(h), action);
        shifted.push({ from: record.slug, to: cfg.successor, checkpoint: result.checkpoint, age_ms: age });
      }

      return ok({ checked, shifted, alerts });
    });
  });
}

export const watchdog = {
  tick,
  status,
  actionLog,
  alertFile,
};



