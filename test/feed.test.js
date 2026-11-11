// T-008 feed 组件哨兵（总管）：huddo 房讯 → zjz 镜像房导入＋游标幂等＋提及抽取
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as zjz from '../src/core.js';
import { feed } from '../src/feed.js';

function tmpHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'zjz-feed-'));
}
function must(res, where) {
  assert.equal(res && res.ok, true, `${where} 应成功，实际 ${JSON.stringify(res)}`);
  return res;
}

// 假 huddo CLI：读 HUDDO_FIXTURE 指向的文本原样吐出（模拟 read 输出）
function fakeHuddo(home, text) {
  const fixture = path.join(home, 'fixture.txt');
  fs.writeFileSync(fixture, text, 'utf8');
  const script = path.join(home, 'fake_huddo.mjs');
  fs.writeFileSync(script, [
    "import fs from 'node:fs';",
    'process.stdout.write(fs.readFileSync(process.env.HUDDO_FIXTURE, "utf8"));',
  ].join('\n'), 'utf8');
  return { cmd: [process.execPath, script], envFixture: fixture };
}

const SAMPLE = [
  '#101 msg_aaa | agent-a (Agent A) | 2026-11-09T08:00:00.000Z | 普通一条房讯',
  '#102 msg_bbb | owner-001 (Owner) | 2026-11-09T08:20:36.662Z | 祝贺你们 @agent-b 把难关攻了下来',
].join('\n') + '\n';

test('F50 bind 建 zjz 镜像房＋重复 bind 幂等返回同房', () => {
  const home = tmpHome();
  const who = must(zjz.identity.create(home, '馈手'), 'identity');
  const b1 = must(feed.bind(home, { huddo_room: 'sp_test1', slug: who.slug, name: '房②镜像' }), 'bind1');
  const b2 = must(feed.bind(home, { huddo_room: 'sp_test1', slug: who.slug, name: '房②镜像' }), 'bind2');
  assert.equal(b2.existed, true);
  assert.equal(b1.bound.zjz_room, b2.bound.zjz_room);
  const listed = must(feed.bindings(home), 'bindings');
  assert.ok(listed.bindings.sp_test1);
});

test('F51 poll 导入新消息（走 ingest 桥 I36 幂等）＋游标持久不重报＋提及抽取', () => {
  const home = tmpHome();
  const who = must(zjz.identity.create(home, '馈手2'), 'identity');
  must(feed.bind(home, { huddo_room: 'sp_test1', slug: who.slug, name: '房②镜像' }), 'bind');
  const fake = fakeHuddo(home, SAMPLE);
  const opts = { huddo_cmd: fake.cmd, huddo_home: null, limit: 50 };
  process.env.HUDDO_FIXTURE = fake.envFixture;
  try {
    const p1 = must(feed.poll(home, opts), 'poll1');
    assert.equal(p1.fresh, 2, '首拉 2 条');
    assert.equal(p1.mentions.length, 1, '一条 @ 提及');
    assert.deepEqual(p1.mentions[0].at, ['@agent-b']);
    assert.equal(p1.mentions[0].ext_id, 'msg_bbb');

    const p2 = must(feed.poll(home, opts), 'poll2 重拉');
    assert.equal(p2.fresh, 0, '游标持久：重跑不重报');

    // 追加一条再拉：只报新的
    fs.writeFileSync(fake.envFixture, SAMPLE + '#103 msg_ccc | agent-b (Agent B) | 2026-11-09T08:30:00.000Z | 收到\n', 'utf8');
    const p3 = must(feed.poll(home, opts), 'poll3 增量');
    assert.equal(p3.fresh, 1);
    assert.equal(p3.new_records[0].ext_id, 'msg_ccc');

    // zjz 镜像房里确有导入消息（带 huddo 头，display_text 由 I39 清洗）
    const binds = must(feed.bindings(home), 'bindings').bindings.sp_test1;
    const msgs = must(zjz.msg.read(home, who.slug, binds.zjz_room), 'read');
    const texts = msgs.messages.map((m) => m.text);
    assert.ok(texts.some((t) => t.includes('[huddo:msg_bbb]')), '镜像房有导入行（ext_id 头）');
  } finally {
    delete process.env.HUDDO_FIXTURE;
  }
});

test('F52 huddo 读失败不炸、未绑定房点名 NOT_BOUND', () => {
  const home = tmpHome();
  const who = must(zjz.identity.create(home, '馈手3'), 'identity');
  const bad = { huddo_cmd: [process.execPath, '-e', 'process.exit(7)'] };
  must(feed.bind(home, { huddo_room: 'sp_down', slug: who.slug, name: '断线房' }), 'bind');
  const r = must(feed.poll(home, bad), 'poll 坏 CLI');
  assert.equal(r.rooms[0].ok, false);
  assert.equal(r.rooms[0].code, 'HUDDO_READ_FAILED');
  const r2 = must(feed.poll(home, { rooms: ['sp_unbound'], huddo_cmd: [process.execPath, '-e', 'process.stdout.write("")'] }), '未绑定');
  assert.equal(r2.rooms[0].code, 'NOT_BOUND');
});
