# 中军帐 M4 · 桌面直达快捷方式（总管交付 2026-11-09）
# 用法：pwsh -NoProfile -File create-shortcut.ps1 [-Port 8788] [-Name 中军帐]
# 形态：Edge/Chrome app 模式 --app=... ＋ 固定 --user-data-dir（保证「单窗口」：再点快捷方式聚焦原窗，不开第二窗）
param(
  [int]$Port = 8788,
  [string]$Name = '中军帐',
  [string]$ShortcutPath = ''
)
$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$launcher = Join-Path $root 'scripts\start-desktop.ps1'
if (-not (Test-Path -LiteralPath $launcher)) { Write-Error "找不到启动器：$launcher"; exit 1 }
$powershell = Join-Path $env:WINDIR 'System32\WindowsPowerShell\v1.0\powershell.exe'

$lnk = if ($ShortcutPath) { [IO.Path]::GetFullPath($ShortcutPath) } else { Join-Path ([Environment]::GetFolderPath('Desktop')) "$Name.lnk" }
$shell = New-Object -ComObject WScript.Shell
$sc = $shell.CreateShortcut($lnk)
$sc.TargetPath = $powershell
$sc.Arguments = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Minimized -File `"$launcher`" -Port $Port -Home `"$root`""
$sc.WorkingDirectory = $root
$icon = Join-Path (Split-Path -Parent $PSScriptRoot) "public\favicon.ico"
if (Test-Path $icon) { $sc.IconLocation = $icon } else { $sc.IconLocation = "$powershell,0" }
$sc.Description = "中军帐（自动确保后端在线并打开单窗口）"
$sc.Save()
Write-Output "快捷方式已建: $lnk"
Write-Output "  目标: $powershell"
Write-Output "  参数: -File $launcher -Port $Port -Home $root"
Write-Output "  职责: 自动确保 serve 在线、健康检查通过后打开桌面窗口"
