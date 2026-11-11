import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { serve } from '../src/serve.js';

test('first-run identity bootstrap can create a room immediately', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'zjz-identity-bootstrap-'));
  const started = await serve.start(home, { port: 0 });
  try {
    const identityResponse = await fetch(`${started.address}/api/identity/create`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: '主人' }),
    });
    const identityText = await identityResponse.text();
    assert.equal(identityResponse.status, 200, identityText);
    const identity = JSON.parse(identityText);
    assert.equal(identity.ok, true);
    assert.ok(identity.slug);

    const roomResponse = await fetch(`${started.address}/api/rooms/create`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ by: identity.slug, name: '首个项目房' }),
    });
    const roomText = await roomResponse.text();
    assert.equal(roomResponse.status, 200, roomText);
    const room = JSON.parse(roomText);
    assert.equal(room.ok, true);
    assert.ok(room.room_id);
    assert.ok(room.invite_code);
  } finally {
    await started.close();
  }
});
