import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import * as zjz from '../src/core.js';
import { delivery as deliveryApi } from '../src/delivery.js';
import { serve } from '../src/serve.js';

function tmpHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'zjz-e36-'));
}

function must(result, where) {
  assert.equal(result && result.ok, true, `${where} failed: ${JSON.stringify(result)}`);
  return result;
}

function seed(home) {
  const owner = must(zjz.identity.create(home, 'E36 owner'), 'owner');
  const guest = must(zjz.identity.create(home, 'E36 guest'), 'guest');
  const room = must(zjz.room.create(home, owner.slug, 'E36 room'), 'room');
  must(zjz.room.join(home, guest.slug, room.invite_code), 'join');
  return { owner, guest, room };
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

test('E36 SSE push writes pushed status and pushed_at', async () => {
  const home = tmpHome();
  const ctx = seed(home);
  const started = await serve.start(home, { port: 0 });
  try {
    const stream = await openSse(`${started.address}/api/rooms/${ctx.room.room_id}/stream?member=${ctx.owner.slug}`);
    must(zjz.msg.send(home, ctx.guest.slug, ctx.room.room_id, 'E36 push'), 'send');
    const deadline = Date.now() + 2000;
    while (stream.messages.length < 1 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.equal(stream.messages.length, 1, 'SSE must receive the pushed message');

    const board = must(deliveryApi.board(home, {}), 'delivery board');
    const row = board.rows.find((item) => (
      item.room_id === ctx.room.room_id
      && item.msg_id === stream.messages[0].id
      && item.recipient === ctx.owner.slug
    ));
    assert.ok(row, 'SSE push must leave a delivery record');
    assert.equal(row.status, 'pushed');
    assert.ok(row.pushed_at, 'SSE push must write pushed_at');
    stream.response.destroy();
  } finally {
    await started.close();
  }
});
