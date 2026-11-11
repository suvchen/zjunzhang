// zjz CLI 冒烟：new -> join -> send -> read -> wait -> members -> archive -> 拒收
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';

const ROOT = path.resolve(import.meta.dirname, '..');
const CLI = path.join(ROOT, 'bin', 'zjz.mjs');
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'zjz-smoke-'));
const env = { ...process.env, ZJZ_HOME: home };

function run(args) {
  const result = spawnSync(process.execPath, [CLI, ...args], { env, encoding: 'utf8' });
  let json = null;
  try {
    json = result.stdout && result.stdout.trim() ? JSON.parse(result.stdout) : null;
  } catch {
    json = null;
  }
  return { status: result.status, json, stdout: result.stdout, stderr: result.stderr };
}

function step(name, fn) {
  const value = fn();
  process.stdout.write(`[smoke] ${name} ok\n`);
  return value;
}

const created = step('identity new', () => {
  const r = run(['identity', 'new', '--name', '冒烟员']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.json.ok, true);
  assert.match(r.json.slug, /^zjz-/);
  return r.json;
});

const made = step('new room', () => {
  const r = run(['new', '--name', '冒烟房']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.json.ok, true);
  assert.match(r.json.invite_code, /^ZJZ-[0-9A-F]{4}-[0-9A-F]{4}$/);
  return r.json;
});

const joined = step('join (owner re-join idempotent)', () => {
  const r = run(['join', made.invite_code]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.json.ok, true);
  assert.equal(r.json.already_member, true);
  return r.json;
});

const sent = step('send', () => {
  const r = run(['send', '你好，中军帐', '--room', made.room_id, '--mention', created.slug]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.json.ok, true);
  assert.equal(r.json.seq, 1);
  return r.json;
});

step('read (不推进游标)', () => {
  const r = run(['read', '--room', made.room_id]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.json.ok, true);
  assert.equal(r.json.messages.length, 1);
  assert.equal(r.json.messages[0].text, '你好，中军帐');
  assert.equal(r.json.messages[0].id, sent.id);
});

step('wait 1 (投递 1 条)', () => {
  const r = run(['wait', '--timeout', '1']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.json.ok, true);
  assert.equal(r.json.messages.length, 1);
  assert.equal(r.json.messages[0].seq, 1);
});

step('wait 2 (无重复)', () => {
  const r = run(['wait', '--timeout', '0']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.json.ok, true);
  assert.equal(r.json.messages.length, 0);
});

step('members', () => {
  const r = run(['members', made.room_id]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.json.ok, true);
  assert.equal(r.json.members.length, 1);
  assert.equal(r.json.members[0].slug, created.slug);
});

step('order dispatch -> claim -> deliver -> accept -> close', () => {
  const d = run(['order', 'dispatch', '--project', 'smoke', '--title', '冒烟工单', '--deliverables', 'x', '--acceptance', 'y']);
  assert.equal(d.status, 0, d.stderr);
  assert.equal(d.json.ok, true);
  const orderId = d.json.order_id;

  const c = run(['order', 'claim', orderId]);
  assert.equal(c.json.ok, true);
  assert.equal(c.json.claim_seq, 1);

  const dv = run(['order', 'deliver', orderId, '--note', '已交']);
  assert.equal(dv.json.status, 'delivered');

  const ac = run(['order', 'accept', orderId]);
  assert.equal(ac.json.status, 'accepted');

  const cl = run(['order', 'close', orderId]);
  assert.equal(cl.json.status, 'closed');

  const ls = run(['order', 'list', '--project', 'smoke']);
  assert.equal(ls.json.ok, true);
  assert.equal(ls.json.orders.length, 1);
  assert.equal(ls.json.orders[0].status, 'closed');
  return d.json;
});

step('duty set -> shift -> get', () => {
  const other = run(['identity', 'new', '--name', '冒烟夜班']);
  assert.equal(other.json.ok, true);
  const from = other.json.slug;

  const setFrom = run(['duty', 'set', '--slug', from, '--mode', 'oncall']);
  assert.equal(setFrom.json.mode, 'oncall');

  const setTo = run(['duty', 'set', '--slug', created.slug, '--mode', 'listen']);
  assert.equal(setTo.json.mode, 'listen');

  const shifted = run(['duty', 'shift', '--slug', from, '--to', created.slug]);
  assert.equal(shifted.status, 0, shifted.stderr);
  assert.equal(shifted.json.ok, true);
  assert.equal(shifted.json.from, from);
  assert.equal(shifted.json.to, created.slug);
  assert.ok(shifted.json.checkpoint && shifted.json.checkpoint.rooms);

  const got = run(['duty', 'get', '--slug', created.slug]);
  assert.equal(got.json.ok, true);
  assert.equal(got.json.duty.mode, 'oncall');
  assert.ok(got.json.duty.checkpoint);
});

step('search index -> query -> audit（CLI 检索接线，I23/I24）', () => {
  const who = run(['identity', 'new', '--name', '冒烟检索员']);
  assert.equal(who.json.ok, true);
  const room = run(['new', '--name', '检索冒烟房', '--slug', who.json.slug]);
  assert.equal(room.json.ok, true);
  const TOKEN = '检索冒烟专用词锟';
  assert.equal(run(['send', `${TOKEN} 的第一条`, '--room', room.json.room_id, '--slug', who.json.slug]).json.ok, true);
  assert.equal(run(['send', '无关内容一条', '--room', room.json.room_id, '--slug', who.json.slug]).json.ok, true);

  assert.equal(run(['search', 'index']).json.ok, true);
  const found = run(['search', TOKEN]);
  assert.equal(found.json.ok, true);
  assert.equal(found.json.total, 1, '二字以上中文词必须命中');
  assert.ok(found.json.hits[0].text.includes(TOKEN));
  assert.equal(found.json.hits[0].display_text, found.json.hits[0].text, '普通消息 display_text 应等于原文');
  assert.equal(found.json.hits[0].ext_id ?? null, null);
  assert.ok(found.json.hits[0].context.after.length >= 1, '命中必须带后文上下文');
  assert.equal(run(['search', TOKEN, '--sender', who.json.slug]).json.total, 1, '发送者过滤');
  assert.equal(run(['search', '不存在词锟斤拷']).json.total, 0, '精度：不存在的词必须零命中');
  const audit = run(['search', 'audit']);
  assert.equal(audit.json.intact, true, '对账必须 intact');
  assert.equal(audit.json.indexed, audit.json.messages);
  run(['search', 'index']);
  run(['search', 'index']);
  const again = run(['search', 'audit']);
  assert.equal(again.json.duplicates, 0, '反复 index 不得产生重复索引条目');
});

step('skill candidates -> approve -> search -> verify（CLI 技能库接线）', () => {
  const who = run(['identity', 'new', '--name', '冒烟技能官']);
  assert.equal(who.json.ok, true);
  const room = run(['new', '--name', '技能冒烟房', '--slug', who.json.slug]);
  assert.equal(room.json.ok, true);
  const sent = run(['send', '实测：技能冒烟验证通过，npm test 42/42 全绿，候选可回溯（test/smoke.mjs）', '--room', room.json.room_id, '--slug', who.json.slug]);
  assert.equal(sent.json.ok, true);

  const candidates = run(['skill', 'candidates', '--room', room.json.room_id]);
  assert.equal(candidates.json.ok, true);
  assert.equal(candidates.json.candidates.length, 1);
  const candidate = candidates.json.candidates[0];
  assert.equal(candidate.msg_id, sent.json.id);

  const baseArgs = [
    'skill', 'approve', candidate.candidate_id,
    '--by', who.json.slug,
    '--problem', '技能卡接入 CLI 后要能闭环验收',
    '--practice', '候选、缺栏拒、全栏入、检索、哈希链顺序验证',
    '--boundary', '本地单房冒烟',
    '--pitfalls', '不得跳过认可门',
    '--sources', `${room.json.room_id}/${sent.json.id}`,
  ];
  const missing = run(baseArgs);
  assert.equal(missing.status, 1);
  assert.equal(missing.json.code, 'SKILL_INCOMPLETE');

  const approved = run([...baseArgs, '--evidence', 'CLI smoke 全链断言']);
  assert.equal(approved.status, 0, approved.stderr);
  assert.equal(approved.json.ok, true);

  const found = run(['skill', 'search', '哈希链']);
  assert.equal(found.json.ok, true);
  assert.ok(found.json.hits.some((hit) => hit.msg_id === approved.json.card_id), 'skill search 必须召回技能卡');
  assert.equal(run(['skill', 'verify']).json.intact, true);
  assert.equal(run(['skill', 'audit']).json.intact, true);
});

step('qc open -> attach -> machine -> human -> close -> verify', () => {
  const artifact = path.join(home, 'smoke-base.mp4');
  fs.writeFileSync(artifact, 'SMOKE-BASE', 'utf8');

  const opened = run(['qc', 'open', '--project', 'smoke-qc', '--title', '冒烟台账', '--gates', 'frame,audio']);
  assert.equal(opened.status, 0, opened.stderr);
  assert.equal(opened.json.ok, true);
  const caseId = opened.json.case_id;

  const attached = run(['qc', 'attach', caseId, '--path', artifact, '--role', 'baseline']);
  assert.equal(attached.json.ok, true);
  assert.equal(attached.json.case.status, 'collecting');

  const machine = run(['qc', 'machine', caseId, '--gate', 'frame', '--result', 'pass', '--metrics', '{"fps":24}']);
  assert.equal(machine.json.case.status, 'machine_checked');

  const human = run(['qc', 'human', caseId, '--verdict', 'pass', '--note', '冒烟目审']);
  assert.equal(human.json.case.status, 'human_verdict');

  const closed = run(['qc', 'close', caseId,
    '--phenomenon', '冒烟现象',
    '--attribution-layer', '参数层',
    '--fix', '冒烟修法',
    '--repro-count', '2',
    '--conclusion', 'baseline']);
  assert.equal(closed.json.case.status, 'closed');

  const verified = run(['qc', 'verify', caseId]);
  assert.equal(verified.json.intact, true);

  const summary = run(['qc', 'summary', caseId]);
  assert.ok(summary.json.summary.includes('冒烟现象'));

  const listed = run(['qc', 'list', '--project', 'smoke-qc']);
  assert.equal(listed.json.cases.length, 1);

  const eventList = run(['event', 'list', '--project', 'smoke-qc']);
  assert.ok(eventList.json.events.length >= 5);
  assert.equal(run(['event', 'verify', '--project', 'smoke-qc']).json.intact, true);
  assert.ok(run(['event', 'projects']).json.projects.some((p) => p.project === 'smoke-qc'));
});

step('archive', () => {
  const r = run(['archive', made.room_id, '--slug', created.slug]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.json.ok, true);
  assert.equal(r.json.archived, true);
});

step('send after archive -> ROOM_ARCHIVED', () => {
  const r = run(['send', '归档后不该发出', '--room', made.room_id, '--slug', created.slug]);
  assert.equal(r.status, 1);
  assert.equal(r.json.ok, false);
  assert.equal(r.json.code, 'ROOM_ARCHIVED');
});

process.stdout.write(`[smoke] ALL GREEN home=${home}\n`);
