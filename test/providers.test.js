// 哨兵 M56 · provider 槽位视图（总管）：本机只有一个本地模型槽（E15），
// 所以「谁配置在用本地、本地槽现在被谁占着」必须是可查的，不能靠人记住分流表。
// 判据来源：error-cards.md E15（单槽串行，并发 2 全排队、并发 4 有请求被断）＋ PROGRESS 分流表。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { member } from '../src/member.js';
import { resource } from '../src/resource.js';

function tmpHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'zjz-providers-'));
}
function must(res, where) {
  assert.equal(res && res.ok, true, `${where} 应成功，实际 ${JSON.stringify(res)}`);
  return res;
}

test('M56-1 空 home：providers 返回空清单，local_slots=0（不得崩）', () => {
  const home = tmpHome();
  const r = member.providers(home);
  must(r, 'providers');
  assert.equal(r.members.length, 0);
  assert.equal(r.summary.local_slots, 0);
});

test('M56-2 spawn 成员：有本地线索算本地；没有线索不猜云端，老实标 unknown；显式声明才改判', () => {
  const home = tmpHome();
  must(member.set(home, {
    slug: '甲-本地', adapter_kind: 'spawn',
    argv: ['host-cli', 'run', '--model', 'local-strata/strata-iq3s-125b', '{task}'],
  }), 'set 甲');
  must(member.set(home, {
    slug: '乙-云端', adapter_kind: 'spawn',
    argv: ['host-cli', 'run', '--model', 'deepseek-api/deepseek-flash', '{task}'],
  }), 'set 乙');
  const r = member.providers(home);
  must(r, 'providers');
  assert.equal(r.members.find((m) => m.slug === '甲-本地').provider, 'local');
  assert.equal(r.members.find((m) => m.slug === '乙-云端').provider, 'unknown', 'argv 里没有本地线索就不能断定它是云端');
  assert.equal(r.summary.local_slots, 1);
  assert.deepEqual(r.summary.local_members, ['甲-本地']);
  // 显式声明后改判（装机时应把这一项写清楚，别留 unknown）
  must(member.set(home, {
    slug: '乙-云端', adapter_kind: 'spawn', provider: 'remote',
    argv: ['host-cli', 'run', '--model', 'deepseek-api/deepseek-flash', '{task}'],
  }), 'set 乙(显式)');
  assert.equal(member.providers(home).members.find((m) => m.slug === '乙-云端').provider, 'remote');
});

test('M56-3 api 成员按 url 判：回环地址＝本地（同一台机器的同一个槽）', () => {
  const home = tmpHome();
  must(member.set(home, { slug: '丙-回环', adapter_kind: 'api', url: 'http://127.0.0.1:8081/v1/chat' }), 'set 丙');
  must(member.set(home, { slug: '丁-远端', adapter_kind: 'api', url: 'https://api.deepseek.com/v1/chat' }), 'set 丁');
  const r = member.providers(home);
  must(r, 'providers');
  assert.equal(r.members.find((m) => m.slug === '丙-回环').provider, 'local');
  assert.equal(r.members.find((m) => m.slug === '丁-远端').provider, 'remote');
  assert.equal(r.summary.local_slots, 1);
});

test('M56-4 缺 provider 线索的成员如实标 unknown，不猜（不得静默算本地或云端）', () => {
  const home = tmpHome();
  must(member.set(home, { slug: '戊-裸', adapter_kind: 'spawn', argv: ['some-tool', '{task}'] }), 'set 戊');
  const r = member.providers(home);
  must(r, 'providers');
  assert.equal(r.members.find((m) => m.slug === '戊-裸').provider, 'unknown');
  assert.equal(r.summary.unknown, 1);
});

test('M56-5 本地槽占用与 resource claim 一致：占着的人看得见，释放后回到空闲', () => {
  const home = tmpHome();
  must(member.set(home, {
    slug: '甲-本地', adapter_kind: 'spawn',
    argv: ['host-cli', 'run', '--model', 'local-strata/strata-iq3s-125b', '{task}'],
  }), 'set 甲');
  assert.equal(member.providers(home).summary.local_held, false, '未 claim 时应显示空闲');
  must(resource.claim(home, { resource: 'local-iq3', slug: '甲-本地', ttl_ms: 60000 }), 'claim');
  const held = member.providers(home);
  must(held, 'providers(占用中)');
  assert.equal(held.summary.local_held, true);
  assert.equal(held.summary.local_holder, '甲-本地');
  assert.ok(held.summary.local_hold_remaining_ms > 0);
  must(resource.release(home, { resource: 'local-iq3', slug: '甲-本地' }), 'release');
  assert.equal(member.providers(home).summary.local_held, false, '释放后应回到空闲');
});

test('M56-7 member set 是合并语义：只改一项不得抹掉 instructions/mention_handles/wake_policy（装机中途换模型会踩这个坑）', () => {
  const home = tmpHome();
  must(member.set(home, {
    slug: '甲-本地', adapter_kind: 'spawn',
    argv: ['host', '--model', 'local-strata/x', '{task}'],
    instructions: '只回帖一次', wake_policy: 'mention', mention_handles: ['huddo-甲'],
    env: { HUDDO_HOME: 'D:/huddo/data-x' },
  }), 'set 初次');
  must(member.set(home, {
    slug: '甲-本地', adapter_kind: 'spawn', provider: 'remote',
    argv: ['host', '--model', 'deepseek-api/deepseek-flash', '{task}'],
  }), 'set 换模型');
  const got = must(member.get(home, '甲-本地'), 'get');
  assert.equal(got.member.instructions, '只回帖一次');
  assert.deepEqual(got.member.mention_handles, ['huddo-甲']);
  assert.equal(got.member.wake_policy, 'mention');
  assert.deepEqual(got.member.env, { HUDDO_HOME: 'D:/huddo/data-x' });
  assert.equal(got.member.provider, 'remote');
  assert.match(got.member.argv.join(' '), /deepseek-api/);
});

test('M56-8 argv 被 shell 二次转义写坏（单 token 且以 [ 开头）必须当场拒绝，不能留到唤醒时才报拉不起来', () => {
  const home = tmpHome();
  const bad = '["host-cli","run","--model","x/y","{task}"]';
  const r = member.set(home, { slug: '甲', adapter_kind: 'spawn', argv: [bad] });
  assert.equal(r && r.ok, false, '这种档案必须拒收');
  assert.equal(r.code, 'ADAPTER_ARGV_ESCAPED');
  assert.match(r.message, /转义|JSON/);
  // 正常单 token（真就一个可执行，靠 {task} 之外的参数不行但形态合法）不该误伤
  const okOne = member.set(home, { slug: '乙', adapter_kind: 'spawn', argv: ['C:\\tools\\host.exe'] });
  assert.equal(okOne && okOne.ok, true, `合法单 token 不该被拒：${JSON.stringify(okOne)}`);
});

test('M56-6 只有一个本地槽：配置里本地成员多于一个＝红旗（over_subscribed），不是崩溃但必须可见', () => {
  const home = tmpHome();
  for (const slug of ['甲', '乙']) {
    must(member.set(home, { slug, adapter_kind: 'spawn', argv: ['host', '--model', 'local-strata/x', '{task}'] }), `set ${slug}`);
  }
  const r = member.providers(home);
  must(r, 'providers');
  assert.equal(r.summary.local_slots, 2);
  assert.equal(r.summary.over_subscribed, true, '两个成员配本地＝超卖，必须给红旗');
});
