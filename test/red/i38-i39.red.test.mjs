// T-007-F 真实语料验收红测。运行前先执行 trials/huddo-real-20261109 的 fetch/import。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ingest } from '../../src/ingest.js';
import { search } from '../../src/search.js';
import { skill } from '../../src/skill.js';

const HOME = process.env.ZJZ_REAL_HOME
  ? path.resolve(process.env.ZJZ_REAL_HOME)
  : path.resolve(import.meta.dirname, '..', '..', 'trials', 'huddo-real-20261109', 'home');

test('I38 真实语料候选占比 ≤20%，纯应答剔除且真经验保留', () => {
  assert.ok(fs.existsSync(path.join(HOME, 'data')), '先重建 trials/huddo-real-20261109/home');
  const audit = search.audit(HOME);
  assert.equal(audit.ok, true);
  const candidates = skill.candidates(HOME, { limit: 1000 });
  assert.ok(candidates.total / audit.messages <= 0.20, `候选占比 ${candidates.total}/${audit.messages} 超过 20%`);
  const quotes = candidates.candidates.map((row) => ingest.stripHeader(row.quote));
  assert.ok(!quotes.some((text) => /^(?:收到|确认|好的)$/.test(text.trim())), '纯应答不得进候选');
  assert.ok(quotes.some((text) => /trigram/i.test(text) && /零命中/.test(text) && /100%/i.test(text) && /实测/.test(text)), 'trigram 实测经验不得误杀');
  assert.ok(quotes.some((text) => /session=0/i.test(text)), 'session=0 验收经验不得误杀');
});

test('I39 真实语料命中 display_text/ext_id 往返一致且性能 ≤50ms p95', () => {
  const queries = ['工单', '换班', '技能库', 'session=0', 'trigram'];
  const durations = [];
  for (const q of queries) {
    const started = performance.now();
    const result = search.query(HOME, { q, limit: 20 });
    durations.push(performance.now() - started);
    assert.equal(result.ok, true);
    for (const hit of result.hits) {
      assert.equal(hit.text, hit.ext_id ? `[huddo:${hit.ext_id}] ${hit.display_text}` : hit.display_text);
      if (hit.ext_id) {
        const lookup = ingest.lookup(HOME, { ext_id: hit.ext_id });
        assert.equal(lookup.ok, true);
        assert.ok(lookup.matches.some((row) => row.msg_id === hit.msg_id));
      }
    }
  }
  durations.sort((a, b) => a - b);
  const p95 = durations[Math.min(durations.length - 1, Math.floor(durations.length * 0.95))];
  assert.ok(p95 <= 50, `p95 ${p95.toFixed(1)}ms 超过 50ms`);
});
