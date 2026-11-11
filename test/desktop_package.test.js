import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

test('desktop installer is mandatory in the customer package', () => {
  const pack = fs.readFileSync(path.join(ROOT, 'scripts', 'pack.ps1'), 'utf8');
  assert.match(pack, /\$include = @\([^)]*'desktop'/);
  assert.match(pack, /desktop\\dist/);
  assert.match(pack, /Filter '\*Setup\*\.exe'/);
  assert.match(pack, /throw "missing desktop installer/);
  assert.match(pack, /Copy-Item \$installer\.FullName \(Join-Path \$stage \$installerName\)/);
  assert.match(pack, /install-desktop\.cmd/);
  assert.match(pack, /excludeDirs = @\([^)]*'node_modules'[^)]*'dist'/);
  for (const required of ['README.md', 'LICENSE', 'ABOUT-联系.md', 'TERMS-用户协议.md', 'PRIVACY-隐私政策.md', 'DISCLAIMER-免责声明.md', 'UPDATE-更新政策.md']) {
    assert.ok(pack.includes(`'${required}'`), `pack must include ${required}`);
  }
  for (const memberFile of ['src\\planner.js', 'src\\scheduler.js', 'src\\summarizer.js', 'src\\prodder.js', 'src\\supervisor.js']) {
    assert.ok(pack.includes(`'${memberFile}'`), `free pack must exclude ${memberFile}`);
  }
  assert.ok(pack.includes(`'test\\chief_cli.test.js'`), 'free pack must exclude member CLI tests');
  assert.ok(pack.includes(`'test\\chief_api.test.js'`), 'free pack must exclude member API tests');
  assert.ok(pack.indexOf('Copy-Item $installer.FullName') < pack.indexOf('Compress-Archive'));
  assert.ok(pack.indexOf("Set-Content -LiteralPath (Join-Path $stage 'install-desktop.cmd')") < pack.indexOf('Compress-Archive'));

  const main = fs.readFileSync(path.join(ROOT, 'desktop', 'main.js'), 'utf8');
  assert.match(main, /app\.isPackaged \? app\.getPath\('userData'\)/);
  assert.match(main, /function freePort\(\)/);
  assert.match(main, /status\.lease\.port/);
  assert.match(main, /probeHealth\(API_BASE\)/);
  assert.match(main, /'--detach'/);
  assert.match(main, /ensureBackend\(\)\.catch\(\(\) => \{\}\)/);
  assert.doesNotMatch(main, /const home = process\.env\.ZJZ_HOME \|\| path\.dirname\(cli\)/);
  assert.doesNotMatch(main, /backendProc\.kill\(\)/);

  const desktopPackage = JSON.parse(fs.readFileSync(path.join(ROOT, 'desktop', 'package.json'), 'utf8'));
  assert.equal(desktopPackage.build.nsis.deleteAppDataOnUninstall, false);
  for (const item of desktopPackage.build.extraResources.filter((entry) => !['../package.json', '../src'].includes(entry.from))) {
    assert.deepEqual(item.filter, ['**/*', '!**/.backups/**', '!**/node_modules/**', '!**/runs/**']);
  }
  const srcResources = desktopPackage.build.extraResources.find((entry) => entry.from === '../src');
  for (const memberFile of ['planner.js', 'scheduler.js', 'summarizer.js', 'prodder.js', 'supervisor.js']) {
    assert.ok(srcResources.filter.includes(`!**/${memberFile}`), `desktop app must exclude ${memberFile}`);
  }

  const privacy = fs.readFileSync(path.join(ROOT, 'PRIVACY-隐私政策.md'), 'utf8');
  assert.match(privacy, /卸载本软件不会自动删除已创建的本地数据/);

  const exportScript = fs.readFileSync(path.join(ROOT, 'scripts', 'export-free-source.ps1'), 'utf8');
  assert.match(pack, /\[IO\.Path\]::IsPathRooted\(\$Out\)/);
  assert.match(exportScript, /\[IO\.Path\]::IsPathRooted\(\$Out\)/);
  assert.match(exportScript, /\$memberOnlyFiles = @\(/);
  assert.match(exportScript, /src\\planner\.js/);
  assert.match(exportScript, /free source snapshot leaked member-only files/);
  assert.match(exportScript, /Join-Path \$stage '\.gitignore'/);
  assert.match(exportScript, /'data\/'/);
  assert.match(exportScript, /Join-Path \$stage 'PROGRESS\.md'/);
  assert.match(exportScript, /Join-Path \$stage 'error-cards\.md'/);
  assert.doesNotMatch(exportScript, /trials\\huddo-real/);
  assert.doesNotMatch(exportScript, /看护巡检红线\.md/);
  assert.doesNotMatch(exportScript, /ZJZ-Setup\.exe/);
});
