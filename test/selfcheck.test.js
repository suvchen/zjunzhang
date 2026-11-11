// 装机验收门对位测试：`zjz selfcheck` 必须存在、结论字段完整、退出码语义分明（PASS=0/FAIL=1/BLOCKED=2）。
// 只选 replay 判据跑真 subprocess，避免在 npm test 里递归跑 npm test。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { selfcheck } from '../src/selfcheck.js';

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'zjz.mjs');

const SLOW = process.env.ZJZ_SLOW_TESTS === '1';

test('SC1 selfcheck 结论契约：verdict/gates/report 齐全，未选判据显式 skip 不假绿', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'zjz-sc1-'));
  const opts = SLOW ? { only: ['replay'] } : { only: ['__none__'] };
  const result = await selfcheck.run(home, opts);
  assert.equal(result.verdict, 'PASS', JSON.stringify(result.gates));
  assert.equal(result.ok, true);
  assert.equal(result.gates.length, 6, '五判据（4 拆 4a/4b + UI 冒烟）必须全在清单里：' + result.gates.map((g) => g.name).join(','));
  for (const g of result.gates) {
    assert.ok(['pass', 'skip'].includes(g.status), g.name + ' 不得为红：' + JSON.stringify(g));
    assert.ok(g.repro, '每条判据必须带复现命令：' + g.name);
  }
  if (!SLOW) assert.ok(result.gates.every((g) => g.status === 'skip'), '未选判据必须 skip，不得静默通过');
  assert.ok(fs.existsSync(result.report), '报告必须落 data/selfcheck/');
  const md = fs.readFileSync(result.report, 'utf8');
  assert.match(md, /判定：PASS/);
  assert.match(md, /\| 判据 \| 结果 \| 耗时 \| 证据尾行 \| 复现命令 \|/);
});

test('SC2 缺宿主如实 BLOCKED（不算 PASS、不算产品红），并给出前置检查复现命令', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'zjz-sc2-'));
  const result = await selfcheck.run(home, { only: ['host'], hostCli: '' });
  const hostGate = result.gates.find((g) => g.name.includes('判据3'));
  assert.ok(hostGate, '判据3 必须在清单里');
  assert.equal(hostGate.status, 'blocked', JSON.stringify(hostGate));
  assert.equal(result.verdict, 'BLOCKED');
  assert.equal(result.ok, false);
  assert.match(hostGate.repro, /install-check/);
  assert.match(fs.readFileSync(result.report, 'utf8'), /判定：BLOCKED/);
});

test('SC3 CLI 入口存在且退出码可用（zjz selfcheck --only host --no-host）', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'zjz-sc3-'));
  const r = spawnSync(process.execPath, [CLI, '--home', home, 'selfcheck', '--only', 'host', '--no-host'], { encoding: 'utf8', timeout: 120000 });
  const parsed = JSON.parse(r.stdout);
  assert.equal(parsed.verdict, 'PASS', '全 skip 视为通过（未选判据不算红）：' + r.stdout.slice(0, 300));
  assert.equal(r.status, 0);
  assert.ok(parsed.report.includes(path.join('data', 'selfcheck')));
});
