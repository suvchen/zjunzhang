// 中军帐 M3 哨兵测试：I18-I22（质检台账 + 事件流）
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import * as zjz from '../src/core.js';

let qc = null;
let events = null;
try {
  ({ qc } = await import('../src/qc.js'));
} catch {
  qc = null;
}
try {
  ({ event: events } = await import('../src/events.js'));
} catch {
  events = null;
}

function tmpHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'zjz-m3-'));
}

function setup() {
  const home = tmpHome();
  const id = must(zjz.identity.create(home, '质检员'), 'identity');
  return { home, id };
}

function must(res, where) {
  assert.equal(res && res.ok, true, `${where} 应成功，实际 ${JSON.stringify(res)}`);
  return res;
}

function assertCode(res, code, where) {
  assert.equal(res && res.ok, false, `${where} 应失败，实际 ${JSON.stringify(res)}`);
  assert.equal(res.code, code, `${where} 错误码应为 ${code}，实际 ${res.code}`);
}

function artifact(home, name, content) {
  const dir = path.join(home, 'artifacts');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  fs.writeFileSync(file, content, 'utf8');
  return file;
}

// ---------- T21 I18 ----------
test('T21 I18 台账状态机与四栏关闭闸门', () => {
  assert.ok(qc, 'src/qc.js 未实现（红测）');
  const { home, id } = setup();
  const opened = must(qc.open(home, id.slug, {
    project: 'M3',
    title: '四栏闸门',
    variable_layer: '参数层',
    gates: ['frame', 'audio'],
  }), 'open');
  const caseId = opened.case_id;

  assertCode(qc.close(home, id.slug, caseId, {
    phenomenon: '表情木', attribution_layer: '参数层', fix: '16 步', repro_count: 2, conclusion: 'baseline',
  }), 'BAD_STATE', 'open 直接 close');

  must(qc.attach(home, id.slug, caseId, { path: artifact(home, 'base.mp4', 'base'), role: 'baseline' }), 'attach');
  let got = must(qc.get(home, caseId), 'get after attach');
  assert.equal(got.case.status, 'collecting');

  must(qc.machine(home, id.slug, caseId, { gate: 'frame', result: 'pass', metrics: { fps: 24 } }), 'machine frame');
  must(qc.machine(home, id.slug, caseId, { gate: 'audio', result: 'pass', metrics: { f0: 149.5 } }), 'machine audio');
  got = must(qc.get(home, caseId), 'get after machine');
  assert.equal(got.case.status, 'machine_checked');

  must(qc.human(home, id.slug, caseId, { verdict: 'pass', note: '东家目审' }), 'human');
  got = must(qc.get(home, caseId), 'get after human');
  assert.equal(got.case.status, 'human_verdict');

  assertCode(qc.close(home, id.slug, caseId, { phenomenon: '表情木' }), 'QC_INCOMPLETE', '缺四栏');
  assertCode(qc.close(home, id.slug, caseId, {
    phenomenon: '表情木',
    attribution_layer: '参数层',
    fix: '16 步',
    repro_count: 1,
    conclusion: 'baseline',
  }), 'QC_NOT_REPRODUCED', 'baseline 复现不足');

  const closed = must(qc.close(home, id.slug, caseId, {
    phenomenon: '表情木',
    attribution_layer: '参数层',
    fix: '16 步',
    repro_count: 2,
    repro_note: '两次同结果',
    conclusion: 'baseline',
  }), 'close');
  assert.equal(closed.case.status, 'closed');
  assert.equal(closed.case.repro_count, 2);

  const summary = must(qc.summary(home, caseId), 'summary');
  assert.ok(summary.summary.includes('表情木'));
  assert.ok(summary.summary.includes('参数层'));
  assert.ok(summary.summary.includes('16 步'));
  assert.ok(summary.summary.includes('2'));
});

// ---------- T22 I19 ----------
test('T22 I19 证据哈希互异、重挂幂等与 verify 防篡改', () => {
  assert.ok(qc, 'src/qc.js 未实现（红测）');
  const { home, id } = setup();
  const caseId = must(qc.open(home, id.slug, { project: 'M3', title: '证据防伪', gates: ['frame'] }), 'open').case_id;

  const base = artifact(home, 'base.mp4', 'AAAA');
  const cand = artifact(home, 'cand.mp4', 'BBBB');
  const copy = artifact(home, 'copy.mp4', 'AAAA');

  must(qc.attach(home, id.slug, caseId, { path: base, role: 'baseline' }), 'attach base');
  must(qc.attach(home, id.slug, caseId, { path: cand, role: 'candidate' }), 'attach cand');
  const again = must(qc.attach(home, id.slug, caseId, { path: base, role: 'baseline' }), 'reattach base');
  assert.equal(again.case.evidence.length, 2, '同文件同角色应幂等');

  assertCode(qc.attach(home, id.slug, caseId, { path: copy, role: 'fixed' }), 'EVIDENCE_DUPLICATE', '跨角色同哈希');

  let verified = must(qc.verify(home, caseId), 'verify clean');
  assert.equal(verified.intact, true);
  assert.equal(verified.mismatches.length, 0);

  fs.writeFileSync(cand, 'BBBC', 'utf8');
  verified = must(qc.verify(home, caseId), 'verify tampered');
  assert.equal(verified.intact, false);
  assert.equal(verified.mismatches.length, 1);
  assert.equal(verified.mismatches[0].reason, 'hash');

  fs.unlinkSync(base);
  verified = must(qc.verify(home, caseId), 'verify missing');
  assert.equal(verified.intact, false);
  assert.ok(verified.mismatches.some((m) => m.reason === 'missing'));
});

// ---------- T23 I20 ----------
test('T23 I20 机器判定接口与人工终判隔离', () => {
  assert.ok(qc, 'src/qc.js 未实现（红测）');
  const { home, id } = setup();
  const caseId = must(qc.open(home, id.slug, { project: 'M3', title: '机器闸', gates: ['frame', 'audio'] }), 'open').case_id;

  assertCode(qc.machine(home, id.slug, caseId, { gate: 'color', result: 'pass' }), 'BAD_GATE', '未注册 gate');

  must(qc.machine(home, id.slug, caseId, { gate: 'frame', result: 'pass', metrics: { r: 1 } }), 'frame pass');
  must(qc.machine(home, id.slug, caseId, { gate: 'audio', result: 'insufficient', metrics: { lag: null } }), 'audio insufficient');

  let got = must(qc.get(home, caseId), 'get insufficient');
  assert.equal(got.aggregate.machine, 'insufficient', '缺证据不得聚合为 pass');

  must(qc.machine(home, id.slug, caseId, { gate: 'frame', result: 'fail', metrics: { r: 0.1 } }), 'frame fail');
  got = must(qc.get(home, caseId), 'get fail');
  assert.equal(got.aggregate.machine, 'fail');
  const frameHistory = got.case.machine_checks.filter((m) => m.gate === 'frame');
  assert.equal(frameHistory.length, 2, '机器历史追加不覆盖');
  assert.equal(frameHistory[1].result, 'fail');

  must(qc.human(home, id.slug, caseId, { verdict: 'pass', note: '人工终判' }), 'human');
  got = must(qc.get(home, caseId), 'get human');
  assert.equal(got.case.human_verdict.verdict, 'pass');
  assert.equal(got.case.machine_checks.filter((m) => m.gate === 'frame').length, 2, '机器历史不受人工影响');
});

// ---------- T24 I21 ----------
test('T24 I21 事件流并发 seq/哈希链/跨项目隔离/篡改发现', async () => {
  assert.ok(events, 'src/events.js 未实现（红测）');
  const home = tmpHome();
  const childScript = path.join(import.meta.dirname, 'fixtures', 'event-append-child.mjs');
  const children = [0, 1, 2].map(() => spawn(process.execPath, [childScript, home, 'P-A', '5'], { stdio: 'inherit' }));
  await Promise.all(children.map((child) => new Promise((resolve, reject) => {
    child.once('exit', (code) => (code === 0 ? resolve() : reject(new Error(`append child exit ${code}`))));
  })));

  const listA = must(events.list(home, { project: 'P-A' }), 'list A');
  assert.equal(listA.events.length, 15);
  assert.deepEqual(listA.events.map((e) => e.seq), Array.from({ length: 15 }, (_, i) => i + 1));
  assert.equal(new Set(listA.events.map((e) => e.hash)).size, 15, '哈希不得重复');

  const clean = must(events.verify(home, 'P-A'), 'verify clean');
  assert.equal(clean.intact, true);
  assert.equal(clean.events, 15);

  must(events.append(home, { project: 'P-B', type: 'probe', actor: 'a', subject: 'P-B', payload: { i: 0 } }), 'append B1');
  must(events.append(home, { project: 'P-B', type: 'probe', actor: 'a', subject: 'P-B', payload: { i: 1 } }), 'append B2');
  const listB = must(events.list(home, { project: 'P-B' }), 'list B');
  assert.equal(listB.events.length, 2);
  assert.ok(listB.events.every((e) => e.project === 'P-B'), '跨项目零串');

  const file = events.file(home, 'P-A');
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
  const tampered = JSON.parse(lines[5]);
  tampered.payload.i = 999;
  lines[5] = JSON.stringify(tampered);
  fs.writeFileSync(file, lines.join('\n') + '\n', 'utf8');

  const broken = must(events.verify(home, 'P-A'), 'verify tampered');
  assert.equal(broken.intact, false);
  assert.equal(broken.broken_at, 6);
});

// ---------- T25 I22 ----------
test('T25 I22 工单/换班/质检动作一一落事件', () => {
  assert.ok(qc, 'src/qc.js 未实现（红测）');
  assert.ok(events, 'src/events.js 未实现（红测）');
  const home = tmpHome();
  const master = must(zjz.identity.create(home, '东家'), 'master');
  const worker = must(zjz.identity.create(home, '值班'), 'worker');

  const order = must(zjz.order.dispatch(home, master.slug, { project: 'M3', title: '落事件' }), 'dispatch');
  must(zjz.order.claim(home, worker.slug, order.order_id), 'claim');
  must(zjz.order.deliver(home, worker.slug, order.order_id, 'delivered'), 'deliver');
  must(zjz.order.accept(home, master.slug, order.order_id, 'accepted'), 'accept');
  must(zjz.order.close(home, master.slug, order.order_id, 'closed'), 'close');

  must(zjz.duty.set(home, master.slug, { mode: 'oncall', project: 'M3' }), 'duty master');
  must(zjz.duty.set(home, worker.slug, { mode: 'listen', project: 'M3' }), 'duty worker');
  must(zjz.duty.shift(home, master.slug, { to: worker.slug }), 'shift');

  const caseId = must(qc.open(home, master.slug, { project: 'M3', title: '落事件案例', gates: ['frame'] }), 'qc open').case_id;
  must(qc.attach(home, master.slug, caseId, { path: artifact(home, 'ev.mp4', 'evidence'), role: 'candidate' }), 'qc attach');
  must(qc.machine(home, master.slug, caseId, { gate: 'frame', result: 'pass' }), 'qc machine');
  must(qc.human(home, master.slug, caseId, { verdict: 'pass' }), 'qc human');
  must(qc.close(home, master.slug, caseId, {
    phenomenon: '构图漂移',
    attribution_layer: '参数层',
    fix: '固定 seed',
    repro_count: 2,
    conclusion: 'baseline',
  }), 'qc close');

  const list = must(events.list(home, { project: 'M3' }), 'list M3');
  const types = list.events.map((e) => e.type);
  for (const expected of [
    'order.dispatch', 'order.claim', 'order.deliver', 'order.accept', 'order.close',
    'duty.shift', 'qc.open', 'qc.attach', 'qc.machine', 'qc.human', 'qc.close',
  ]) {
    assert.equal(types.filter((t) => t === expected).length, 1, `${expected} 应恰好一条`);
  }

  const byType = Object.fromEntries(list.events.map((e) => [e.type, e]));
  assert.equal(byType['order.dispatch'].subject, order.order_id);
  assert.equal(byType['duty.shift'].payload.from, master.slug);
  assert.equal(byType['duty.shift'].payload.to, worker.slug);
  assert.equal(byType['qc.open'].subject, caseId);
  assert.equal(byType['qc.close'].payload.repro_count, 2);
  assert.equal(must(events.verify(home, 'M3'), 'verify M3').intact, true);
});
