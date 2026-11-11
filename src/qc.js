// 中军帐 M3：质检台账（四栏 / 证据留档 / 机器判定 / 人工终判）
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { identity } from './core.js';
import { appendEvent } from './events.js';

const LOCK_TIMEOUT_MS = 5000;
const LOCK_POLL_MS = 10;
const ROLES = ['baseline', 'candidate', 'fixed', 'bad', 'request', 'prompt', 'ref', 'other'];
const MACHINE_RESULTS = ['pass', 'fail', 'insufficient'];
const HUMAN_VERDICTS = ['pass', 'fail', 'needs_work'];
const CONCLUSIONS = ['baseline', 'candidate', 'rejected', 'pending'];

class QcError extends Error {
  constructor(code, message, extra = {}) {
    super(message || code);
    this.name = 'QcError';
    this.code = code;
    this.extra = extra;
  }
}

function fail(code, message, extra) {
  throw new QcError(code, message, extra);
}

function ok(payload = {}) {
  return { ok: true, ...payload };
}

function guard(fn) {
  try {
    return fn();
  } catch (error) {
    if (error instanceof QcError) {
      return { ok: false, code: error.code, message: error.message, ...error.extra };
    }
    return { ok: false, code: 'INTERNAL', message: String(error && error.message ? error.message : error) };
  }
}

function requireString(value, name) {
  if (typeof value !== 'string' || value.trim() === '') fail('BAD_INPUT', `${name} 必须是非空字符串`);
  return value.trim();
}

function homeDir(home) {
  return path.resolve(home || process.env.ZJZ_HOME || process.cwd());
}

function casesDir(home) {
  return path.join(homeDir(home), 'data', 'qc', 'cases');
}

function caseFile(home, caseId) {
  return path.join(casesDir(home), `${requireString(caseId, 'case_id')}.json`);
}

function lockFile(home, caseId) {
  return `${caseFile(home, caseId)}.lock`;
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

function readCase(home, caseId) {
  const file = caseFile(home, caseId);
  if (!fs.existsSync(file)) fail('NOT_FOUND', `案例不存在：${caseId}`);
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    fail('CORRUPT_QC_CASE', `案例文件损坏：${file}`);
  }
}

function writeCase(home, caseRecord) {
  atomicJson(caseFile(home, caseRecord.case_id), caseRecord);
}

function hashFile(file) {
  const fd = fs.openSync(file, 'r');
  const hash = createHash('sha256');
  const buffer = Buffer.alloc(1024 * 1024);
  let bytes = 0;
  try {
    for (;;) {
      const read = fs.readSync(fd, buffer, 0, buffer.length, bytes);
      if (read <= 0) break;
      hash.update(buffer.subarray(0, read));
      bytes += read;
    }
  } finally {
    fs.closeSync(fd);
  }
  return { sha256: hash.digest('hex'), bytes };
}

function actorFor(home, slug) {
  const actor = identity.load(home, slug);
  if (!actor || actor.ok === false) fail('NOT_FOUND', actor && actor.message ? actor.message : 'identity 不存在');
  return actor;
}

function recordEvent(home, caseRecord, type, actor, payload) {
  const result = appendEvent(home, {
    project: caseRecord.project,
    type,
    actor,
    subject: caseRecord.case_id,
    payload,
  });
  return { event: result.ok ? result.event : null, event_error: result.ok ? null : result.code };
}

function aggregate(caseRecord) {
  const latest = {};
  for (const check of caseRecord.machine_checks || []) latest[check.gate] = check.result;
  let machine = 'pass';
  let missing = false;
  for (const gate of caseRecord.gates || []) {
    if (!latest[gate]) {
      missing = true;
      continue;
    }
    if (latest[gate] === 'fail') machine = 'fail';
    else if (latest[gate] === 'insufficient' && machine !== 'fail') machine = 'insufficient';
  }
  if (missing && machine !== 'fail') machine = 'insufficient';
  return { machine, human: caseRecord.human_verdict ? caseRecord.human_verdict.verdict : null, gates: latest };
}

function openCase(home, slug, options = {}) {
  return guard(() => {
    const h = homeDir(home);
    const actor = actorFor(h, slug);
    const project = requireString(options.project, 'project');
    const title = requireString(options.title, 'title');
    const gates = Array.isArray(options.gates) ? [...new Set(options.gates.map((gate) => requireString(gate, 'gate')))] : [];
    let caseId = null;
    for (let attempt = 0; attempt < 16; attempt += 1) {
      const candidate = `qc_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
      if (!fs.existsSync(caseFile(h, candidate))) {
        caseId = candidate;
        break;
      }
    }
    if (!caseId) fail('ID_COLLISION', '无法分配 case_id');
    const at = new Date().toISOString();
    const caseRecord = {
      case_id: caseId,
      project,
      title,
      status: 'open',
      variable_layer: options.variable_layer === undefined ? null : String(options.variable_layer),
      baseline_ref: options.baseline_ref === undefined ? null : String(options.baseline_ref),
      gates,
      evidence: [],
      machine_checks: [],
      human_verdict: null,
      phenomenon: null,
      attribution_layer: null,
      fix: null,
      repro_count: 0,
      repro_note: '',
      conclusion: null,
      owner: actor.slug,
      created_at: at,
      updated_at: at,
    };
    writeCase(h, caseRecord);
    const recorded = recordEvent(h, caseRecord, 'qc.open', actor.slug, {
      title,
      variable_layer: caseRecord.variable_layer,
      baseline_ref: caseRecord.baseline_ref,
      gates,
    });
    return ok({ case_id: caseId, case: caseRecord, ...recorded });
  });
}

function attachEvidence(home, slug, caseId, options = {}) {
  return guard(() => {
    const h = homeDir(home);
    const actor = actorFor(h, slug);
    return withLock(lockFile(h, caseId), () => {
      const caseRecord = readCase(h, caseId);
      if (!['open', 'collecting'].includes(caseRecord.status)) fail('BAD_STATE', `当前状态 ${caseRecord.status} 不可挂证据`);
      const file = path.resolve(requireString(options.path, 'path'));
      if (!fs.existsSync(file) || !fs.statSync(file).isFile()) fail('NOT_FOUND', `证据文件不存在：${file}`);
      const role = requireString(options.role, 'role');
      if (!ROLES.includes(role)) fail('BAD_INPUT', `未知证据角色 ${role}`);
      const { sha256, bytes } = hashFile(file);
      const sameHash = (caseRecord.evidence || []).filter((item) => item.sha256 === sha256);
      if (sameHash.length > 0) {
        const sameRole = sameHash.find((item) => item.role === role);
        if (sameRole) {
          return ok({ case: caseRecord, evidence: sameRole, idempotent: true, event: null });
        }
        if (!options.allow_same) {
          fail('EVIDENCE_DUPLICATE', '同一哈希已用于其它角色（E5）；合法复用需 allow_same + reason', { conflict: sameHash[0] });
        }
        const reason = requireString(options.reason, 'reason');
        const entry = {
          path: file,
          role,
          sha256,
          bytes,
          note: options.note === undefined ? '' : String(options.note),
          attached_at: new Date().toISOString(),
          attached_by: actor.slug,
          same_hash_exemption: { reason, at: new Date().toISOString(), actor: actor.slug },
        };
        caseRecord.evidence.push(entry);
        caseRecord.status = 'collecting';
        caseRecord.updated_at = entry.attached_at;
        writeCase(h, caseRecord);
        const recorded = recordEvent(h, caseRecord, 'qc.attach', actor.slug, {
          role,
          path: file,
          sha256,
          bytes,
          allow_same: true,
          reason,
          exemption: true,
        });
        return ok({ case: caseRecord, evidence: entry, ...recorded });
      }
      const entry = {
        path: file,
        role,
        sha256,
        bytes,
        note: options.note === undefined ? '' : String(options.note),
        attached_at: new Date().toISOString(),
        attached_by: actor.slug,
      };
      caseRecord.evidence.push(entry);
      caseRecord.status = 'collecting';
      caseRecord.updated_at = entry.attached_at;
      writeCase(h, caseRecord);
      const recorded = recordEvent(h, caseRecord, 'qc.attach', actor.slug, {
        role,
        path: file,
        sha256,
        bytes,
        allow_same: false,
        reason: null,
        exemption: false,
      });
      return ok({ case: caseRecord, evidence: entry, ...recorded });
    });
  });
}

function machineCheck(home, slug, caseId, options = {}) {
  return guard(() => {
    const h = homeDir(home);
    const actor = actorFor(h, slug);
    return withLock(lockFile(h, caseId), () => {
      const caseRecord = readCase(h, caseId);
      const gate = requireString(options.gate, 'gate');
      if (!caseRecord.gates.includes(gate)) fail('BAD_GATE', `gate 未在案例注册：${gate}`);
      const result = requireString(options.result, 'result');
      if (!MACHINE_RESULTS.includes(result)) fail('BAD_INPUT', `机器结果必须是 ${MACHINE_RESULTS.join('/')}`);
      if (!['open', 'collecting', 'machine_checked'].includes(caseRecord.status)) fail('BAD_STATE', `当前状态 ${caseRecord.status} 不可写机器判定`);
      const check = {
        gate,
        result,
        metrics: options.metrics && typeof options.metrics === 'object' ? options.metrics : {},
        checker: options.checker === undefined ? actor.slug : String(options.checker),
        independent: Boolean(options.independent),
        at: new Date().toISOString(),
      };
      caseRecord.machine_checks.push(check);
      caseRecord.status = 'machine_checked';
      caseRecord.updated_at = check.at;
      writeCase(h, caseRecord);
      const recorded = recordEvent(h, caseRecord, 'qc.machine', actor.slug, {
        gate,
        result,
        metrics: check.metrics,
        checker: check.checker,
        independent: check.independent,
      });
      return ok({ case: caseRecord, check, aggregate: aggregate(caseRecord), ...recorded });
    });
  });
}

function humanVerdict(home, slug, caseId, options = {}) {
  return guard(() => {
    const h = homeDir(home);
    const actor = actorFor(h, slug);
    return withLock(lockFile(h, caseId), () => {
      const caseRecord = readCase(h, caseId);
      if (!['machine_checked', 'human_verdict'].includes(caseRecord.status)) fail('BAD_STATE', `当前状态 ${caseRecord.status} 不可写人工终判`);
      const verdict = requireString(options.verdict, 'verdict');
      if (!HUMAN_VERDICTS.includes(verdict)) fail('BAD_INPUT', `人工终判必须是 ${HUMAN_VERDICTS.join('/')}`);
      const at = new Date().toISOString();
      caseRecord.human_verdict = { verdict, note: options.note === undefined ? '' : String(options.note), actor: actor.slug, at };
      caseRecord.status = 'human_verdict';
      caseRecord.updated_at = at;
      writeCase(h, caseRecord);
      const recorded = recordEvent(h, caseRecord, 'qc.human', actor.slug, { verdict, note: caseRecord.human_verdict.note });
      return ok({ case: caseRecord, aggregate: aggregate(caseRecord), ...recorded });
    });
  });
}

function closeCase(home, slug, caseId, options = {}) {
  return guard(() => {
    const h = homeDir(home);
    const actor = actorFor(h, slug);
    return withLock(lockFile(h, caseId), () => {
      const caseRecord = readCase(h, caseId);
      if (caseRecord.status !== 'human_verdict') fail('BAD_STATE', `当前状态 ${caseRecord.status} 不可关闭`);
      const fields = {
        phenomenon: options.phenomenon,
        attribution_layer: options.attribution_layer,
        fix: options.fix,
      };
      const missing = Object.entries(fields)
        .filter(([, value]) => typeof value !== 'string' || value.trim() === '')
        .map(([key]) => key);
      if (missing.length > 0) fail('QC_INCOMPLETE', `四栏缺失：${missing.join(',')}`, { missing });
      const phenomenon = fields.phenomenon.trim();
      const attributionLayer = fields.attribution_layer.trim();
      const fix = fields.fix.trim();
      const reproCount = Number(options.repro_count);
      if (!Number.isInteger(reproCount) || reproCount < 0) fail('BAD_INPUT', 'repro_count 必须是非负整数');
      const conclusion = options.conclusion === undefined ? 'pending' : String(options.conclusion);
      if (!CONCLUSIONS.includes(conclusion)) fail('BAD_INPUT', `conclusion 必须是 ${CONCLUSIONS.join('/')}`);
      if (conclusion === 'baseline' && reproCount < 2) fail('QC_NOT_REPRODUCED', '升为基线需复现 >=2 次');
      const at = new Date().toISOString();
      caseRecord.phenomenon = phenomenon;
      caseRecord.attribution_layer = attributionLayer;
      caseRecord.fix = fix;
      caseRecord.repro_count = reproCount;
      caseRecord.repro_note = options.repro_note === undefined ? '' : String(options.repro_note);
      caseRecord.conclusion = conclusion;
      caseRecord.status = 'closed';
      caseRecord.closed_at = at;
      caseRecord.updated_at = at;
      writeCase(h, caseRecord);
      const recorded = recordEvent(h, caseRecord, 'qc.close', actor.slug, {
        phenomenon,
        attribution_layer: attributionLayer,
        fix,
        repro_count: reproCount,
        repro_note: caseRecord.repro_note,
        conclusion,
      });
      return ok({ case: caseRecord, aggregate: aggregate(caseRecord), ...recorded });
    });
  });
}

function getCase(home, caseId) {
  return guard(() => {
    const h = homeDir(home);
    const caseRecord = readCase(h, caseId);
    return ok({ case: caseRecord, aggregate: aggregate(caseRecord) });
  });
}

function listCases(home, filters = {}) {
  return guard(() => {
    const h = homeDir(home);
    const dir = casesDir(h);
    if (!fs.existsSync(dir)) return ok({ cases: [] });
    const project = filters.project ? String(filters.project) : null;
    const status = filters.status ? String(filters.status) : null;
    const cases = [];
    for (const name of fs.readdirSync(dir)) {
      if (!name.endsWith('.json')) continue;
      try {
        const caseRecord = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
        if (project && caseRecord.project !== project) continue;
        if (status && caseRecord.status !== status) continue;
        cases.push(caseRecord);
      } catch { /* skip corrupt */ }
    }
    cases.sort((a, b) => String(b.updated_at || '').localeCompare(String(a.updated_at || '')));
    return ok({ cases });
  });
}

function verifyEvidence(home, caseId) {
  return guard(() => {
    const h = homeDir(home);
    const caseRecord = readCase(h, caseId);
    const mismatches = [];
    for (const item of caseRecord.evidence || []) {
      if (!fs.existsSync(item.path) || !fs.statSync(item.path).isFile()) {
        mismatches.push({ path: item.path, role: item.role, reason: 'missing' });
        continue;
      }
      const { sha256, bytes } = hashFile(item.path);
      if (bytes !== item.bytes) mismatches.push({ path: item.path, role: item.role, reason: 'size', expected_bytes: item.bytes, actual_bytes: bytes });
      else if (sha256 !== item.sha256) mismatches.push({ path: item.path, role: item.role, reason: 'hash', expected: item.sha256, actual: sha256 });
    }
    return ok({ case_id: caseRecord.case_id, checked: (caseRecord.evidence || []).length, intact: mismatches.length === 0, mismatches });
  });
}

function summary(home, caseId) {
  return guard(() => {
    const h = homeDir(home);
    const caseRecord = readCase(h, caseId);
    const repro = caseRecord.repro_count > 0
      ? `${caseRecord.repro_count}${caseRecord.repro_note ? `（${caseRecord.repro_note}）` : ''}`
      : '待补';
    const line = `${caseRecord.phenomenon || '待补'}→${caseRecord.attribution_layer || '待补'}→${caseRecord.fix || '待补'}→${repro}`;
    return ok({ case_id: caseRecord.case_id, summary: line, conclusion: caseRecord.conclusion, status: caseRecord.status });
  });
}

export const qc = {
  open: openCase,
  attach: attachEvidence,
  machine: machineCheck,
  human: humanVerdict,
  close: closeCase,
  get: getCase,
  list: listCases,
  verify: verifyEvidence,
  summary,
};

export {
  openCase,
  attachEvidence,
  machineCheck,
  humanVerdict,
  closeCase,
  getCase,
  listCases,
  verifyEvidence,
  summary,
};

