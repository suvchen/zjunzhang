import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as zjz from '../src/core.js';
import { serve } from '../src/serve.js';

function seed() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'zjz-chief-api-'));
  const owner = zjz.identity.create(home, '参谋长测试房主');
  const room = zjz.room.create(home, owner.slug, '参谋长 API 房');
  return { home, owner, room };
}

test('chief API runs the full loop and posts its report to the room', async () => {
  const ctx = seed();
  const started = await serve.start(ctx.home, { port: 0 });
  try {
    const response = await fetch(`${started.address}/api/chief`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        goal: '参谋长：整理一份市场报告',
        by: ctx.owner.slug,
        room_id: ctx.room.room_id,
      }),
    });
    const raw = await response.text();
    assert.equal(response.status, 200, raw);
    const out = JSON.parse(raw);
    assert.equal(out.ok, true);
    assert.ok(out.plan_id);
    assert.equal(out.dispatched.length, 3);
    assert.match(out.report, /参谋长汇报/);
    assert.match(out.review, /监督官验收/);
    assert.equal(out.posted.ok, true, JSON.stringify(out.posted));

    const read = zjz.msg.read(ctx.home, ctx.owner.slug, ctx.room.room_id, {});
    assert.equal(read.ok, true);
    const postedText = read.messages.at(-1).text;
    assert.match(postedText, /参谋长汇报/);
    assert.match(postedText, /监督官验收/);
  } finally {
    await started.close();
  }
});

test('chief API rejects a non-member reporter before dispatching work', async () => {
  const ctx = seed();
  const outsider = zjz.identity.create(ctx.home, '房外发言人');
  const started = await serve.start(ctx.home, { port: 0 });
  try {
    const response = await fetch(`${started.address}/api/chief`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        goal: '不应被派发',
        by: outsider.slug,
        room_id: ctx.room.room_id,
      }),
    });
    const raw = await response.text();
    assert.equal(response.status, 403, raw);
    const out = JSON.parse(raw);
    assert.equal(out.ok, false);
    assert.equal(out.code, 'NOT_MEMBER');
    assert.equal(fs.existsSync(path.join(ctx.home, 'data', 'plans')), false);
  } finally {
    await started.close();
  }
});

test('chief API requires a reporter when posting back to a room', async () => {
  const ctx = seed();
  const started = await serve.start(ctx.home, { port: 0 });
  try {
    const response = await fetch(`${started.address}/api/chief`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ goal: '缺发送人', room_id: ctx.room.room_id }),
    });
    const raw = await response.text();
    assert.equal(response.status, 400, raw);
    const out = JSON.parse(raw);
    assert.equal(out.code, 'BAD_INPUT');
    assert.equal(fs.existsSync(path.join(ctx.home, 'data', 'plans')), false);
  } finally {
    await started.close();
  }
});
