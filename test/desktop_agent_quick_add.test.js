import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const renderer = fs.readFileSync(path.join(ROOT, 'desktop', 'renderer.js'), 'utf8');

function block(startMarker, endMarker) {
  const start = renderer.indexOf(startMarker);
  const end = renderer.indexOf(endMarker, start);
  assert.ok(start >= 0 && end > start, 'missing source block');
  return renderer.slice(start, end);
}

test('E45 discovered agents can be added to the selected room in one click', () => {
  const detect = block('// —— 智能体：本机探测 ——', '// —— 智能体：进房下拉（带房主） ——');
  assert.match(detect, /class="chip add-one"/);
  assert.match(detect, /class="chip fill-one"/);
  assert.match(detect, /if \(!room_id\)/);
  assert.match(detect, /\$\('agArgs'\)\.value = defaultAgentArgs/);
  assert.match(detect, /\$\('agInvite'\)\.click\(\)/);
});

test('E45-B detected agent defaults match common CLI task syntax', () => {
  assert.match(renderer, /key\.includes\('opencode'\)\) return 'run \{task\}'/);
  assert.match(renderer, /key\.includes\('codex'\)\) return 'exec \{task\}'/);
  assert.match(renderer, /key\.includes\('claude'\)\) return '-p \{task\}'/);
});

test('E45-C room removal remains available per room', () => {
  const agents = block('async function loadAgents()', '// —— 主题：深色/浅色可选 ——');
  assert.match(agents, /\/api\/agents\/remove/);
  assert.match(agents, /loadAgents\(\);/);
});
