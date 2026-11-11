// 中军帐 T-008 I47 · 适配器层哨兵（总管）：注册校验/spawn 任务体/resume 协议/env 隔离/notify 不执行/防呆熔断
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { member } from '../src/member.js';
import { identity, room } from '../src/core.js';
import { adapter } from '../src/adapter.js';

function tmpHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'zjz-member-'));
}
function must(res, where) {
  assert.equal(res && res.ok, true, `${where} 应成功，实际 ${JSON.stringify(res)}`);
  return res;
}
function assertCode(res, code, where) {
  assert.equal(res && res.ok, false, `${where} 应失败，实际 ${JSON.stringify(res)}`);
  assert.equal(res.code, code, `${where} 错误码应为 ${code}，实际 ${res.code}`);
}

const FAKE_SPAWN = `
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const here = path.dirname(fileURLToPath(import.meta.url));
const task = process.argv[2] || '';
fs.writeFileSync(path.join(here, 'spawn_out.json'), JSON.stringify({ task, huddo: process.env.HUDDO_HOME || null, task_file_env: process.env.ZJZ_TASK_FILE || null }), 'utf8');
`;
const FAKE_FAIL = 'process.stderr.write("boom"); process.exit(3);\n';

function fakeScript(home, name, body) {
  const file = path.join(home, name);
  fs.writeFileSync(file, body, 'utf8');
  return file;
}

// ---- 注册校验 ----
test('M45 非法注册拒绝：spawn 缺 argv/非法 kind/路径注入 slug/env 非字符串', () => {
  const home = tmpHome();
  assertCode(member.set(home, { slug: 'ok-but-no-argv', adapter_kind: 'spawn' }), 'BAD_INPUT', 'spawn 缺 argv');
  assertCode(member.set(home, { slug: 'ok1', adapter_kind: 'whisper' }), 'BAD_INPUT', 'kind 非法');
  assertCode(member.set(home, { slug: '../evil', adapter_kind: 'notify' }), 'BAD_INPUT', 'slug 路径注入');
  assertCode(member.set(home, { slug: 'ok2', adapter_kind: 'spawn', argv: ['node', ''], }), 'BAD_INPUT', 'argv 含空 token');
  assertCode(member.set(home, { slug: 'ok3', adapter_kind: 'notify', env: { A: 5 } }), 'BAD_INPUT', 'env 值必须字符串');
  assertCode(member.get(home, 'nope'), 'NOT_FOUND', '未注册');
  must(member.set(home, { slug: 'ok2', adapter_kind: 'spawn', argv: ['node', 'x.mjs', '{task}'] }), '合法注册');
  const listed = must(member.list(home), 'list');
  assert.equal(listed.total, 1);
});

// ---- spawn 执行：任务体＋resume 协议＋env 隔离 ----
test('M46 spawn 适配器：任务含 pending 正文与 resume 协议；HUDDO_HOME 逐成员覆写', () => {
  const home = tmpHome();
  const fake = fakeScript(home, 'fake_spawn.mjs', FAKE_SPAWN);
  must(member.set(home, {
    slug: '成员甲',
    adapter_kind: 'spawn',
    argv: ['node', fake, '{task}'],
    env: { HUDDO_HOME: 'D:\\huddo\\data-jia' },
  }), 'register');

  const res = must(adapter.run(home, {
    slug: '成员甲',
    messages: [
      { room_id: 'room_x', seq: 7, author: 'zjz-总管', text: '这条 pending 消息必须出现在任务里：请验收 I47。' },
    ],
  }), 'adapter.run');
  assert.equal(res.status, 'spawned');
  assert.equal(res.exit, 0);

  const out = JSON.parse(fs.readFileSync(path.join(home, 'spawn_out.json'), 'utf8'));
  assert.ok(out.task.includes('请验收 I47'), '任务必须含 pending 正文');
  assert.ok(out.task.includes('zjz.mjs resume'), '任务必须含 resume 协议');
  assert.equal(out.huddo, 'D:\\huddo\\data-jia', '子进程 HUDDO_HOME 必须逐成员覆写（E8 防线）');
  assert.ok(out.task_file_env && fs.existsSync(out.task_file_env), '任务必须落盘供 {task_file} 槽使用');
});

// ---- notify：绝不拉起进程 ----
test('M47 notify 成员只写 inbox，绝不 spawn（即便注册里留了 argv 也不执行）', () => {
  const home = tmpHome();
  const marker = path.join(home, 'should_not_exist.txt');
  const evil = fakeScript(home, 'evil.mjs', `import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(marker)}, 'x');`);
  must(member.set(home, { slug: '桌面宿主', adapter_kind: 'notify', argv: ['node', evil] }), 'register notify');

  const res = must(adapter.run(home, { slug: '桌面宿主', messages: [{ room_id: 'room_y', seq: 1, text: '给 notify 成员的提醒' }] }), 'run notify');
  assert.equal(res.status, 'notified');
  assert.equal(res.spawned, false);
  assert.ok(!fs.existsSync(marker), 'notify 绝不允许执行进程');
  const inbox = path.join(home, 'data', 'inbox', '桌面宿主.md');
  assert.ok(fs.readFileSync(inbox, 'utf8').includes('给 notify 成员的提醒'), 'inbox 必须带正文');
});

// ---- PATH shim 解析（11-09 冒烟实踩：claude 在 PATH 上是无扩展 shim，裸 spawn ENOENT）----
test('M49 PATH 命令解析优先可执行扩展：无扩展诱饵存在时仍命中 .cmd', (t) => {
  if (process.platform !== 'win32') { t.skip('Windows 专属'); return; }
  const home = tmpHome();
  const bin = path.join(home, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, 'zjzfake'), '#!/bin/sh 我是无扩展诱饵', 'utf8'); // 故意排在 .cmd 前
  const marker = path.join(home, 'cmd_ran.txt');
  fs.writeFileSync(path.join(bin, 'zjzfake.cmd'), `@echo off\r\necho ran> "${marker}"\r\n`, 'utf8');
  const oldPath = process.env.PATH;
  process.env.PATH = `${bin};${oldPath}`;
  try {
    must(member.set(home, { slug: 'shim用户', adapter_kind: 'spawn', argv: ['zjzfake', '{task}'] }), 'register');
    const res = adapter.run(home, { slug: 'shim用户', task: 'hi' });
    assert.equal(res.status, 'spawned', `应经 .cmd 拉起，实际 ${JSON.stringify(res)}`);
    assert.ok(fs.existsSync(marker), '.cmd 真执行');
  } finally {
    process.env.PATH = oldPath;
  }
});

// ---- api 形态：GUI 宿主经本地 HTTP 投递进活会话 ----
test('M50 api 适配器：POST 投递含正文＋resume；绝不 spawn；500 计连败并熔断；缺 url 拒绝', async () => {
  // 目标 server 必须是独立进程（adapter.run 同步 spawnSync 会阻塞宿主事件循环——11-09 实踩：
  // 若 server 与调用方同进程，投递必死锁超时；生产语义＝投递对象是外部 GUI 宿主进程，不受影响）。
  const home = tmpHome();
  const srvFile = path.join(home, 'target_srv.cjs');
  const portFile = path.join(home, 'srv_port');
  fs.writeFileSync(srvFile, `
const http = require('http');
const fs = require('fs');
const portFile = process.argv[2];
const s = http.createServer((req, res) => {
  let b = '';
  req.on('data', (c) => { b += c; });
  req.on('end', () => {
    fs.writeFileSync(portFile + '.last', JSON.stringify({ method: req.method, body: b, headers: req.headers }));
    if (String(req.url).includes('fail')) { res.writeHead(500); res.end('nope'); }
    else { res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end('session queued'); }
  });
});
s.listen(0, '127.0.0.1', () => fs.writeFileSync(portFile, String(s.address().port)));
`, 'utf8');
  const { spawn } = await import('node:child_process');
  const child = spawn(process.execPath, [srvFile, portFile], { windowsHide: true });
  try {
    let port = 0;
    for (let i = 0; i < 40 && !port; i += 1) {
      await new Promise((r) => setTimeout(r, 100));
      try { port = Number(fs.readFileSync(portFile, 'utf8')); } catch { /* 等启动 */ }
    }
    assert.ok(port > 0, '目标 server 子进程未起来');
    const last = () => JSON.parse(fs.readFileSync(portFile + '.last', 'utf8'));

    assertCode(member.set(home, { slug: '无url的api', adapter_kind: 'api' }), 'BAD_INPUT', 'api 缺 url 必须拒绝');
    assertCode(member.set(home, { slug: '坏url的api', adapter_kind: 'api', url: 'ftp://x/y' }), 'BAD_INPUT', 'api url 必须 http(s)');
    must(member.set(home, { slug: 'gui宿主', adapter_kind: 'api', url: `http://127.0.0.1:${port}/wake`, headers: { 'X-ZJZ': '1' } }), 'api 注册');

    const marker = path.join(home, 'never_spawn.txt');
    const evil = fakeScript(home, 'evil_api.mjs', `import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(marker)}, 'x');`);
    must(member.set(home, { slug: 'gui宿主2', adapter_kind: 'api', url: `http://127.0.0.1:${port}/wake2`, argv: ['node', evil] }), 'api 注册带杂项 argv');

    const res = must(adapter.run(home, { slug: 'gui宿主', messages: [{ room_id: 'room_g', seq: 3, author: 'zjz-甲', text: '这条正文必须出现在API投递体里' }] }), 'api run');
    assert.equal(res.status, 'api_delivered');
    assert.equal(res.http, 200);
    assert.equal(res.spawned, false, 'api 形态绝不 spawn 宿主进程');
    const recv = last();
    assert.ok(recv.body.includes('这条正文必须出现在API投递体里'), '投递体含 pending 正文');
    assert.ok(recv.body.includes('zjz.mjs resume'), '投递体含 resume 协议');
    assert.equal(recv.headers['x-zjz'], '1', '自定义 header 生效');

    const res2 = must(adapter.run(home, { slug: 'gui宿主2', task: 't' }), 'api run with stray argv');
    assert.equal(res2.status, 'api_delivered');
    assert.ok(!fs.existsSync(marker), 'api 形态绝不允许执行任何进程');

    must(member.set(home, { slug: 'gui坏端', adapter_kind: 'api', url: `http://127.0.0.1:${port}/fail`, max_consecutive: 1 }), 'api 失败端注册');
    const bad = adapter.run(home, { slug: 'gui坏端', task: 't' });
    assert.equal(bad.status, 'api_failed');
    assert.equal(bad.http, 500, '非 2xx＝api_failed');
    assertCode(adapter.run(home, { slug: 'gui坏端', task: 't' }), 'ADAPTER_MAX_CONSECUTIVE', 'api 连败同样熔断（升级交 wake）');
  } finally {
    child.kill();
  }
});

// ---- 常驻指令与唤醒策略 ----
test('M53 instructions 焊进任务体首段；wake_policy 非法拒绝', () => {
  const home = tmpHome();
  const fake = fakeScript(home, 'fake_ins.mjs', FAKE_SPAWN);
  assertCode(member.set(home, { slug: '指1', adapter_kind: 'spawn', argv: ['node', fake, '{task}'], wake_policy: 'sometimes' }), 'BAD_INPUT', 'wake_policy 枚举');
  assertCode(member.set(home, { slug: '指2', adapter_kind: 'spawn', argv: ['node', fake, '{task}'], instructions: '  ' }), 'BAD_INPUT', 'instructions 非空');
  must(member.set(home, {
    slug: '指3', adapter_kind: 'spawn', argv: ['node', fake, '{task}'],
    instructions: '你是数字分身：回帖只发一次，用指定命令。', wake_policy: 'mention',
  }), '注册含常驻指令');
  const res = must(adapter.run(home, { slug: '指3', messages: [{ room_id: 'r', seq: 1, text: '待处理消息' }] }), 'run');
  assert.equal(res.status, 'spawned');
  const out = JSON.parse(fs.readFileSync(path.join(home, 'spawn_out.json'), 'utf8'));
  assert.ok(out.task.startsWith('你是数字分身'), '常驻指令＝任务体首段（醒来看见的第一段话）');
  assert.ok(out.task.includes('待处理消息') && out.task.includes('zjz.mjs resume'), '正文与 resume 协议仍在');
});

// ---- 防呆：连续失败熔断＋冷却 ----
test('M48 连续失败达 max_consecutive 熔断；cooldown 窗口内不重复拉起', () => {
  const home = tmpHome();
  const fake = fakeScript(home, 'fake_fail.mjs', FAKE_FAIL);
  must(member.set(home, { slug: '脆弱者', adapter_kind: 'spawn', argv: ['node', fake, '{task}'], max_consecutive: 2 }), 'register');

  const r1 = adapter.run(home, { slug: '脆弱者', task: 't1' });
  assert.equal(r1.ok, true); assert.equal(r1.status, 'spawn_failed');
  const r2 = adapter.run(home, { slug: '脆弱者', task: 't2' });
  assert.equal(r2.ok, true); assert.equal(r2.status, 'spawn_failed');
  const r3 = adapter.run(home, { slug: '脆弱者', task: 't3' });
  assertCode(r3, 'ADAPTER_MAX_CONSECUTIVE', '第三次必须熔断（升级交 wake/值班）');

  must(member.set(home, { slug: '冷却者', adapter_kind: 'spawn', argv: ['node', fake, '{task}'], cooldown_ms: 600000 }), 'register cooldown');
  const c1 = adapter.run(home, { slug: '冷却者', task: 't' });
  assert.equal(c1.status, 'spawn_failed'); // 首次允许跑
  const c2 = adapter.run(home, { slug: '冷却者', task: 't' });
  assert.equal(c2.status, 'cooldown', '冷却窗口内不得再拉起');
  assert.ok(c2.wait_ms > 0);
});

// ---- 熔断复位（实弹教训 2026-11-09：闩锁后无复位路径＝成员永久失联且监督环空转） ----
test('M54 adapter.state 点名闩锁；reset 复位后可再拉起（wake tick 见 latched 须停止派发）', () => {
  const home = tmpHome();
  const failFake = fakeScript(home, 'fake_fail54.mjs', FAKE_FAIL);
  const okFake = fakeScript(home, 'fake_ok54.mjs', FAKE_SPAWN);
  must(member.set(home, { slug: '闩锁者', adapter_kind: 'spawn', argv: ['node', failFake, '{task}'], max_consecutive: 2 }), 'register');
  adapter.run(home, { slug: '闩锁者', task: 't1' });
  adapter.run(home, { slug: '闩锁者', task: 't2' });
  assertCode(adapter.run(home, { slug: '闩锁者', task: 't3' }), 'ADAPTER_MAX_CONSECUTIVE', '先熔一段');
  const st = must(adapter.state(home, { slug: '闩锁者' }), 'state');
  assert.equal(st.latched, true, 'state 必须点名闩锁（wake 层据此停止派发，值班板据此开单）');
  assert.equal(st.consecutive_failures, 2);
  assertCode(adapter.run(home, { slug: '闩锁者', task: 't4' }), 'ADAPTER_MAX_CONSECUTIVE', '未复位不得自动复活');
  must(adapter.reset(home, { slug: '闩锁者' }), 'reset');
  assert.equal(must(adapter.state(home, { slug: '闩锁者' }), 'state2').latched, false, '复位后解除闩锁');
  must(member.set(home, { slug: '闩锁者', adapter_kind: 'spawn', argv: ['node', okFake, '{task}'] }), '修好适配器');
  assert.equal(must(adapter.run(home, { slug: '闩锁者', task: 't5' }), 'run 复位后').status, 'spawned', '复位＋修好后必须能再拉起');
});

// ---- E14：成员级 timeout_ms；超时必须报 ADAPTER_TIMEOUT，不得误报成"拉不起来" ----
const FAKE_SLOW = 'await new Promise((r) => setTimeout(r, 5000));\n';

test('E14-A 成员级 timeout_ms 生效；超时＝ADAPTER_TIMEOUT（elapsed、exit=null），不进 ADAPTER_SPAWN_FAILED', () => {
  const home = tmpHome();
  const slow = fakeScript(home, 'fake_slow_e14.mjs', FAKE_SLOW);
  must(member.set(home, { slug: '慢宿主', adapter_kind: 'spawn', argv: ['node', slow, '{task}'], timeout_ms: 1000 }), 'register 慢宿主（成员级 timeout_ms=1000）');
  assert.equal(must(member.get(home, '慢宿主'), 'get 慢宿主').member.timeout_ms, 1000, 'timeout_ms 必须落到档案');

  const r = must(adapter.run(home, { slug: '慢宿主', task: 't' }), 'run 慢宿主');
  assert.equal(r.status, 'timeout');
  assert.equal(r.code, 'ADAPTER_TIMEOUT', '超时码必须是 ADAPTER_TIMEOUT');
  assert.equal(r.exit, null, '超时 exit=null');
  assert.ok(r.elapsed_ms >= 1000, `elapsed_ms 应 ≥1000，实际 ${r.elapsed_ms}`);
  assert.equal(r.timeout_ms, 1000);
});

test('E14-B 真拉不起来（ENOENT）＝ADAPTER_SPAWN_FAILED，且带 errno', () => {
  const home = tmpHome();
  must(member.set(home, { slug: '拉不起来', adapter_kind: 'spawn', argv: ['此可执行不存在_e14.exe', '{task}'], timeout_ms: 5000 }), 'register 不存在的可执行');
  const r = must(adapter.run(home, { slug: '拉不起来', task: 't' }), 'run 拉不起来');
  assert.equal(r.status, 'spawn_failed');
  assert.equal(r.code, 'ADAPTER_SPAWN_FAILED');
  assert.equal(r.exit, null);
  assert.ok(typeof r.errno === 'string' && r.errno.length > 0, `必须带 errno，实际 ${JSON.stringify(r.errno)}`);
});

test('E14-C timeout_ms 校验：拒绝 0/负数/非整数', () => {
  const home = tmpHome();
  const slow = fakeScript(home, 'fake_slow_e14c.mjs', FAKE_SLOW);
  assertCode(member.set(home, { slug: '坏超时0', adapter_kind: 'spawn', argv: ['node', slow, '{task}'], timeout_ms: 0 }), 'BAD_INPUT', 'timeout_ms=0 必须拒绝');
  assertCode(member.set(home, { slug: '坏超时负', adapter_kind: 'spawn', argv: ['node', slow, '{task}'], timeout_ms: -1 }), 'BAD_INPUT', '负 timeout_ms 必须拒绝');
  assertCode(member.set(home, { slug: '坏超时浮点', adapter_kind: 'spawn', argv: ['node', slow, '{task}'], timeout_ms: 1234.5 }), 'BAD_INPUT', '非整数 timeout_ms 必须拒绝');
});
// ---- E20：member set 不建身份不进房＝配置死的；wiring 把缺哪步摆到台面 ----
test('E20-A wiring：无身份无房＝MEMBER_NOT_IN_ROOM，补身份后仍提示未进房，进房后 wired', () => {
  const home = tmpHome();
  const w0 = must(member.wiring(home, '待接线'), 'wiring 空');
  assert.equal(w0.wired, false);
  assert.equal(w0.has_identity, false);
  assert.equal(w0.rooms.length, 0);
  assert.equal(w0.warning.code, 'MEMBER_NOT_IN_ROOM');
  assert.match(w0.warning.message, /member wire/, '告警必须给一条命令的补法');

  must(member.set(home, { slug: '待接线', adapter_kind: 'notify' }), 'set 不接线也能写配置');
  const w1 = must(member.wiring(home, '待接线'), 'wiring 写完配置');
  assert.equal(w1.wired, false, '只写适配器配置不算接通');
  assert.equal(w1.warning.code, 'MEMBER_NOT_IN_ROOM');

  // 建身份＋进房后必须翻绿
  const ident = must(identity.create(home, '待接线'), 'identity');
  const roomRow = must(room.create(home, ident.slug, '接线房'), 'room');
  const roomHome = path.join(home, 'data', 'rooms', roomRow.room_id, 'members.json');
  fs.mkdirSync(path.dirname(roomHome), { recursive: true });
  fs.writeFileSync(roomHome, JSON.stringify([{ slug: ident.slug, cursor: 0 }]), 'utf8');
  const w2 = must(member.wiring(home, ident.slug), 'wiring 接通');
  assert.equal(w2.wired, true);
  assert.equal(w2.warning, null);
  assert.equal(w2.has_identity, true);
  assert.equal(w2.rooms.length, 1);
});
// ---- E28：多智能体接入（主人问「如何让智能体加入这里」→ 接入命令必须有对位测试）----
test('E28-A member wire 一条命令=建身份+进房+绑适配器；两个智能体都能接进来', () => {
  const home = tmpHome();
  const ident = must(identity.create(home, '房主'), 'identity owner');
  const roomRow = must(room.create(home, ident.slug, '多智能体房'), 'room');

  const a = must(member.wiring(home, 'agent-A'), 'wiring A 起点');
  assert.equal(a.wired, false, '起点必须是未接通');

  const adapterA = path.join(home, 'a.json');
  fs.writeFileSync(adapterA, JSON.stringify(['node', '-e', 'process.exit(0)', '{task}']), 'utf8');
  const wa = must(member.wire(home, { slug: 'agent-A', room_id: roomRow.room_id, name: '智能体甲', adapter_kind: 'spawn', argv: ['node', '-e', 'process.exit(0)', '{task}'] }), 'wire A');
  assert.ok(wa.slug, 'wire 必须返回真实 slug');
  assert.equal(wa.joined, 'joined');
  assert.equal(must(member.wiring(home, wa.slug), 'wiring A 之后').wired, true, 'A 必须接通');

  const wb = must(member.wire(home, { slug: 'agent-B', room_id: roomRow.room_id, name: '智能体乙', adapter_kind: 'notify' }), 'wire B');
  assert.equal(must(member.wiring(home, wb.slug), 'wiring B').wired, true, 'B 必须接通');

  const list = must(member.list(home), 'list');
  const slugs = list.members.map((r) => r.slug);
  assert.ok(slugs.includes(wa.slug) && slugs.includes(wb.slug), `两个智能体都应在册，实际 ${JSON.stringify(slugs)}`);

  const roster = must(room.members(home, ident.slug, roomRow.room_id), '房名单');
  const roomSlugs = roster.members.map((m) => m.slug);
  assert.ok(roomSlugs.includes(wa.slug) && roomSlugs.includes(wb.slug), `两个都应进房，实际 ${JSON.stringify(roomSlugs)}`);
});

test('E28-B member wire 坏输入必须挡住：无房间/无适配器不静默建档', () => {
  const home = tmpHome();
  const ident = must(identity.create(home, '房主B'), 'identity');
  const roomRow = must(room.create(home, ident.slug, '校验房'), 'room');

  const noRoom = member.wire(home, { slug: 'x', room_id: 'room_不存在', adapter_kind: 'notify' });
  assert.equal(noRoom.ok, false, '房间不存在必须报错');
  assert.equal(noRoom.code, 'NOT_FOUND');

  const badKind = member.wire(home, { slug: 'y', room_id: roomRow.room_id, adapter_kind: 'spawn' });
  assert.equal(badKind.ok, false, 'spawn 必须有 argv，否则不许建档');
  assert.equal(badKind.code, 'BAD_INPUT');
});