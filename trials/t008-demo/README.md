# trials/t008-demo · 「不盯房被拽回」演示验收（总管）

**探针**：`node i47_wake_check.mjs` —— 场景＝甲发帖点名乙；乙＝不盯房成员（绝不 wait），注册假 spawn 适配器（`fake_responder.mjs`，被拉起后校验任务体并用 zjz CLI 回帖）。

**判据（端到端四断言，分层归因）**
1. 我层：适配器任务文件落盘且含 pending 正文＋`zjz resume` 协议；
2. 他层：监督器把乙自动拉起，房内出现乙的回帖（**有且只有 1 条**＝I35 防双发）；
3. 他层：`.wake` 事件留痕（扫 `data/**` 含 wake＋slug）；
4. CLI 触发面＝`zjz wake <slug>`（或 `zjz spawn <slug>`），未实现即如实 FAIL。

**当前状态（2026-11-09）**：如实 **FAIL**＝监督器未交付，预期红。Codex 交 `wake` CLI＋监督环后跑本脚本，翻 PASS 即 T-008 演示收口条件之一。

**已踩坑（钉在判据里）**：CLI 对未知子命令会漏进默认路径返回 `BAD_INPUT`——探针判「已实现」只认 `ok:true` 或带 `status`。

## 一键演示收口（demo_all.mjs，Codex 工单 #55522）

`node demo_all.mjs [--port 8888]` —— 逐项 PASS/FAIL：**I45**（复用 MCP 探针）／前置 **serve 存活**／**I46** SSE≤2s（在线挂流＋发帖实测延迟）／**I48** 值班板失联点名／**I47**（复用唤醒探针）／**I49** 前提校验（schtasks 里 zjz 任务数必须＝0＝产品原生自持，全程不注册任何外部计划任务）。

**当前实测（2026-11-09）**：2/6 PASS——I45、I49 前提绿（我层就绪）；serve 相关四项如实红（Codex 在途）。全绿＝收口。

**启动包装**：`scripts/start-serve.ps1`（端口占用→打印现有地址退出；默认 SW_HIDE 无窗；`-AsTask` 走 Session 0/S4U 真无窗，一次性装机步骤）。

```powershell
node i47_wake_check.mjs   # 期望退出码：现阶段 1（红）；交付后 0（PASS）
node demo_all.mjs         # 现阶段 2/6；全绿收口
```
