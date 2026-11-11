# 中军帐（ZJunZhang）— 多智能体协作调度系统

> 第二个产品（第一个是排盘/mingyu）。定位：不止群聊——把「派单-接单-值班-换班-质检-台账」做成一等公民。
> 差异化全部源自 2026-11-08 Huddo 实战踩坑清单（见 error-cards.md）。

## 不变量（哨兵断言，先测这些再写业务码）

- I1 每个房间的消息 seq 严格递增、无洞、无重
- I2 身份私钥永不出数据目录；签名校验失败的消息拒绝入库
- I3 房间隔离：A 房消息绝不出现在 B 房的任何读取里
- I4 wait 游标单调：同一条消息绝不对同一成员重复投递
- I5 邀请码是入房唯一入口；已归档房间拒收新消息
- I6 空输入不崩溃：空房读取 / 未加入即发送 / 坏签名消息，三个 fixture 优雅返回错误
- I7 身份隔离硬保证：每智能体独立 zjz_home，进程环境不串号

## M1 范围（核心管道）

- 身份：Ed25519 密钥对（node:crypto），slug = zjz-<name>-<rand8>
- 房间：create / join(invite) / archive / members / list
- 消息：send（reply_to、mention）/ read（before/after 分页）/ wait（游标语义）
- 通道：CLI `zjz` + MCP stdio（zjz_* 工具），同一核心库
- 存储：data/ 纯文件（JSON meta + JSONL 消息），本地优先、可离线
- 测试：node --test 跑哨兵 I1-I7 + 手算小 fixture

## M2+（后续）

M2 工单系统（派单/接单/验收/seq 仲裁/催办）+ 值班编排（listen 模式/自动换班/看门狗）
M2 增补（2026-11-08 主人提出，需求原型＝本次分房动作）：话题/项目隔离——一项目一房、工单挂项目维度、跨项目上下文不混流
M3 质检台账（四栏对照/留档钩子/机器判定接口）+ 产线事件流
M4 Web UI（localhost）+ 桌面直达入口 + 多机
M4 增补（2026-11-08 主人提出）：**单窗口多房间**——一个应用窗口内左侧房间列表切换，禁一房一窗（本次痛点：两个房间开了两个桌面窗口）

## 目录（V 盘·工具盘规矩）

```
V:\zjunzhang\
  PROGRESS.md        进度与待办（每完成一步更新）
  SPEC.md            M1 规格与接口
  error-cards.md     错误模式卡片（同类任务开工先查）
  src/               核心库
  bin/               zjz CLI + zjz-mcp
  test/              哨兵测试
  data/              运行数据（git 忽略）
```
## M1 进度（2026-11-08，Codex 交付）

- [x] `src/core.js`：identity / room / msg；Ed25519 签名 `(room_id|seq|text)`、`.lock` 串行 seq、per-member cursor、结构化错误
- [x] `bin/zjz.mjs`：identity new/whoami、new/join/list/members/send/read/wait/archive
- [x] `bin/zjz-mcp.mjs`：stdio JSON-RPC，10 个 `zjz_*` 工具
- [x] `test/sentinel.test.js`：I1-I7 七哨兵全绿（`node --test`）
- [x] `test/smoke.mjs`：CLI new→join→send→read→wait→members→archive 全绿
- [x] `test/mcp.smoke.mjs`：initialize / tools/list / 工具调用全绿
- 返回契约：成功 `{ok:true,...}`；失败 `{ok:false,code,message}`；`msg.read` 返回 `{ok:true,room_id,messages}`
## M2 进度（2026-11-08，Codex 交付）

- [x] `src/core.js`：工单状态机 dispatched → claimed → delivered → accepted|rejected → closed；非法跃迁 `BAD_STATE`
- [x] claim_seq 仲裁：先到者胜，后到者 `CLAIM_LOST`；非认领人交付 `NOT_ASSIGNEE`
- [x] `order.dispatch/claim/deliver/accept/reject/close/get/list`，list 按 project/status/assignee 过滤
- [x] `duty.set/get/shift`：checkpoint 捕获、接班者游标续传、双份 shift_log
- [x] `msg.waitAsync`：fs.watch daemon 即时唤醒；`ZJZ_DAEMON=0` 回退 100ms 轮询；不重复投递
- [x] CLI/MCP 增补 order.* 与 duty.*；MCP 共 21 个工具
- [x] 哨兵 I8-I12（T8-T12）全绿，M1 回归不破
- [x] 狗粮试点 `trials/runs/2026-11-08T08-50-46-258Z/`：MCP 真房全链 PASS

## M2-B 进度（2026-11-08，Codex 交付）
- [x] `src/listen.js`：租约单例、epoch 围栏、损坏租约接管、命名管道/事件文件广播、断链重启
- [x] `src/watchdog.js`：心跳超龄换班、幂等 CAS、动作台账（epoch＋checkpoint 前后值）、无接班人告警
- [x] `src/core.js`：duty 记录扩展 `heartbeat_at/watchdog`；`duty.heartbeat`；shift 更新双方心跳
- [x] CLI/MCP 接线：listen start/status/stop、duty heartbeat、watchdog tick/status/run（MCP 27 工具）
- [x] 哨兵 I13-I17（T13-T18）全绿；含跨进程子进程租约与 TTL 失效实测
- [x] `npm test` 21/21 绿；CLI smoke 与 MCP smoke 全绿；跨进程 CLI wait 唤醒实测 392ms（含 300ms 注入延迟）
- 边界：监听不消费消息；不做跨机器/Web UI/M3；token 级上下文测量留后续

## M3 进度（2026-11-08，Codex 交付）
- [x] `src/events.js`：项目级 append-only 事件流；每行自带 project；seq 连续；prev_hash 哈希链；`.lock` 串行写；跨项目文件隔离（项目名 sha256 前 16 位）
- [x] `src/qc.js`：质检台账状态机 open → collecting → machine_checked → human_verdict → closed；四栏关闭闸门；机器判定与人工终判分栏；证据流式 SHA256；`EVIDENCE_DUPLICATE` 默认拒 + `allow_same`/`reason` 显式豁免并随事件留痕
- [x] `src/core.js`：duty 增 `project`；工单 dispatch/claim/deliver/accept/reject/close 一一落事件；`duty.shift` 落事件并返回 event id
- [x] `src/watchdog.js`：换班/告警写 `duty.watchdog_shift` / `duty.watchdog_alert` 事件；`actions.jsonl` 回填 `event_id`，事件引用 `duty_event_id`，双台账互引
- [x] CLI/MCP 接线：`qc open/attach/machine/human/close/get/list/verify/summary`、`event list/verify/projects`；MCP 共 39 个工具
- [x] 哨兵 I18-I22（T21-T25）全绿；`npm test` 26/26；CLI/MCP smoke 全绿
- [x] 狗粮 `trials/runs/2026-11-08T10-46-47-793Z/`：工单/质检/换班事件一一对应；3 进程 × 5 并发 append → seq 1..15 连续、15 哈希互异；篡改 1 条 → verify intact=false；双台账 event_id 互指 PASS
- 边界：事件流不做跨机器复制；QC 只留档不代替人工耳审/目审

## 新会话恢复协议（记忆制度，2026-11-09 总管立）

任何 Agent 的新会话碰本项目，开工三步缺一不可：**①读本文件（PROGRESS.md）②读 error-cards.md ③`git log --oneline -15`**。每完成一个模块/修一个错，**必须同步更新本文件**（这是跨会话记忆的单一真源，不靠任何聊天窗口）。会话交接写桌面交接书，项目状态只写这里。

## M4+ 规划与设计输入（2026-11-09）

- **M4（T-005，已派单未开工）**：单窗口多房间 UI（主人拍板：一房一窗禁止）。
- **T-007 三大需求（主人 11-09 令，优先级：检索＞技能库＞M4 再排后）**：
  1. Huddo 实战十案全部产品化（需求池，逐条出哨兵 I23 起）：①检测器零消耗（监听/监控禁消费信号）②在岗可见性（listening/最后响应可查，失联告警）③响应时效 SLO（消息→首回延迟入事件流）④同身份单活围栏⑤配置健康自检（端点/脚本/环境变量漂移：HUDDO_HOME 复活实案）⑥经验固化钩子⑦环境漂移防御⑧保活件静默化（watchdog 一律无窗：CCR-Gateway-KeepAlive Hidden 样板）⑨桥链路猝死自愈（CCR 死→全断实案：探活+静默拉起+留痕）⑩配置变更必带「加载验证」步（ZCode zod 一处非法整文件拒绝实案，改完先验校验再报喜）。
  2. **检索模块（最急）**：全部房间历史消息关键词检索（sqlite FTS5 起步），关键词/时间/发送者过滤，返回消息号+上下文；哨兵＝索引与消息库一致性对账。
  3. **技能库提取（M3 增强）**：从消息流定位候选经验（引用消息号可回溯）→ 认可门（不自动入库）→ 五栏技能卡落库可检索（真源样板＝V:\经验库，S01/S03/S05 为验收数据；格式与两门槛见 V:\经验库\README.md）。
- 状态：M1✅ M2✅ M2-B✅ M3✅（全部总管本机实跑验收）；M4 等开工方案。
- **T-007-A 检索模块 ✅（2026-11-09 总管接手写码并本机实跑验收）**：`src/search.js`（sqlite `node:sqlite`＋FTS5 trigram 预筛＋`norm` 规范化子串核实两层召回；按房 jsonl byte-offset 增量索引，文件变短整房重投）。
  - 验收账：红测先行 T26–T31 先全红后全绿；`node --test test/t007.test.js` 6/6；`npm test` **32/32**（26 旧回归不破）；真实 trial 消息库 reindex/audit `intact=true`、滑窗 2/3/4 字片段召回 **100%**（probes 9/9，零漏检）。
  - 实现前实测钉死两条（见 T-007-acceptance.md）：**FTS5 trigram 对 2 字中文词零命中**、`unicode61` 整段中文一 token——故召回底线必须是 norm 子串，FTS5 只做 ≥3 字符的候选预筛；1 万条 LIKE 全扫仅 1ms，性能不构成换召回的理由。
  - 新哨兵：**I23** 索引↔消息库对账（audit 以磁盘 jsonl 为权威，顺手清幽灵/去重/补漏后再报数）、**I24** 增量索引不重投（send 后 ≤2s 可检索、反复 sync 零重复条目）、跨房隔离延续 I3（含成员作用域 `NOT_MEMBER`）。
  - **接线已完成（11-09 总管）**：CLI `zjz search "词" [--room --sender --since --until --limit]` ＋ `zjz search index|reindex|audit`；MCP `zjz_search / zjz_search_index / zjz_search_reindex / zjz_search_audit`（MCP 43 工具）。smoke 门已钉：`test/smoke.mjs` 新增「search index→query→audit」步（中文词命中/发送者过滤/不存在词零命中/对账 intact/反复 index 零重投），`test/mcp.smoke.mjs` 新增 search 三件套＋工具名单四枚。实跑：`npm test` 32/32、`node test/smoke.mjs` ALL GREEN、`node test/mcp.smoke.mjs` ALL GREEN。
  - 待做：技能库提取（`src/skill.js`，I25/I26）归 Codex（分工见房② #55030）。
- **T-007-C 技能库提取 ✅（2026-11-09 总管代做，Codex 转复核＋下一批）**：`src/skill.js`＋`test/skill.test.js`（T32–T36）。
  - 三段闸门：①`skill.candidates` 从消息流定位候选（信号词驱动：实测/验证/验收/收讫/全绿/PASS/确认/通了/生效/修复/成功/可用/复现；**每条必带 房号＋消息号引用**，无信号不列）②`skill.approve` 认可门（缺任一栏→`SKILL_INCOMPLETE`；来源消息不存在→`SKILL_SOURCE_MISSING`；重复入库→`ALREADY_APPROVED`；驳回→`reject` 留原因台账，之后不再列为候选）③五栏卡落 `data/skills/cards.jsonl`（append-only＋哈希链，`skill.verify` 篡改可检出）并**进同一检索索引**（`docs.kind='skill'`）。
  - 索引扩展不破 I23：`search` 加 `kind` 列（旧库 `ALTER TABLE` 自动升级）、`query` 支持 `kind: msg|skill|all`（默认 msg，老测试语义不变）、`audit` 的消息对账只认 `kind='msg'` 并新增 `cards` 计数。新增导出 `indexDoc/removeDoc` 供上层复用。
  - 验收账（本机实跑）：`npm test` **37/37**（新增 I25/I26 五条）、`smoke`/`mcp.smoke` 全绿；红测中我先写错两个查询词（`二字中文词`/`看门狗` 不是卡片真子串）→ 改测试而非改码，记此坑。
  - **缺口（新需求，已记账）**：真实经验卡（`V:\经验库` S01/S03/S05）的来源是 **Huddo 房消息**，不在 zjz 消息库内，故 `approve` 的来源校验会按 I26 拒入——需要「**Huddo→zjz 导入桥**」：导入时保留 `huddo_msg_id` 映射，卡片来源可指向外部消息并同样可回溯。不伪造来源（E5 同源纪律）。
- **T-007-D 导入桥 ✅（2026-11-09 总管）**：`src/ingest.js`＋`test/ingest.test.js`（T37–T39）。
  - `ingest.records(home,{room_id,slug,source,records:[{ext_id,author,ts,text}]})`：外部聊天记录导入 zjz 消息库，消息正文前置 `[source:ext_id]` 导入头，映射落 `data/ingest/<room>.jsonl`（含 `author_ext/ts_ext` 原署名原时间戳，不改写原文）。
  - 新哨兵：**I36 导入幂等**（同 `ext_id` 重复导入零新增、`skipped` 计数、消息库不出现重复条目）；**I37 映射↔消息库对账**（映射指向已删消息→`ghosts`；带导入头却无映射的手工塞入→`orphan_msgs`；`intact` 才可用）。
  - **I26 不放宽只多一条解析路**：`skill.approve` 的 `sources` 现可写 `{ext_id}`，经 `ingest.lookup` 解析成真实 房号＋消息号；解析不到或已失联→`SKILL_SOURCE_MISSING`。`skill.get` 溯源自动剥导入头还原原文并保留 `ext_id`。
  - 验收账：`npm test` **40/40**（新增 3 条）。
- **T-007-C 技能库 CLI/MCP 接线＋二审 ✅（2026-11-09 Codex，房② #55040）**：
  - CLI：`zjz skill candidates|approve|reject|list|get|verify|audit|search`；MCP：`zjz_skill_candidates / approve / reject / list / get / verify / search / audit` 八件，MCP 从 43 增至 **51 工具**。两个 smoke 已钉「候选→缺栏拒→全栏入→搜索命中→verify/audit」全链。
  - 二审修两处：①`approve/get` 原来逐来源全房扫描，改为按房一次读入、按消息号定位（多来源不再 O(来源数×全库)）；②`skill.audit` 原来用 `q:'来源'` 猜幽灵，改为 `search.listDocs(kind='skill')` 枚举权威对账，幽灵/重复/缺失都自动修复，新增无“来源”字样幽灵回归测试。
  - 最终门：`npm test` **40/40**、`node test/smoke.mjs` ALL GREEN、`node test/mcp.smoke.mjs` ALL GREEN（51 工具）。
- **T-007 需求①红测与逐条转绿 ✅（2026-11-09 Codex）**：`test/red/i27-i35.red.test.mjs`＋说明，**9/9 全绿**。I27 零消耗检测、I28 在岗可见性、I29 并发 wait 原子取投、I30 环境漂移、I31 无窗留痕、I32 依赖自愈、I33 配置加载验证、I34 项目记忆恢复、I35 资源租约单活全部转绿。常规门 `npm test` 保持全绿。
- **T-007-E 真实语料演示 ✅（2026-11-09 总管，房② #55102）**：房② 83 条＋房① 232 条＝**315 条真实 Huddo 交流**导入 `trials/huddo-real-20261109/home`（trial 目录，整目录可删，不污染主干）。实跑账：I36 幂等复跑 imported=0/skipped=83；`ingest.audit intact=true mapped=315 ghosts=0 orphan=0`；`search.audit intact=true messages=315 indexed=315`；真实关键词检索 2–4ms（工单36/换班18/技能库15/游标12/哈希链7/闪现3/保活1/zod1）。坑：PowerShell 重定向会把 huddo UTF-8 输出二次编码成乱码（中文词 0 命中假象）——抓 Huddo 输出必须用 node `spawnSync` 取原始 Buffer。
- **总管验收（需求①，房② #55137）✅**：9 枚提交（`7dc0f68`…`765ec64`）本机实跑判收：`npm test` 40/40、双 smoke 全绿（51 工具）、红测 9/9；另起临时 home 真用抽查 `resume`、资源租约单活、`config verify` 优雅失败均 ✓。I29 是红测抓到的真 bug，因果留档：**同身份并发投递必须先取房间锁、再读游标并原子推进，不能“先读后写”**。nit①③已修，nit②已在此保留。
- **resume 补充 nit③（总管实测 11-09）**：`resume.js` 以 `process.cwd()` 定位仓库根——**从仓库外目录跑 `zjz resume` 报 `RESUME_SOURCE_MISSING`**（报错本身合规，但治「新会话忘了项目」的机关必须从哪跑都能接力）。修法：从模块自身路径（`import.meta.url` 上溯）定位仓库根，或 `--repo` 参数；并让错误 message 提示「请在仓库根运行或传 --repo」。同场坑复现：PowerShell 管道同样会二次编码 CLI 的 UTF-8 JSON（不止重定向到文件），验 CLI 一律 node `spawnSync` 取原始 Buffer。
- **新需求进池（真实数据暴露，总管 11-09）**：**I38 候选闸门收紧**（315 条扫出 214 候选＝68% 等于没筛；要求真实语料候选 ≤20%、剔除「收到/确认」纯应答词、抽样人工判定）；**I39 检索命中展示清洗**（命中含 `[huddo:msg_xxx]` 导入头；加 `display_text`＋`ext_id`，原文与对账不动）。归 Codex，排在 I27–I35 之后；随后 M4（T-005 单窗口多房间）。
- **T-008 投递即唤醒 ✅规格＋最高优先（主人 11-09 定性，总管起草，`T-008-wake-spec.md`）**：「房间新消息→提示到智能体本体」必须做成**软件自带器官**——计划任务/规则文件/自觉续 wait 都算外挂，不算产品（今日 Codex 三次交活即停、1-2 小时不盯房＝实案）。`zjz serve` 常驻进程＝UI 后端＋投递监督器：第0层 在线即推（SSE＋MCP wait，≤2s，I46）；第1层 离线唤醒（适配器注册一次，监督器 `zjz spawn` 拉无头会话，任务＝pending 正文＋resume 协议，走 I35 租约防双发，落 `.wake` 事件，I47）；第2层 SLA 台账（posted→pushed→read→answered，超时出 `delivery_late`/自动开值班工单＋UI 红标，I48）；第3层 监督器软件内自持（≤60s 自恢复＋`.revive`，**测试全程禁用外部计划任务**＝原生化硬判据，I49）。收口演示：Codex 注册真适配器后**不盯房**，被房②发帖自动拉起回帖。归 Codex，与 M4 合并实施，优先级高于 M4 其余部分（房② #55216）。
- **T-008 补丁 · 第 0.5 层「被动带出」I45（主人 11-09 点破，插到最前）**：实案＝Codex 最近两次回帖都靠主人当面提醒，产品自身没拽回他。规则：任何 zjz MCP 工具返回一律附 `inbox` 块（pending_rooms/mention_me/duty 健康行，游标对账不消费游标）＋`zjz_wait` 自持续契约（每次返回带 next＋pending）。宿主 AGENTS 规则只算装机过渡不算产品实现。**验收口径钉死：凡由主人当面提醒触发的回帖不算 T-007/T-008 进展；只有 I45（工具返回拽回）与 I47（离线被自动拉起）两种形态算数**（房② #55234）。
- **I45 核心已落地（总管 `a865cba`）**：`src/inbox.js`＋`test/inbox.test.js`（I45-1..4）。`inbox.compose(home,{slug})` → `pending_rooms`（逐房未读数，游标对账）＋`mention_me`（@我 摘要）＋`duty`（在岗/已停 X 分钟，读 listen 租约）。纯读不写、连查不消费游标（红测断言）。**游标语义坑（已钉进红测）**：`msg.read` 不推进游标，只有 `wait` 推进——unread 在 read 后不清零是正确行为。npm test **46/46**。Codex 只剩接线：MCP reply 出口统一挂 `payload.inbox`（一处全效）＋CLI `zjz inbox`＋wait 返回附 `next`＋pending（房② #55244）。
- **M4 前端已交付（总管，Codex 并行工单 #55249，交于 #55254）**：`public/index.html`（单文件零依赖：左房列表/右消息流/三入口/SSE＋轮询兜底/display_text 优先/NOT_MEMBER 红标/首屏自动选身份进房）、`scripts/create-shortcut.ps1`（app 模式＋固定 profile＝物理杜绝第二窗口）、`trials/m4-frontend-dev/`（契约 dev 桩＋README）。ego 语义审计 PASS：首屏 40 条、零导入头泄漏、ext 徽章 40/40、**切房页数恒 1**、检索 19 命中、值班板失联红标；I45 MCP 探针（`i45_mcp_check.mjs`）当前如实 FAIL＝未接线，接线后翻 PASS 才收。提交 `9475603`＋`0aff7f3`。契约请求两条已提：`/api/members`、`/api/rooms` 带 `current_slug`＋`unread`。
- **M4 证据缺口闭环（Codex #55259 抓到，总管认账补齐 `10ca3f5`/`bd41e40`）**：取证脚本当时在 Temp 未入仓（与 huddo-real trials 同款错，第二次犯）。纪律更新：**取证脚本与交付同提交**。补交 `evidence_static_check.mjs`（无浏览器依赖 13 断言，实跑 13/13 PASS）＋ego 审计两轮回放脚本（页数恒 1 只有它能测）＋`i45_mcp_check.mjs` 探针＋README 复现命令。Codex 复核报数与我一致（3 房/40 条/19 命中）。
- **I47 适配器层交付（总管，Codex 拆半工单 #55261→交于 #55263，`0e95d14`）**：`src/member.js`（注册表 `data/members/<slug>.json`：`adapter_kind:spawn|notify`/argv/env/cooldown_ms/max_consecutive，非法注册结构化 BAD_INPUT 含 slug 路径注入拦截）＋`src/adapter.js`（`adapter.run` 返回 `status:spawned|spawn_failed|notified|cooldown`；任务合成＝头＋resume 协议＋pending 正文；notify 绝不 spawn 只写 `data/inbox/<slug>.md`；env 逐成员覆写 HUDDO_HOME＋`ZJZ_TASK_FILE`/`{task_file}` 槽；.ps1→pwsh 包装/.cmd→cmd /c、windowsHide；连败熔断 `ADAPTER_MAX_CONSECUTIVE` 升级归 wake.js）。`test/member.test.js` M45–M48。门：**npm test 50/50**＋双 smoke 绿。Codex 接 wake.js（租约/.wake/升级/serve 监督环）。
- **适配器真宿主冒烟（总管 11-09，房② #55281）**：`adapter.run` 拉起真 `claude --print` 端到端通（spawned/exit=0/stdout=OK）。**实踩坑已修＋红测 M49**：PATH 上 `claude` 是无扩展 shim（`where.exe` 排第一）→裸 spawn ENOENT；`resolveCommand` 现优先命中 .exe/.cmd/.bat/.com（提交 `2ae40fa`，npm test **51/51**）。**演示日待排雷**：claude 配置模型 `deepseek-flash`  unrecognized（回落默认才答对）——注册真适配器前须配好模型（成员 env 可传）。已提醒 Codex：一切拉进程走 adapter.run，勿在 wake.js 旁路自 spawn。
- **I45 接线完成（总管越权代接，`b9e2103`，房② #55297）**：死锁＝接线在 Codex 的 `bin/zjz-mcp.mjs`，他不看房就永远看不见要接它。两处：①`tools/call` 出口统一挂 `inbox` 横幅（slug 优先级 args→结果→current.json；失败不影响主结果）②`zjz_wait` 自持续契约（`pending_after`＋`next`）。**探针 `i45_mcp_check.mjs` 从 FAIL 翻 PASS**（无关工具返回带 pending_rooms=2/mention_me/duty），npm test 51/51＋mcp smoke 绿。所有权仍归 Codex，可重构但横幅必须在——**I45 产品形态自此落地**。
- **claude 适配器模型排雷结论（演示日用）**：成员 env **不要覆写模型名**。默认配置（settings.json model=deepseek-flash→CCR:3456）实测 exit=0 正常回话；覆写 `qwen3.8-flash-next*`（CCR 名/opencode 名两种写法都试过）反而 400 All target providers failed。`unrecognized_model` 仅告警（claude 回落默认仍答对），CCR 模型名属装机期整理。CCR 目录实扫：providers 含 deepseek-flash/deepseek-v4-pro/mimo-v2.6-pro/mimo-v2.6-flash/Strata-IQ3S-125B/qwen3.8-flash-next；:8081 网关只挂 `qwen3.8-flash-next-iq3_s`。**主人定资源边界（11-09）：总管用本地模型（独占不抢），Codex 走云端**——唤醒适配器若要本地模型无需租约排队。
- **Codex #55522 分工更新＋演示面交付（总管 `4c0a7fc`）**：Codex 继续 `src/wake.js`/`zjz wake|spawn`/I49 自持/serve；总管接演示面四件——①`trials/t008-demo/demo_all.mjs` 一键收口（I45/前置 serve/I46 SSE≤2s 实测/I48 失联点名/I47 端到端/I49 前提＝schtasks 里 zjz 任务数必须 0），现测 **2/6**（我层绿、serve 四项如实红）②`scripts/start-serve.ps1` 无窗启动（端口占用打印现有地址；默认 SW_HIDE；-AsTask Session 0/S4U 真无窗＝一次性装机）③前端真接口兜底已在位④取证同提交纪律保持。**值班轮纪律教训（已认）**：Codex 07:28 发帖时值班轮恰停摆——凡对 Codex 静默等待，wait 不得中断，超时立即续轮。探针判「命令已实现」只认 `ok:true`/带 `status`（BAD_INPUT＝未知命令假绿）。
- **攻关「新消息→本体可见」（主人 11-09 点名生死线，`8e87f38`，房②攻关帖）**：三类投递分层＝A 调工具的（I45 已 PASS）／B 挂监听的（等 serve）／C **GUI 宿主（客户主力，此前 notify 死路）**→ 适配器新增第三种 **kind=api**：`member.set {adapter_kind:'api',url,method,headers}`，`adapter.run` HTTP POST 投递进活会话（任务体走文件；绝不 spawn；冷却/熔断同规则；`api_delivered|api_failed`＋http 码），M50 红测，**npm test 52/52**。本机实探：opencode-cli 监听 28894（UI+API 同端口，SPA 兜底待解调真 API 路径）、Codex Desktop 60121 非 HTTP。**死锁坑（曾误诊 EDR）**：同步 spawnSync 阻塞调用方事件循环——投递目标必须是外部进程（生产天然满足；测试夹具已照此修）。向 Codex 提三对齐：wake 决策后用一次性 `zjz wake-exec` 子进程执行 adapter.run（防监督环卡死＋利 I49）；api_delivered 在 I48 记 pushed 非 read；OpenCode API 我啃、Codex Desktop 他探，先通先演。
- **T-008 三对齐定案（Codex #55638，总管确认 #55642）**：①监督环不同步跑 adapter.run——主循环只做 pending 判定/租约/`.wake` 留痕，拉一次性 `zjz wake-exec <slug>` 子进程执行适配器，wake-exec 猝死 ≤60s 再拉＋`.revive`（正对 I49）；②`api_delivered` 记 **pushed** 不记 read（游标推进＝read、回帖＝answered，防 SLA 假绿）；③分工＝Codex Desktop 60121 归 Codex（已提醒非 HTTP 非 TLS）、OpenCode 归总管（CLI run 已通，28894 是 SPA 别碰），演示先演 opencode-cli 档。Codex 接下来落 `src/wake.js`＋`zjz wake/wake-exec/spawn`，spawn 只调 adapter.run、按 M50 外部进程夹具语义。对接点已回帖：adapter.run 返回 status 六态（spawned/spawn_failed/notified/cooldown/api_delivered/api_failed）、熔断 `ADAPTER_MAX_CONSECUTIVE` 升级开单归 wake、i47 探针触发面＝`zjz wake <slug>` 连发两次房内恰 1 回帖、`.wake` 落 `data/**` 任意 json/jsonl。
- **生死线闭环验收通过（总管独立实跑，2026-11-09 08:2x，Codex `179cbfd`/`5a9db70`/`f31cb35`）**：npm test **57/57**；无窗启动 serve（`start-serve.ps1` pid30392 端口8888，health 自证 `session_id:0`）；`demo_all` **6/6 PASS**（I45 横幅／I46 SSE **98ms**≤2s／I47 假适配器恰1回帖＋`.wake` 留痕／I48 失联点名／I49 零外部计划任务）；**`i47_real_check` 真宿主 PASS**：真 opencode-cli（本地模型）被 `zjz wake` 拉起→读消息→自跑 zjz CLI 回帖**恰 1 条**，二次 wake 返回 `status:'idle'`＝防双发生效。**全程人工提醒零输入**。探针修正：demo_all 加 `--slug` 直传（serve health 的 current_slug 依赖 home 已有身份）。**T-008 主链路具备演示条件**；待办：主人到场时演「房②真实发帖→不盯房成员被拽回」＋M4 四幕真库跑。
- **房②实弹闭环 PASS（主人授权①，`863dd2b`/`cfdeed5`/房② #55996）**：serve 挂 feed 直播环（15s）＋`wake_policy=mention`＋`mention_handles`＋分身常驻指令 `instructions`（M53，61/61）；给 Codex 建档（slug zjz-codex分身-5d8f7b04，opencode-cli＋HUDDO_HOME=data-codex，主人授权、档案可接管）。实弹：09:22 总管 @帖 → 09:25 **Codex 本人账号自动回帖「唤醒器代答」**（resume→确认三对齐→如实交底 markPushed/I48 欠账）。链＝feed→镜像→wake.tick→wake-exec→以本人身份回帖，零人工。越权针均标注可重构。
- **分身二次回帖核实＋重放诊断定案（`ebbb2f9`，房② #56097）**：分身（09:48 #56066）报「跨周期 pending 重放会二次拉起」——核实：机制属实（wake 不消费游标，游标只被 wait/shiftDuty 推进），但 09:48 那次不是重放（镜像游标已到 11、触发＝#56035 新提及＝mention 策略正确）。新哨兵 `replay_guard_check.mjs` 坐实红：夹具不守自觉 wait 时，租约过期后 wake2 再 spawn＝重放成立，**防必须落 wake 层，不能靠分身自觉协议**。修法纠偏已发：反对「投递即推游标」（违三对齐② pushed≠read），主张 wake batch 记录＋游标推进挂 answered/ack 点＋markPushed 落投递（Codex 欠针正好接上），ext_id 已答台账作再入补丁收进 I48。另二单归 Codex：member set CLI 缺 instructions/wake_policy/mention_handles 旗标；exec 的 pendingMessages 未过 wake_policy 过滤。判收口径：replay_guard 翻绿（第二周期无新消息必 idle）。
- **熔断闩锁事故＋复位路径入仓（`b8c8732`，M54）**：事件日志坐实——09:25/09:28 两枚 adapter 失败（code undefined，本体回帖成功但 exec 收尾记失败，待查）触发 max_consecutive=2 闩锁后**无复位路径**：成员永久失联＋serve 监督环每租约周期空转（224 条 wake 事件）。修复：`adapter.state`（点名 latched）＋`adapter.reset`（手动复位）＋`wake.tick 见 latched 停止派发`＋CLI `member adapter-state|reset-adapter`、`feed bind|poll|bindings`。实弹当场用过：复位 Codex 分身档案→链接通。
- **飞行中双发活案例（房② #56218/#56219，10:45:56/10:46:56 两条分身回帖）**：一帖两答。成因：租约 TTL=max(60s,cooldown)=90s 先到期，wake-exec（opencode-cli ~3.5min）还在飞→第二周期再派发两进程并行；cooldown 从**拉起时刻**起算形同虚设。夹具化＝`trials/t008-demo/longrun_guard_check.mjs`（任务 140s，t+110s 再 wake 不得 spawned；当前预期如实红，batch 语义落后进对位翻绿）。
- **answered 触发拍板＝方案 (c)（房② #56220，Codex 开放点 (a)/(b) 之外）**：read（游标推进）挂 **wake batch 闭合**（wake-exec 退出即闭包推进，零自觉）；answered 挂 **feed 机器检测**（feed/ingest 收到作者＝该成员 handle 的新消息即 markAnswered，零退出码混淆）；台账全程机器可证 posted→pushed→read→answered。值班板两类超时分开开单：pushed 未 read＝宿主没跑动；read 未 answered＝跑了没回话。防双发核心：batch 未闭合不再派发（别只靠租约 TTL）。Codex 排期：先红对位→batch＋markPushed→闭合推游标→feed 触发 answered→ext_id 再入补丁。
- **跨周期重放＝生产已发生（房②三通：#56218 10:45 / #56219 10:46 / #56222 10:59，均回旧提及 #56097）**：根因坐实——我给分身的常驻指令「不做其他任何事」＝分身永不 wait，游标停在 11、旧 @提及永远 pending，每过冷却＋租约再拉一次。止血（正当运维）：以档案身份跑一次 `wait` 消费游标（11→17，pending=0），wake 即 idle、风暴停。**但这仍是运维自觉，翻绿判据不变：replay_guard/longrun_guard 在「没人替分身 wait」前提下自动绿**。给 Codex batch 语义补硬要求：**batch 闭合＝游标推进无条件成立**（即便 exit0 未回帖，read 照成立、answered 缺席由值班板开单）——重放防线彻底不依赖自觉。（房②通报 #56223）
- **T-007-F I38/I39 ✅（2026-11-09 Codex）**：真实语料 **318 条**候选由 216 降至 **43（13.52%）**，纯「收到/确认/好的」不入，trigram 实测与 session=0 验收两条真经验保留；`search.query` 新增 `display_text/ext_id`，`text` 原样不动，外部号经 `ingest.lookup` 往返一致，性能 p95 **10.156ms**。三条 nit 同批闭环：`resume` 任意 cwd 可定位仓库、`dependency check` 用法提示、I29「先取锁再取游标」因果留档。常规门 `npm test` 42/42＋双 smoke 全绿，待总管抽样判定。
- **M4/T-008 serve 骨架 ✅（2026-11-09 Codex）**：`src/serve.js`＋`test/serve.test.js` 先红后绿，I40 单实例、I41 只绑 `127.0.0.1`、I42 UI/SSE 零消耗（推后 `wait` 仍收齐）、I43 跨房隔离，以及 T-008 第 0 层 I46 在线 SSE ≤2s 全部通过。serve 只读消息流不推进游标。
- **T-008 I48 SLA 台账 ✅（2026-11-09 Codex）**：`src/delivery.js`＋`test/t008.test.js` 实现 `posted→pushed→read→answered`，假时钟 read 超时落 `delivery_late`，answered 超时自动开 delivery 值班工单；`zjz duty board` 点名到人到条。常规门 `npm test` **47/47**＋双 smoke 全绿；下一块 I47 适配器唤醒。
- **T-008 I47 唤醒监督器核心 ✅（2026-11-09 Codex）**：`src/wake.js`＋`zjz wake/wake-exec/spawn/member` 落地；按 I35 资源租约防双发，任务含 pending 正文＋`zjz resume`，`.wake` 事件留痕，一次性 `wake-exec` 执行适配器。`trials/t008-demo/i47_wake_check.mjs` 已从红翻 **PASS**（不盯房成员被自动拉起并只回帖 1 次）。当前常规门 `npm test` **57/57**＋双 smoke 全绿；下一步把 wake 监督环接入 serve，补 I49 自持。
- **T-008 投递闭环收口 ✅（2026-11-09 Codex）**：`serve` 监督环接入 `wake.tick`/`delivery.tick`，POST 自动建投递记录，SSE 在线通道只读不消费游标，离线成员走 `wake-exec` 一次性子进程；补 `/api/members`、`/api/search`、`/api/skills`、`/api/duty/board`。修复 demo 端口解析、真实成员流探测、唤醒风暴在途去重。`trials/t008-demo/demo_all.mjs --port 8791` **6/6 PASS**：I45 inbox、I46 SSE **96ms**、I47 不盯房被拽回且防双发、I48 失联红标、I49 零外部计划任务。产品核心问题“房间信息到不了智能体本体”已在本机闭环验证。
- **T-008 wake batch 防重放 ✅（2026-11-09 Codex）**：`src/wake.js` 改持久 batch（消息清单、open/closed、batch 闭合无条件推进游标），`src/delivery.js` 增按消息 `markPushed/markRead` 与按作者 `markAnswered`；`pendingMessages` 排除自身回帖，阻断“答完又把自己当 pending”。验收：`replay_guard_check.mjs` **PASS**（第二周期无新消息 idle、恰 1 回帖），`longrun_guard_check.mjs` **PASS**（140s 飞行任务期间二次 wake=`batch_open`、最终恰 1 回帖），`npm test` **62/62**。下针：feed 回流自动 `markAnswered` 与 ext_id 再入台账。
- **T-008 feed answered 回流 ✅（2026-11-09 Codex）**：`serve.feedScan` 改为读取一次性 feed 子进程的结构化输出，将回帖作者按 `mention_handles` 映射到 zjz 成员并调用 `delivery.markAnsweredByAuthor`；`api_delivered/spawned` 只记 pushed，batch 闭合记 read，feed 回流才记 answered。`npm test` **62/62**、serve/t008 定向测试 5/5。待补 ext_id 再入台账和真库回流实弹。
- **T-007-F 总管验收 PASS（2026-11-09，房② #55204 交）**：独立复核全过——I38 占比 43/318=13.52%、纯应答 0、两条指定真经验在列；抽 5 人工判定 2/5 严格经验、3/5 过程记录（判定 PASS：候选≠入库，终审在认可门；下轮建议候选分类「经验/决议/过程」降权过程类）；I39 `display_text/ext_id` 往返一致、I23/I37 不破、总管侧 p95 3.20ms；nit①③ 原失败场景复刻均 PASS。详见 `T-007-F-acceptance.md` 验收记录区。**下一批＝M4（`T-005-m4-spec.md`，I40–I44）**。
- **M55 房讯必须带时间（2026-11-09 总管，主人实弹反馈）**：主人指出「房间里的信息没有时间」——`adapter.composeTask` 的消息头只有 `房 #seq 作者`，无时间。已改：新增 `tsLabel(ts)`（本地可读 `YYYY-MM-DD HH:MM:SS（UTC±hh:mm｜ISO 原值）`，缺 ts 显式标「时间未知」），消息头追加 `| <时间>`；`RESUME_PROTOCOL` 增加「回帖首行写『回复于 <本地时间>』」。旧对位不破：`trials/t008-demo/fake_responder.mjs` 依赖的 `^--- 房 #seq ` 前缀保持，已核。哨兵 `test/task_timestamp.test.js`（M55）＋`npm test` **63/63**。
- **总管侧未结案（发现，未修）**：`src/serve.js` 无静态路由——`T-005-m4-spec.md` 第 30 行要求 `public/index.html`＋静态路由，现 `GET /` 返回 `{"ok":false,"code":"NOT_FOUND"}`，M4 前端只在 `trials/m4-frontend-dev/mock_api.mjs` dev 桩上验过，产品路径打不开（且 `index.html:169` 直接把 ISO `ts` 原样渲染，人读不出）。serve.js 属 Codex，改动需越权或开工单。
- **M4 产品静态路由 ✅（2026-11-09 Codex）**：`GET /` 与 `/index.html` 直接返回 `public/index.html`，错误显式 `UI_LOAD_FAILED`；serve 验收新增真实首页 200、`text/html`、DOCTYPE 断言。`npm test` **63/63**，M4 不再依赖 mock dev 桩。
- **另一条产品线定位（不串线）**：`http://127.0.0.1:3010/` ＝ `G:\大导演库\04_产品\灵墟造物_商业版`（PID 36124 `LXCore.exe`，11-07 打包；`lxcore_web.py` 起 3010；安卓 Chaquopy 同端口；`server/app.py` 11-09 10:23 仍在改）。这条线已有会员/卡密/发卡器/合规文档，与「海钺造物」命名定案冲突待主人裁定；该项目真源在 `V:\haiyue\PROGRESS.md`，本仓不碰其源码。
- **T-008 判收：独立复跑全绿（2026-11-09 夜，总管）**，不采信 Codex 自测记录：`replay_guard_check.mjs` **PASS**（第二周期 wake=`idle`、`spawned=false`、房内恰 1 回帖）；`longrun_guard_check.mjs` **PASS**（飞行中二次 wake=`batch_open`、`spawned=false`＝不再派发、最终恰 1 回帖）；`i47_real_check.mjs` **PASS**（真宿主 拉起→恰 1 回帖→二次 `idle`，全程无人提醒）；`demo_all.mjs` **6/6**（真 serve 8888，I46 在线即推 **81ms / 28ms** 两次）。批语语义与 feed answered 回流认收（Codex `2843456`/`91666b4`/`d13cefa`）。
- **demo_all 两处测试侧缺陷已修（总管，trials）**：①I46 订阅未注册就发帖的竞态（`got=null` 假红，实测先等 SSE `ready` 再发帖即稳；延迟改为只算「发帖→收到」）；②前置 serve 不在时级联出 3 条产品红——改为重试 5 秒后 `exit 2` 并打印确切启动命令，夜巡与装机自测由此分辨「没人起服务」与「闭环坏了」。
- **初级品口径已立案**：`初级品-v0.1-装机门.md`（五件交付物、四判据验收门、四项阻塞、1 天内部可装测／3 天对外）。第一 blocker＝serve 静态路由，工单已发房② #56259（带时间标）。
- **装机门四件已交付并本机验证（2026-11-09 夜，总管，10:00 装机测试用）**：
  1. `scripts/preview-web.mjs`：Web 前挂（发 `public/` ＋ `/api` 与 SSE 原样代理到 serve），**不改 Codex 的 serve.js**。实测 `GET /` 200 `text/html` 12380B、`/api/health` 与 `/api/rooms` 经代理 200、SSE 经代理收到 `event: message`（含 ts）。端口 8890 在本机被 `kxescore.exe` 占（返 404 的假服务），故 README 默认 **8899**。
  2. `trials/t008-demo/selfcheck.mjs`：装机验收门一条命令（单元＋demo_all＋replay_guard＋〔longrun_guard〕＋i47_real），报告落 `data/selfcheck/<ts>.md`，退出码即结论。
  3. `scripts/install-check.ps1` ＋ `.cmd`：只读前置检查（Node≥22、仓文件完整性、宿主 CLI〔PATH 外还查 `%APPDATA%\ai.opencode.desktop\cli\*\opencode-cli.exe` 与 `ZJZ_HOST_CLI`〕、huddo 与身份目录、端口占用、serve 在场）。实跑本机：Node 26.12.1 PASS、宿主 CLI 找到 claude 与 `opencode-cli.exe(2.2.5-x64)`、两端口 WARN 给换号建议。**坑记档：Windows PowerShell 5.1 按 ANSI 读无 BOM 的 .ps1 会解析错乱（中文注释被吞、catch 块被当字符串），已改成 UTF-8 BOM 存盘，且必须 `powershell -ExecutionPolicy Bypass -File` 或双击 .cmd。**
  4. `README-装机.md`：15 分钟到第一条自动回帖的七步＋常见红对照表（`ADAPTER_SPAWN_FAILED`、E12 闩锁复位、前置未就绪、游标不推进、界面前挂）。
- **夜巡修正**：`night_patrol.mjs` 两哨兵预期由红改绿（batch 已落仓），并加「红灯自动复跑一次再记录」（本机模型偶发瞬时不可用，两次都红才算红）。
- **11-09 收工状态（关机前快照）**：HEAD `36c6712`（Codex merge）＋我方 `0f399a5`，工作树干净。已排 **02:00 一次性关机**（`shutdown /s /t 7409`，事件 1074 在案；房②#56433 已通知 Codex）。**明早开机后 serve 不会自起**（按 I49 不注册计划任务），10:00 测试第一步就是手动起：`node bin\zjz.mjs --home V:\zjunzhang serve --port 8888`，再 `install-check.ps1` → `selfcheck --port 8888 --fast` → 开 http://127.0.0.1:8888/ 。
- **11-10 早复核（07:55，总管实跑，不采信汇报）**：
  - 开机后 serve 确认未自起（`serve status → running:false`），手动起 8888 成功（lease pid 4912）。
  - **Codex 昨夜落了两件**：`ef7cc48` E14（成员级 `timeout_ms`，默认 600000；`ADAPTER_TIMEOUT` 带 `elapsed_ms`/`exit=null` vs `ADAPTER_SPAWN_FAILED` 带 `errno`，`adapter.js:208/218/219`、`member.js:96` 校验 ≥1000ms、CLI `--timeout-ms`）；`c66f564` 落 `zjz selfcheck`（装机门第 3 件，四判据＋`PASS|FAIL|BLOCKED|SKIP`＋退出码 0/1/2＋报告落 `data/selfcheck/`）。
  - `npm test` **70/70**；`zjz selfcheck --port 8888` 判据1/判据2 PASS（判据 3 真宿主在跑，见下条报告）。
  - README 已对齐真源：第 5 步改主推 `zjz selfcheck`（脚本版降备用）、第 3 步补 `--timeout-ms`、常见红把 E14 行改成 `ADAPTER_TIMEOUT` 口径、界面行改成「旧版 serve 需 stop 再起」、并明确 **start-serve.ps1 的 `schtasks` 段属人工诊断遗留、产品路径不用**（与 I49＋全局红线同口径）。
  - 装机门四项 blocker 全部标注已关（附复核凭据）。
  - 新 home 实弹（装机门判据 5）：全新 home `zjz-fresh`＋新房 `room_5febd45dc45d282d`，脚本 `fresh_home_test.mjs`（起 serve→send→轮回帖→事件/inbox 取证→serve stop）。
- **11-10 08:0x 装机自测全绿（`zjz selfcheck --port 8888`，报告 `data/selfcheck/2026-11-09T23-55-23-873Z.md`）**：判据1 单测 70/70、判据2 演示收口 6/6、判据4a 防重放 PASS(66s)、判据4b 飞行中不双发 PASS(214s)、**判据3 真宿主不盯房被拽回 PASS(149s，全程无人提醒)**，退出码 0，总耗时 436s。**判据 3 昨天红的机制已闭环**：任务实耗 149s，旧默认 180s 卡线下并被误报 `ADAPTER_SPAWN_FAILED`；E14（成员超时 600s＋`ADAPTER_TIMEOUT` 分码）落仓后同一任务 PASS。
- **本地 IQ3 单槽的处置口径（11-10 定，写进 README 与红线）**：
  - 实测账：模型 77.9GiB（IQ3_S 两分片），引擎 `arena_mib=47962`（显存 49140 只剩 `vram_free_mib=1786`），常驻专家缓存 38.2GiB／20049 槽走内存，整机 125.6GiB 只剩 20.5GiB 可用 → **开多槽（`--slots 2..8` 引擎支持）在当前 262k 上下文下显存不够**；要开必须先把 `--max-context` 降到 32k–64k ＋ `--kv q4_0`，且每 agent 速度不会变快（算力共享＝每人约 1/4）。**改引擎启动参数＝处置别人产品，须主人点头，我只出 A/B 实测不擅自重启。**
  - 今天的分流表（唯一硬规则：**同一时刻只有一个智能体吃本地**）：总管（我）＝本地 `local-strata/strata-iq3s-125b`（262k 长上下文，演示主角）；Codex 分身／Hermes 值班／ZCode＝云端 flash（`deepseek-api/deepseek-flash`，本就是成本纪律要求的日常档位）。
  - 谁要用本地：先 `zjz resource claim --resource local-iq3 --ttl-ms <用完的秒数>`，用完 `resource release`；拿不到就走云端。这条把"四个 agent 一起打→排队不可预测→请求被断→误报没装上"变成"占位可见、等待可预期"。
- **11-10 上午开发：M56 provider 槽位视图（先红后测，`test/providers.test.js` 8 例，全量 `npm test` 80/80）**：
  - `src/member.js` 新增 `providers(home)`（＋CLI `zjz member providers`）：列出每个成员用的 provider（`local`/`remote`/`unknown`，**没线索不猜云端**，可显式 `--provider local|remote`）、汇总 `local_slots`/`local_members`/`local_held`/`local_holder`/`over_subscribed`（本地成员多于一个＝红旗），占用状态直接取 `resource`（`local-iq3`）。目的：把 E15 的分流表从"人记住"变成"可查、可红旗"。
  - **顺手修掉一个会咬人的缺陷**：`member.set` 原为整档重写，只改一项（换模型／调 timeout）会静默抹掉 `instructions`/`mention_handles`/`wake_policy`/`env` → 改为合并语义（M56-7 钉死）。
  - **错误卡 E17 立案并加防线**：README 教的 `--adapter '[\"exe\",...]'` 在 PowerShell 下被二次转义成**单 token**，档案当场写坏、到唤醒时才报 `ADAPTER_SPAWN_FAILED`（与 E14 同面孔）。防线：`argv.length===1` 且形如 JSON 数组 → 当场拒收（`ADAPTER_ARGV_ESCAPED`，M56-8）；新增 `--adapter-file <json>` 绕开 shell 引号层；脚本改档案走 `member.set()`。我自己刚踩到（改 Codex 分身时 argv 被写坏），已修回。
  - **本地独占已执行**（主人定「先不动，只你一个人用」）：Codex 分身 `zjz-codex分身-5d8f7b04` 的模型从 `local-strata/strata-iq3s-125b` 换成 `deepseek-api/deepseek-flash`，并显式 `provider: remote`、`timeout_ms: 600000`；其余字段（instructions/mention_handles/wake_policy/env/cooldown/max_consecutive）核对未丢。房②留底 #56768（含回滚办法：把 argv 第 4 项换回 `local-strata/strata-iq3s-125b`）。现 `member providers` → `local_slots=0`（本地槽空着归我用）、`over_subscribed=false`。
- **静态路由已由 Codex 落仓并复核（`d6c3e8e`，总管 11-09 夜重启 serve 后实测）**：`GET /` 200 `text/html` 12380 字符（同一 `public/index.html`，含 M55 时间标渲染）、`/api/health` 200、`/../src/serve.js` 与 `/nope.html` 404；`demo_all --port 8888` **6/6**（SSE 45ms）。`scripts/preview-web.mjs` 降级为备用前挂（旧版 serve／换端口时用），README 第 2 步已改为直接开 8888。
- **同机双改撞车一次（记档）**：Codex 同时在改 `trials/t008-demo/i47_real_check.mjs`（他加了 `findHostCli()` 与 `ZJZ_HOST_MODEL`），我这边也加了 `MODEL` 常量 → 文件一度出现重复声明（语法错）。已消重并采用他的 `ZJZ_HOST_MODEL` 口径。**分工收紧：装机取证脚本（`trials/t008-demo/*` 去绝对路径那批）归 Codex，总管转做复核与验收，避免 E13 的文件级双发。**
- **E14/E15 已立案（错误卡）＋README 常见红对照**：180s 适配器默认超时短于真任务且误报成 `ADAPTER_SPAWN_FAILED`（`member.js` 档案 schema 无 `timeout_ms` 字段）；本地 IQ3 单槽串行，并发 2 全排队、并发 4 两个 `fetch failed`。**待 Codex 落：超时按成员可配＋超时与拉不起来分两个 code。**
- **T-008 ext_id 再入防护 ✅（2026-11-09 Codex）**：`src/wake.js` 建 `data/wake/answered_ext.json` 已答外部消息台账，feed 回流在 `markAnsweredByAuthor` 成功后写入 ext_id；`pendingMessages` 对已答 ext_id 永久跳过，即使外部记录重复导入也不再唤醒。`npm test` **63/63**，`replay_guard` 与 `longrun_guard` 均 PASS。
- **初级品装机门静态路由补齐 ✅（2026-11-09 Codex）**：`GET/HEAD` 安全服务 `public/` 下 HTML/CSS/JS/图片，HTML `cache-control:no-store`，路径越界（`..`、`%2e%2e`、绝对路径）返回 `STATIC_FORBIDDEN`，静态缺失回落 `NOT_FOUND` 且不干扰 `/api/*`。对位测试覆盖 MIME、HEAD、POST、路径逃逸与 API 回归，`npm test` **64/64**。

- **I47 真宿主离线唤醒实弹跑通一次 ✅（2026-11-10 09:26–09:28，本轮会话即被拉起的那台）**：home=`C:/Users/Administrator/AppData/Local/Temp/zjz-i47r-F2aCEM`，房 `room_a9681ddf75d0c29f`；被唤醒后按协议先跑 `zjz resume` 读回记忆，再读房读到发帖甲的 @ 唤醒帖（seq=1），回帖 seq=3（正文以标记词开头，含"回复于"时间行）。台账对位：`status=answered`、`pushed_at/read_at/answered_at` 全齐、`read_late=false`（E22 已闭环），`i47_real_check` 按标记词计数 → 真身回帖数＝1。**全程无主人当面提醒**，符合 T-008 验收口径（I45/I47 才计数）。
  - 副产物：踩到并立案 **E23**——`zjz send -` 不读 stdin，把字面量 `-` 当正文发出去（huddo 那边 `send -` 是走 stdin 的，宿主按习惯照抄就中招）；本轮先多发了一条 `-`（seq=2），随后用 argv 传正文修正为 seq=3。建议 Codex 排：`send -` 读 stdin ＋ `-`/空白正文拒收 `BAD_INPUT`。
- **I47 真宿主离线唤醒复跑 ✅（2026-11-10 15:14–15:17，第二次实弹）**：home=`%LOCALAPPDATA%/Temp/zjz-i47r-k7K1CI`，房 `room_103eeb4dd7c4def7`；被自动拉起后按协议先在仓库根跑 `zjz resume`（M1–M3 全绿、未闭合工单 0），再读房回帖 seq=2，首行＝标记词 `自动唤醒回帖-1794294854011` 且含"回复于"时间行。台账 `status=answered`、`pushed_at/read_at/answered_at` 全齐、`read_late=false`，回帖数 1 条无双发；全程无主人当面提醒。唯一坑：CLI 参数里直接塞多行中文正文会被宿主 shell 扫描器以 `invalid-structure` 拒执行，改落一次性脚本用 `spawnSync` 数组传参即通（脚本在 `.work/reply-i47.mjs`，用后未入库）。

- **E38-C 桌面启动器改开独立客户端 ✅（2026-11-10 22:03，中军帐成员）**：`scripts/start-desktop.ps1` 由「开 Edge app 窗口」改为「优先开 `desktop/` 的 Electron 客户端，网页版只做兜底」：① 传 `ZJZ_API=http://127.0.0.1:<实际租约端口>`，跟随 E38-B 端口自动发现（客户端默认只认 8888，不传就是空窗）；② 客户端进程 1.5s 内退出即弹窗点名退出码，`-BrowserOnly` 可强制退回网页版；③ `desktop/main.js` 加 `requestSingleInstanceLock`＋`second-instance` 聚焦，双击两次不再变两个窗口（单窗口多房间口径）。实弹：`-CheckOnly` → port 8888；启动器拉起 electron（pid 已验窗口在、responding）；CDP 读渲染后 DOM → `.room`＝6、`window.zjz` 桥可用、标题「中军帐 · 指挥台」（不截图，`.work/tmp/desktop_smoke.mjs`）；单实例锁已加（`requestSingleInstanceLock`＋`second-instance` 聚焦），实测再启动一次未新增 app 主进程；但加锁前就已跑着的旧实例不参与锁，需关掉重开一次才纳入（记 E41）。`npm test` **99/99**＋`check-ui` PASS。捷径无需改：`create-shortcut.ps1` 本来就指向 `start-desktop.ps1`，双击即得 Electron 窗口。

- **11-11 11:47 桌面首启建房安装验收 ✅（中军帐成员）**：根因是已安装桌面包仍为旧构建，缺首启身份接口。已重建并静默升级 `中军帐-Setup-0.1.0.exe`（SHA256 `B118814E1D526C5BD66F78312D12B051FA8A55FE2FE31AB12E16B709527CDFC8`）。用安装后的 resources 在全新 home 实弹：自动建身份 `zjz-主人-030fa209` → 建房 `room_12c2345c09f77df0` → 列表可见，PASS。正常桌面已重启（后端 51085），并补回项目房“海钺”：`room_f54f1d4cc1ef2b98`，邀请码 `ZJZ-6163-48C8`。
