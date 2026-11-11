# 中军帐 装机前置检查（总管）：只读不改，缺什么直接说什么。
# 用法：powershell -NoProfile -File scripts\install-check.ps1 [-Port 8888] [-WebPort 8890]
param([int]$Port = 8888, [int]$WebPort = 8890)
$ErrorActionPreference = 'SilentlyContinue'
$repo = Split-Path -Parent $PSScriptRoot
$miss = 0; $warn = 0
function Say($level, $what, $hint) {
  Write-Host ("{0,-5} {1}" -f $level, $what)
  if ($hint) { Write-Host ("      -> {0}" -f $hint) }
}

# 1) Node 版本 ≥22
$node = Get-Command node
if (-not $node) { Say MISS "node 不在 PATH" "装 Node 22+（https://nodejs.org），装机第一步就是这个" ; $miss++ }
else {
  $v = (node -v) -replace 'v',''
  $major = [int]($v.Split('.')[0])
  if ($major -lt 22) { Say MISS "Node 版本 $v 太老" "升到 22+（本项目用 node --test 与顶层 await）" ; $miss++ }
  else { Say PASS "Node $v" }
}

# 2) 仓内关键文件在不在（包没打全就直接说）
foreach ($f in @('bin\zjz.mjs','src\serve.js','src\adapter.js','src\wake.js','public\index.html','README-装机.md')) {
  if (-not (Test-Path (Join-Path $repo $f))) { Say MISS "缺文件 $f" "包不完整，重新取包或 git pull" ; $miss++ }
}
Say PASS "仓根 $repo"

# 3) 宿主 CLI：至少一个能被拉起（PATH 里没有时，再查常见安装位置与环境变量）
$hosts = @('opencode-cli','codex','claude')
$found = @($hosts | Where-Object { Get-Command $_ })
$probeDirs = @("$env:APPDATA\npm", "$env:LOCALAPPDATA\Programs\opencode\bin", 'C:\Program Files\opencode\bin', 'D:\opencode\bin')
foreach ($d in $probeDirs) {
  if (Test-Path $d) {
    foreach ($h in $hosts) {
      $hit = Get-ChildItem -Path $d -Filter "$h*" -ErrorAction SilentlyContinue | Select-Object -First 1
      if ($hit -and -not $found.Contains($hit.Name)) { $found += "$($hit.Name)（$($hit.FullName)）" }
    }
  }
}
# OpenCode 桌面版装的 opencode-cli 不在 PATH，装在 %APPDATA%\ai.opencode.desktop\cli\<版本>\ 下（中军帐实跑就是这个路径）
$ocRoot = Join-Path $env:APPDATA 'ai.opencode.desktop\cli'
if (Test-Path $ocRoot) {
  $hit = Get-ChildItem -Path $ocRoot -Recurse -Filter 'opencode-cli.exe' -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($hit) { $found += "opencode-cli（$($hit.FullName)）" }
}
if ($env:ZJZ_HOST_CLI -and (Test-Path $env:ZJZ_HOST_CLI)) { $found += "ZJZ_HOST_CLI=$env:ZJZ_HOST_CLI" }
if ($found.Count -eq 0) {
  Say MISS "宿主 CLI 一个都没找到（PATH 试了：$($hosts -join ', ')；又查了 npm 全局目录与常见安装目录）" '唤醒器要拉它干活；把它加进 PATH，或 member set --adapter 写可执行全路径，或设 ZJZ_HOST_CLI 环境变量'
  $miss++
} else { Say PASS ('宿主 CLI：' + ($found -join ' / ')) }

# 4) huddo（可选：只有要用 huddo 房驱动本体才需要）
$huddoCli = $env:HUDDO_CLI
if (-not $huddoCli) {
  foreach ($c in @('D:\huddo\mcp\node_modules\huddoai\huddo.mjs', "$env:USERPROFILE\.huddo\huddo.mjs")) { if (Test-Path $c) { $huddoCli = $c; break } }
}
if ($huddoCli) { Say PASS "huddo CLI $huddoCli" }
else { Say WARN "没找到 huddo CLI" "只用 zjz 自己的房可以先不管；要用 huddo 房驱动本体，装 huddo 并设 HUDDO_CLI 环境变量" ; $warn++ }

foreach ($h in @("$env:USERPROFILE\.huddo", 'D:\huddo\data-codex')) {
  if (Test-Path $h) { Say PASS "身份目录 $h" }
}

# 5) 端口占用
foreach ($p in @($Port, $WebPort)) {
  $l = Get-NetTCPConnection -LocalPort $p -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($l) {
    $who = (Get-CimInstance Win32_Process -Filter "ProcessId=$($l.OwningProcess)").Name
    Say WARN "端口 $p 已被 $who 占用" "换端口：serve --port $($p+10)，preview-web --port $($p+11)" ; $warn++
  } else { Say PASS "端口 $p 空闲" }
}

# 6) 服务是否已在跑（并查旧租约：机器重启/被杀留下的死租约会挡掉一次 serve start，见错误卡 E18）
$leaseFile = Join-Path $repo 'data\serve\lease.json'
if (Test-Path $leaseFile) {
  try {
    $lease = Get-Content $leaseFile -Raw -Encoding UTF8 | ConvertFrom-Json
    $alive = $null
    try { $alive = (Get-Process -Id $lease.pid -ErrorAction Stop).ProcessName } catch { $alive = $null }
    if ($alive) { Say PASS "租约 pid=$($lease.pid) 活着（$alive），端口 $($lease.port)" }
    else { Say WARN "租约 pid=$($lease.pid) 已不存在（旧租约）" "首次 zjz serve --port 可能报 ok:false：先跑一次 zjz serve status 把死租约判掉，再起服务（E18）" ; $warn++ }
  } catch { Say WARN "租约文件读不懂：$leaseFile" '不影响，起服务时会重建' ; $warn++ }
}
try {
  $health = Invoke-RestMethod "http://127.0.0.1:$Port/api/health" -TimeoutSec 3
  if ($health.ok) { Say PASS "zjz serve 已在 $Port 上跑（current_slug=$($health.current_slug)）" }
} catch { Say WARN "zjz serve 未在 $Port 上" "起服务：node bin\zjz.mjs --home <HOME> serve --port $Port；若报 ok:false 再跑一次（E18 旧租约）" ; $warn++ }

Write-Host ""
if ($miss -eq 0) { Write-Host "== 前置 OK：可继续 README-装机.md 第 1 步（警告 $warn 条）==" ; exit 0 }
Write-Host "== 前置不足：$miss 项必须先补，别硬跑自测 =="
exit 1
