// 中军帐 M1 哨兵测试：I1-I7（node --test）
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import * as zjz from '../src/core.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const FIX = path.join(import.meta.dirname, 'fixtures');

function tmpHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'zjz-home-'));
}

function must(res, where) {
  assert.equal(res && res.ok, true, `${where} 应成功，实际 ${JSON.stringify(res)}`);
  return res;
}

function assertCode(res, code, where) {
  assert.equal(res && res.ok, false, `${where} 应失败，实际 ${JSON.stringify(res)}`);
  assert.equal(res.code, code, `${where} 错误码应为 ${code}，实际 ${res.code}`);
}

function fixture(name) {
  return JSON.parse(fs.readFileSync(path.join(FIX, name), 'utf8'));
}

function messagePath(home, roomId) {
  return path.join(home, 'data', 'rooms', roomId, 'messages.jsonl');
}

function tamperFirstMessage(home, roomId) {
  const file = messagePath(home, roomId);
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
  const first = JSON.parse(lines[0]);
  first.text += '（被篡改）';
  lines[0] = JSON.stringify(first);
  fs.writeFileSync(file, lines.join('\n') + '\n', 'utf8');
}

// ---------- T1 I1 ----------
test('T1 I1 单房连续发 5 条，seq 严格递增无洞无重', () => {
  const home = tmpHome();
  const id = must(zjz.identity.create(home, '卡卡'), 'identity.create');
  const room = must(zjz.room.create(home, id.slug, '中军帐'), 'room.create');
  const seqs = [];
  for (const text of ['一', '二', '三', '四', '五']) {
    const sent = must(zjz.msg.send(home, id.slug, room.room_id, text), `send ${text}`);
    seqs.push(sent.seq);
  }
  assert.deepEqual(seqs, fixture('t1-expected.json').seqs);
  const read = must(zjz.msg.read(home, id.slug, room.room_id), 'msg.read');
  assert.deepEqual(read.messages.map(m => m.seq), [1, 2, 3, 4, 5]);
  assert.deepEqual(read.messages.map(m => m.text), ['一', '二', '三', '四', '五']);
});

// ---------- T2 I2 ----------
test('T2 I2 篡改消息文本后读取，验签失败被拒', () => {
  const home = tmpHome();
  const id = must(zjz.identity.create(home, '校验员'), 'identity.create');
  const room = must(zjz.room.create(home, id.slug, '验签房'), 'room.create');
  must(zjz.msg.send(home, id.slug, room.room_id, '原文'), 'send');
  tamperFirstMessage(home, room.room_id);
  assertCode(zjz.msg.read(home, id.slug, room.room_id), fixture('t6-bad-sig.json').code, 'tampered read');
  const auditFile = path.join(home, 'data', 'audit.jsonl');
  assert.equal(fs.existsSync(auditFile), true, '篡改应留下审计记录');
  assert.match(fs.readFileSync(auditFile, 'utf8'), /SIGNATURE_INVALID/);
});

// ---------- T3 I3 ----------
test('T3 I3 双房隔离：A 房 3 条、B 房 2 条互不可见', () => {
  const home = tmpHome();
  const id = must(zjz.identity.create(home, '分房员'), 'identity.create');
  const roomA = must(zjz.room.create(home, id.slug, 'A房'), 'create A');
  const roomB = must(zjz.room.create(home, id.slug, 'B房'), 'create B');
  for (const t of ['a1', 'a2', 'a3']) must(zjz.msg.send(home, id.slug, roomA.room_id, t), 'send A');
  for (const t of ['b1', 'b2']) must(zjz.msg.send(home, id.slug, roomB.room_id, t), 'send B');

  const readA = must(zjz.msg.read(home, id.slug, roomA.room_id), 'read A');
  const readB = must(zjz.msg.read(home, id.slug, roomB.room_id), 'read B');
  assert.deepEqual(readA.messages.map(m => m.text), ['a1', 'a2', 'a3']);
  assert.deepEqual(readB.messages.map(m => m.text), ['b1', 'b2']);
  assert.equal(readA.messages.every(m => m.text.startsWith('a')), true);
  assert.equal(readB.messages.every(m => m.text.startsWith('b')), true);
});

// ---------- T4 I4 ----------
test('T4 I4 wait 两次调用无重复投递，游标单调', () => {
  const home = tmpHome();
  const id = must(zjz.identity.create(home, '值班员'), 'identity.create');
  const room = must(zjz.room.create(home, id.slug, '值班房'), 'room.create');
  must(zjz.msg.send(home, id.slug, room.room_id, '第一条'), 'send 1');
  must(zjz.msg.send(home, id.slug, room.room_id, '第二条'), 'send 2');

  const first = must(zjz.msg.wait(home, id.slug, { timeout_ms: 100 }), 'wait 1');
  assert.deepEqual(first.messages.map(m => m.seq), [1, 2]);

  const second = must(zjz.msg.wait(home, id.slug, { timeout_ms: 30 }), 'wait 2');
  assert.deepEqual(second.messages, [], '第二次 wait 不应重复投递');

  must(zjz.msg.send(home, id.slug, room.room_id, '第三条'), 'send 3');
  const third = must(zjz.msg.wait(home, id.slug, { timeout_ms: 100 }), 'wait 3');
  assert.deepEqual(third.messages.map(m => m.seq), [3]);
});

// ---------- T5 I5 ----------
test('T5 I5 归档房 send 返回 ROOM_ARCHIVED', () => {
  const home = tmpHome();
  const id = must(zjz.identity.create(home, '归档员'), 'identity.create');
  const room = must(zjz.room.create(home, id.slug, '归档房'), 'room.create');
  must(zjz.msg.send(home, id.slug, room.room_id, '归档前'), 'send before archive');
  must(zjz.room.archive(home, id.slug, room.room_id), 'archive');
  assertCode(zjz.msg.send(home, id.slug, room.room_id, '归档后'), 'ROOM_ARCHIVED', 'send after archive');
});

// ---------- T6 I6 ----------
test('T6 I6 空/坏输入全部结构化错误，不裸抛', () => {
  const home = tmpHome();
  assertCode(zjz.identity.create(home, ''), fixture('t6-empty-name.json').code, 'empty name');

  const owner = must(zjz.identity.create(home, '房主'), 'owner');
  const outsider = must(zjz.identity.create(home, '外来者'), 'outsider');
  const room = must(zjz.room.create(home, owner.slug, '准入房'), 'room');
  assertCode(zjz.msg.send(home, outsider.slug, room.room_id, '混进来'), fixture('t6-not-member.json').code, 'not member');

  const emptyRead = must(zjz.msg.read(home, owner.slug, room.room_id), 'empty room read');
  assert.deepEqual(emptyRead.messages, []);

  must(zjz.msg.send(home, owner.slug, room.room_id, '原话'), 'send');
  tamperFirstMessage(home, room.room_id);
  assertCode(zjz.msg.read(home, owner.slug, room.room_id), fixture('t6-bad-sig.json').code, 'bad signature');
});

// ---------- T7 I7 ----------
function runCreate(homeDir, name) {
  const script = [
    `import * as zjz from ${JSON.stringify(pathToFileURL(path.join(ROOT, 'src', 'core.js')).href)};`,
    `const res = zjz.identity.create(${JSON.stringify(homeDir)}, ${JSON.stringify(name)});`,
    `process.stdout.write(JSON.stringify(res));`,
  ].join('\n');
  return new Promise((resolve, reject) => {
    execFile(process.execPath, ['--input-type=module', '-e', script], (error, stdout, stderr) => {
      if (error) reject(new Error(`${error.message}\n${stderr}`));
      else resolve(JSON.parse(stdout));
    });
  });
}

test('T7 I7 两个 home 并发写互不污染身份', async () => {
  const homeA = tmpHome();
  const homeB = tmpHome();
  const [a, b] = await Promise.all([runCreate(homeA, '同名智能体'), runCreate(homeB, '同名智能体')]);
  must(a, 'homeA create');
  must(b, 'homeB create');
  assert.notEqual(a.slug, b.slug);
  assert.deepEqual(fs.readdirSync(path.join(homeA, 'data', 'identities')), [a.slug]);
  assert.deepEqual(fs.readdirSync(path.join(homeB, 'data', 'identities')), [b.slug]);
  assertCode(zjz.identity.load(homeB, a.slug), 'NOT_FOUND', 'homeB 不应看到 homeA 身份');
});