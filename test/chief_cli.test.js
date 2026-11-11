import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const CLI = path.join(ROOT, 'bin', 'zjz.mjs');

function runCli(args) {
  return spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' });
}

test('chief command turns a goal into plan, dispatch, report and review', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'zjz-chief-cli-'));
  const r = runCli(['--home', home, 'chief', '做一份市场报告']);
  assert.equal(r.status, 0, r.stderr || r.stdout);
  const out = JSON.parse(r.stdout.trim());
  assert.equal(out.ok, true);
  assert.ok(out.plan_id);
  assert.equal(out.goal, '做一份市场报告');
  assert.equal(out.dispatched.length, 3);
  assert.ok(out.dispatched.every((row) => row.reason === 'NO_AGENT'));
  assert.match(out.report, /参谋长汇报/);
  assert.match(out.review, /监督官验收/);
});

test('chief command rejects an empty goal without creating a plan', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'zjz-chief-empty-'));
  const r = runCli(['--home', home, 'chief']);
  assert.equal(r.status, 1, r.stderr || r.stdout);
  const out = JSON.parse(r.stdout.trim());
  assert.equal(out.ok, false);
  assert.equal(out.code, 'BAD_INPUT');
  assert.equal(fs.existsSync(path.join(home, 'data', 'plans')), false);
});

test('chief status and report reopen an existing plan', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'zjz-chief-status-'));
  const created = runCli(['--home', home, 'chief', '整理一份季度报告']);
  assert.equal(created.status, 0, created.stderr || created.stdout);
  const planId = JSON.parse(created.stdout.trim()).plan_id;

  for (const action of ['status', 'report']) {
    const r = runCli(['--home', home, 'chief', action, planId]);
    assert.equal(r.status, 0, r.stderr || r.stdout);
    const out = JSON.parse(r.stdout.trim());
    assert.equal(out.ok, true);
    assert.equal(out.plan_id, planId);
    assert.equal(out.plan.goal, '整理一份季度报告');
    assert.match(out.report, /参谋长汇报/);
    assert.match(out.review, /监督官验收/);
  }
});

test('chief status reports a missing plan without inventing results', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'zjz-chief-status-missing-'));
  const r = runCli(['--home', home, 'chief', 'status', 'plan_missing']);
  assert.equal(r.status, 1, r.stderr || r.stdout);
  const out = JSON.parse(r.stdout.trim());
  assert.equal(out.ok, false);
  assert.equal(out.code, 'NOT_FOUND');
});

test('chief CLI loads paid modules lazily so free snapshots still start', () => {
  const cli = fs.readFileSync(CLI, 'utf8');
  assert.doesNotMatch(cli, /import \{ scheduler as schedulerApi \} from '\.\.\/src\/scheduler\.js'/);
  assert.match(cli, /import\('\.\.\/src\/scheduler\.js'\)/);
  assert.match(cli, /FEATURE_NOT_AVAILABLE/);
});

test('serve loads paid modules lazily so free snapshots can still start', () => {
  const serve = fs.readFileSync(path.join(ROOT, 'src', 'serve.js'), 'utf8');
  assert.doesNotMatch(serve, /^import .* from '\.\/scheduler\.js'/m);
  assert.doesNotMatch(serve, /^import .* from '\.\/summarizer\.js'/m);
  assert.doesNotMatch(serve, /^import .* from '\.\/supervisor\.js'/m);
  assert.match(serve, /import\('\.\/scheduler\.js'\)/);
  assert.match(serve, /FEATURE_NOT_AVAILABLE/);
});
