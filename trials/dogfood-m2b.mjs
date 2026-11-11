// M2-B 狗粮：常驻监听 + 跨进程唤醒 + 看门狗换班（MCP 真房）
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { spawn } from 'node:child_process';

const ROOT = path.resolve(import.meta.dirname, '..');
const SERVER = path.join(ROOT, 'bin', 'zjz-mcp.mjs');
const CLI = path.join(ROOT, 'bin', 'zjz.mjs');
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

async function tool(name, args = {}) {
  const response = await rpc('tools/call', { name, arguments: args });
  assert.ok(response.result, `${name} 无 result`);
  const payload = JSON.parse(response.result.content[0].text);
  transcript.push({ at: new Date().toISOString(), tool: name, args, result: payload });
  return payload;
}

function must(payload, where) {
  assert.equal(payload.ok, true, `${where} 失败：${JSON.stringify(payload)}`);
  return payload;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function cliWait(slug, timeoutS) {
  const startedAt = Date.now();
  const proc = spawn(process.execPath, [CLI, 'wait', '--home', home, '--slug', slug, '--timeout', String(timeoutS)], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  proc.stdout.on('data', (chunk) => { out += chunk; });
  proc.stderr.on('data', (chunk) => { out += chunk; });
  const done = new Promise((resolve) => proc.once('exit', (code) => resolve({ code, out, elapsed: Date.now() - startedAt })));
  return { proc, done };
}

async function main() {
  const init = await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'dogfood-m2b' } });
  assert.equal(init.result.serverInfo.name, 'zjz-mcp');
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');

  const master = must(await tool('zjz_identity_new', { name: '东家' }), 'identity 东家');
  const worker = must(await tool('zjz_identity_new', { name: '值班Codex' }), 'identity 值班Codex');
  const room = must(await tool('zjz_new', { name: 'M2-B狗粮房', slug: master.slug }), 'new room');
  must(await tool('zjz_join', { invite: room.invite_code, slug: worker.slug }), 'join');

  must(await tool('zjz_duty_set', {
    slug: master.slug,
    mode: 'oncall',
    watchdog: { successor: worker.slug, max_age_ms: 1000, check_ms: 1000 },
  }), 'duty set master');
  must(await tool('zjz_duty_set', { slug: worker.slug, mode: 'listen' }), 'duty set worker');
  must(await tool('zjz_duty_heartbeat', { slug: master.slug }), 'heartbeat master');

  const started = must(await tool('zjz_listen_start', { ttl_ms: 5000, heartbeat_ms: 500 }), 'listen start');
  assert.ok(started.epoch >= 1);
  const live = must(await tool('zjz_listen_status', {}), 'listen status');
  assert.equal(live.running, true);

  const notice = must(await tool('zjz_send', { room_id: room.room_id, text: '工单已派，请接手。', slug: master.slug }), 'send 1');
  assert.equal(notice.seq, 1);
  const masterSeen = must(await tool('zjz_wait', { slug: master.slug, timeout_ms: 3000 }), 'master wait 1');
  assert.deepEqual(masterSeen.messages.map((m) => m.seq), [1]);
  const workerSeen = must(await tool('zjz_wait', { slug: worker.slug, timeout_ms: 3000 }), 'worker wait 1');
  assert.deepEqual(workerSeen.messages.map((m) => m.seq), [1]);

  const waiter = cliWait(worker.slug, 5);
  await sleep(250);
  const second = must(await tool('zjz_send', { room_id: room.room_id, text: '跨进程唤醒这一条。', slug: master.slug }), 'send 2');
  assert.equal(second.seq, 2);
  const cliResult = await waiter.done;
  assert.equal(cliResult.code, 0, cliResult.out);
  assert.ok(cliResult.out.includes('跨进程唤醒这一条。'), 'CLI wait 应收到 seq2');
  assert.ok(cliResult.elapsed < 2500, `跨进程唤醒应 <2500ms，实际 ${cliResult.elapsed}ms`);
  const masterSeen2 = must(await tool('zjz_wait', { slug: master.slug, timeout_ms: 3000 }), 'master wait 2');
  assert.deepEqual(masterSeen2.messages.map((m) => m.seq), [2]);

  const later = Date.now() + 60000;
  const tick1 = must(await tool('zjz_watchdog_tick', { now: later }), 'watchdog tick 1');
  assert.equal(tick1.shifted.length, 1);
  assert.equal(tick1.shifted[0].from, master.slug);
  assert.equal(tick1.shifted[0].to, worker.slug);
  assert.equal(tick1.shifted[0].checkpoint.rooms[room.room_id], 2);

  const noReplay = must(await tool('zjz_wait', { slug: worker.slug, timeout_ms: 300 }), 'worker wait after shift');
  assert.deepEqual(noReplay.messages, [], '换班后不得重播');

  const tick2 = must(await tool('zjz_watchdog_tick', { now: later + 1000 }), 'watchdog tick 2');
  assert.equal(tick2.shifted.length, 0, '同一超龄事件不得二次换班');

  const third = must(await tool('zjz_send', { room_id: room.room_id, text: '换班后新消息。', slug: master.slug }), 'send 3');
  assert.equal(third.seq, 3);
  const workerNext = must(await tool('zjz_wait', { slug: worker.slug, timeout_ms: 3000 }), 'worker wait 3');
  assert.deepEqual(workerNext.messages.map((m) => m.seq), [3]);

  const stopped = must(await tool('zjz_listen_stop', {}), 'listen stop');
  assert.equal(stopped.released, true);

  const actionsPath = path.join(home, 'data', 'watchdog', 'actions.jsonl');
  const actions = fs.readFileSync(actionsPath, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
  const shifts = actions.filter((a) => a.action === 'shift');
  assert.equal(shifts.length, 1);
  assert.ok(Number.isInteger(shifts[0].epoch) && shifts[0].epoch >= 1);
  assert.deepEqual(shifts[0].checkpoint_before, {});
  assert.deepEqual(shifts[0].checkpoint_after, { [room.room_id]: 2 });

  const record = `# 中军帐 M2-B 狗粮记录

- 时间：${stamp}
- 房间：${room.room_id}（M2-B狗粮房）
- 身份：东家 ${master.slug} / 值班Codex ${worker.slug}
- 监听：listen start ok，epoch=${started.epoch}，stop released=true
- 跨进程唤醒：CLI wait 在注入延迟 250ms 后 ${cliResult.elapsed}ms 返回 seq2
- 看门狗：hello 超龄自动换班 ${master.slug} → ${worker.slug}，checkpoint rooms[${room.room_id}]=2
- 幂等：第二次 tick shifted=0；换班后 wait 无重播
- 台账：actions.jsonl 一条 shift，epoch=${shifts[0].epoch}，before={} after={${room.room_id}:2}
- 结论：**PASS**

| # | 工具 | 结果 |
|---|------|------|
${transcript.map((entry, index) => `| ${index + 1} | ${entry.tool} | ${entry.result.ok ? 'ok' : entry.result.code} |`).join('\n')}

原始记录：trials/runs/${stamp}/transcript.json
`;
  fs.writeFileSync(path.join(runDir, 'RECORD.md'), record, 'utf8');
  fs.writeFileSync(path.join(runDir, 'transcript.json'), JSON.stringify(transcript, null, 2), 'utf8');
  fs.writeFileSync(path.join(ROOT, 'trials', 'LATEST.md'), `# 最新狗粮记录

- 运行：trials/runs/${stamp}/
- 结论：PASS
- 房间：${room.room_id}
- 特性：常驻监听 + 跨进程唤醒 + 看门狗换班
`, 'utf8');
  console.log(JSON.stringify({ ok: true, run: `trials/runs/${stamp}`, room: room.room_id, wake_ms: cliResult.elapsed }));
}

try {
  await main();
} finally {
  child.stdin.end();
  setTimeout(() => child.kill(), 200).unref();
}
