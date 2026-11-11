# M2-B 开工方案（常驻监听 / 换班看门狗）

> 状态：总管已批（2026-11-08）。批注四条已纳入：I13 数值上界、损坏租约可接管、台账 epoch＋前后 checkpoint、E2/E3 护栏。
> 基线：`npm test` 13/13 绿（node v22.23.2，2026-11-08 实测）。

## 一、范围边界

### 做（M2-B）
1. **常驻监听**：独立进程持有 `fs.watch`，跨进程广播“有新消息”信号；调用方重启/多调用方不重复建 watcher。
2. **换班看门狗**：按心跳超龄自动 `duty.shift`；监听进程断链自愈；动作留台账。
3. **兼容 M2-A**：`duty.shift` checkpoint 语义不动；无监听/无看门狗时行为与 M2 完全一致。

### 不做（留给后续）
- 不做消息投递方：监听器**只广播、不推进游标、不消费消息**，真相仍是 `members.json` 游标 + `msg.read`。
- 不做跨机器（M4）、不做 Web UI（M4）、不做 M3 质检台账。
- 不做“按 token 数”测上下文：只看进程心跳与墙钟年龄（E6 的可用代理指标）。

## 二、接口与数据

### 常驻监听
- `zjz listen start [--timeout S]` / `listen status` / `listen stop`。
- 单例租约：`data/listen/lease.json` = `{pid, epoch, started_at, heartbeat_at, pipe}`。
  - 获取用独占创建；心跳每 5s；租约 15s 无心跳视为过期，可接管，`epoch+1`。
- 跨进程唤醒：Windows 命名管道 `\\.\pipe\zjz-<sha256(home)[0:16]>`，广播一行 `{ts, epoch}`。
  - 管道不可用时退化为事件文件 `data/listen/events.jsonl`；客户端仍以有界轮询兜底。
- watcher 对象：`data/listen/watch.json`（home 级，不在 rooms 下，避免自触发）。

### 看门狗
- duty 记录兼容扩展（旧字段不动）：
  `{ heartbeat_at, watchdog: { max_age_ms, successor, check_ms } }`
- `zjz duty heartbeat`：只更新 `heartbeat_at`，不触发换班。
- `zjz watchdog tick`：单次检查，幂等；`watchdog run --interval S` 循环。
- 动作台账 `data/watchdog/actions.jsonl`：`{at, action, from, to, reason, epoch, checkpoint_digest}`。
- 无接班人：写 `data/watchdog/ALERT.json`，返回 `WATCHDOG_NO_SUCCESSOR`，不改 duty 状态。

## 三、哨兵清单（先红后绿，编号自 I13 续）

| 编号 | 断言 | 红测要点 |
|---|---|---|
| I13 | 唤醒非真相源：监听器崩溃/漏唤醒/管道不可用时，`wait` 仍靠有界轮询收齐消息，不重不漏 | 杀掉监听进程后发消息，`wait` 在一次轮询周期内收到 |
| I14 | 监听单例与租约围栏：同 home 只有一个活监听；并发启动第二个不双广播；过期接管后旧进程复活不得再广播 | 双进程启动 + 伪造过期租约 + 旧 epoch 广播被拒 |
| I15 | 看门狗换班幂等且单调：同一超龄事件多次 tick/双看门狗并发只换一次；checkpoint 只前进不后退 | 两次 `tick` 只产生一条 shift；cursor 不回退 |
| I16 | 断链自愈：监听被杀或 rooms 目录重建后自动恢复；恢复前消息不丢 | 删/建 rooms 子目录后发消息，恢复后 `wait` 正常 |
| I17 | M2-A 兼容：未配置 watchdog、未启动 listen 时行为与 M2 一致；看门狗 shift 与手工 `duty.shift` 产出同语义 checkpoint | 原 T1-T12 全绿 + 两路 shift 结果对照 |

## 四、提交切分（一次一模块）

1. `test(m2b): I13/I14 红测 + 监听契约`（仅 test，先红）
2. `feat(listen): 常驻监听租约/管道广播/断链自愈`（src/listen.js + CLI listen 子命令）
3. `test(m2b): I15/I16 红测 + 看门狗契约`
4. `feat(duty): heartbeat + watchdog 配置与 tick 幂等换班`（core.js 扩展 + src/watchdog.js）
5. `feat(cli,mcp): listen/watchdog 工具接线 + I17 兼容回归`（bin 两处 + package.json test 脚本 + smoke）
6. `docs: SPEC/PROGRESS/error-cards 更新（E6 命中即带哨兵）`

每步提交前：`npm test` 全绿；新增哨兵先单独跑红，再跑全量绿。

## 五、风险与对策

- **Windows `fs.watch` 递归在 V 盘/网络盘可能漏事件** → 读路径 2s 有界轮询兜底；I13 以“漏唤醒也能收齐”为断言。
- **双看门狗并发换班** → duty 文件 `.lock` + epoch 围栏 + 动作台账去重；I15。
- **监听器自杀式触发**（自己写 data 导致 watcher 触发）→ watcher 只挂 `rooms/`，监听自身状态放 `data/listen/`。
- **旧版本读新 duty 记录** → 只增可选字段，旧 `setDuty` 会丢弃未知字段但不报错；I17 对照。
- **E6 长跑爆仓** → 看门狗按心跳超龄强制换班；换班后新进程从 checkpoint 续传（复用 I10 语义）。

## 六、验收口径

- `npm test` >= 18/18 绿（原 13 + 新 5）。
- 手工演练：`listen start` -> 两进程 `wait` -> 杀监听 -> 发消息 -> 重启监听 -> `watchdog tick` 超龄换班 -> 接班人 `wait` 无重复无遗漏。
- 输出台账：租约 epoch、shift 前后 checkpoint、动作 jsonl、异常 0。


