import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as zjz from '../src/core.js';
import { serve } from '../src/serve.js';

function tmpHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'zjz-agent-life-'));
}

function must(result, where) {
  assert.equal(result && result.ok, true, `${where} failed: ${JSON.stringify(result)}`);
  return result;
}

async function postJson(base, route, body) {
  const response = await fetch(`${base}${route}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: response.status, json: await response.json() };
}

async function getJson(base, route) {
  const response = await fetch(`${base}${route}`);
  return { status: response.status, json: await response.json() };
}

test('E37 agent room lifecycle keeps other rooms and identity reusable', async () => {
  const home = tmpHome();
  const owner = must(zjz.identity.create(home, 'Lifecycle owner'), 'owner');
  const outsider = must(zjz.identity.create(home, 'Lifecycle outsider'), 'outsider');
  const roomA = must(zjz.room.create(home, owner.slug, 'Lifecycle room A'), 'room A');
  const roomB = must(zjz.room.create(home, owner.slug, 'Lifecycle room B'), 'room B');
  const started = await serve.start(home, { port: 0 });

  try {
    const base = started.address;
    const invitedA = await postJson(base, '/api/agents/invite', {
      by: owner.slug,
      room_id: roomA.room_id,
      name: 'Lifecycle Agent',
      adapter_kind: 'notify',
      wake_policy: 'mention',
    });
    assert.equal(invitedA.status, 200, JSON.stringify(invitedA.json));
    const agentSlug = invitedA.json.slug;
    assert.equal(invitedA.json.wiring.wired, true);

    const invitedB = await postJson(base, '/api/agents/invite', {
      by: owner.slug,
      room_id: roomB.room_id,
      slug: agentSlug,
      adapter_kind: 'notify',
      wake_policy: 'mention',
    });
    assert.equal(invitedB.status, 200, JSON.stringify(invitedB.json));
    assert.equal(invitedB.json.wiring.rooms.length, 2);
    assert.deepEqual(invitedB.json.wiring.rooms.map((row) => row.owner), [owner.slug, owner.slug]);

    const removedA = await postJson(base, '/api/agents/remove', {
      by: owner.slug,
      room_id: roomA.room_id,
      slug: agentSlug,
    });
    assert.equal(removedA.status, 200, JSON.stringify(removedA.json));
    assert.deepEqual(removedA.json.removed_from, [roomA.room_id]);
    assert.equal(removedA.json.adapter_unbound, false, 'still in room B, so adapter must remain bound');
    assert.deepEqual(removedA.json.still_in_rooms, [roomB.room_id]);

    const afterA = await getJson(base, '/api/agents');
    const kept = afterA.json.agents.find((row) => row.slug === agentSlug);
    assert.ok(kept, 'agent must stay listed while it remains in another room');
    assert.equal(kept.wired, true);
    assert.deepEqual(kept.rooms.map((row) => row.room_id), [roomB.room_id]);

    const denied = await postJson(base, '/api/agents/remove', {
      by: outsider.slug,
      room_id: roomB.room_id,
      slug: agentSlug,
    });
    assert.equal(denied.status, 403);
    assert.equal(denied.json.code, 'NOT_OPERATOR');

    const removedB = await postJson(base, '/api/agents/remove', {
      by: owner.slug,
      room_id: roomB.room_id,
      slug: agentSlug,
    });
    assert.equal(removedB.status, 200, JSON.stringify(removedB.json));
    assert.deepEqual(removedB.json.removed_from, [roomB.room_id]);
    assert.equal(removedB.json.adapter_unbound, true);
    assert.deepEqual(removedB.json.still_in_rooms, []);

    assert.equal(must(zjz.identity.load(home, agentSlug), 'identity retained').slug, agentSlug);
    const reinvited = await postJson(base, '/api/agents/invite', {
      by: owner.slug,
      room_id: roomA.room_id,
      slug: agentSlug,
      adapter_kind: 'notify',
      wake_policy: 'mention',
    });
    assert.equal(reinvited.status, 200, JSON.stringify(reinvited.json));
    assert.equal(reinvited.json.slug, agentSlug);
    assert.equal(reinvited.json.wiring.wired, true);

    const ui = fs.readFileSync(path.join(process.cwd(), 'public', 'index.html'), 'utf8');
    assert.match(ui, /for \(const room of \(r\.rooms \|\| \[\]\)\)|\(r\.rooms \|\| \[\]\)\.map\(\(x\)/);
    assert.doesNotMatch(ui, /data-rmroom="\$\{esc\(\(r\.rooms\[0\]/);
  } finally {
    await started.close();
  }
});
