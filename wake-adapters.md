# wake-adapters · T-008 适配器事实与施工坑（总管实测 2026-11-09）

> 配套规格 `T-008-wake-spec.md`；房② #55217 同款。此文件进 `zjz resume` 的读物面，施工前先看。

## 适配器事实（已核，别重复摸）
| 宿主 | 无头入口 | 适配器 kind | 备注 |
|---|---|---|---|
| Claude Code | `claude --print "{task}"`（PATH，2.1.319） | **spawn** | `~/.claude.json` **没挂 huddo MCP** → 回帖走 CLI：`node D:\huddo\mcp\node_modules\huddoai\huddo.mjs send - --room <id>`（正文 stdin） |
| Codex Desktop | 无（GUI）；60121＝私有协议（非 HTTP 非 TLS，EPROTO） | **notify**（同类解法见下行） | GUI 宿主唤醒的正路＝找该宿主 CLI 非交互模式；写 `data/inbox/<slug>.md` 只是兜底 |
| OpenCode Desktop | **`opencode-cli.exe run "{task}"`**（`AppData\Roaming\ai.opencode.desktop\cli\2.2.5-x64\opencode-cli.exe`，v2.2.5，**已实测**：adapter.run 拉起→exit=0→答 OK，走本地模型） | **spawn** | 内置 28894 是 SPA 前端（`/doc` 都回 HTML），60121 非 HTTP——**桌面内置服务不暴露官方 server API，唤醒走 CLI run**。官方 `/session/:id/prompt_async` API 属独立 `opencode serve`（默认 4096），桌面场景用不上 |
| 脚本/测试 | 任意 node 脚本 | **spawn** | I47 红测用假适配器（把 `{task}` 落盘断言内容） |

- spawn 子进程 **env.HUDDO_HOME 必须逐成员覆写**——E8 身份串号事故会在子进程继承 env 时复发。
- **api 投递死锁坑（11-09 实踩，曾误诊为 EDR 拦 curl）**：`adapter.run` 是同步（spawnSync 阻塞调用方事件循环）——**投递目标绝不能是调用方自己进程内的 HTTP server**，否则必超时。生产语义天然安全（投递对象是外部 GUI 宿主）；测试夹具必须把目标 server 起成独立子进程（M50 已照此钉死）。若 wake.js 想在 serve 进程内给自己发 api 消息，必须走异步旁路或干脆用本机回环外进程。
- 注册接口按规格：`zjz member set --slug S --adapter-kind spawn|notify|api --adapter 'argv 模板含 {task}'`（api 形态用 `--url`）。

## 施工坑（Windows＋本仓库特有，全部实踩过）
1. 拉起 .ps1/.cmd：`pwsh.exe -NoProfile -File 脚本` 包一层，裸 spawn 会 ENOENT（`dependency check --revive-file` 有同款样板）。
2. jsonl 读取一律 `split(/\r?\n/)`；CRLF 尾 `\r` 会让 JSON.parse 偶发红。
3. serve 第二实例捕 EADDRINUSE → I40 `ALREADY_RUNNING`＋现有地址，勿裸抛；**测试端口用 0 随机取实际值**（`npm test` 并行会撞固定端口）。
4. spawn 风暴防呆（I47 必含断言）：同成员已有活租约／该条已 answered → 不 spawn；连续两次唤醒无回应 → 升级值班工单，不做第三次。参数进 config：`wake.cooldown_ms`、`wake.max_consecutive`。
5. 「不在线」只认 listen 租约活性（epoch/心跳），别用最后发言时间猜（I28 旧病）。
6. 红测假时钟照 `test/m2b.test.js` 的 `--now` 注入；并发防双发照 I35 红测写法。
7. I49 硬判据形态：**红测全程不得出现任何外部计划任务**——内部 supervisor＋租约＋`.revive` 事件闭环。

## 卡壳规矩
同一问题卡 30 分钟即发帖（现象＋已试三招），不许 solo 两小时。
