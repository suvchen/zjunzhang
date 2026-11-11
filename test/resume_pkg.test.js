import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { resumeApi } from '../src/resume.js';

function tmpHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'zjz-resume-'));
}

test('E23 装机包解压根没有 .git：resume 必须降级为只读记忆源，不得 RESUME_SOURCE_MISSING', () => {
  const home = tmpHome();
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'zjz-pkg-'));
  fs.writeFileSync(path.join(repo, 'PROGRESS.md'), '## T-008\n状态：收口', 'utf8');
  fs.writeFileSync(path.join(repo, 'error-cards.md'), '## E22\n答完锁死', 'utf8');
  assert.equal(fs.existsSync(path.join(repo, '.git')), false, '前置：包内确实没有 .git');

  const r = resumeApi.resume(home, { repo });
  assert.equal(r && r.ok, true, `包内 resume 应成功，实际 ${JSON.stringify(r)}`);
  assert.equal(r.git_available, false, 'git_available 必须如实 false');
  assert.deepEqual(r.recent_commits, [], '无 git 历史时 commits 为空数组');
  assert.match(String(r.note), /无 git 历史/, 'note 必须说明包内无 git 历史');
  assert.ok(String(r.progress_summary).length > 0, '记忆源 PROGRESS.md 必须读到');
});

test('E23-B 真源仓库（真 .git）行为不破：仍出提交历史', () => {
  const home = tmpHome();
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'zjz-realrepo-'));
  fs.writeFileSync(path.join(repo, 'PROGRESS.md'), '## T-008\n状态：收口', 'utf8');
  fs.writeFileSync(path.join(repo, 'error-cards.md'), '## E22\n答完锁死', 'utf8');
  // 自建真 git 仓：测试不能依赖「自己住在哪个目录」——装机包解压根没有 .git，照那样判会假红。
  const init = spawnSync('git', ['init'], { cwd: repo, encoding: 'utf8' });
  assert.equal(init.status, 0, 'git init 应成功');
  spawnSync('git', ['add', '.'], { cwd: repo, encoding: 'utf8' });
  spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-m', 'init'], { cwd: repo, encoding: 'utf8' });

  const r = resumeApi.resume(home, { repo });
  assert.equal(r && r.ok, true, `真源 resume 应成功，实际 ${JSON.stringify(r)}`);
  assert.equal(r.git_available, true);
  assert.ok(Array.isArray(r.recent_commits) && r.recent_commits.length > 0, '真源必须出提交历史');
});