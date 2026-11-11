// 中军帐 T-008 I47 · 适配器执行器（src/adapter.js）（总管，Codex 工单 #55261）
// spawn：按注册 argv 拉起无头会话；任务文本必含 pending 正文＋zjz resume 协议；
//        .ps1/.cmd 用 pwsh -NoProfile -File 包装（Win 裸 spawn 会 ENOENT）；env 逐成员覆写（E8 防串号）。
// notify：只写 data/inbox/<slug>.md，绝不拉起进程。
// 防呆：cooldown_ms 冷却窗＋max_consecutive 连续失败熔断（唤醒风暴防线）。唤醒决策/升级归 wake.js。
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { member as memberApi } from './member.js';

class AdapterError extends Error {
  constructor(code, message = code) {
    super(message);
    this.name = 'AdapterError';
    this.code = code;
  }
}

function fail(code, message = code) {
  throw new AdapterError(code, message);
}

function ok(payload = {}) {
  return { ok: true, ...payload };
}

function wrap(fn) {
  try {
    return fn();
  } catch (error) {
    if (error instanceof AdapterError) return { ok: false, code: error.code, message: error.message };
    return { ok: false, code: 'INTERNAL', message: String(error && error.message ? error.message : error) };
  }
}

function homeDir(home) {
  return path.resolve(home || '.');
}

function adapterDir(home) {
  return path.join(homeDir(home), 'data', 'adapters');
}

function stateFile(home, slug) {
  return path.join(adapterDir(home), `${slug}.state.json`);
}

function readState(home, slug) {
  try {
    return JSON.parse(fs.readFileSync(stateFile(home, slug), 'utf8'));
  } catch {
    return { consecutive_failures: 0, last_spawn_at: 0 };
  }
}

function writeState(home, slug, state) {
  fs.mkdirSync(adapterDir(home), { recursive: true });
  fs.writeFileSync(stateFile(home, slug), JSON.stringify(state, null, 2) + '\n', 'utf8');
}

// E21：回帖必须带 --slug <你自己的 slug>。不带就会用当前默认身份发，署名变成别人（主人实弹：send 不显式 --slug 会以探针乙发出）。
function resumeProtocol(slug, roomId) {
  const s = slug ? ` --slug ${slug}` : '';
  const r = roomId ? ` --room ${roomId}` : '';
  return [
    '恢复协议（第一步必做）：在仓库根运行 `node bin/zjz.mjs resume` 读回项目记忆（进度/未闭合工单/错误卡）。',
    '读完按消息处理，处理完在对应房回帖；回帖后如仍在线请续 wait。',
    '回帖首行写「回复于 <本地时间>」，让人一眼看出回应发生在何时。',
    `回帖命令（必须原样带上 --slug，署名才是你自己）：` +
      `node bin/zjz.mjs${s}${r} send "<回帖正文>"`,
  ].join('\n');
}

// 房讯进任务文本必须带时间（主人 11-09 反馈：房间里的信息没有时间）。本地可读＋ISO 原值并列，不猜时区。
export function tsLabel(ts) {
  if (!ts) return '时间未知';
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return String(ts);
  const p = (n) => String(n).padStart(2, '0');
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  const abs = Math.abs(off);
  const local = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  return `${local}（UTC${sign}${p(Math.floor(abs / 60))}:${p(abs % 60)}｜${ts}）`;
}

// 任务文本＝任务头＋resume 协议＋pending 消息正文（wake.js 传消息；无消息也必须可执行）
export function composeTask(payload = {}) {
  const p = payload && typeof payload === 'object' ? payload : {};
  const messages = Array.isArray(p.messages) ? p.messages : [];
  const head = typeof p.head === 'string' && p.head.trim() !== '' ? p.head.trim() : '你有未处理的消息（中军帐自动唤醒）。';
  const lines = [head, '', resumeProtocol(p.slug, p.room_id), ''];
  for (const m of messages) {
    lines.push(`--- ${m.room_id || '?'} #${m.seq ?? '?'} ${m.author || ''} | ${tsLabel(m.ts)} ---`);
    lines.push(String(m.text ?? '').trim());
    lines.push('');
  }
  return lines.join('\n');
}

function inboxFile(home, slug) {
  return path.join(homeDir(home), 'data', 'inbox', `${slug}.md`);
}

function notifyAppend(home, slug, task) {
  const file = inboxFile(home, slug);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const block = `\n## ${new Date().toISOString()} 唤醒提醒（notify）\n\n${task}\n`;
  fs.appendFileSync(file, block, 'utf8');
  return file;
}

// argv 槽位：{task} 占位替换；模板无占位则任务文本作尾参。任务同时落盘，argv 里给路径槽 {task_file}
function materializeArgv(argv, task, taskFile) {
  const out = [];
  let slot = false;
  for (const token of argv) {
    if (token.includes('{task_file}')) { out.push(token.replace('{task_file}', taskFile)); slot = true; continue; }
    if (token.includes('{task}')) { out.push(token.replace('{task}', task)); slot = true; continue; }
    out.push(token);
  }
  if (!slot) out.push(task);
  return out;
}

// .ps1/.cmd/.bat 包装（今天实测坑：裸 spawn 在 Win 下 ENOENT/EAP）；
// 无扩展名命令先经 where.exe 解析（PATH 上的 claude 其实是 .ps1 shim——11-09 冒烟实踩）。
function resolveCommand(head) {
  if (path.isAbsolute(head) || head.includes(path.sep)) return head;
  const res = spawnSync('where.exe', [head], { encoding: 'utf8', windowsHide: true });
  if (res.status === 0) {
    const lines = String(res.stdout || '').split(/\r?\n/).map((l) => l.trim()).filter((l) => l !== '');
    // 关键：PATH shim 常是裸名/无扩展（如 E:\claude-code\claude），spawnSync 会 ENOENT——
    // 必须优先命中可执行扩展（11-09 冒烟实踩）。
    const preferred = lines.find((l) => /\.(exe|cmd|bat|com)$/i.test(l));
    if (preferred) return preferred;
    if (lines[0]) return lines[0];
  }
  return head;
}

function wrapExec(argv) {
  const [rawHead, ...rest] = argv;
  const head = resolveCommand(rawHead);
  const lower = head.toLowerCase();
  if (lower.endsWith('.ps1')) return { exec: 'pwsh.exe', args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', head, ...rest] };
  if (lower.endsWith('.cmd') || lower.endsWith('.bat')) return { exec: 'cmd.exe', args: ['/c', head, ...rest] };
  return { exec: head, args: rest };
}

export function run(home, payload = {}) {
  return wrap(() => {
    const p = payload && typeof payload === 'object' ? payload : {};
    const slug = typeof p.slug === 'string' ? p.slug.trim() : '';
    if (slug === '') fail('BAD_INPUT', 'slug 必填');
    const got = memberApi.get(home, slug);
    if (!got.ok) return got;
    const member = got.member;
    const task = typeof p.task === 'string' && p.task.trim() !== '' ? p.task : composeTask(p);
    // 分身常驻指令（装机时登记）：以谁的身份、回哪、怎么回——醒来看见的第一段话。
    const fullTask = member.instructions ? `${member.instructions}\n\n${task}` : task;

    if (member.adapter_kind === 'notify') {
      const file = notifyAppend(home, slug, fullTask);
      return ok({ status: 'notified', inbox: path.relative(homeDir(home), file), spawned: false });
    }

    const state = readState(home, slug);
    const now = Date.now();
    if (member.cooldown_ms > 0 && now - (state.last_spawn_at || 0) < member.cooldown_ms) {
      return ok({ status: 'cooldown', spawned: false, wait_ms: member.cooldown_ms - (now - state.last_spawn_at) });
    }
    if ((state.consecutive_failures || 0) >= member.max_consecutive) {
      fail('ADAPTER_MAX_CONSECUTIVE', `连续失败 ${state.consecutive_failures} 次已达上限 ${member.max_consecutive}（熔断，升级交 wake/值班）`);
    }

    fs.mkdirSync(adapterDir(home), { recursive: true });
    const taskFile = path.join(adapterDir(home), `${slug}.task.md`);
    fs.writeFileSync(taskFile, fullTask, 'utf8');

    const argv = materializeArgv(member.argv || [], fullTask, taskFile);

    // api 形态：经本地 HTTP 投递进 GUI 宿主的活会话。绝不 spawn 宿主进程。
    // 实现＝node 内置 fetch 子进程（curl.exe 被本机 EDR 拦截 loopback——11-09 实踩 status=28，错误卡已记）。
    if (member.adapter_kind === 'api') {
      const code = [
        'const [url, method, file, hj] = process.argv.slice(1);',
        'const fs = await import("node:fs");',
        'const body = fs.readFileSync(file);',
        'try {',
        '  const r = await fetch(url, { method, headers: JSON.parse(hj || "{}"), body: method === "GET" ? undefined : body, signal: AbortSignal.timeout(20000) });',
        '  const t = await r.text();',
        '  process.stdout.write(JSON.stringify({ http: r.status, tail: t.slice(0, 300) }));',
        '} catch (e) { process.stdout.write(JSON.stringify({ http: 0, error: String(e && e.message || e) })); }',
      ].join('\n');
      const headers = member.headers || { 'Content-Type': 'text/plain; charset=utf-8' };
      const res = spawnSync(process.execPath, ['--input-type=module', '-e', code, member.url, member.method || 'POST', taskFile, JSON.stringify(headers)],
        { timeout: Number(p.timeout_ms ?? member.timeout_ms ?? 30000), maxBuffer: 4 * 1024 * 1024, windowsHide: true });
      let parsed = {};
      try { parsed = JSON.parse(String(res.stdout || '{}')); } catch { /* 视同失败 */ }
      const success = !res.error && parsed.http >= 200 && parsed.http < 300;
      writeState(home, slug, { consecutive_failures: success ? 0 : (state.consecutive_failures || 0) + 1, last_spawn_at: now });
      return ok({
        status: success ? 'api_delivered' : 'api_failed',
        spawned: false,
        http: parsed.http || 0,
        body_tail: String(parsed.tail || '').slice(0, 300),
        message: res.error ? String(res.error.message || res.error) : parsed.error,
        task_file: path.relative(homeDir(home), taskFile),
      });
    }

    const { exec, args } = wrapExec(argv);
    const env = { ...process.env, ...(member.env || {}), ZJZ_TASK_FILE: taskFile };
    const timeoutMs = Number(p.timeout_ms ?? member.timeout_ms ?? 600000);
    const startedAt = Date.now();
    const res = spawnSync(exec, args, { env, timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024, windowsHide: true });

    const spawnedAt = now;
    const elapsed = Date.now() - startedAt;
    if (res.error) {
      writeState(home, slug, { consecutive_failures: (state.consecutive_failures || 0) + 1, last_spawn_at: spawnedAt });
      const timedOut = res.error.code === 'ETIMEDOUT';
      return ok(timedOut
        ? { status: 'timeout', spawned: true, code: 'ADAPTER_TIMEOUT', message: `超时：宿主超过 ${timeoutMs}ms 未返回（elapsed=${elapsed}ms，exit=null）——进程已起来但慢，不是拉不起来`, timeout_ms: timeoutMs, elapsed_ms: elapsed, exit: null, task_file: path.relative(homeDir(home), taskFile) }
        : { status: 'spawn_failed', spawned: true, code: 'ADAPTER_SPAWN_FAILED', message: String(res.error.message || res.error), errno: String(res.error.code || ''), elapsed_ms: elapsed, exit: null, task_file: path.relative(homeDir(home), taskFile) });
    }
    const success = res.status === 0;
    writeState(home, slug, {
      consecutive_failures: success ? 0 : (state.consecutive_failures || 0) + 1,
      last_spawn_at: spawnedAt,
    });
    return ok({
      status: success ? 'spawned' : 'spawn_failed',
      spawned: true,
      exit: res.status,
      stdout_tail: String(res.stdout || '').slice(-400),
      stderr_tail: String(res.stderr || '').slice(-200),
      task_file: path.relative(homeDir(home), taskFile),
    });
  });
}

// 熔断状态与复位：latched＝闩锁态，wake 层见 latched 必须停止派发；复位只认手动 reset（升级开单归值班板/I48）。
export function state(home, options = {}) {
  return wrap(() => {
    const slug = String((options && options.slug) || '').trim();
    if (slug === '') fail('BAD_INPUT', 'slug 必填');
    const reg = memberApi.get(home, slug);
    if (!reg.ok) return reg;
    const st = readState(home, slug);
    const max = Number(reg.member.max_consecutive) || 2;
    return ok({
      slug,
      consecutive_failures: Number(st.consecutive_failures) || 0,
      last_spawn_at: Number(st.last_spawn_at) || 0,
      max_consecutive: max,
      latched: (Number(st.consecutive_failures) || 0) >= max,
    });
  });
}

export function reset(home, options = {}) {
  return wrap(() => {
    const slug = String((options && options.slug) || '').trim();
    if (slug === '') fail('BAD_INPUT', 'slug 必填');
    const reg = memberApi.get(home, slug);
    if (!reg.ok) return reg;
    writeState(home, slug, { consecutive_failures: 0, last_spawn_at: 0 });
    return ok({ slug, reset: true });
  });
}

export const adapter = { run, composeTask, state, reset };
export default adapter;
