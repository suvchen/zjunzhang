import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const renderer = fs.readFileSync(path.join(ROOT, 'desktop', 'renderer.js'), 'utf8');

function handlerSource(source, id) {
  const direct = `$('${id}').onclick = async () => {`;
  const named = id === 'newRoom' ? 'const createRoomFromPrompt = async () => {' : '';
  const directStart = source.indexOf(direct);
  const start = directStart >= 0 ? directStart : source.indexOf(named);
  assert.notEqual(start, -1, `missing ${id} handler`);
  const open = source.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    if (source[i] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error(`unterminated ${id} handler`);
}

test('E42 sidebar room creation refreshes the agent room selector', () => {
  const handler = handlerSource(renderer, 'newRoom');
  assert.match(handler, /await Promise\.all\(\[\s*loadRooms\(\),\s*loadAgentRooms\(\)\s*\]\);/);
});

test('E42-B agent-panel room creation uses the same room refresh path', () => {
  const handler = handlerSource(renderer, 'agCreate');
  assert.match(handler, /await Promise\.all\(\[\s*loadRooms\(\),\s*loadAgentRooms\(\)\s*\]\);/);
});

test('E42-C stale localStorage identity is revalidated before room creation', () => {
  assert.match(renderer, /const memberState = await window\.zjz\.get\('\/api\/members'\);[\s\S]{0,600}if \(!slug \|\| !available\.includes\(slug\)\)/);
  assert.doesNotMatch(renderer, /if \(!slug\) \{\s*const m = await window\.zjz\.get\('\/api\/members'\)/);
});
