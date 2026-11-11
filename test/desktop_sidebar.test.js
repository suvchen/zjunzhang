import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const html = fs.readFileSync(path.join(ROOT, 'desktop', 'index.html'), 'utf8');
const renderer = fs.readFileSync(path.join(ROOT, 'desktop', 'renderer.js'), 'utf8');

test('E46 sidebar has a compact useful footer instead of empty bottom space', () => {
  const aside = html.match(/<aside>[\s\S]*?<\/aside>/);
  assert.ok(aside, 'missing sidebar');
  assert.match(aside[0], /id="sideRoomCount"/);
  assert.match(aside[0], /id="sideIdentity"/);
  assert.match(html, /id="sideNewRoom"/);
  assert.match(html, /id="sideAgents"/);
  assert.match(html, /\.side-foot \{[^}]*border-top:[^}]*display:grid/);
});

test('E46-B sidebar footer stays synced with rooms and identity', () => {
  assert.match(renderer, /function updateSidebarSummary/);
  assert.match(renderer, /sideRoomCount/);
  assert.match(renderer, /sideIdentity/);
  assert.match(renderer, /updateSidebarSummary\(\)/);
});

test('E46-C sidebar shortcuts reuse existing room and agent flows', () => {
  assert.match(renderer, /sideNewRoom/);
  assert.match(renderer, /sideAgents/);
  assert.match(renderer, /createRoomFromPrompt/);
  assert.match(renderer, /switchView\('agents'\)/);
});
