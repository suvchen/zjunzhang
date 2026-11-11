# 中军帐 M1 规格（核心管道）

## 数据布局（zjz_home 下）

```
data/
  identities/<slug>/key.json      Ed25519 密钥对（私钥仅本目录）
  identities/<slug>/profile.json  name / created
  rooms/<room_id>/meta.json       name / owner / invite / archived
  rooms/<room_id>/messages.jsonl  每行一条：{seq, id, author, ts, text, reply_to?, mentions?, sig}
  rooms/<room_id>/members.json    [{slug, role, joined, cursor}]
  index.json                      房间索引、身份索引
```

## 核心库 API（src/core.js）

- identity.create(home, name) → {slug, keypair}；identity.load(home, slug)
- room.create(home, slug, name) → {room_id, invite_code}
- room.join(home, slug, invite) → member
- room.archive(home, slug, room_id)   仅 owner
- msg.send(home, slug, room_id, text, {reply_to, mentions}) → {seq, id}（作者签名）
- msg.read(home, slug, room_id, {before, after, limit}) → [msg]（验签后返回）
- msg.wait(home, slug, {timeout_ms}) → 新消息批次（游标单调，跨房按 seq 归并）
- room.members / room.list / identity.whoami

## 语义要点

- seq：每房独立，从 1 起严格递增；写入持锁（.lock 文件）
- 签名：作者私钥对 (room_id|seq|text) 签名；读取时验签，失败拒绝并记 E1
- 游标：members.json 中 per-member cursor；wait 返回后推进，同消息不重复（I4）
- 归档房：send 抛 ROOM_ARCHIVED（I5）
- 错误：全部走结构化 {ok:false, code}，不裸抛（I6）

## CLI（bin/zjz.mjs）

zjz identity new --name X | whoami
zjz new --name 房名 | join <invite> | list | members <room>
zjz send "text" [--room R] [--reply-to M] [--mention X]
zjz read [--room R] [--before S] [--after S] [--limit N]
zjz wait [--timeout S]
zjz archive <room>

## MCP（bin/zjz-mcp.mjs，stdio）

zjz_new / zjz_join / zjz_send / zjz_read / zjz_wait / zjz_members / zjz_list / zjz_whoami / zjz_archive
（参数同 CLI 语义，返回 JSON）

## M2 规格（工单系统 + 值班编排）

数据：
- orders/<order_id>.json：{project, title, deliverables, acceptance, status, assignee, claim_seq, history[]}
- 状态机：dispatched → claimed → delivered → accepted|rejected → closed（非法跃迁一律拒绝）
- duty/<slug>.json：{mode: listen|oncall, schedule, checkpoint, shift_log[]}

API 增补：
- order.dispatch / claim / deliver / accept / close / list（list 按 project 过滤）
- duty.set / duty.shift（换班：存 checkpoint、接班者从 checkpoint 续）
- msg.wait daemon 化：本地 daemon 即时唤醒（ZJZ_DAEMON=0 关闭回退轮询）

哨兵增补：
- I8 工单状态机非法跃迁拒绝（如 dispatched 直接 accept）
- I9 seq 仲裁：双人认领以 claim_seq 小者胜，后到者自动驳回
- I10 换班游标交接：checkpoint 恢复后消息无重复无遗漏
- I11 daemon 唤醒不重复投递
- I12 项目维度隔离：order.list 按 project 过滤，跨项目零串

狗粮验收（M2 首个场景）：用 zjz 自己的 MCP 开真房，跑通「派单 → 接单 → wait → 换班」全链，过程记录存 V:\zjunzhang\trials\，一次验证 M1+M2 两层。

## 哨兵测试（test/sentinel.test.js，node --test）

- T1 I1 seq 递增无洞（发 5 条手算 seq=1..5）
- T2 I2 篡改消息文本 → 验签失败被拒
- T3 I3 双房隔离（A 房 3 条 B 房 2 条，互不可见）
- T4 I4 wait 两次调用无重复投递
- T5 I5 归档房 send → ROOM_ARCHIVED
- T6 I6 三个空/坏 fixture 全部结构化错误
- T7 I7 两个 home 并发写互不污染身份

## M2-B 规格（常驻监听 + 换班看门狗，2026-11-08）

### 常驻监听（src/listen.js）
- 定位：只广播「rooms 有变化」，不推进游标、不消费消息；消息真相仍是 `members.json` + `msg.read`。
- 单例租约：`data/listen/lease.json` = `{pid, epoch, started_at, heartbeat_at, ttl_ms, pipe}`。
  - 同 pid 重入＝续租；异 pid 且心跳未过期＝`LEASE_HELD`；过期/损坏（含半写）＝可接管，epoch 必递增。
  - 写入一律 tmp+rename 原子写；epoch 计数持久化在 `data/listen/epoch.json`。
- 跨进程唤醒：Windows 命名管道 `\\.\pipe\zjz-listen-<sha256(home)[0:16]>`；失败退事件文件 `data/listen/events.jsonl`。
  - 客户端即使完全漏唤醒，`wait` 仍以有界轮询兜底（I13）。
- watcher 只挂 `data/rooms/`，监听自身状态在 `data/listen/`，避免自触发。
- `msg.waitAsync` 增加可选 `wake(ms)` 钩子；CLI/MCP 的 wait 自动接命名管道，先于轮询感知变化；漏唤醒仍有界轮询兜底。
- CLI：`zjz listen start [--timeout S] | listen status | listen stop`。

### 换班看门狗（src/watchdog.js）
- duty 记录兼容扩展：`heartbeat_at`、`watchdog: {enabled, successor, max_age_ms, check_ms}`。
- `zjz duty heartbeat` 更新心跳；`zjz watchdog tick` 单次检查；`zjz watchdog run --interval S` 循环。
- 超龄判定＝now - heartbeat_at > max_age_ms（E6 代理口径：心跳＋墙钟，不做 token 级测量）。
- 换班复用 `duty.shift`：checkpoint 捕获/应用语义与 M2-A 完全一致，cursor 只前进不后退。
- 幂等：watchdog 级 `.lock` 串行化 + 换班前 CAS 复核 heartbeat_at；同一超龄事件只换一次。
- 台账：`data/watchdog/actions.jsonl`，每条含 `epoch`、`action`、`from/to`、`checkpoint_before/after`、`checkpoint_digest`。
- 无接班人/接班人非法/换班失败：写 `data/watchdog/ALERT.json`，返回结构化告警，不擅改 duty 状态。

### 哨兵增补
- I13 唤醒非真相源：监听崩溃/漏唤醒时 wait 仍收齐，不重不漏，且有数值上界断言。
- I14 监听单例＋租约围栏：双启动不双广播；损坏/过期接管 epoch 递增；旧 epoch 广播 `STALE_EPOCH`。
- I15 看门狗换班幂等且单调：多次 tick/双看门狗只换一次；checkpoint 前后值可回溯、不倒退。
- I16 断链自愈：监听被杀/重启后恢复；期间消息不丢不重。
- I17 M2-A 兼容：无 watchdog/listen 配置时行为不变；看门狗 shift 与手工 duty.shift 同语义。

## M3 规格（质检台账 + 产线事件流，2026-11-08）

### 产线事件流（src/events.js）
- 定位：项目级 append-only 账本，所有工单/值班/质检动作写同一事件流；事件是最终证据源。
- 存储：`data/events/<sha256(project)[0:16]>.jsonl` + 同名 `.meta.json`；每行自带 `project`，拒绝跨项目混写。
- 记录：`{id, seq, at, project, type, actor, subject, payload, prev_hash, hash}`。
- 哈希链：`hash = sha256(prev_hash | seq | at | project | type | actor | subject | canonical(payload))`，首条 `prev_hash = genesis`。
- 并发：项目级 `.lock` 串行「读尾 → 定 seq/prev_hash → 追加 → 原子写 meta」；append 以文件尾自愈落后 meta。
- API：`event.append / list(project, after, limit) / verify(project) / projects / file(project)`。
- 错误：`BAD_INPUT`、`EVENT_PROJECT_MISMATCH`、`LOCK_TIMEOUT`、`EVENT_APPEND_FAILED`。

### 质检台账（src/qc.js）
- 状态机：`open → collecting → machine_checked → human_verdict → closed`；非法跃迁 `BAD_STATE`。
- 两个判定栏严格隔离：`machine_checks[]` 只追加不覆盖；`human_verdict` 独立记录，不得改写机器历史。
- 证据：挂载时流式 SHA256 + 字节数；同文件同角色幂等；同哈希跨角色默认 `EVIDENCE_DUPLICATE`，仅 `allow_same + reason` 豁免，豁免理由写入 `qc.attach` 事件。
- 四栏：`phenomenon / attribution_layer / fix / repro_count` 缺一返回 `QC_INCOMPLETE`；`conclusion=baseline` 要求 `repro_count >= 2`，否则 `QC_NOT_REPRODUCED`。
- 聚合：`aggregate.machine = pass|fail|insufficient`；缺任一已注册 gate 证据一律 `insufficient`，不得因缺证判 pass。
- API：`qc.open / attach / machine / human / close / get / list / verify / summary`。

### 双台账互引
- watchdog 换班：`actions.jsonl` 记录 `event_id`（事件流 `duty.watchdog_shift.id`）；事件 payload 记录 `epoch` 与 `duty_event_id`（core `duty.shift` 事件 id）。
- watchdog 告警：写 `duty.watchdog_alert` 事件，同样回填 `event_id`。

### CLI 增补
`zjz qc open|attach|machine|human|close|get|list|verify|summary`
`zjz event list|verify|projects`
`zjz duty set --project P`

### MCP 增补（共 39 工具）
`zjz_qc_open|attach|machine|human|close|get|list|verify|summary`
`zjz_event_list|verify|projects`

### 哨兵增补
- I18 台账状态机与四栏关闭闸门（缺栏/复现不足不可关）。
- I19 证据哈希互异、重挂幂等、verify 防篡改/缺失。
- I20 机器判定接口与人工终判隔离（未注册 gate 拒；缺证不聚合为 pass）。
- I21 事件流并发 seq 连续、哈希互异、跨项目隔离、篡改可发现。
- I22 工单/换班/质检动作一一落事件，双台账互引。

