import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

function runGate(repo) {
  const script = path.join(ROOT, 'scripts', 'check-public-release.ps1');
  return spawnSync('powershell.exe', [
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    script,
    '-Repo',
    repo,
  ], { encoding: 'utf8' });
}

function writeLegalDocs(repo, contact = 'release@example.com') {
  const docs = {
    'LICENSE': 'MIT License',
    'ABOUT-联系.md': `邮箱：${contact}`,
    'TERMS-用户协议.md': 'terms',
    'PRIVACY-隐私政策.md': 'privacy',
    'DISCLAIMER-免责声明.md': 'disclaimer',
    'UPDATE-更新政策.md': 'updates',
  };
  for (const [name, content] of Object.entries(docs)) {
    fs.writeFileSync(path.join(repo, name), content, 'utf8');
  }
}

test('public release gate blocks mixed-license fixture', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'zjz-release-blocked-'));
  writeLegalDocs(repo, '<待填：联系邮箱>');
  fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'src', 'planner.js'), 'paid', 'utf8');
  const inspected = runGate(repo);
  assert.equal(inspected.status, 2, inspected.stderr || inspected.stdout);
  const result = JSON.parse(inspected.stdout.trim());
  assert.equal(result.verdict, 'BLOCKED');
  assert.ok(result.issues.includes('paid_modules_in_public_tree'));
  assert.ok(result.issues.includes('license_mismatch'));
  assert.ok(result.issues.includes('placeholder_contact'));
});

test('public release gate passes a clean free-source fixture', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'zjz-release-pass-'));
  writeLegalDocs(repo);
  const inspected = runGate(repo);
  assert.equal(inspected.status, 0, inspected.stderr || inspected.stdout);
  const result = JSON.parse(inspected.stdout.trim());
  assert.equal(result.verdict, 'PASS');
  assert.deepEqual(result.issues, []);
});

test('public release gate blocks missing legal documents', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'zjz-release-missing-'));
  fs.writeFileSync(path.join(repo, 'LICENSE'), 'MIT License', 'utf8');
  const inspected = runGate(repo);
  assert.equal(inspected.status, 2, inspected.stderr || inspected.stdout);
  const result = JSON.parse(inspected.stdout.trim());
  assert.ok(result.issues.includes('missing_legal_docs'));
});
