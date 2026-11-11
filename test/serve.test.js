// M4/T-008 serve 骨架红测：I40 单实例 / I41 回环 / I42 UI 零消耗 / I43 跨房隔离。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import * as zjz from '../src/core.js';

let serve = null;
try {
  ({ serve } = await import('../src/serve.js'));
} catch {
  serve = null;
}

function tmpHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'zjz-serve-'));
}

function must(result, where) {
  assert.equal(result && result.ok, true, `${where} 应成功，实际 ${JSON.stringify(result)}`);
  return result;
}

function seed(home) {
  const owner = must(zjz.identity.create(home, 'serve房主'), 'identity owner');
  const guest = must(zjz.identity.create(home, 'serve成员'), 'identity guest');
  const outsider = must(zjz.identity.create(home, 'serve外人'), 'identity outsider');
  const room = must(zjz.room.create(home, owner.slug, 'serve房'), 'room');
  must(zjz.room.join(home, guest.slug, room.invite_code), 'join guest');
  return { owner, guest, outsider, room };
}

async function getJson(url) {
  const response = await fetch(url);
  return { status: response.status, json: await response.json() };
}

async function getText(url) {
  const response = await fetch(url);
  return { status: response.status, text: await response.text(), type: response.headers.get('content-type') };
}

function rawRequest(baseUrl, method, rawPath) {
  const target = new URL(baseUrl);
  return new Promise((resolve, reject) => {
    const request = http.request({
      hostname: target.hostname,
      port: target.port,
      method,
      path: rawPath,
    }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { body += chunk; });
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body }));
    });
    request.on('error', reject);
    request.end();
  });
}

function openSse(url) {
  return new Promise((resolve, reject) => {
    const request = http.get(url, (response) => {
      let buffer = '';
      const messages = [];
      response.setEncoding('utf8');
      response.on('data', (chunk) => {
        buffer += chunk;
        const parts = buffer.split('\n\n');
        buffer = parts.pop();
        for (const part of parts) {
          const match = part.match(/^event: message\ndata: (.+)$/ms);
          if (match) messages.push(JSON.parse(match[1]));
        }
      });
      resolve({ response, messages });
    });
    request.on('error', reject);
  });
}

test('I40 serve 单实例：第二实例返回 ALREADY_RUNNING', async () => {
  assert.ok(serve, 'src/serve.js 未实现（红测）');
  const home = tmpHome();
  seed(home);
  const first = await serve.start(home, { port: 0 });
  assert.equal(first.ok, true);
  const second = await serve.start(home, { port: 0 });
  assert.equal(second.ok, false);
  assert.equal(second.code, 'ALREADY_RUNNING');
  assert.match(String(second.address), /^http:\/\/127\.0\.0\.1:\d+$/);
  await first.close();
});

test('I41 serve 只绑 127.0.0.1 且回环可达', async () => {
  assert.ok(serve, 'src/serve.js 未实现（红测）');
  const home = tmpHome();
  seed(home);
  const started = await serve.start(home, { port: 0 });
  assert.equal(started.ok, true);
  assert.equal(started.host, '127.0.0.1');
  const health = await getJson(`${started.address}/api/health`);
  assert.equal(health.status, 200);
  assert.equal(health.json.ok, true);
  const homePage = await getText(`${started.address}/`);
  assert.equal(homePage.status, 200);
  assert.match(homePage.type || '', /text\/html/);
  assert.match(homePage.text, /<!doctype html>/i);
  await started.close();
});

test('I42 UI SSE 零消耗：推送后成员 wait 仍收齐全部消息', async () => {
  assert.ok(serve, 'src/serve.js 未实现（红测）');
  const home = tmpHome();
  const ctx = seed(home);
  const started = await serve.start(home, { port: 0 });
  const stream = await openSse(`${started.address}/api/rooms/${ctx.room.room_id}/stream?member=${ctx.owner.slug}`);
  must(zjz.msg.send(home, ctx.guest.slug, ctx.room.room_id, 'SSE第一条'), 'send 1');
  must(zjz.msg.send(home, ctx.guest.slug, ctx.room.room_id, 'SSE第二条'), 'send 2');
  const deadline = Date.now() + 2000;
  while (stream.messages.length < 2 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25));
  stream.response.destroy();
  assert.deepEqual(stream.messages.map((row) => row.seq), [1, 2], '在线通道 2 秒内必须收到');
  const waited = must(zjz.msg.wait(home, ctx.owner.slug, { timeout_ms: 100 }), 'wait');
  assert.deepEqual(waited.messages.map((row) => row.seq), [1, 2], 'SSE 不得消费成员游标');
  await started.close();
});

test('I43 跨房隔离：非成员读 API 返回 NOT_MEMBER', async () => {
  assert.ok(serve, 'src/serve.js 未实现（红测）');
  const home = tmpHome();
  const ctx = seed(home);
  const started = await serve.start(home, { port: 0 });
  const result = await getJson(`${started.address}/api/rooms/${ctx.room.room_id}/messages?slug=${ctx.outsider.slug}`);
  assert.equal(result.status, 403);
  assert.equal(result.json.code, 'NOT_MEMBER');
  await started.close();
});

test('M4 静态文件路由：MIME、HEAD、403 越界与 API 不回退', async () => {
  assert.ok(serve, 'src/serve.js 未实现（红测）');
  const home = tmpHome();
  seed(home);
  const started = await serve.start(home, { port: 0 });
  try {
    const index = await getText(`${started.address}/index.html`);
    assert.equal(index.status, 200);
    assert.match(index.type || '', /text\/html/);

    const head = await rawRequest(started.address, 'HEAD', '/');
    assert.equal(head.status, 200);
    assert.match(head.headers['content-type'] || '', /text\/html/);
    assert.equal(head.headers['cache-control'], 'no-store');
    assert.equal(head.body, '');

    const missing = await getJson(`${started.address}/missing.js`);
    assert.equal(missing.status, 404);
    assert.equal(missing.json.code, 'NOT_FOUND');

    const traversal = await rawRequest(started.address, 'GET', '/../src/serve.js');
    assert.equal(traversal.status, 403);
    assert.equal(traversal.body.includes('class Broker'), false);
    assert.match(traversal.body, /STATIC_FORBIDDEN/);

    const encoded = await rawRequest(started.address, 'GET', '/%2e%2e/src/serve.js');
    assert.equal(encoded.status, 403);
    assert.match(encoded.body, /STATIC_FORBIDDEN/);

    const post = await rawRequest(started.address, 'POST', '/');
    assert.equal(post.status, 404);
    assert.match(post.body, /NOT_FOUND/);

    const api = await getJson(`${started.address}/api/health`);
    assert.equal(api.status, 200);
    assert.equal(api.json.ok, true);
  } finally {
    await started.close();
  }
});

// ---- E18：旧租约不得让「起服务」假失败；pid 被回收不得误判/误杀 ----
import { spawn } from 'node:child_process';
import { member as memberApi } from '../src/member.js';

function writeLease(home, pid, port = 8899) {
  const dir = path.join(home, 'data', 'serve');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'lease.json'), JSON.stringify({ pid, port, host: '127.0.0.1', home, session_id: 0, started_at: new Date().toISOString() }), 'utf8');
}

test('E18-A 死租约＝环境残骸：起服务就地清掉继续起，不报产品红', async () => {
  assert.ok(serve, 'src/serve.js 未实现（红测）');
  const home = tmpHome();
  seed(home);
  const ghost = spawn(process.execPath, ['-e', 'process.exit(0)'], { windowsHide: true, stdio: 'ignore' });
  await new Promise((r) => ghost.once('exit', r));
  writeLease(home, ghost.pid);

  const started = await serve.start(home, { port: 0 });
  try {
    assert.equal(started.ok, true, `死租约不得挡起服务，实际 ${JSON.stringify(started)}`);
    assert.equal(started.stale_lease_cleared, true, '必须显式告知清掉了陈旧租约');
  } finally {
    if (started.ok) await started.close();
  }
});

test('E18-B pid 被回收给无关进程：不得当 serve 已在跑、stop 不得杀它', async () => {
  assert.ok(serve, 'src/serve.js 未实现（红测）');
  const home = tmpHome();
  seed(home);
  const decoy = spawn(process.execPath, ['-e', 'setTimeout(()=>{}, 30000)'], { windowsHide: true, stdio: 'ignore' });
  try {
    writeLease(home, decoy.pid);

    const stopped = serve.stop(home);
    assert.equal(stopped.ok, false);
    assert.equal(stopped.code, 'LEASE_STALE', '非 zjz serve 的 pid 必须走 LEASE_STALE，不得 kill');

    const started = await serve.start(home, { port: 0 });
    try {
      assert.equal(started.ok, true, `pid 被回收不得报 ALREADY_RUNNING，实际 ${JSON.stringify(started)}`);
      assert.equal(started.stale_lease_cleared, true);
    } finally {
      if (started.ok) await started.close();
    }
    let alive = true;
    try { process.kill(decoy.pid, 0); } catch { alive = false; }
    assert.equal(alive, true, '无关进程必须还活着（E16 红线：禁按名/模糊匹配杀）');
  } finally {
    try { decoy.kill(); } catch { /* already gone */ }
  }
});

test('红靶二 值班板：只有成员档案、无同名身份的 slug 也必须上板，listening 取真实值', async () => {
  assert.ok(serve, 'src/serve.js 未实现（红测）');
  const home = tmpHome();
  seed(home);
  must(memberApi.set(home, { slug: '孤身成员', adapter_kind: 'notify' }), 'register 无同名身份的成员');
  const started = await serve.start(home, { port: 0 });
  try {
    assert.equal(started.ok, true);
    const res = await fetch(`http://127.0.0.1:${started.port}/api/duty/board`);
    const body = await res.json();
    assert.equal(body.ok, true);
    const slugs = body.members.map((row) => row.slug);
    assert.ok(slugs.includes('孤身成员'), `成员档案必须上板，实际 ${JSON.stringify(slugs)}`);
    assert.equal(typeof body.listening, 'boolean', 'listening 必须是真值而非写死 false');
  } finally {
    await started.close();
  }
});
// ---- E33：客户自助开项目房（总管 3b96147/58193 补的接口，Codex 复核并补对位测试）----
test('E33 开项目房：建房人即房主，缺 by 必须 400', async () => {
  assert.ok(serve, 'src/serve.js 未实现（红测）');
  const home = tmpHome();
  const who = seed(home);
  const started = await serve.start(home, { port: 0 });
  try {
    const base = `http://127.0.0.1:${started.port}`;
    const r1 = await fetch(`${base}/api/rooms/create`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ by: who.owner.slug, name: '测试项目房' }) });
    const j1 = await r1.json();
    assert.equal(r1.status, 200, `建房应成功，实际 ${JSON.stringify(j1)}`);
    assert.ok(j1.room_id, '必须返回 room_id');
    assert.ok(j1.invite_code, '必须返回 invite_code（客户要拿去拉人）');

    const r2 = await fetch(`${base}/api/rooms/create`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: '缺建房人' }) });
    const j2 = await r2.json();
    assert.equal(r2.status, 400, '缺 by 必须 400');
    assert.equal(j2.code, 'BAD_INPUT');
  } finally {
    await started.close();
  }
});
// ---- E35：/api/messages 缺 slug 必须报错点名缺参（不默认身份，否则搞不清谁在说话）----
test('E35 读消息缺 slug 必须 400 并点名缺参', async () => {
  assert.ok(serve, 'src/serve.js 未实现（红测）');
  const home = tmpHome();
  const who = seed(home);
  const started = await serve.start(home, { port: 0 });
  try {
    const base = `http://127.0.0.1:${started.port}`;
    const r = await fetch(`${base}/api/rooms/${who.room.room_id}/messages`);
    const j = await r.json();
    assert.equal(r.status, 400, `缺 slug 必须 400，实际 ${JSON.stringify(j)}`);
    assert.equal(j.code, 'BAD_INPUT');
    assert.equal(j.missing, 'query.slug', '必须点名缺哪个参数');
    assert.match(String(j.message), /slug/, '报错要说清补法');
  } finally {
    await started.close();
  }
});