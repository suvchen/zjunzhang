// zjz-mcp stdio 冒烟：initialize -> tools/list -> identity/new/send/read/wait/join/archive
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { spawn } from 'node:child_process';

const ROOT = path.resolve(import.meta.dirname, '..');
const SERVER = path.join(ROOT, 'bin', 'zjz-mcp.mjs');
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'zjz-mcp-'));
const child = spawn(process.execPath, [SERVER, '--home', home], { stdio: ['pipe', 'pipe', 'inherit'] });

let buffer = '';
const lines = [];
const waiters = [];

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
    else lines.push(message);
  }
});

function nextMessage() {
  if (lines.length > 0) return Promise.resolve(lines.shift());
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('等待 MCP 响应超时')), 15000);
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
  assert.equal(response.jsonrpc, '2.0');
  return response;
}

async function tool(name, args = {}) {
  const response = await rpc('tools/call', { name, arguments: args });
  assert.ok(response.result, `${name} 应返回 result，实际 ${JSON.stringify(response)}`);
  const payload = JSON.parse(response.result.content[0].text);
  return { payload, isError: response.result.isError };
}

async function main() {
  const init = await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'smoke' } });
  assert.equal(init.result.serverInfo.name, 'zjz-mcp');
  assert.ok(init.result.capabilities.tools);
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  process.stdout.write('[mcp] initialize ok\n');

  const listed = await rpc('tools/list', {});
  const names = listed.result.tools.map((t) => t.name);
  for (const expected of ['zjz_new', 'zjz_join', 'zjz_send', 'zjz_read', 'zjz_wait', 'zjz_members', 'zjz_list', 'zjz_whoami', 'zjz_archive', 'zjz_identity_new', 'zjz_order_dispatch', 'zjz_order_claim', 'zjz_order_deliver', 'zjz_order_accept', 'zjz_order_reject', 'zjz_order_close', 'zjz_order_get', 'zjz_order_list', 'zjz_duty_set', 'zjz_duty_get', 'zjz_duty_shift', 'zjz_duty_heartbeat', 'zjz_listen_start', 'zjz_listen_status', 'zjz_listen_stop', 'zjz_watchdog_tick', 'zjz_watchdog_status', 'zjz_qc_open', 'zjz_qc_attach', 'zjz_qc_machine', 'zjz_qc_human', 'zjz_qc_close', 'zjz_qc_get', 'zjz_qc_list', 'zjz_qc_verify', 'zjz_qc_summary', 'zjz_event_list', 'zjz_event_verify', 'zjz_event_projects', 'zjz_search', 'zjz_search_index', 'zjz_search_reindex', 'zjz_search_audit', 'zjz_skill_candidates', 'zjz_skill_approve', 'zjz_skill_reject', 'zjz_skill_list', 'zjz_skill_get', 'zjz_skill_verify', 'zjz_skill_search', 'zjz_skill_audit']) {
    assert.ok(names.includes(expected), `tools/list 缺少 ${expected}`);
  }
  process.stdout.write(`[mcp] tools/list ok (${names.length})\n`);

  const id1 = (await tool('zjz_identity_new', { name: 'MCP测试员' })).payload;
  assert.equal(id1.ok, true);
  const id2 = (await tool('zjz_identity_new', { name: 'MCP第二人' })).payload;
  assert.equal(id2.ok, true);
  assert.notEqual(id1.slug, id2.slug);
  process.stdout.write('[mcp] identity new x2 ok\n');

  const made = (await tool('zjz_new', { name: 'MCP房', slug: id1.slug })).payload;
  assert.equal(made.ok, true);
  const sent = (await tool('zjz_send', { room_id: made.room_id, text: '甲发的第一条', slug: id1.slug })).payload;
  assert.equal(sent.ok, true);
  assert.equal(sent.seq, 1);
  process.stdout.write('[mcp] new + send ok\n');

  const read = (await tool('zjz_read', { room_id: made.room_id, slug: id1.slug })).payload;
  assert.equal(read.messages.length, 1);
  assert.equal(read.messages[0].text, '甲发的第一条');

  const waited = (await tool('zjz_wait', { slug: id1.slug, timeout_ms: 1000 })).payload;
  assert.equal(waited.messages.length, 1);
  const waitedAgain = (await tool('zjz_wait', { slug: id1.slug, timeout_ms: 30 })).payload;
  assert.equal(waitedAgain.messages.length, 0);
  process.stdout.write('[mcp] read + wait(no dupe) ok\n');

  const joined = (await tool('zjz_join', { invite: made.invite_code, slug: id2.slug })).payload;
  assert.equal(joined.ok, true);
  assert.equal(joined.room_id, made.room_id);
  const sent2 = (await tool('zjz_send', { room_id: made.room_id, text: '乙加入后发言', slug: id2.slug })).payload;
  assert.equal(sent2.seq, 2);
  const waited2 = (await tool('zjz_wait', { slug: id2.slug, timeout_ms: 1000 })).payload;
  assert.deepEqual(waited2.messages.map((m) => m.seq), [2]);
  process.stdout.write('[mcp] join + cursor-on-join ok\n');

  const members = (await tool('zjz_members', { room_id: made.room_id, slug: id1.slug })).payload;
  assert.equal(members.ok, true);
  assert.deepEqual(members.members.map((m) => m.slug).sort(), [id1.slug, id2.slug].sort());

  const sidx = (await tool('zjz_search_index', {})).payload;
  assert.equal(sidx.ok, true);
  const sfound = (await tool('zjz_search', { q: '第一条' })).payload;
  assert.ok(sfound.hits.some((hit) => hit.msg_id === sent.id), 'MCP 检索必须命中已发消息');
  assert.ok(sfound.hits[0].room_id === made.room_id && typeof sfound.hits[0].seq === 'number', '命中须带房号与 seq');
  assert.equal(sfound.hits[0].display_text, sfound.hits[0].text);
  assert.equal(sfound.hits[0].ext_id ?? null, null);
  const saudit = (await tool('zjz_search_audit', {})).payload;
  assert.equal(saudit.intact, true, 'MCP 对账必须 intact');
  await tool('zjz_search_index', {});
  const saudit2 = (await tool('zjz_search_audit', {})).payload;
  assert.equal(saudit2.duplicates, 0, '重复索引不得重投');
  process.stdout.write('[mcp] search index/query/audit ok\n');

  const skillSent = (await tool('zjz_send', {
    room_id: made.room_id,
    text: '实测：MCP 技能候选链验证通过，npm test 42/42 全绿（test/mcp.smoke.mjs）',
    slug: id1.slug,
  })).payload;
  const skillCandidates = (await tool('zjz_skill_candidates', { room_id: made.room_id, limit: 10 })).payload;
  assert.equal(skillCandidates.ok, true);
  const skillCandidate = skillCandidates.candidates.find((row) => row.msg_id === skillSent.id);
  assert.ok(skillCandidate, 'MCP 技能候选必须引用原消息');
  const skillSources = [{ room_id: made.room_id, msg_id: skillSent.id }];
  const skillMissing = await tool('zjz_skill_approve', {
    candidate_id: skillCandidate.candidate_id,
    by: id1.slug,
    card: {
      problem: 'MCP 技能工具要闭环',
      practice: '候选后过认可门再入库',
      boundary: '本地冒烟',
      pitfalls: '缺证据不得入库',
    },
    sources: skillSources,
  });
  assert.equal(skillMissing.isError, true);
  assert.equal(skillMissing.payload.code, 'SKILL_INCOMPLETE');
  const skillApproved = (await tool('zjz_skill_approve', {
    candidate_id: skillCandidate.candidate_id,
    by: id1.slug,
    card: {
      problem: 'MCP 技能工具要闭环',
      practice: '候选后过认可门再入库',
      evidence: 'MCP smoke 全链断言',
      boundary: '本地冒烟',
      pitfalls: '缺证据不得入库',
    },
    sources: skillSources,
  })).payload;
  assert.equal(skillApproved.ok, true);
  const skillFound = (await tool('zjz_skill_search', { q: '认可门' })).payload;
  assert.ok(skillFound.hits.some((hit) => hit.msg_id === skillApproved.card_id));
  assert.equal((await tool('zjz_skill_get', { card_id: skillApproved.card_id })).payload.intact, true);
  assert.equal((await tool('zjz_skill_verify', {})).payload.intact, true);
  assert.equal((await tool('zjz_skill_audit', {})).payload.intact, true);
  process.stdout.write('[mcp] skill candidates/approve/search/verify/audit ok\n');

  const ord = (await tool('zjz_order_dispatch', { project: 'MCP项目', title: 'MCP工单', slug: id1.slug })).payload;
  assert.equal(ord.ok, true);
  const badAccept = await tool('zjz_order_accept', { order_id: ord.order_id, slug: id1.slug });
  assert.equal(badAccept.isError, true);
  assert.equal(badAccept.payload.code, 'BAD_STATE');
  const claim1 = (await tool('zjz_order_claim', { order_id: ord.order_id, slug: id1.slug })).payload;
  assert.equal(claim1.claim_seq, 1);
  const claim2 = await tool('zjz_order_claim', { order_id: ord.order_id, slug: id2.slug });
  assert.equal(claim2.isError, true);
  assert.equal(claim2.payload.code, 'CLAIM_LOST');
  assert.equal((await tool('zjz_order_deliver', { order_id: ord.order_id, slug: id1.slug })).payload.status, 'delivered');
  assert.equal((await tool('zjz_order_accept', { order_id: ord.order_id, slug: id1.slug })).payload.status, 'accepted');
  assert.equal((await tool('zjz_order_close', { order_id: ord.order_id, slug: id1.slug })).payload.status, 'closed');
  const ordersA = (await tool('zjz_order_list', { project: 'MCP项目' })).payload;
  assert.equal(ordersA.orders.length, 1);
  const ordersNone = (await tool('zjz_order_list', { project: '别的项目' })).payload;
  assert.equal(ordersNone.orders.length, 0);
  process.stdout.write('[mcp] order chain + project filter ok\n');

  assert.equal((await tool('zjz_duty_set', { slug: id1.slug, mode: 'oncall' })).payload.mode, 'oncall');
  assert.equal((await tool('zjz_duty_set', { slug: id2.slug, mode: 'listen' })).payload.mode, 'listen');
  const shifted = (await tool('zjz_duty_shift', { slug: id1.slug, to: id2.slug })).payload;
  assert.equal(shifted.ok, true);
  assert.equal(shifted.to, id2.slug);
  assert.ok(shifted.checkpoint.rooms[made.room_id] !== undefined);
  const dutyGot = (await tool('zjz_duty_get', { slug: id2.slug })).payload;
  assert.equal(dutyGot.duty.mode, 'oncall');
  assert.ok(dutyGot.duty.shift_log.length >= 1);
  process.stdout.write('[mcp] duty set/shift/get ok\n');

  const artifact = path.join(home, 'mcp-qc-base.mp4');
  fs.writeFileSync(artifact, 'MCP-QC-BASE', 'utf8');
  const qcOpened = (await tool('zjz_qc_open', { project: 'MCP质检', title: 'MCP 台账', gates: ['frame'], slug: id1.slug })).payload;
  assert.equal(qcOpened.ok, true);
  assert.equal((await tool('zjz_qc_attach', { case_id: qcOpened.case_id, path: artifact, role: 'baseline', slug: id1.slug })).payload.ok, true);
  assert.equal((await tool('zjz_qc_machine', { case_id: qcOpened.case_id, gate: 'frame', result: 'pass', metrics: { fps: 24 }, slug: id1.slug })).payload.case.status, 'machine_checked');
  assert.equal((await tool('zjz_qc_human', { case_id: qcOpened.case_id, verdict: 'pass', note: '冒烟', slug: id1.slug })).payload.case.status, 'human_verdict');
  const qcClosed = (await tool('zjz_qc_close', {
    case_id: qcOpened.case_id,
    phenomenon: '冒烟现象',
    attribution_layer: '参数层',
    fix: '冒烟修法',
    repro_count: 2,
    conclusion: 'baseline',
    slug: id1.slug,
  })).payload;
  assert.equal(qcClosed.case.status, 'closed');
  assert.equal((await tool('zjz_qc_verify', { case_id: qcOpened.case_id })).payload.intact, true);
  assert.ok((await tool('zjz_qc_summary', { case_id: qcOpened.case_id })).payload.summary.includes('冒烟现象'));
  assert.equal((await tool('zjz_qc_list', { project: 'MCP质检' })).payload.cases.length, 1);
  const mcpEvents = (await tool('zjz_event_list', { project: 'MCP质检' })).payload;
  assert.ok(mcpEvents.events.length >= 5);
  assert.equal((await tool('zjz_event_verify', { project: 'MCP质检' })).payload.intact, true);
  assert.ok((await tool('zjz_event_projects', {})).payload.projects.some((p) => p.project === 'MCP质检'));
  process.stdout.write('[mcp] qc + event chain ok\n');

  const archived = (await tool('zjz_archive', { room_id: made.room_id, slug: id1.slug })).payload;
  assert.equal(archived.archived, true);

  const denied = await tool('zjz_send', { room_id: made.room_id, text: '归档后', slug: id1.slug });
  assert.equal(denied.isError, true);
  assert.equal(denied.payload.code, 'ROOM_ARCHIVED');
  process.stdout.write('[mcp] members + archive + ROOM_ARCHIVED ok\n');

  const who = (await tool('zjz_whoami', { slug: id1.slug })).payload;
  assert.equal(who.slug, id1.slug);
  process.stdout.write(`[mcp] ALL GREEN home=${home}\n`);
}

main()
  .then(() => {
    child.stdin.end();
    setTimeout(() => child.kill(), 100);
  })
  .catch((error) => {
    process.stderr.write(String(error && error.stack ? error.stack : error) + '\n');
    child.kill();
    process.exit(1);
  });
