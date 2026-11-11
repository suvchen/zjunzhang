// 中军帐 T-008 I47 · 成员适配器注册表（src/member.js）（总管，Codex 工单 #55261）
// data/members/<slug>.json：adapter_kind=spawn|notify；spawn 必带 argv（含 {task} 槽）；notify 严禁执行进程。
// 只存配置，不执行——执行在 src/adapter.js；唤醒决策在 Codex 的 src/wake.js。
import fs from 'node:fs';
import path from 'node:path';
import { resource } from './resource.js';
import { identity, room } from './core.js';

class MemberError extends Error {
  constructor(code, message = code) {
    super(message);
    this.name = 'MemberError';
    this.code = code;
  }
}

function fail(code, message = code) {
  throw new MemberError(code, message);
}

function ok(payload = {}) {
  return { ok: true, ...payload };
}

function wrap(fn) {
  try {
    return fn();
  } catch (error) {
    if (error instanceof MemberError) return { ok: false, code: error.code, message: error.message };
    return { ok: false, code: 'INTERNAL', message: String(error && error.message ? error.message : error) };
  }
}

function homeDir(home) {
  return path.resolve(home || '.');
}

function membersDir(home) {
  return path.join(homeDir(home), 'data', 'members');
}

function memberFile(home, slug) {
  return path.join(membersDir(home), `${slug}.json`);
}

const SLUG_RE = /^[a-z0-9\u4e00-\u9fff][a-z0-9\u4e00-\u9fff._-]{0,63}$/i;

function validate(payload) {
  const p = payload && typeof payload === 'object' ? payload : {};
  const slug = typeof p.slug === 'string' ? p.slug.trim() : '';
  if (!SLUG_RE.test(slug)) fail('BAD_INPUT', 'slug 非法（限字母数字中文 . _ -，不得含路径字符）');
  const kind = p.adapter_kind;
  if (!['spawn', 'notify', 'api'].includes(kind)) fail('BAD_INPUT', 'adapter_kind 只能是 spawn|notify|api');
  const record = {
    slug,
    adapter_kind: kind,
    argv: undefined,
    url: undefined,
    method: undefined,
    headers: undefined,
    env: undefined,
    cooldown_ms: 0,
    max_consecutive: 3,
    timeout_ms: undefined,
    provider: 'auto',
    updated_at: new Date().toISOString(),
  };
  if (kind === 'spawn') {
    if (!Array.isArray(p.argv) || p.argv.length === 0 || p.argv.some((token) => typeof token !== 'string' || token.trim() === '')) {
      fail('BAD_INPUT', 'spawn 适配器必须给非空 argv 数组（含 {task} 槽）');
    }
    record.argv = p.argv.map((token) => token.trim());
    // E17：PowerShell/cmd 会把 '[\"a\",\"b\"]' 这类转义串二次转义成**一个 token**，档案当场写坏，
    // 症状却要等到唤醒时才出现（ADAPTER_SPAWN_FAILED/ENOENT）。形态像 JSON 数组的单 token＝当场拒收。
    if (record.argv.length === 1 && /^\s*\[.*\]\s*$/.test(record.argv[0])) {
      fail('ADAPTER_ARGV_ESCAPED', 'argv 只有一个 token 且形如 JSON 数组：多半是 shell 把 --adapter 的引号转义弄坏了。请用 --adapter-file <json 文件>，或按数组逐参数传');
    }
  }
  if (kind === 'api') {
    // GUI 宿主（OpenCode/Codex Desktop 等带本地 HTTP API 的会话）＝直接投递进活会话，绝不 spawn 进程。
    if (typeof p.url !== 'string' || !/^https?:\/\/[^\s]+$/i.test(p.url)) fail('BAD_INPUT', 'api 适配器必须给 http(s) url');
    record.url = p.url.trim();
    if (p.method !== undefined && !['POST', 'PUT', 'GET'].includes(String(p.method).toUpperCase())) fail('BAD_INPUT', 'method 只支持 POST|PUT|GET');
    record.method = p.method === undefined ? 'POST' : String(p.method).toUpperCase();
    if (p.headers !== undefined) {
      if (typeof p.headers !== 'object' || p.headers === null || Array.isArray(p.headers)) fail('BAD_INPUT', 'headers 必须是对象');
      for (const [key, value] of Object.entries(p.headers)) {
        if (typeof value !== 'string') fail('BAD_INPUT', `headers.${key} 必须是字符串`);
      }
      record.headers = p.headers;
    }
  }
  if (p.env !== undefined) {
    if (typeof p.env !== 'object' || p.env === null || Array.isArray(p.env)) fail('BAD_INPUT', 'env 必须是对象');
    for (const [key, value] of Object.entries(p.env)) {
      if (typeof value !== 'string') fail('BAD_INPUT', `env.${key} 必须是字符串`);
    }
    record.env = p.env;
  }
  if (p.cooldown_ms !== undefined && (!Number.isInteger(p.cooldown_ms) || p.cooldown_ms < 0)) fail('BAD_INPUT', 'cooldown_ms 必须是非负整数');
  if (p.cooldown_ms !== undefined) record.cooldown_ms = p.cooldown_ms;
  if (p.max_consecutive !== undefined && (!Number.isInteger(p.max_consecutive) || p.max_consecutive < 1)) fail('BAD_INPUT', 'max_consecutive 必须是正整数');
  if (p.max_consecutive !== undefined) record.max_consecutive = p.max_consecutive;
  if (p.timeout_ms !== undefined && (!Number.isInteger(p.timeout_ms) || p.timeout_ms < 1000)) fail('BAD_INPUT', 'timeout_ms 必须是 ≥1000 的整数毫秒（真宿主建议 600000）');
  if (p.timeout_ms !== undefined) record.timeout_ms = p.timeout_ms;
  // M56：provider 可显式声明（local/remote），没声明就按线索判、判不出标 unknown——绝不猜。
  if (p.provider !== undefined && !['auto', 'local', 'remote'].includes(p.provider)) {
    fail('BAD_INPUT', 'provider 只能是 auto|local|remote');
  }
  if (p.provider !== undefined) record.provider = p.provider;
  if (p.instructions !== undefined) {
    if (typeof p.instructions !== 'string' || p.instructions.trim() === '') fail('BAD_INPUT', 'instructions 必须是非空字符串（分身常驻指令）');
    if (p.instructions.length > 4000) fail('BAD_INPUT', 'instructions 上限 4000 字');
    record.instructions = p.instructions.trim();
  }
  if (p.wake_policy !== undefined) {
    if (!['mention', 'all'].includes(p.wake_policy)) fail('BAD_INPUT', 'wake_policy 只能是 mention|all');
    record.wake_policy = p.wake_policy;
  }
  if (p.mention_handles !== undefined) {
    if (!Array.isArray(p.mention_handles) || p.mention_handles.some((x) => typeof x !== 'string' || x.trim() === '')) fail('BAD_INPUT', 'mention_handles 必须是非空字符串数组');
    record.mention_handles = p.mention_handles.map((x) => x.trim());
  }
  return record;
}

export function set(home, payload = {}) {
  return wrap(() => {
    // 合并语义（不是整档重写）：只覆盖 payload 里出现的字段。
    // 原因：装机/演示中途常要只改一项（如换模型、调 timeout_ms），整档重写会把 instructions/mention_handles 悄悄抹掉。
    let previous = {};
    try {
      previous = JSON.parse(fs.readFileSync(memberFile(home, String(payload.slug || '').trim()), 'utf8')) || {};
    } catch { /* 新成员：无旧档 */ }
    const merged = { ...previous, ...Object.fromEntries(Object.entries(payload).filter(([, v]) => v !== undefined)) };
    const record = validate(merged);
    const file = memberFile(home, record.slug);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(record, null, 2) + '\n', 'utf8');
    fs.renameSync(tmp, file);
    return ok({ slug: record.slug, adapter_kind: record.adapter_kind, path: `data/members/${record.slug}.json` });
  });
}

export function get(home, slug) {
  return wrap(() => {
    const s = typeof slug === 'string' ? slug.trim() : '';
    if (!SLUG_RE.test(s)) fail('BAD_INPUT', 'slug 非法');
    try {
      return ok({ member: JSON.parse(fs.readFileSync(memberFile(home, s), 'utf8')) });
    } catch {
      fail('NOT_FOUND', '成员未注册适配器');
    }
  });
}

export function list(home) {
  return wrap(() => {
    let names = [];
    try {
      names = fs.readdirSync(membersDir(home)).filter((name) => name.endsWith('.json'));
    } catch {
      names = [];
    }
    const members = [];
    for (const name of names) {
      try {
        members.push(JSON.parse(fs.readFileSync(path.join(membersDir(home), name), 'utf8')));
      } catch { /* 坏文件跳过，get 会点名 */ }
    }
    return ok({ total: members.length, members });
  });
}

// M56 · provider 槽位视图：本机只有一个本地模型槽（E15：单槽串行，并发 2 全排队、并发 4 有请求被断），
// 所以「哪个成员配的是本地、本地槽此刻被谁占着」必须可查，不能靠人记分流表。
// 只读，不改成员；占用信息取自 src/resource.js 的 local-iq3 这类资源（claim/release 口径）。
const LOCAL_HINT_RE = /local-strata|strata-iq3s|127\.0\.0\.1:8081|localhost:8081|local:/i;
const LOOPBACK_RE = /^https?:\/\/(127\.0\.0\.1|localhost)([:\/]|$)/i;

export const LOCAL_SLOT_RESOURCE = 'local-iq3';

function classifyProvider(record) {
  if (record.provider === 'local' || record.provider === 'remote') return record.provider;
  if (record.adapter_kind === 'spawn') {
    const line = (record.argv || []).join(' ') + ' ' + Object.values(record.env || {}).join(' ');
    return LOCAL_HINT_RE.test(line) ? 'local' : (line.trim() ? 'unknown' : 'unknown');
  }
  if (record.adapter_kind === 'api') {
    if (LOOPBACK_RE.test(record.url || '')) return 'local';
    return record.url ? 'remote' : 'unknown';
  }
  return 'unknown';
}

export function providers(home, options = {}) {
  return wrap(() => {
    const listed = list(home);
    if (!listed.ok) return listed;
    const rows = listed.members.map((record) => ({
      slug: record.slug,
      adapter_kind: record.adapter_kind,
      provider: classifyProvider(record),
      endpoint: record.adapter_kind === 'api' ? (record.url || null)
        : (record.adapter_kind === 'spawn' ? (record.argv || []).join(' ').slice(0, 160) : null),
      timeout_ms: record.timeout_ms ?? null,
    }));
    const localMembers = rows.filter((r) => r.provider === 'local').map((r) => r.slug);
    const resourceName = options.resource || LOCAL_SLOT_RESOURCE;
    const held = resource.status(home, { resource: resourceName });
    return ok({
      resource: resourceName,
      members: rows,
      summary: {
        total: rows.length,
        local_slots: localMembers.length,
        local_members: localMembers,
        unknown: rows.filter((r) => r.provider === 'unknown').length,
        local_held: Boolean(held.ok && held.held),
        local_holder: held.ok ? held.holder : null,
        local_hold_remaining_ms: held.ok ? held.hold_remaining_ms : 0,
        // 本机物理上只有一个本地槽：配本地的成员多于一个＝超卖，红旗可见（不崩、不拦，拦是 wake 侧的事）。
        over_subscribed: localMembers.length > 1,
      },
    });
  });
}

function readJsonFile(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

// E20：member set 只写适配器配置，不建身份也不进房——三件事没接通，配置就是死的且不报错。
// wiring 把「身份在不在、进没进房」摆到台面，让 member set 能当场告警、让新用户一眼看懂缺哪步。
export function wiring(home, slug) {
  return wrap(() => {
    const s = String(slug || '').trim();
    if (s === '') fail('BAD_INPUT', 'slug 必填');
    const h = homeDir(home);
    const has_identity = fs.existsSync(path.join(h, 'data', 'identities', s, 'key.json'));
    const roomsRoot = path.join(h, 'data', 'rooms');
    const rooms = [];
    try {
      for (const entry of fs.readdirSync(roomsRoot, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const members = readJsonFile(path.join(roomsRoot, entry.name, 'members.json'));
        const row = Array.isArray(members) ? members.find((item) => item && item.slug === s) : null;
        if (row) rooms.push({ room_id: entry.name, cursor: Number(row.cursor) || 0 });
      }
    } catch { /* 没有 rooms 目录＝没进任何房 */ }
    const wired = has_identity && rooms.length > 0;
    return ok({
      slug: s,
      has_identity,
      rooms,
      wired,
      warning: wired ? null : {
        code: 'MEMBER_NOT_IN_ROOM',
        message: has_identity
          ? `成员 ${s} 有身份但没进任何房名单，照这样发消息它永远醒不来。补法：zjz member wire --slug ${s} --room <room_id>`
          : `成员 ${s} 既无身份也没进房，配置是死的。补法：zjz member wire --slug ${s} --room <room_id>（一条命令建身份＋进房＋绑适配器）`,
      },
    });
  });
}
// E28：一条命令接通「建身份＋进房＋绑适配器」。主人问怎么把智能体加进来，就是跑这个。
export function wire(home, options = {}) {
  return wrap(() => {
    const roomId = String(options.room_id || '').trim();
    if (roomId === '') fail('BAD_INPUT', 'room_id 必填');
    const meta = readJsonFile(path.join(homeDir(home), 'data', 'rooms', roomId, 'meta.json'));
    if (!meta || !meta.invite) fail('NOT_FOUND', `房间 ${roomId} 不存在或没有邀请码`);

    let slug = String(options.slug || '').trim();
    let ident;
    if (slug !== '' && fs.existsSync(path.join(homeDir(home), 'data', 'identities', slug, 'key.json'))) {
      ident = { ok: true, slug };
    } else {
      ident = identity.create(home, options.name || slug || '中军帐成员');
      if (!ident.ok) fail(ident.code, ident.message);
      slug = ident.slug;
    }

    const join = room.join(home, slug, meta.invite);
    if (!join.ok && join.code !== 'ALREADY_MEMBER') fail(join.code, join.message);

    const setRes = set(home, {
      slug,
      adapter_kind: options.adapter_kind,
      argv: options.argv,
      url: options.url,
      method: options.method,
      headers: options.headers,
      env: options.env,
      cooldown_ms: options.cooldown_ms,
      max_consecutive: options.max_consecutive,
      timeout_ms: options.timeout_ms,
      instructions: options.instructions,
      wake_policy: options.wake_policy,
      mention_handles: options.mention_handles,
      provider: options.provider,
    });
    if (!setRes.ok) fail(setRes.code, setRes.message);

    return ok({ slug, room_id: roomId, identity: ident.slug, joined: join.ok ? 'joined' : 'already_member', member: setRes.member, wiring: wiring(home, slug) });
  });
}
export const member = { set, get, list, providers, wiring, wire };
export default member;
