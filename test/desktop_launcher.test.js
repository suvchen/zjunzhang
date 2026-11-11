import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

test('E38 desktop shortcut launches a self-healing backend launcher', () => {
  const launcher = fs.readFileSync(path.join(ROOT, 'scripts', 'start-desktop.ps1'), 'utf8');
  assert.match(launcher, /serve', 'status'/);
  assert.match(launcher, /serve', '--port'/);
  assert.match(launcher, /'--detach'/);
  assert.match(launcher, /\$activePort = \[int\]\$status\.lease\.port/);
  assert.match(launcher, /\$Port = \$activePort/);
  assert.match(launcher, /\/api\/health/);
  assert.match(launcher, /Start-Process -FilePath \$browser/);

  // E38-C：启动器优先开独立桌面客户端（Electron），网页版只做兜底
  assert.ok(launcher.includes('[switch]$BrowserOnly'));
  assert.ok(launcher.includes('electronExe = Join-Path $desktopDir'));
  assert.ok(launcher.includes('Start-Process -FilePath $electronExe'));
  // 客户端必须跟随实际服务端口（E38-B），否则客户端连 8888 而后端在别的端口＝空窗
  assert.ok(launcher.includes('ZJZ_API = "http://127.0.0.1:$Port"'));
  // Electron 分支在前、网页版兜底在后
  assert.ok(launcher.indexOf('Start-Process -FilePath $electronExe') < launcher.indexOf('Start-Process -FilePath $browser'));

  const shortcutScript = fs.readFileSync(path.join(ROOT, 'scripts', 'create-shortcut.ps1'), 'utf8');
  assert.match(shortcutScript, /start-desktop\.ps1/);
  assert.doesNotMatch(shortcutScript, /\$sc\.TargetPath = \$browsers/);

  // E41：桌面客户端必须单实例（双击两次不该出两个窗口）
  const mainJs = fs.readFileSync(path.join(ROOT, 'desktop', 'main.js'), 'utf8');
  assert.ok(mainJs.includes('requestSingleInstanceLock'));
  assert.ok(mainJs.includes("app.on('second-instance'"));
});

test('E38 generated shortcut points to start-desktop.ps1', (t) => {
  if (process.platform !== 'win32') {
    t.skip('Windows shortcut test');
    return;
  }
  const shortcut = path.join(os.tmpdir(), `zjz-shortcut-${process.pid}.lnk`);
  const script = path.join(ROOT, 'scripts', 'create-shortcut.ps1');
  const created = spawnSync('powershell.exe', [
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    script,
    '-ShortcutPath',
    shortcut,
    '-Port',
    '8788',
  ], { encoding: 'utf8' });
  assert.equal(created.status, 0, created.stderr || created.stdout);

  const inspected = spawnSync('powershell.exe', [
    '-NoProfile',
    '-Command',
    '$sh=(New-Object -ComObject WScript.Shell).CreateShortcut($env:ZJZ_TEST_SHORTCUT); [pscustomobject]@{Target=$sh.TargetPath;Arguments=$sh.Arguments}|ConvertTo-Json -Compress',
  ], {
    encoding: 'utf8',
    env: { ...process.env, ZJZ_TEST_SHORTCUT: shortcut },
  });
  assert.equal(inspected.status, 0, inspected.stderr || inspected.stdout);
  const link = JSON.parse(inspected.stdout);
  assert.match(link.Target, /powershell\.exe$/i);
  assert.match(link.Arguments, /start-desktop\.ps1/i);
  assert.match(link.Arguments, /-Port 8788/);
  fs.unlinkSync(shortcut);
});
