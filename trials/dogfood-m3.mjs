// M3 狗粮：质检台账 + 项目事件流 + 双台账互引（MCP 真房）
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { spawn } from 'node:child_process';

const ROOT = path.resolve(import.meta.dirname, '..');
const SERVER = path.join(ROOT, 'bin', 'zjz-mcp.mjs');
const CHILD = path.join(ROOT, 'test', 'fixtures', 'event-append-child.mjs');
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const runDir = path.join(ROOT, 'trials', 'runs', stamp);
const home = path.join(runDir, 'home');
fs.mkdirSync(home, { recursive: true });

const child = spawn(process.execPath, [SERVER, '--home', home], { stdio: ['pipe', 'pipe', 'inherit'] });
let buffer = '';
const queue = [];
const waiters = [];
const transcript = [];

child.stdout.on('data', (chunk) => {
  buffer += chunk.toString('utf8');
  for (;;) {
    const index = buffer.indexOf('\n');
    if (index === -1) break;
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (!line) continue;
    const message = JSON.parse(line);
    if (waiters.length > 0) waiters.shift()(message);
    else queue.push(message);
  }
});

function nextMessage() {
  if (queue.length > 0) return Promise.resolve(queue.shift());
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('MCP 响应超时')), 20000);
    waiters.push((message) => {
      clearTimeout(timer);
      resolve(message);
    });
  });
}

let nextId = 1;
async function rpc(method, params) {
  const id = nextId++;
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  const response = await nextMessage();
  assert.equal(response.id, id, `${method} 响应 id 不匹配`);
  return response;
}

async function call(name, args = {}) {
  const response = await rpc('tools/call', { name, arguments: args });
  assert.ok(response.result, `${name} 无 result`);
  const payload = JSON.parse(response.result.content[0].text);
  transcript.push({ at: new Date().toISOString(), tool: name, args, result: payload, isError: response.result.isError });
  return { payload, isError: Boolean(response.result.isError) };
}

async function tool(name, args = {}) {
  return (await call(name, args)).payload;
}

function must(payload, where) {
  assert.equal(payload.ok, true, `${where} 失败：${JSON.stringify(payload)}`);
  return payload;
}

function artifact(name, content) {
  const file = path.join(runDir, name);
  fs.writeFileSync(file, content, 'utf8');
  return file;
}

async function main() {
  const init = await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'dogfood-m3' } });
  assert.equal(init.result.serverInfo.name, 'zjz-mcp');
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');

  const master = must(await tool('zjz_identity_new', { name: '东家' }), 'identity 东家');
  const worker = must(await tool('zjz_identity_new', { name: '值班Codex' }), 'identity 值班Codex');
  const room = must(await tool('zjz_new', { name: 'M3狗粮房', slug: master.slug }), 'new room');
  must(await tool('zjz_join', { invite: room.invite_code, slug: worker.slug }), 'join');
  must(await tool('zjz_send', { room_id: room.room_id, text: 'M3 狗粮开工。', slug: master.slug }), 'send');

  const project = '狗粮M3';
  const order = must(await tool('zjz_order_dispatch', {
    project,
    title: 'M3 工单链',
    deliverables: '事件流',
    acceptance: '一一对应',
    slug: master.slug,
  }), 'order dispatch');
  must(await tool('zjz_order_claim', { order_id: order.order_id, slug: worker.slug }), 'order claim');
  must(await tool('zjz_order_deliver', { order_id: order.order_id, note: '已交', slug: worker.slug }), 'order deliver');
  must(await tool('zjz_order_accept', { order_id: order.order_id, slug: master.slug }), 'order accept');
  must(await tool('zjz_order_close', { order_id: order.order_id, slug: master.slug }), 'order close');

  const base = artifact('qc-baseline.mp4', 'QC-BASELINE-M3');
  const cand = artifact('qc-candidate.mp4', 'QC-CANDIDATE-M3');
  const same = artifact('qc-same-hash.mp4', 'QC-BASELINE-M3');
  const qcCase = must(await tool('zjz_qc_open', {
    project,
    title: 'M3 质检台账',
    variable_layer: '参数层',
    gates: ['frame', 'audio'],
    slug: worker.slug,
  }), 'qc open');

  must(await tool('zjz_qc_attach', { case_id: qcCase.case_id, path: base, role: 'baseline', slug: worker.slug }), 'qc attach baseline');
  must(await tool('zjz_qc_attach', { case_id: qcCase.case_id, path: cand, role: 'candidate', slug: worker.slug }), 'qc attach candidate');

  const duplicate = await call('zjz_qc_attach', { case_id: qcCase.case_id, path: same, role: 'fixed', slug: worker.slug });
  assert.equal(duplicate.isError, true);
  assert.equal(duplicate.payload.code, 'EVIDENCE_DUPLICATE');

  const exempt = must(await tool('zjz_qc_attach', {
    case_id: qcCase.case_id,
    path: same,
    role: 'fixed',
    allow_same: true,
    reason: '同一源文件复用为修复前后对照',
    slug: worker.slug,
  }), 'qc attach exempt');
  assert.equal(exempt.evidence.same_hash_exemption.reason, '同一源文件复用为修复前后对照');

  must(await tool('zjz_qc_machine', { case_id: qcCase.case_id, gate: 'frame', result: 'pass', metrics: { fps: 24 }, slug: worker.slug }), 'qc machine frame');
  must(await tool('zjz_qc_machine', { case_id: qcCase.case_id, gate: 'audio', result: 'pass', metrics: { f0: 149.5 }, slug: worker.slug }), 'qc machine audio');
  must(await tool('zjz_qc_human', { case_id: qcCase.case_id, verdict: 'pass', note: '东家耳审', slug: master.slug }), 'qc human');
  must(await tool('zjz_qc_close', {
    case_id: qcCase.case_id,
    phenomenon: '表情木',
    attribution_layer: '参数层',
    fix: '16 步 + 克隆音频',
    repro_count: 2,
    repro_note: '两次同结果',
    conclusion: 'baseline',
    slug: master.slug,
  }), 'qc close');

  const verifiedQC = must(await tool('zjz_qc_verify', { case_id: qcCase.case_id }), 'qc verify');
  assert.equal(verifiedQC.intact, true);
  const summary = must(await tool('zjz_qc_summary', { case_id: qcCase.case_id }), 'qc summary');
  assert.ok(summary.summary.includes('表情木'));

  const projectEvents = must(await tool('zjz_event_list', { project }), 'event list project');
  const types = projectEvents.events.map((event) => event.type);
  for (const type of ['order.dispatch', 'order.claim', 'order.deliver', 'order.accept', 'order.close', 'qc.open', 'qc.attach', 'qc.machine', 'qc.human', 'qc.close']) {
    assert.ok(types.includes(type), `事件流缺少 ${type}`);
  }
  assert.equal(types.filter((type) => type === 'qc.attach').length, 3, 'attach 三次（含豁免复用）');
  const machineEvent = projectEvents.events.find((event) => event.type === 'qc.machine' && event.payload.gate === 'frame');
  assert.equal(machineEvent.actor, worker.slug);

  const concurrentProject = '并发M3';
  const children = [0, 1, 2].map(() => spawn(process.execPath, [CHILD, home, concurrentProject, '5'], { stdio: 'inherit' }));
  await Promise.all(children.map((proc) => new Promise((resolve, reject) => {
    proc.once('exit', (code) => (code === 0 ? resolve() : reject(new Error(`append child exit ${code}`))));
  })));

  const concurrent = must(await tool('zjz_event_list', { project: concurrentProject }), 'event list concurrent');
  assert.equal(concurrent.events.length, 15);
  assert.deepEqual(concurrent.events.map((event) => event.seq), Array.from({ length: 15 }, (_, i) => i + 1));
  assert.equal(new Set(concurrent.events.map((event) => event.hash)).size, 15, '15 条事件哈希必须互异');
  assert.equal(new Set(concurrent.events.map((event) => event.id)).size, 15, '15 条事件 id 必须互异');
  const concurrentVerify = must(await tool('zjz_event_verify', { project: concurrentProject }), 'event verify concurrent');
  assert.equal(concurrentVerify.intact, true);
  assert.equal(concurrentVerify.events, 15);

  const eventDir = path.join(home, 'data', 'events');
  const concurrentFile = fs.readdirSync(eventDir)
    .filter((name) => name.endsWith('.jsonl'))
    .map((name) => path.join(eventDir, name))
    .find((file) => fs.readFileSync(file, 'utf8').includes(`"project":"${concurrentProject}"`));
  assert.ok(concurrentFile, '找不到并发项目事件文件');
  const pristine = fs.readFileSync(concurrentFile, 'utf8');
  const lines = pristine.split('\n');
  const tampered = JSON.parse(lines[0]);
  tampered.payload.i = 99;
  lines[0] = JSON.stringify(tampered);
  fs.writeFileSync(concurrentFile, lines.join('\n'), 'utf8');
  const tamperCheck = must(await tool('zjz_event_verify', { project: concurrentProject }), 'event verify tampered');
  assert.equal(tamperCheck.intact, false);
  assert.equal(tamperCheck.reason, 'hash');
  fs.writeFileSync(concurrentFile, pristine, 'utf8');
  assert.equal(must(await tool('zjz_event_verify', { project: concurrentProject }), 'event verify restored').intact, true);

  must(await tool('zjz_duty_set', {
    slug: master.slug,
    mode: 'oncall',
    project,
    watchdog: { successor: worker.slug, max_age_ms: 1000, check_ms: 1000 },
  }), 'duty master');
  must(await tool('zjz_duty_set', { slug: worker.slug, mode: 'listen', project }), 'duty worker');
  must(await tool('zjz_duty_heartbeat', { slug: master.slug }), 'heartbeat master');
  const tick = must(await tool('zjz_watchdog_tick', { now: Date.now() + 60000 }), 'watchdog tick');
  assert.equal(tick.shifted.length, 1);
  assert.equal(tick.shifted[0].from, master.slug);
  assert.equal(tick.shifted[0].to, worker.slug);

  const actions = fs.readFileSync(path.join(home, 'data', 'watchdog', 'actions.jsonl'), 'utf8')
    .trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
  const shiftAction = actions.find((action) => action.action === 'shift');
  assert.ok(shiftAction && shiftAction.event_id, 'actions.jsonl 必须带 event_id');
  const afterShift = must(await tool('zjz_event_list', { project }), 'event list after shift');
  const watchdogEvent = afterShift.events.find((event) => event.type === 'duty.watchdog_shift');
  assert.ok(watchdogEvent, '事件流必须有 duty.watchdog_shift');
  assert.equal(watchdogEvent.id, shiftAction.event_id, '双台账 event_id 必须互相指向');
  assert.equal(watchdogEvent.payload.epoch, shiftAction.epoch, 'epoch 必须一致');
  assert.ok(watchdogEvent.payload.duty_event_id, 'watchdog 事件必须引用 duty.shift 事件');
  const dutyShiftEvent = afterShift.events.find((event) => event.id === watchdogEvent.payload.duty_event_id);
  assert.equal(dutyShiftEvent.type, 'duty.shift');
  assert.equal(dutyShiftEvent.payload.to, worker.slug);
  assert.equal(must(await tool('zjz_event_verify', { project }), 'event verify final').intact, true);

  const projectVerify = await tool('zjz_event_verify', { project });
  const projectList = must(await tool('zjz_event_projects', {}), 'event projects');
  assert.ok(projectList.projects.some((entry) => entry.project === project));
  assert.ok(projectList.projects.some((entry) => entry.project === concurrentProject));

  const record = `# 中军帐 M3 狗粮记录

- 时间：${stamp}
- 房间：${room.room_id}（M3狗粮房）
- 身份：东家 ${master.slug} / 值班Codex ${worker.slug}
- 工单事件链：dispatch → claim → deliver → accept → close，5 条一一对应
- 质检台账：${qcCase.case_id}，证据 3 挂（含 allow_same 豁免 1），机器 2 闸，人工 1 判，状态 closed
- 证据防伪：同哈希跨角色默认拒（EVIDENCE_DUPLICATE），豁免理由随事件流留痕
- 并发事件流：3 进程 × 5 条，seq 1..15 连续，15 个哈希互异，verify intact=true
- 篡改检测：改 1 条 payload → intact=false/reason=hash；恢复后 intact=true
- 双台账互引：actions.jsonl shift.event_id=${shiftAction.event_id} ↔ 事件流 duty.watchdog_shift.id；epoch=${shiftAction.epoch}；引用 duty.shift=${watchdogEvent.payload.duty_event_id}
- 项目事件总数：${project} ${afterShift.events.length} 条 / ${concurrentProject} ${concurrent.events.length} 条
- 哈希链尾：${projectVerify.last_hash.slice(0, 16)}…
- 结论：**PASS**

| # | 工具 | 结果 |
|---|------|------|
${transcript.map((entry, index) => `| ${index + 1} | ${entry.tool} | ${entry.isError ? (entry.result.code || 'error') : 'ok'} |`).join('\n')}

原始记录：trials/runs/${stamp}/transcript.json
`;
  fs.writeFileSync(path.join(runDir, 'RECORD.md'), record, 'utf8');
  fs.writeFileSync(path.join(runDir, 'transcript.json'), JSON.stringify(transcript, null, 2), 'utf8');
  fs.writeFileSync(path.join(ROOT, 'trials', 'LATEST.md'), `# 最新狗粮记录

- 运行：trials/runs/${stamp}/
- 结论：PASS
- 房间：${room.room_id}
- 特性：质检台账 + 并发事件流 + 哈希链 + 双台账互引
`, 'utf8');
  console.log(JSON.stringify({
    ok: true,
    run: `trials/runs/${stamp}`,
    room: room.room_id,
    events: { [project]: afterShift.events.length, [concurrentProject]: concurrent.events.length },
    watchdog_event: watchdogEvent.id,
  }));
}

try {
  await main();
} finally {
  child.stdin.end();
  setTimeout(() => child.kill(), 200).unref();
}
