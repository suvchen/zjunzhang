import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const renderer = fs.readFileSync(path.join(ROOT, 'desktop', 'renderer.js'), 'utf8');
const html = fs.readFileSync(path.join(ROOT, 'desktop', 'index.html'), 'utf8');

function block(startMarker, endMarker) {
  const start = renderer.indexOf(startMarker);
  const end = renderer.indexOf(endMarker, start);
  assert.ok(start >= 0 && end > start, 'missing renderer block');
  return renderer.slice(start, end);
}

test('E47 quick-add reuses the same detected agent across rooms', () => {
  const detect = block('// —— 智能体：本机探测 ——', '// —— 智能体：进房下拉（带房主） ——');
  assert.ok(detect.includes("window.zjz.get('\/api\/agents')"));
  assert.match(detect, /argv\[0\]/);
  assert.match(detect, /agSlug/);
  assert.match(detect, /defaultAgentArgs/);
});

test('E47-B invite preserves an existing agent slug instead of creating a duplicate', () => {
  const invite = block("  $('agInvite').onclick = async () => {", '  $(\'sendBtn\').onclick = sendMsg;');
  assert.match(invite, /\$\('agSlug'\)\.value/);
  assert.match(invite, /slug: preferredSlug \|\| name \|\| undefined/);
  assert.match(html, /id="agSlug"/);
});

test('E47-C room buttons display room names and remain room-scoped', () => {
  const agents = block('async function loadAgents()', '// —— 主题：深色/浅色可选 ——');
  assert.match(agents, /roomNames/);
  assert.match(agents, /\/api\/rooms\?slug=/);
  assert.match(agents, /roomNames\.get\(rm\.room_id\)/);
  assert.match(agents, /\/api\/agents\/remove/);
});
