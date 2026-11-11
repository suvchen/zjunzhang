import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as zjz from '../src/core.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const CLI = path.join(ROOT, 'bin', 'zjz.mjs');

function seed() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'zjz-send-stdin-'));
  const owner = zjz.identity.create(home, '发送者');
  const room = zjz.room.create(home, owner.slug, 'stdin room');
  return { home, owner, room };
}

function runSend(ctx, args, input = '') {
  return spawnSync(process.execPath, [
    CLI,
    '--home', ctx.home,
    '--slug', ctx.owner.slug,
    '--room', ctx.room.room_id,
    'send',
    ...args,
  ], { encoding: 'utf8', input });
}

test('send - reads multiline message from stdin', () => {
  const ctx = seed();
  const r = runSend(ctx, ['-'], '第一行\n第二行\n');
  assert.equal(r.status, 0, r.stderr || r.stdout);
  const out = JSON.parse(r.stdout.trim());
  assert.equal(out.ok, true);
  const read = zjz.msg.read(ctx.home, ctx.owner.slug, ctx.room.room_id, {});
  assert.equal(read.ok, true);
  assert.equal(read.messages.at(-1).text, '第一行\n第二行');
});

test('send rejects empty stdin and blank literal bodies', () => {
  const ctx = seed();
  const emptyStdin = runSend(ctx, ['-'], '');
  assert.equal(emptyStdin.status, 1, emptyStdin.stderr || emptyStdin.stdout);
  assert.equal(JSON.parse(emptyStdin.stdout.trim()).code, 'BAD_INPUT');

  const blank = runSend(ctx, ['   '], '');
  assert.equal(blank.status, 1, blank.stderr || blank.stdout);
  assert.equal(JSON.parse(blank.stdout.trim()).code, 'BAD_INPUT');
});
