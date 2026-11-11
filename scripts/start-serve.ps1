# 中军帐 serve 无窗启动包装（总管，Codex 工单 #55522 第3件）
# 用法：pwsh -NoProfile -File start-serve.ps1 [-Port 8788] [-Repo V:\zjunzhang]
# 纪律：
#  - 端口已占用＝已有实例：打印现有地址退出（I40 单实例的 UI 侧防线）。
#  - 无窗三档（经验库 S05）：本脚本默认 SW_HIDE 无控制台窗拉起；需要 Session 0 级无窗
#    （彻底杜绝闪现）可用 -AsTask。**但按 E16/I49 红线：-AsTask 建 schtasks 属"仅人工诊断用、产品路径不用"**；产品路径一律用默认 Start-Process -WindowStyle Hidden 直起，不注册任何外部计划任务。
param(
  [int]$Port = 8888,
  [string]$Repo = (Join-Path $PSScriptRoot '..'),
  [switch]$AsTask
)
$ErrorActionPreference = 'Stop'

# 端口占用：打印现有地址，不重复拉
$busy = Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue
if ($busy) {
  Write-Output "已有实例在听：http://127.0.0.1:$Port/ （pid=$($busy[0].OwningProcess)），不再启动"
  exit 0
}

$node = (Get-Command node.exe -ErrorAction SilentlyContinue).Source
if (-not $node) { Write-Error 'PATH 无 node.exe'; exit 1 }
$serve = Join-Path $Repo 'bin\zjz.mjs'

if ($AsTask) {
  Write-Output "[E16 警告] -AsTask 会注册 schtasks；仅供人工诊断，产品路径/装机验收不得走这里。"
  # Session 0 / S4U：真无窗（装机一次性）。日志自证 session=0。
  $taskName = 'Zjunzhang-Serve'
  $log = Join-Path $env:LOCALAPPDATA 'zjunzhang\serve.log'
  New-Item -ItemType Directory -Path (Split-Path $log) -Force | Out-Null
  $action = "`"$node`" `"$serve`" serve --port $Port >> `"$log`" 2>&1"
  schtasks /create /tn $taskName /tr "cmd /c $action" /sc once /st 00:00 /f /rl LIMITED | Out-Null
  schtasks /change /tn $taskName /ru SYSTEM | Out-Null  # Session 0
  schtasks /run /tn $taskName | Out-Null
  Write-Output "已经 Session 0 无窗拉起（日志 $log，启动后查日志 session 行自证）：http://127.0.0.1:$Port/"
  exit 0
}

$proc = Start-Process -FilePath $node -ArgumentList "`"$serve`" serve --port $Port" -WindowStyle Hidden -PassThru -WorkingDirectory $Repo
Start-Sleep -Milliseconds 800
if ($proc.HasExited) { Write-Error "serve 立即退出（exit=$($proc.ExitCode)）——看仓库日志"; exit 1 }
Write-Output "无窗启动 pid=$($proc.Id)：http://127.0.0.1:$Port/"
