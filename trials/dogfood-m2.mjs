// M2 狗粮试点：用 zjz 自己的 MCP 开真房，跑「派单 → 接单 → wait → 换班」全链
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { spawn } from 'node:child_process';

const ROOT = path.resolve(import.meta.dirname, '..');
const SERVER = path.join(ROOT, 'bin', 'zjz-mcp.mjs');
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

async function main() {
  const init = await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'dogfood-m2' } });
  assert.equal(init.result.serverInfo.name, 'zjz-mcp');
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');

  const master = must(await tool('zjz_identity_new', { name: '东家' }), 'identity 东家');
  const worker = must(await tool('zjz_identity_new', { name: '值班Codex' }), 'identity 值班Codex');

  const room = must(await tool('zjz_new', { name: '狗粮试点房', slug: master.slug }), 'new room');
  must(await tool('zjz_join', { invite: room.invite_code, slug: worker.slug }), 'join');

  const order = must(await tool('zjz_order_dispatch', {
    project: 'dogfood-M2',
    title: '用自身管道跑通 M2 全链',
    deliverables: 'trials 记录 + 全链断言',
    acceptance: '派单/接单/wait/换班/交付/验收/结单全通',
    slug: master.slug,
  }), 'dispatch');
  assert.equal(order.status, 'dispatched');

  const claim = must(await tool('zjz_order_claim', { order_id: order.order_id, slug: worker.slug }), 'claim');
  assert.equal(claim.claim_seq, 1);

  const notice = must(await tool('zjz_send', {
    room_id: room.room_id,
    text: '工单已派，请接手。',
    slug: master.slug,
  }), 'send notice');
  assert.equal(notice.seq, 1);

  const masterSeen = must(await tool('zjz_wait', { slug: master.slug, timeout_ms: 3000 }), 'master wait');
  assert.deepEqual(masterSeen.messages.map((m) => m.seq), [1]);

  const workerSeen = must(await tool('zjz_wait', { slug: worker.slug, timeout_ms: 3000 }), 'worker wait');
  assert.deepEqual(workerSeen.messages.map((m) => m.seq), [1]);

  must(await tool('zjz_duty_set', { slug: master.slug, mode: 'oncall' }), 'duty set master');
  must(await tool('zjz_duty_set', { slug: worker.slug, mode: 'listen' }), 'duty set worker');

  const shift = must(await tool('zjz_duty_shift', { slug: master.slug, to: worker.slug }), 'duty shift');
  assert.equal(shift.checkpoint.rooms[room.room_id], 1);
  assert.deepEqual(shift.applied_rooms, [room.room_id]);

  const handoverMsg = must(await tool('zjz_send', {
    room_id: room.room_id,
    text: '已接班，继续盯工单。',
    slug: worker.slug,
  }), 'send handover');
  assert.equal(handoverMsg.seq, 2);

  const masterAfter = must(await tool('zjz_wait', { slug: master.slug, timeout_ms: 3000 }), 'master wait after shift');
  assert.deepEqual(masterAfter.messages.map((m) => m.seq), [2], '换班后只收新消息，无重播');

  const delivered = must(await tool('zjz_order_deliver', { order_id: order.order_id, note: '全链记录已落盘', slug: worker.slug }), 'deliver');
  assert.equal(delivered.status, 'delivered');
  const accepted = must(await tool('zjz_order_accept', { order_id: order.order_id, note: '验收通过', slug: master.slug }), 'accept');
  assert.equal(accepted.status, 'accepted');
  const closed = must(await tool('zjz_order_close', { order_id: order.order_id, note: '结单', slug: master.slug }), 'close');
  assert.equal(closed.status, 'closed');

  const listed = must(await tool('zjz_order_list', { project: 'dogfood-M2' }), 'order list');
  assert.equal(listed.orders.length, 1);
  assert.equal(listed.orders[0].status, 'closed');

  const dutyGot = must(await tool('zjz_duty_get', { slug: worker.slug }), 'duty get');
  assert.equal(dutyGot.duty.mode, 'oncall');
  assert.equal(dutyGot.duty.checkpoint.rooms[room.room_id], 1);

  const record = {
    stamp,
    home,
    room: { room_id: room.room_id, name: '狗粮试点房' },
    identities: { master: master.slug, worker: worker.slug },
    order: { order_id: order.order_id, project: 'dogfood-M2', final_status: 'closed' },
    shift: { from: master.slug, to: worker.slug, checkpoint: shift.checkpoint },
    conclusion: 'PASS',
  };
  fs.writeFileSync(path.join(runDir, 'transcript.json'), JSON.stringify({ record, transcript }, null, 2) + '\n', 'utf8');

  const lines = [
    '# 中军帐 M2 狗粮记录',
    '',
    `- 时间：${stamp}`,
    `- 房间：${room.room_id}（狗粮试点房）`,
    `- 身份：东家 ${master.slug} / 值班Codex ${worker.slug}`,
    `- 工单：${order.order_id}（dogfood-M2，最终 closed）`,
    `- 换班：${master.slug} → ${worker.slug}，checkpoint rooms[${room.room_id}]=1`,
    '- 结论：**PASS**（派单 → 接单 → wait → 换班 → 交接消息 → 交付 → 验收 → 结单）',
    '',
    '| # | 工具 | 结果 |',
    '|---|------|------|',
    ...transcript.map((entry, index) => {
      const summary = entry.result.ok === false
        ? `ERROR ${entry.result.code}`
        : `ok${entry.result.seq !== undefined ? ` seq=${entry.result.seq}` : ''}${entry.result.status ? ` status=${entry.result.status}` : ''}`;
      return `| ${index + 1} | ${entry.tool} | ${summary} |`;
    }),
    '',
    `原始记录：trials/runs/${stamp}/transcript.json`,
  ];
  fs.writeFileSync(path.join(runDir, 'RECORD.md'), lines.join('\n') + '\n', 'utf8');
  fs.writeFileSync(path.join(ROOT, 'trials', 'LATEST.md'), [
    '# 最新狗粮记录',
    '',
    `- 运行：trials/runs/${stamp}/`,
    `- 结论：PASS`,
    `- 房间：${room.room_id}`,
    `- 工单：${order.order_id}`,
    '',
  ].join('\n'), 'utf8');
  process.stdout.write(`[dogfood] PASS ${runDir}\n`);
  process.stdout.write(`[dogfood] room=${room.room_id} order=${order.order_id}\n`);
}

main()
  .then(() => {
    child.stdin.end();
    setTimeout(() => child.kill(), 100);
  })
  .catch((error) => {
    process.stderr.write(String(error && error.stack ? error.stack : error) + '\n');
    if (transcript.length > 0) {
      fs.writeFileSync(path.join(runDir, 'transcript.failed.json'), JSON.stringify({ transcript, error: String(error) }, null, 2) + '\n', 'utf8');
    }
    child.kill();
    process.exit(1);
  });