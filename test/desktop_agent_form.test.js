import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const html = fs.readFileSync(path.join(ROOT, 'desktop', 'index.html'), 'utf8');

function inviteSection() {
  const match = html.match(/<div class="acard">\s*<div class="at">请一个智能体进帐<\/div>[\s\S]*?<div class="amsg" id="agInviteMsg"><\/div>\s*<\/div>/);
  assert.ok(match, 'missing agent invite card');
  return match[0];
}

test('E43 agent invite keeps only four plain fields visible', () => {
  const section = inviteSection();
  const advancedStart = section.indexOf('<details id="agAdvanced"');
  const advancedEnd = section.indexOf('</details>', advancedStart);
  assert.ok(advancedStart > 0 && advancedEnd > advancedStart, 'advanced settings must be wrapped in details');
  const visible = section.slice(0, advancedStart) + section.slice(advancedEnd + '</details>'.length);
  for (const label of ['名字', '进入房间', '程序', '参数']) {
    assert.ok(visible.includes(`<label>${label}</label>`), `missing visible label ${label}`);
  }
  assert.doesNotMatch(visible, /id="agWake"|id="agTimeout"|<label>唤醒<\/label>|<label>超时/);
});

test('E43-B wake and timeout stay available under advanced settings', () => {
  const section = inviteSection();
  const start = section.indexOf('<details id="agAdvanced"');
  const end = section.indexOf('</details>', start);
  const advanced = section.slice(start, end);
  assert.match(advanced, /<summary>高级设置<\/summary>/);
  assert.match(advanced, /id="agWake"/);
  assert.match(advanced, /id="agTimeout"/);
  assert.doesNotMatch(advanced, /id="agInvite"/);
  assert.match(section.slice(0, start) + section.slice(end + '</details>'.length), /id="agInvite"/);
});

test('E43-C common task argument is prefilled and explained', () => {
  const section = inviteSection();
  assert.match(section, /<input id="agArgs"[^>]*value="run \{task\}"/);
  assert.match(section, /一般不用改|通常不用改/);
});
