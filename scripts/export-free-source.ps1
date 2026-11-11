# 导出可公开的免费版源码快照：不带 Git 历史、不带会员模块、不带构建产物。
# 用法：powershell -ExecutionPolicy Bypass -File scripts\export-free-source.ps1 [-Out zjz-free-source.zip]
param([string]$Out = 'zjz-free-source.zip')
$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$stage = Join-Path $env:TEMP ('zjz-free-source-' + (Get-Date -Format 'HHmmss'))
$zip = if ([IO.Path]::IsPathRooted($Out)) { [IO.Path]::GetFullPath($Out) } else { Join-Path $repo $Out }

$include = @('bin','src','public','scripts','test','desktop','package.json','README.md','README-装机.md','README-加智能体.md','LICENSE','ABOUT-联系.md','TERMS-用户协议.md','PRIVACY-隐私政策.md','DISCLAIMER-免责声明.md','UPDATE-更新政策.md','SPEC.md')
$excludeDirs = @('.git','.backups','data','node_modules','runs','dist')
$memberOnlyFiles = @(
  'src\planner.js','src\scheduler.js','src\summarizer.js','src\prodder.js','src\supervisor.js',
  'test\planner.test.js','test\scheduler.test.js','test\summarizer.test.js','test\prodder.test.js','test\supervisor.test.js','test\chief_cli.test.js','test\chief_api.test.js'
)

New-Item -ItemType Directory -Path $stage -Force | Out-Null
foreach ($item in $include) {
  $src = Join-Path $repo $item
  if (-not (Test-Path $src)) { continue }
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

$leaks = Get-ChildItem $stage -Recurse -File -Force | Where-Object {
  $rel = $_.FullName.Substring($stage.Length).TrimStart('\','/')
  $memberOnlyFiles -contains ($rel -replace '/','\')
}
if ($leaks) { throw ('free source snapshot leaked member-only files: ' + (($leaks | ForEach-Object FullName) -join ', ')) }

Set-Content -LiteralPath (Join-Path $stage '.gitignore') -Value @(
  'data/',
  'runs/',
  '.work/',
  'node_modules/',
  'desktop/node_modules/',
  'desktop/dist/',
  '*.zip',
  'zjz-v0.1/'
) -Encoding UTF8
Set-Content -LiteralPath (Join-Path $stage 'PROGRESS.md') -Value @(
  '# 中军帐免费版进展',
  '',
  '- 免费版提供项目房间、消息收发、智能体管理、唤醒/回执/超时报警与独立桌面客户端。',
  '- 数据默认保存在本机；第三方智能体由用户自行配置并受其自身条款约束。',
  '- 当前版本以可运行、可测试、可审计为发布基线。'
) -Encoding UTF8
Set-Content -LiteralPath (Join-Path $stage 'error-cards.md') -Value @(
  '# 常见错误卡',
  '',
  '- ADAPTER_SPAWN_FAILED：检查智能体可执行文件、参数和 PATH。',
  '- ADAPTER_TIMEOUT：任务超时，可增大成员 timeout_ms 后重试。',
  '- NOT_OPERATOR：只有项目房主人能邀请或移出智能体。',
  '- NOT_MEMBER：发送者不在目标房间。'
) -Encoding UTF8

if (Test-Path $zip) { Remove-Item $zip -Force }
Compress-Archive -Path (Join-Path $stage '*') -DestinationPath $zip -CompressionLevel Optimal
Write-Output ("free source snapshot: " + $zip)
Write-Output ("entries: " + (Get-ChildItem $stage -Recurse -File -Force).Count)
