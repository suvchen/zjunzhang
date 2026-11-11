# 中军帐 v0.1 打包（Codex 应急版，MiMo 可重构覆盖）：只装产品要的，不装运行期数据与历史备份。
# 用法：powershell -ExecutionPolicy Bypass -File scripts\pack.ps1 [-Out zjz-v0.1.zip]
param([string]$Out = 'zjz-v0.1.zip')
$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$stage = Join-Path $env:TEMP ('zjz-pack-' + (Get-Date -Format 'HHmmss'))
$zip = if ([IO.Path]::IsPathRooted($Out)) { [IO.Path]::GetFullPath($Out) } else { Join-Path $repo $Out }

$include = @('bin','src','public','scripts','test','trials','desktop','package.json','README.md','README-装机.md','README-加智能体.md','LICENSE','ABOUT-联系.md','TERMS-用户协议.md','PRIVACY-隐私政策.md','DISCLAIMER-免责声明.md','UPDATE-更新政策.md','error-cards.md','看护巡检红线.md','初级品-v0.1-装机门.md','PROGRESS.md','SPEC.md')
$excludeDirs = @('.git','.backups','data','node_modules','runs','dist')
$memberOnlyFiles = @(
  'src\planner.js','src\scheduler.js','src\summarizer.js','src\prodder.js','src\supervisor.js',
  'test\planner.test.js','test\scheduler.test.js','test\summarizer.test.js','test\prodder.test.js','test\supervisor.test.js','test\chief_cli.test.js','test\chief_api.test.js'
)

$desktopDist = Join-Path $repo 'desktop\dist'
$installer = Get-ChildItem -LiteralPath $desktopDist -Filter '*Setup*.exe' -File -ErrorAction SilentlyContinue |
  Sort-Object LastWriteTime -Descending |
  Select-Object -First 1
if (-not $installer) {
  throw "missing desktop installer: run npm run dist in desktop and ensure desktop\dist\*Setup*.exe exists"
}

New-Item -ItemType Directory -Path $stage -Force | Out-Null
foreach ($item in $include) {
  $src = Join-Path $repo $item
  if (-not (Test-Path $src)) { Write-Output ("SKIP missing " + $item); continue }
  $dst = Join-Path $stage $item
  if (Test-Path $src -PathType Container) {
    New-Item -ItemType Directory -Path $dst -Force | Out-Null
    Get-ChildItem $src -Recurse -Force | ForEach-Object {
      $rel = $_.FullName.Substring($src.Length).TrimStart('\','/')
      $parts = $rel -split '[\\/]'
      if ($parts | Where-Object { $excludeDirs -contains $_ }) { return }
      $relKey = ($item + '\' + ($rel -replace '/','\'))
      if ($memberOnlyFiles -contains $relKey) { return }
      $target = Join-Path $dst $rel
      if ($_.PSIsContainer) { New-Item -ItemType Directory -Path $target -Force | Out-Null }
      else { New-Item -ItemType Directory -Path (Split-Path $target) -Force | Out-Null; Copy-Item $_.FullName $target -Force }
    }
  } else {
    Copy-Item $src $dst -Force
  }
}

$installerName = 'ZJZ-Setup.exe'
Copy-Item $installer.FullName (Join-Path $stage $installerName) -Force
Set-Content -LiteralPath (Join-Path $stage 'install-desktop.cmd') -Value @(
  '@echo off',
  'setlocal',
  'start "" "%~dp0ZJZ-Setup.exe"',
  'endlocal'
) -Encoding Ascii

if (Test-Path $zip) { Remove-Item $zip -Force }
Compress-Archive -Path (Join-Path $stage '*') -DestinationPath $zip -CompressionLevel Optimal
$size = [math]::Round((Get-Item $zip).Length / 1MB, 2)
Write-Output ("packed: " + $zip + " (" + $size + " MB)")
Write-Output ("desktop installer: " + $installer.FullName)
Write-Output 'verify: extract to a clean dir, run install-desktop.cmd, launch the desktop app, then scripts\install-check.ps1 ; npm test ; node bin\zjz.mjs --home <EMPTY_HOME> selfcheck --fast --no-host'
