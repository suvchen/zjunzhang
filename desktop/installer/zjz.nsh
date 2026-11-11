; ============================================================
; 中军帐 · NSIS 安装引导（自定义向导页）
; 在安装向导里加：产品说明 + 装好后怎么用（三步入门）。
; 经 electron-builder 的 NSIS include 机制注入。
; ============================================================

; —— 欢迎/产品说明页：安装目录选择后、安装前 ——
!macro customHeader
  !define MUI_PAGE_HEADER_TEXT "中军帐 · 多智能体指挥台"
  !define MUI_PAGE_HEADER_SUBTEXT "装好后，用它把智能体请进项目房间、发任务、看回执。"
!macroend

!macro customInstallMode
  ; 保持 electron-builder 默认的"为所有用户/当前用户"选择
!macroend

; —— 安装前插入"产品说明与上手"页 ——
!macro customInstallDirectoryPage
  ; 目录选择页之后追加一页：写清这是什么、装好三步怎么用
  !insertmacro MUI_PAGE_DIRECTORY
  Page custom zjzGuidePage zjzGuidePageLeave
!macroend

!macro zjzGuidePage
  nsDialogs::Create 1018
  Pop $0
  ${If} $0 == error
    Abort
  ${EndIf}

  ${NSD_CreateLabel} 0 0 100% 26u "中军帐是「多智能体协作指挥台」——把本机的 AI 智能体请进项目房间，发任务、看它们干活、按时收到回执。"
  Pop $0

  ${NSD_CreateLabel} 0 34u 100% 12u "装好后三步入门："
  Pop $0
  ${NSD_CreateLabel} 12u 48u 100% 10u "1. 开一个「项目房间」，拿到邀请码。"
  Pop $0
  ${NSD_CreateLabel} 12u 62u 100% 10u "2. 在「智能体」页把本机智能体（Codex / Claude / OpenCode…）请进这个房间。"
  Pop $0
  ${NSD_CreateLabel} 12u 76u 100% 10u "3. 回「房讯」发消息、下任务；智能体被唤醒后自动回帖，超时会在值班板报警。"
  Pop $0

  ${NSD_CreateLabel} 0 96u 100% 24u "提示：中军帐需要一个本机后端在运行（装好后会随应用自动拉起，无需手动启动）。它只投递消息、查状态、超时报警，不会替你自动处置别的程序。界面可切换深/浅色。"
  Pop $0

  nsDialogs::Show
!macroend

!macro zjzGuidePageLeave
!macroend

; —— 安装完成页：加"开始使用"引导 ——
!macro customFinishPage
  !define MUI_FINISHPAGE_TEXT "中军帐已装好。双击桌面「中军帐」图标即可启动（首次会自动拉起本机后端）。"
  !define MUI_FINISHPAGE_RUN "$INSTDIR\中军帐.exe"
  !define MUI_FINISHPAGE_RUN_TEXT "立即启动 中军帐"
!macroend
