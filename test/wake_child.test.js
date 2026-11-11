import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { registerWakeChild, clearWakeChild, wakeChildStatus } from '../src/wake.js';

function tmpHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'zjz-wakechild-'));
}

function must(res, where) {
  assert.equal(res && res.ok, true, `${where} 应成功，实际 ${JSON.stringify(res)}`);
  return res;
}

test('E16-A 子进程登记带 pid＋命令行前缀；退出后清账', async () => {
  const home = tmpHome();
  const child = spawn(process.execPath, ['-e', 'setTimeout(()=>{}, 30000)'], { windowsHide: true, stdio: 'ignore' });
  must(registerWakeChild(home, '分身甲', child.pid, [process.execPath, '-e', 'setTimeout(()=>{}, 30000)']), 'register');

  const st = must(wakeChildStatus(home, '分身甲'), 'status');
  assert.equal(st.registered, true);
  assert.equal(st.pid, child.pid);
  assert.equal(st.alive, true, '存活时 alive=true');
  assert.equal(st.matched, true, '命令行前缀匹配时 matched=true');

  const c = must(clearWakeChild(home, '分身甲', child.pid), 'clear');
  assert.equal(c.cleared, true, '清账应命中 pid');
  assert.equal(wakeChildStatus(home, '分身甲').registered, false, '清账后不留残档');
  child.kill();
});

test('E16-B 按 pid 校验：pid 不匹配不得误判为自己的子进程（禁按名模糊匹配）', async () => {
  const home = tmpHome();
  const child = spawn(process.execPath, ['-e', 'setTimeout(()=>{}, 30000)'], { windowsHide: true, stdio: 'ignore' });
  must(registerWakeChild(home, '分身乙', child.pid, [process.execPath, '-e', 'setTimeout(()=>{}, 30000)']), 'register');

  // 故意登记一个无关 pid（模拟别人家的同名进程），不得被认作自己的子进程
  must(registerWakeChild(home, '分身乙', 999999, [process.execPath, '-e', 'setTimeout(()=>{}, 30000)']), 'overwrite with bogus pid');
  const st = must(wakeChildStatus(home, '分身乙'), 'status');
  assert.equal(st.pid, 999999);
  assert.equal(st.alive, false, 'pid 999999 不在＝alive=false，绝不按名字去认领');
  assert.equal(st.matched, false, '不在即不匹配');

  const c = must(clearWakeChild(home, '分身乙', child.pid), 'clear with real pid');
  assert.equal(c.cleared, false, 'pid 不同不得清掉别人的档');
  assert.equal(wakeChildStatus(home, '分身乙').registered, true, '档仍在');
  child.kill();
});
// ---- E22：答完一条后被隐形锁死——孤儿 batch 必须被对账收口并补 read_at ----
import { delivery as deliveryApi } from '../src/delivery.js';
import { wake as wakeApi } from '../src/wake.js';
import { identity as identityApi, room as roomApi } from '../src/core.js';

test('E22-A 孤儿 open batch（子进程已不在）→ 对账收口 child_gone 并补 read_at', () => {
  const home = tmpHome();
  const ident = must(identityApi.create(home, '被锁分身'), 'identity');
  const roomRow = must(roomApi.create(home, ident.slug, 'E22房'), 'room');
  const membersFile = path.join(home, 'data', 'rooms', roomRow.room_id, 'members.json');
  fs.mkdirSync(path.dirname(membersFile), { recursive: true });
  fs.writeFileSync(membersFile, JSON.stringify([{ slug: ident.slug, cursor: 0 }]), 'utf8');
  must(deliveryApi.post(home, { room_id: roomRow.room_id, msg_id: 'm_e22_1', sender: '提问人', recipient: ident.slug }), 'post');

  // 手工造一个 open batch，且 children.json 里没有它（＝子进程已死/退出）
  const batchFile = path.join(home, 'data', 'wake', 'batches.json');
  fs.mkdirSync(path.dirname(batchFile), { recursive: true });
  const orphan = {
    batch_id: 'wakebatch_e22_orphan',
    slug: ident.slug,
    status: 'open',
    opened_at: new Date(Date.now() - 12 * 60 * 1000).toISOString(),
    closed_at: null,
    expires_at: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
    messages: [{ room_id: roomRow.room_id, msg_id: 'm_e22_1', seq: 1 }],
  };
  fs.writeFileSync(batchFile, JSON.stringify({ records: [orphan] }, null, 2), 'utf8');

  const r = must(wakeApi.reconcileBatches(home), 'reconcile');
  assert.equal(r.reconciled, 1, `应恰好收口 1 个孤儿 batch，实际 ${JSON.stringify(r)}`);

  const batches = JSON.parse(fs.readFileSync(batchFile, 'utf8')).records;
  assert.equal(batches[0].status, 'child_gone', '孤儿 batch 必须收口，不得挂满一个租期');
  assert.ok(batches[0].closed_at, 'closed_at 必须写');

  const board = must(deliveryApi.board(home, {}), 'board');
  const row = board.rows.find((item) => item.msg_id === 'm_e22_1');
  assert.ok(row && row.read_at, `read_at 必须补上，实际 ${JSON.stringify(row)}`);

  // 再对账必须幂等，不重复收口
  const r2 = must(wakeApi.reconcileBatches(home), 'reconcile 2');
  assert.equal(r2.reconciled, 0);
});

test('E22-B 活着的子进程对应的 open batch 不得被误收口', () => {
  const home = tmpHome();
  const ident = must(identityApi.create(home, '在跑分身'), 'identity');
  const roomRow = must(roomApi.create(home, ident.slug, 'E22房B'), 'room');
  const membersFile = path.join(home, 'data', 'rooms', roomRow.room_id, 'members.json');
  fs.mkdirSync(path.dirname(membersFile), { recursive: true });
  fs.writeFileSync(membersFile, JSON.stringify([{ slug: ident.slug, cursor: 0 }]), 'utf8');

  const alive = spawn(process.execPath, ['-e', 'setTimeout(()=>{}, 30000)'], { windowsHide: true, stdio: 'ignore' });
  try {
    must(wakeApi.exec ? { ok: true } : { ok: true }, 'noop');
    const childFile = path.join(home, 'data', 'wake', 'children.json');
    fs.mkdirSync(path.dirname(childFile), { recursive: true });
    fs.writeFileSync(childFile, JSON.stringify({ [ident.slug]: { pid: alive.pid, prefix: [process.execPath], started_at: new Date().toISOString() } }), 'utf8');

    const batchFile = path.join(home, 'data', 'wake', 'batches.json');
    fs.mkdirSync(path.dirname(batchFile), { recursive: true });
    fs.writeFileSync(batchFile, JSON.stringify({ records: [{ batch_id: 'wakebatch_e22_live', slug: ident.slug, status: 'open', opened_at: new Date().toISOString(), closed_at: null, expires_at: new Date(Date.now() + 600000).toISOString(), messages: [] }] }), 'utf8');

    const r = must(wakeApi.reconcileBatches(home), 'reconcile live');
    assert.equal(r.reconciled, 0, '子进程还在跑的 batch 不得误收口');
    const batches = JSON.parse(fs.readFileSync(batchFile, 'utf8')).records;
    assert.equal(batches[0].status, 'open');
  } finally {
    try { alive.kill(); } catch { /* already gone */ }
  }
});