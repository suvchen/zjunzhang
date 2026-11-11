// T-007-F：I38 候选闸门收紧 / I39 检索命中清洗。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as zjz from '../src/core.js';
import { ingest } from '../src/ingest.js';
import { search } from '../src/search.js';
import { skill } from '../src/skill.js';

function tmpHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'zjz-t007f-'));
}

function must(result, where) {
  assert.equal(result && result.ok, true, `${where} 应成功，实际 ${JSON.stringify(result)}`);
  return result;
}

function seed(home, texts) {
  const identity = must(zjz.identity.create(home, 'T-007F测试员'), 'identity');
  const room = must(zjz.room.create(home, identity.slug, 'T-007F房'), 'room');
  const messages = texts.map((text) => must(zjz.msg.send(home, identity.slug, room.room_id, text), 'send'));
  return { identity, room, messages };
}

test('T40 I38 候选闸门：纯应答剔除，验证类＋结果类＋可核验证据才入', () => {
  const home = tmpHome();
  const texts = [
    '收到',
    '@someone 确认',
    'PASS',
    '确认收到，稍后处理。',
    '实测：FTS5 trigram 对二字中文词零命中，改两层召回后召回 100%（src/search.js）。',
    '验收通过：CCR 保活按 session=0 无窗执行，npm test 40/40 全绿（trials/keepalive.log）。',
  ];
  const ctx = seed(home, texts);
  const candidates = must(skill.candidates(home, { limit: 20 }), 'candidates');
  assert.equal(candidates.total, 2, '纯应答与弱信号不得进候选');
  assert.deepEqual(
    candidates.candidates.map((row) => row.msg_id).sort(),
    [ctx.messages[4].id, ctx.messages[5].id].sort(),
  );
});

test('T41 I39 检索命中清洗：display_text/ext_id 新增，text 原样且往返一致', () => {
  const home = tmpHome();
  const identity = must(zjz.identity.create(home, 'I39测试员'), 'identity');
  const room = must(zjz.room.create(home, identity.slug, 'I39房'), 'room');
  const importedText = '导入消息正文用于清洗断言';
  must(ingest.records(home, {
    room_id: room.room_id,
    slug: identity.slug,
    source: 'huddo',
    records: [{ ext_id: 'msg_ext_39', author: '原作者', ts: '2026-11-09T00:00:00.000Z', text: importedText }],
  }), 'ingest');
  const normal = must(zjz.msg.send(home, identity.slug, room.room_id, '普通消息正文用于清洗断言'), 'send');

  const imported = must(search.query(home, { q: importedText }), 'search imported');
  assert.equal(imported.hits.length, 1);
  assert.equal(imported.hits[0].text, `[huddo:msg_ext_39] ${importedText}`, 'text 必须保持导入原样');
  assert.equal(imported.hits[0].display_text, importedText, 'display_text 必须剥导入头');
  assert.equal(imported.hits[0].ext_id, 'msg_ext_39');
  const roundTrip = must(ingest.lookup(home, { ext_id: imported.hits[0].ext_id }), 'ingest lookup');
  assert.equal(roundTrip.matches[0].msg_id, imported.hits[0].msg_id);

  const ordinary = must(search.query(home, { q: '普通消息正文' }), 'search normal');
  assert.equal(ordinary.hits[0].text, '普通消息正文用于清洗断言');
  assert.equal(ordinary.hits[0].display_text, ordinary.hits[0].text);
  assert.equal(ordinary.hits[0].ext_id ?? null, null);
  assert.equal(must(search.audit(home), 'search audit').intact, true);
  assert.equal(must(ingest.audit(home), 'ingest audit').intact, true);
  assert.equal(normal.id, ordinary.hits[0].msg_id);
});
