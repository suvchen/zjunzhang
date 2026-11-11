param(
  [int]$Port = 8788,
  [Alias('Home')]
  [string]$ZjzHome = (Split-Path -Parent $PSScriptRoot),
  [switch]$CheckOnly,
  # 强制退回网页版（Edge/Chrome app 窗口）；默认优先独立桌面客户端
  [switch]$BrowserOnly
)
$ErrorActionPreference = 'Stop'

function Show-Failure([string]$Message) {
  Write-Error $Message
  if (-not $CheckOnly) {
    try {
      Add-Type -AssemblyName System.Windows.Forms | Out-Null
      [System.Windows.Forms.MessageBox]::Show($Message, '中军帐启动失败', 'OK', 'Error') | Out-Null
    } catch { }
  }
  exit 1
}

$root = [IO.Path]::GetFullPath($ZjzHome)
$cli = Join-Path $root 'bin\zjz.mjs'
if (-not (Test-Path -LiteralPath $cli)) { Show-Failure "找不到中军帐程序：$cli" }

$node = (Get-Command node.exe -ErrorAction SilentlyContinue).Source
if (-not $node) {
  $candidate = Join-Path $env:LOCALAPPDATA 'hermes\node\node.exe'
  if (Test-Path -LiteralPath $candidate) { $node = $candidate }
}
if (-not $node) { Show-Failure '找不到 Node.js，请先安装 Node 22 或运行 scripts\install-check.ps1' }

function Read-ZjzJson([string[]]$CommandArgs) {
  $oldPreference = $ErrorActionPreference
  $ErrorActionPreference = 'SilentlyContinue'
  try { $raw = (& $node @CommandArgs 2>$null | Out-String).Trim() }
  finally { $ErrorActionPreference = $oldPreference }
  if (-not $raw) { return $null }
  try { return $raw | ConvertFrom-Json } catch { return $null }
}

$status = Read-ZjzJson @($cli, '--home', $root, 'serve', 'status')
if ($status -and $status.ok -and $status.running) {
  $activePort = [int]$status.lease.port
  if ($activePort -gt 0) { $Port = $activePort }
} else {
  $started = Read-ZjzJson @($cli, '--home', $root, 'serve', '--port', "$Port", '--detach')
  if (-not ($started -and $started.ok)) {
    Start-Sleep -Milliseconds 800
    $status = Read-ZjzJson @($cli, '--home', $root, 'serve', 'status')
    if (-not ($status -and $status.ok -and $status.running)) {
      Show-Failure "中军帐后端启动失败。请运行 scripts\install-check.ps1，或改用 node bin\zjz.mjs --home `"$root`" serve --port $Port"
    }
  }
}

$healthUrl = "http://127.0.0.1:$Port/api/health"
$healthy = $false
for ($i = 0; $i -lt 40; $i += 1) {
  try {
    $response = Invoke-WebRequest -UseBasicParsing -Uri $healthUrl -TimeoutSec 2
    if ($response.StatusCode -eq 200) { $healthy = $true; break }
  } catch { Start-Sleep -Milliseconds 250 }
}
if (-not $healthy) { Show-Failure "后端未在 $healthUrl 就绪" }

if ($CheckOnly) {
  Write-Output ([pscustomobject]@{ ok = $true; home = $root; port = $Port; health = $healthUrl } | ConvertTo-Json -Compress)
  exit 0
}

# ── 打开界面：优先独立桌面客户端（Electron），没有才退回网页版 app 窗口 ──
$desktopDir = Join-Path $root 'desktop'
$electronExe = Join-Path $desktopDir 'node_modules\electron\dist\electron.exe'
$desktopMain = Join-Path $desktopDir 'main.js'

if (-not $BrowserOnly -and (Test-Path -LiteralPath $electronExe) -and (Test-Path -LiteralPath $desktopMain)) {
  # 客户端经主进程当网关连 serve，端口必须跟着实际租约走（E38-B）
  $env:ZJZ_API = "http://127.0.0.1:$Port"
  $app = Start-Process -FilePath $electronExe -ArgumentList @($desktopDir) -WorkingDirectory $desktopDir -PassThru
  Start-Sleep -Milliseconds 1500
  if ($app.HasExited) {
    Show-Failure "桌面客户端启动后立刻退出（退出码 $($app.ExitCode)）。要退回网页版就加 -BrowserOnly。"
  }
  Write-Output "中军帐桌面客户端已启动（Electron，pid $($app.Id)）：http://127.0.0.1:$Port/"
  exit 0
}

if (-not $BrowserOnly) {
  Write-Output '（未找到独立客户端 desktop\node_modules\electron，先退回网页版；装客户端：cd desktop && npm install）'
}

$browser = @(
  "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe",
  "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe",
  "$env:ProgramFiles\Google\Chrome\Application\chrome.exe"
) | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
if (-not $browser) { Show-Failure '找不到 Edge 或 Chrome，无法打开中军帐桌面窗口' }

$profileDir = Join-Path $env:LOCALAPPDATA 'zjunzhang\webapp-profile'
New-Item -ItemType Directory -Path $profileDir -Force | Out-Null
$browserArgs = "--app=http://127.0.0.1:$Port/ --user-data-dir=`"$profileDir`" --window-size=1280,860"
Start-Process -FilePath $browser -ArgumentList $browserArgs -WorkingDirectory $root
Write-Output "中军帐已启动：http://127.0.0.1:$Port/"
