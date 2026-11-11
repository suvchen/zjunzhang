// T-007 I32：依赖链探活、静默拉起、拉起留痕。探针只读状态，不碰业务信号。
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { appendEvent } from './events.js';

class DependencyError extends Error {
  constructor(code, message) {
    super(message || code);
    this.name = 'DependencyError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new DependencyError(code, message);
}

function ok(payload = {}) {
  return { ok: true, ...payload };
}

function wrap(fn) {
  try {
    return fn();
  } catch (error) {
    return error instanceof DependencyError
      ? { ok: false, code: error.code, message: error.message }
      : { ok: false, code: 'INTERNAL', message: String(error && error.message ? error.message : error) };
  }
}

function homeDir(home) {
  return path.resolve(home || process.env.ZJZ_HOME || process.cwd());
}

function actionLog(home) {
  return path.join(homeDir(home), 'data', 'dependencies', 'actions.jsonl');
}

function requireString(value, name) {
  if (typeof value !== 'string' || value.trim() === '') fail('BAD_INPUT', `${name} 必须是非空字符串`);
  return value.trim();
}

function readProbe(file) {
  try {
    return fs.readFileSync(file, 'utf8').trim();
  } catch {
    return null;
  }
}

function appendJsonl(file, record) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify(record) + '\n', 'utf8');
}

export function check(home, options = {}) {
  return wrap(() => {
    if (!options || typeof options !== 'object' || options.name === undefined || options.probe_file === undefined || options.expect === undefined) {
      fail('BAD_INPUT', '用法：zjz dependency check --name X [--endpoint URL] --probe-file F --expect V [--revive-file F]');
    }
    const name = requireString(options.name, 'name');
    const probeFile = path.resolve(requireString(options.probe_file, 'probe_file'));
    const expected = requireString(options.expect, 'expect');
    const reviveFile = options.revive_file === undefined ? null : path.resolve(requireString(options.revive_file, 'revive_file'));
    const timeoutMs = options.timeout_ms === undefined ? 30000 : Number(options.timeout_ms);
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) fail('BAD_INPUT', 'timeout_ms 必须是正数');
    const startedAt = new Date().toISOString();
    const before = readProbe(probeFile);
    const base = {
      name,
      probe_file: probeFile,
      expected,
      session_id: 0,
      windowless: true,
      started_at: startedAt,
    };
    if (before === expected) {
      const record = { ...base, action: 'probe', ok: true, revived: false, before, after: before, at: new Date().toISOString() };
      appendJsonl(actionLog(home), record);
      return ok({ ...record, probe: { ok: true, before, after: before } });
    }
    if (!reviveFile || !fs.existsSync(reviveFile)) fail('DEPENDENCY_REVIVE_UNAVAILABLE', '依赖失败且未提供可用恢复脚本');
    const launched = spawnSync(process.execPath, [reviveFile, probeFile], {
      cwd: path.dirname(reviveFile),
      env: { ...process.env, ZJZ_SESSION_ID: '0' },
      windowsHide: true,
      stdio: 'ignore',
      timeout: timeoutMs,
    });
    const after = readProbe(probeFile);
    const revived = after === expected;
    const record = {
      ...base,
      action: revived ? 'revive' : 'revive_failed',
      ok: revived,
      revived,
      before,
      after,
      exit_status: launched.status,
      launch_error: launched.error ? String(launched.error.message || launched.error) : null,
      at: new Date().toISOString(),
    };
    appendJsonl(actionLog(home), record);
    if (!revived) fail('DEPENDENCY_REVIVE_FAILED', `恢复后探针仍为 ${after === null ? '<unreadable>' : after}`);
    const event = appendEvent(home, {
      project: 'dependencies',
      type: 'dependency.revive',
      actor: 'dependency',
      subject: name,
      payload: {
        probe_file: probeFile,
        expected,
        before,
        after,
        session_id: 0,
        windowless: true,
        exit_status: launched.status,
      },
    });
    return ok({
      ...record,
      probe: { ok: true, before, after },
      event: event.ok ? event.event : null,
      event_error: event.ok ? null : event.code,
    });
  });
}

export const dependency = { check };
export default dependency;
