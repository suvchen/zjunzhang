// 中军帐 M2-B 哨兵测试：I13-I17
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import * as zjz from '../src/core.js';
import { listen } from '../src/listen.js';

let watchdog = null;
try {
  ({ watchdog } = await import('../src/watchdog.js'));
} catch {
  watchdog = null;
}

function tmpHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'zjz-m2b-'));
}

function must(res, where) {
  assert.equal(res && res.ok, true, `${where} 应成功，实际 ${JSON.stringify(res)}`);
  return res;
}

function assertCode(res, code, where) {
  assert.equal(res && res.ok, false, `${where} 应失败，实际 ${JSON.stringify(res)}`);
  assert.equal(res.code, code, `${where} 错误码应为 ${code}，实际 ${res.code}`);
}

function setup() {
  const home = tmpHome();
  const id = must(zjz.identity.create(home, '值班员'), 'identity');
  return { home, id };
}

function leaseFile(home) {
  return path.join(home, 'data', 'listen', 'lease.json');
}

// ---------- T13 I13 ----------
test('T13 I13 监听崩溃/漏唤醒时 wait 仍收齐消息，不重不漏', async () => {
  delete process.env.ZJZ_DAEMON;
  const { home, id } = setup();
  const room = must(zjz.room.create(home, id.slug, '断链房'), 'room');

  const st = must(listen.status(home), 'status');
  assert.equal(st.running, false, '未启动时不应有活监听');

  const timer = setTimeout(() => {
    zjz.msg.send(home, id.slug, room.room_id, '监听崩溃后仍要收到');
  }, 150);
  const startedAt = Date.now();
  const first = await zjz.msg.waitAsync(home, id.slug, { timeout_ms: 1500 });
  const elapsed = Date.now() - startedAt;
  clearTimeout(timer);

  assert.equal(first.ok, true, JSON.stringify(first));
  assert.deepEqual(first.messages.map((m) => m.text), ['监听崩溃后仍要收到']);
  const POLL_UPPER_BOUND_MS = 2500;
  assert.ok(elapsed <= POLL_UPPER_BOUND_MS, `监听崩溃时有界轮询应在 ${POLL_UPPER_BOUND_MS}ms 内收齐，实际 ${elapsed}ms`);

  const second = await zjz.msg.waitAsync(home, id.slug, { timeout_ms: 60 });
  assert.deepEqual(second.messages, [], '第二次不应重复投递');

  process.env.ZJZ_DAEMON = '0';
  try {
    const timer2 = setTimeout(() => {
      zjz.msg.send(home, id.slug, room.room_id, '纯轮询兜底');
    }, 50);
    const pollStarted = Date.now();
    const polled = await zjz.msg.waitAsync(home, id.slug, { timeout_ms: 1000 });
    const pollElapsed = Date.now() - pollStarted;
    clearTimeout(timer2);
    assert.deepEqual(polled.messages.map((m) => m.text), ['纯轮询兜底']);
    assert.ok(pollElapsed <= 500, `ZJZ_DAEMON=0 时 100ms 轮询上界应 <=500ms，实际 ${pollElapsed}ms`);
  } finally {
    delete process.env.ZJZ_DAEMON;
  }
});

// ---------- T14 I14 ----------
test('T14 I14 监听单例、租约接管与 epoch 围栏', () => {
  const { home } = setup();

  const a = must(listen.acquire(home, { pid: 1111, ttl_ms: 15000 }), 'acquire A');
  assert.equal(a.epoch, 1);
  assert.equal(a.lease.pid, 1111);

  const renew = must(listen.acquire(home, { pid: 1111, ttl_ms: 15000 }), 'renew A');
  assert.equal(renew.epoch, 1, '同 pid 重入应续租不换 epoch');

  const b = listen.acquire(home, { pid: 2222, ttl_ms: 15000 });
  assertCode(b, 'LEASE_HELD', '第二进程抢租约');
  assert.equal(b.lease.pid, 1111);

  const file = leaseFile(home);
  const staleLease = JSON.parse(fs.readFileSync(file, 'utf8'));
  staleLease.heartbeat_at = new Date(Date.now() - 60000).toISOString();
  fs.writeFileSync(file, JSON.stringify(staleLease, null, 2) + '\n', 'utf8');

  const c = must(listen.acquire(home, { pid: 2222, ttl_ms: 15000 }), '接管过期租约');
  assert.equal(c.epoch, 2, '接管必须递增 epoch');
  assert.equal(c.lease.pid, 2222);

  const stale = listen.broadcast(home, { pid: 1111, epoch: 1 });
  assertCode(stale, 'STALE_EPOCH', '旧 epoch 广播');
  const fresh = must(listen.broadcast(home, { pid: 2222, epoch: 2 }), '新 epoch 广播');
  assert.equal(fresh.delivered, 0, '无客户端时事件文件兜底，投递 0');

  must(listen.release(home, { pid: 2222, epoch: 2 }), 'release');

  const next = must(listen.acquire(home, { pid: 3333, ttl_ms: 15000 }), 'reacquire');
  assert.equal(next.epoch, 3, '释放后新租约继续递增，防旧进程复活');

  fs.writeFileSync(file, '{"pid": 3333, "epoch":', 'utf8');
  const corrupt = must(listen.status(home), 'status corrupt');
  assert.equal(corrupt.running, false, '半写租约视为不活');
  assert.equal(corrupt.corrupt, true, '损坏租约应显式标记');
  const taken = must(listen.acquire(home, { pid: 4444, ttl_ms: 15000 }), 'takeover corrupt');
  assert.equal(taken.epoch, 4, '损坏租约接管必须继续递增 epoch');
  assert.equal(taken.takeover, true);
  const stale2 = listen.broadcast(home, { pid: 3333, epoch: 3 });
  assertCode(stale2, 'STALE_EPOCH', '损坏接管后旧 epoch 广播');
});

// ---------- T15 I15 ----------
test('T15 I15 看门狗换班幂等、不重复投递、checkpoint 单调', async () => {
  assert.ok(watchdog, 'src/watchdog.js 未实现（红测）');
  const home = tmpHome();
  const day = must(zjz.identity.create(home, '白班'), 'day');
  const night = must(zjz.identity.create(home, '夜班'), 'night');
  const room = must(zjz.room.create(home, day.slug, '看门狗房'), 'room');
  must(zjz.room.join(home, night.slug, room.invite_code), 'join');

  for (const t of ['1', '2', '3']) must(zjz.msg.send(home, day.slug, room.room_id, t), 'send 1-3');
  const before = await zjz.msg.waitAsync(home, day.slug, { timeout_ms: 50 });
  assert.deepEqual(before.messages.map((m) => m.seq), [1, 2, 3]);
  for (const t of ['4', '5']) must(zjz.msg.send(home, day.slug, room.room_id, t), 'send 4-5');

  must(zjz.duty.set(home, day.slug, {
    mode: 'oncall',
    watchdog: { successor: night.slug, max_age_ms: 1000, check_ms: 1000 },
  }), 'duty day');
  must(zjz.duty.heartbeat(home, day.slug), 'heartbeat day');

  const later = Date.now() + 60000;
  const first = must(watchdog.tick(home, { now: later }), 'tick 1');
  assert.equal(first.shifted.length, 1, '超龄应换班一次');
  assert.equal(first.shifted[0].from, day.slug);
  assert.equal(first.shifted[0].to, night.slug);
  assert.equal(first.shifted[0].checkpoint.rooms[room.room_id], 3, 'checkpoint 应为已读游标 3');

  const handover = await zjz.msg.waitAsync(home, night.slug, { timeout_ms: 100 });
  assert.deepEqual(handover.messages.map((m) => m.seq), [4, 5], '接班人只收 checkpoint 之后');

  const second = must(watchdog.tick(home, { now: later + 1000 }), 'tick 2');
  assert.equal(second.shifted.length, 0, '同一超龄事件不得二次换班');
  const noRepeat = await zjz.msg.waitAsync(home, night.slug, { timeout_ms: 50 });
  assert.deepEqual(noRepeat.messages, [], '换班不得重复投递');

  const readActions = () => fs.readFileSync(path.join(home, 'data', 'watchdog', 'actions.jsonl'), 'utf8')
    .trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
  const actions = readActions();
  assert.equal(actions.filter((a) => a.action === 'shift').length, 1, '台账只记一条 shift');
  const shiftAction = actions.find((a) => a.action === 'shift');
  assert.ok(Number.isInteger(shiftAction.epoch) && shiftAction.epoch >= 1, '动作必须带 epoch');
  assert.deepEqual(shiftAction.checkpoint_before, {}, '首次换班前无既有 checkpoint');
  assert.deepEqual(shiftAction.checkpoint_after, { [room.room_id]: 3 }, '动作必须带换班后 checkpoint');

  must(zjz.duty.shift(home, night.slug, {
    to: day.slug,
    checkpoint: { rooms: { [room.room_id]: 5 } },
  }), 'shift back');
  must(zjz.duty.set(home, day.slug, {
    mode: 'oncall',
    watchdog: { successor: night.slug, max_age_ms: 1000, check_ms: 1000 },
  }), 'duty day again');
  must(zjz.duty.heartbeat(home, day.slug), 'heartbeat day again');

  const back = must(watchdog.tick(home, { now: Date.now() + 120000 }), 'tick back');
  assert.equal(back.shifted.length, 1);
  assert.equal(back.shifted[0].checkpoint.rooms[room.room_id], 5, 'checkpoint 不得倒退');

  must(zjz.msg.send(home, day.slug, room.room_id, '6'), 'send 6');
  const next = await zjz.msg.waitAsync(home, night.slug, { timeout_ms: 100 });
  assert.deepEqual(next.messages.map((m) => m.seq), [6]);

  const shiftActions = readActions().filter((a) => a.action === 'shift');
  assert.equal(shiftActions.length, 2);
  assert.deepEqual(shiftActions[1].checkpoint_before, { [room.room_id]: 5 }, '第二次换班前 checkpoint 应可见');
  assert.deepEqual(shiftActions[1].checkpoint_after, { [room.room_id]: 5 }, 'checkpoint 不得倒退');
  assert.ok(shiftActions[1].epoch > shiftActions[0].epoch, '动作 epoch 必须递增');
});

// ---------- T17 I17 ----------
test('T17 I17 M2-A 兼容：无 watchdog/listen 时 duty.shift 语义不变', async () => {
  const home = tmpHome();
  const day = must(zjz.identity.create(home, '白班'), 'day');
  const night = must(zjz.identity.create(home, '夜班'), 'night');
  const room = must(zjz.room.create(home, day.slug, '兼容房'), 'room');
  must(zjz.room.join(home, night.slug, room.invite_code), 'join');

  for (const t of ['1', '2', '3']) must(zjz.msg.send(home, day.slug, room.room_id, t), 'send 1-3');
  const before = await zjz.msg.waitAsync(home, day.slug, { timeout_ms: 50 });
  assert.deepEqual(before.messages.map((m) => m.seq), [1, 2, 3]);
  for (const t of ['4', '5']) must(zjz.msg.send(home, day.slug, room.room_id, t), 'send 4-5');

  const duty = must(zjz.duty.set(home, day.slug, { mode: 'oncall' }), 'duty set');
  assert.equal(duty.watchdog, null, '未配置时 watchdog 必须为 null');
  const ticked = must(watchdog.tick(home, { now: Date.now() + 3600000 }), 'tick no config');
  assert.equal(ticked.checked, 0, '无 watchdog 配置不应被检查');
  assert.equal(ticked.shifted.length, 0, '无 watchdog 配置不应换班');

  const shift = must(zjz.duty.shift(home, day.slug, { to: night.slug }), 'manual shift');
  assert.equal(shift.checkpoint.rooms[room.room_id], 3, 'M2-A checkpoint 语义不变');
  const handover = await zjz.msg.waitAsync(home, night.slug, { timeout_ms: 100 });
  assert.deepEqual(handover.messages.map((m) => m.seq), [4, 5]);

  const st = must(watchdog.status(home, night.slug), 'status');
  assert.equal(st.enabled, false, '接班者未配置 watchdog');
  assert.equal(st.stale, false);
});

// ---------- T16 I16 ----------
test('T16 I16 监听断链后自愈，期间消息不丢不重', async () => {
  const { home, id } = setup();
  const room = must(zjz.room.create(home, id.slug, '自愈房'), 'room');
  must(zjz.msg.send(home, id.slug, room.room_id, '启动前'), 'send pre');

  const started = must(listen.start(home, { ttl_ms: 5000, heartbeat_ms: 1000 }), 'listen start');
  assert.ok(started.epoch >= 1);
  const live = must(listen.status(home), 'status live');
  assert.equal(live.running, true);

  const first = await zjz.msg.waitAsync(home, id.slug, { timeout_ms: 100 });
  assert.deepEqual(first.messages.map((m) => m.text), ['启动前']);

  must(listen.stop(home), 'listen stop');
  const dead = must(listen.status(home), 'status dead');
  assert.equal(dead.running, false, '停止后租约不应为活');

  must(zjz.msg.send(home, id.slug, room.room_id, '断链期间'), 'send during');
  const during = await zjz.msg.waitAsync(home, id.slug, { timeout_ms: 500 });
  assert.deepEqual(during.messages.map((m) => m.text), ['断链期间'], '断链期间消息不得丢');

  const restarted = must(listen.start(home, { ttl_ms: 5000, heartbeat_ms: 1000 }), 'listen restart');
  assert.ok(restarted.epoch >= 2, '重启必须换新 epoch');
  must(zjz.msg.send(home, id.slug, room.room_id, '恢复后'), 'send after');
  const after = await zjz.msg.waitAsync(home, id.slug, { timeout_ms: 500 });
  assert.deepEqual(after.messages.map((m) => m.text), ['恢复后']);
  must(listen.stop(home), 'listen stop final');
});




// ---------- T18 I14b ----------
test('T18 I14b 跨进程常驻监听：子进程持租约、进程死亡后按 TTL 失效', async () => {
  const { home, id } = setup();
  const room = must(zjz.room.create(home, id.slug, '跨进程房'), 'room');
  must(zjz.msg.send(home, id.slug, room.room_id, '子进程启动前'), 'send pre');

  const cli = path.join(import.meta.dirname, '..', 'bin', 'zjz.mjs');
  const child = spawn(process.execPath, [
    cli, 'listen', 'start', '--home', home, '--ttl-ms', '1000', '--heartbeat-ms', '300', '--timeout', '5',
  ], { stdio: 'ignore' });

  try {
    let live = null;
    for (let i = 0; i < 40; i += 1) {
      live = listen.status(home);
      if (live.ok && live.running) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal(live.running, true, '子进程应持有活租约');
    assert.equal(live.lease.pid, child.pid, '租约 pid 必须等于子进程 pid');

    const first = await zjz.msg.waitAsync(home, id.slug, { timeout_ms: 100 });
    assert.deepEqual(first.messages.map((m) => m.text), ['子进程启动前']);

    must(zjz.msg.send(home, id.slug, room.room_id, '子进程运行中'), 'send during');
    const during = await zjz.msg.waitAsync(home, id.slug, { timeout_ms: 500 });
    assert.deepEqual(during.messages.map((m) => m.text), ['子进程运行中']);
  } finally {
    child.kill();
    await new Promise((resolve) => child.once('exit', resolve));
  }

  await new Promise((resolve) => setTimeout(resolve, 1200));
  const dead = must(listen.status(home), 'status dead');
  assert.equal(dead.running, false, '进程死亡且超过 TTL 后租约不得再显示为活');
});


// ---------- T19 I14c ----------
test('T19 I14c 跨进程强制停止：force 终止持租约进程并释放租约', async () => {
  const { home, id } = setup();
  must(zjz.room.create(home, id.slug, '强制停止房'), 'room');
  const cli = path.join(import.meta.dirname, '..', 'bin', 'zjz.mjs');
  const child = spawn(process.execPath, [
    cli, 'listen', 'start', '--home', home, '--ttl-ms', '5000', '--heartbeat-ms', '500', '--timeout', '10',
  ], { stdio: 'ignore' });

  try {
    let live = null;
    for (let i = 0; i < 40; i += 1) {
      live = listen.status(home);
      if (live.ok && live.running) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal(live.running, true);
    assert.equal(live.lease.pid, child.pid);

    const stopped = must(listen.stop(home, { force: true }), 'force stop');
    assert.equal(stopped.released, true);
    assert.equal(stopped.killed, true);
    assert.equal(stopped.pid, child.pid);

    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('子进程未在 2s 内退出')), 2000);
      child.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    });
    const dead = must(listen.status(home), 'status after force');
    assert.equal(dead.running, false);
  } finally {
    if (!child.killed) child.kill();
  }
});

// ---------- T20 I13b ----------
test('T20 I13b 常驻监听唤醒通道：waitForChange 先于轮询感知变化且不消费消息', async () => {
  const { home, id } = setup();
  const room = must(zjz.room.create(home, id.slug, '唤醒房'), 'room');
  must(listen.start(home, { ttl_ms: 5000, heartbeat_ms: 500 }), 'listen start');

  try {
    const startedAt = Date.now();
    const waiter = listen.waitForChange(home, 1500);
    const timer = setTimeout(() => {
      zjz.msg.send(home, id.slug, room.room_id, '唤醒事件');
    }, 120);
    const event = must(await waiter, 'waitForChange');
    const elapsed = Date.now() - startedAt;
    clearTimeout(timer);

    assert.equal(event.changed, true, '发送消息应触发变化信号');
    assert.equal(event.attached, true, '应通过命名管道唤醒（非事件文件兜底）');
    assert.ok(elapsed <= 1000, `唤醒应明显早于 1500ms 超时，实际 ${elapsed}ms`);

    const delivered = await zjz.msg.waitAsync(home, id.slug, { timeout_ms: 500 });
    assert.deepEqual(delivered.messages.map((m) => m.text), ['唤醒事件'], '唤醒不得消费消息');
  } finally {
    must(listen.stop(home), 'listen stop');
  }
});

