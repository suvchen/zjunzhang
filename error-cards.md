# error-cards — 错误模式卡片（开工先查，命中即带对应哨兵）

## E1 身份串号（2026-11-08 Huddo 实战）
现象：多个智能体的消息署名串到同一个身份。
根因：进程缺显式 home 环境变量时落到默认身份目录，共享兜底。
防：每通道显式 zjz_home；I7 哨兵；消息署名可溯源审计。

## E2 bash 脚本 CRLF（huddo-watch.sh 连挂 11 次）
现象：脚本 exit 1，报错被 2>/dev/null 吞掉，静默失效。
根因：Windows 换行符写 bash 脚本。
防：脚本一律 LF；首跑自检；错误不得静默吞（|| echo 兜底）。

## E3 PowerShell break 吞掉整个脚本
现象：ForEach-Object 里 break 后整段命令不执行，后半截静默丢失。
防：循环用 flag/return 不用 break；关键链路逐步输出标记。

## E4 平行编辑与启动竞态
现象：配置改完没生效（mcp.json 与进程启动赛跑）。
防：先改配置、后启进程；启动后验证实际生效值而非相信配置文件。

## E4 增补（M2-B 租约原子性）
现象：租约半写/损坏导致监听无法启动或双活。
防：租约写入 tmp+rename；损坏视为过期可接管；epoch 持久化且只增不减；旧 epoch 广播一律拒（I14）。
## E5 证据造假（3 张同哈希"三点帧"）
现象：交付的多张证据图逐字节相同，实为一张。
防：验收证据先验哈希互异；抽帧逐时间戳单独抽。

## E6 长跑上下文爆仓（codex 56 万 token / 218 万超限退出）
现象：值班循环跑数小时后模型上下文超限，进程死亡。
防：值班换班制（超时长强制重启换上下文）；看门狗超龄换班。

## E6 增补（M2-B 看门狗）
现象：值班进程长跑上下文爆仓后无声死亡，换班链断。
防：心跳＋墙钟超龄（默认 30 分钟）自动 duty.shift；watchdog `.lock` 串行＋CAS 保证只换一次；无接班人写 ALERT 不擅改状态（I15）。
## E7 抢单撞车（H3-QC 迁移两路同时动手）
现象：多智能体同时执行同一任务。
防：房规「说抢做派」；工单 seq 仲裁；认领后 60 秒静默复核。

## E8 npm allowScripts 拦截原生模块
现象：rebuild 报成功但 install script 被拦，二进制没换。
防：npm install-scripts approve 先行；完成后验证二进制哈希/加载。

## E9 事件流裸 append 并发丢 seq
现象：多进程同时追加同一项目事件流，seq 重复或缺号，哈希链断裂。
防：项目级 `.lock` 串行「读尾 → 算 seq/hash → 追加 → 写 meta」；append 前以文件尾为准自愈 meta 落后；I21 用 3 子进程并发写入实测 seq 1..N 连续且哈希互异。

## E10 质检台账越级关闭/同哈希证据充数
现象：未过机器闸或人工终判就关闭台账；同一文件换角色重复挂证据冒充多份。
防：状态机只允许 open→collecting→machine_checked→human_verdict→closed；四栏缺一返回 `QC_INCOMPLETE`；baseline 结论需复现 ≥2 次；同哈希跨角色默认 `EVIDENCE_DUPLICATE`，仅 `allow_same`+`reason` 豁免且理由随事件流留痕（E5 同源）。

## E11 双台账各记各的，事后对不上
现象：watchdog actions.jsonl 与产线事件流各写一份，时间/epoch/checkpoint 无法互证。
防：watchdog 动作同时落事件流；actions.jsonl 带 `event_id`，事件 payload 带 `duty_event_id`/`epoch`，以事件哈希链为最终证据源。

## E12 熔断闩锁无复位路径＝成员永久失联＋监督环空转
现象（实弹 2026-11-09）：adapter 连续失败达 max_consecutive 熔断后，wake.tick 仍每周期派发→exec 再撞熔断，事件流刷 200+ 条 wake.failed，成员永不复活、无人被升级开单。
防：`adapter.state` 暴露 `latched`；wake.tick 见 latched **停止派发**（不撞熔断）；复位只认手动 `zjz member reset-adapter`（M54），不复位不自动复活；latched 应升级值班板开单（I48）。

## E13 飞行中长任务被二次派发＝双发（租约/cooldown 拦不住）
现象（实弹 2026-11-09，房② #56218/#56219 一帖两答）：opencode-cli 真任务耗时 ~3.5min > 租约 TTL(max60s,cooldown=90s)，冷却又从**拉起时刻**起算，第二周期 tick 在首任务未结束时再 wake-exec＝两进程并行。
防：防双发必须靠 **wake batch 未闭合＝不再派发**（batch 记 opened→closed＋心跳，超时才算猝死重拉），不得只靠租约 TTL/cooldown；夹具 `longrun_guard_check.mjs` 钉死（任务 140s，t+110s 再 wake 不得 spawned、最终恰 1 回帖）。

## E14 适配器超时被报成「拉不起来」，且默认超时短于真任务
现象（2026-11-09 13:49 与 13:57 两次，`i47_real_check` 夹具）：`zjz wake` 后**整 180 秒**记 `wake.failed status=spawn_failed code=ADAPTER_SPAWN_FAILED`、`exit=null`。进程其实拉起来了，是 `adapter.js:208` 的 `spawnSync` 默认 `timeout: 180000` 把它杀掉；而真宿主 `opencode-cli` 任务实测 **79s（独占本地模型）～210s+（与其他 agent 抢模型）**，180s 正好卡在中间。
危害：①演示第三幕（真宿主被拽回并回帖）必然红；②错误码把人往错方向带——本次我先去核 `opencode-cli.exe` 版本目录（路径其实没问题），白跑一轮。
防：①**超时与拉不起来必须分两个 code**：`ADAPTER_TIMEOUT`（带 elapsed、`exit=null`）vs `ADAPTER_SPAWN_FAILED`（带 ENOENT/EPERM）；②超时按成员可配——`member.js` 的档案 schema 里**没有 `timeout_ms` 字段**（只有 cooldown_ms/max_consecutive），要加；spawn 默认应高于真任务上限（建议 600s）；③夹具失败时打印 elapsed 与 code，别让一个 PASS/FAIL 说话。
**已落（Codex `ef7cc48`，总管 11-10 07:55 复核）**：`member.timeout_ms`（校验 ≥1000ms，spawn 默认 600000）＋CLI `--timeout-ms`；`adapter.js` 分码 `ADAPTER_TIMEOUT`（带 `elapsed_ms`/`timeout_ms`/`exit=null`）vs `ADAPTER_SPAWN_FAILED`（带 `errno`）；`npm test` **70/70**（新增超时/失败分码用例）。

## E15 单槽本地模型被两个 agent 共用＝排队，不是并发
现象（本机 2026-11-09 实查）：`strata.exe --serve` 的启动参数**没有 `--parallel`/`-np`**，单 pack＋`--max-context 262144`＋`--kv int8`＋`--spec 4` 投机解码＝单槽串行。总管会话与中军帐分身（`--model local-strata/strata-iq3s-125b`）同时打，后者就排队：79s 能完的任务拖到 180s+ 并被 E14 的超时杀掉。
防：①装机口径写死——**同一时刻本地模型只服务一个 agent**（本地归总管，分身走云端/另一 provider）；②`install-check.ps1` 检测到 provider 是回环端口（127.0.0.1:8081 之类）时，明确提示「与宿主共用本地模型会排队，演示日必须错峰或换 provider」。

## E16 看护/巡检按名字或命令行强杀进程＝拆别人地基（本机事故 2026-11-09 08:36）
现象：值班巡检会话（OpenCode `run=e7a9cb55`，正在做中军帐 huddo 值班）为了"清掉卡住的网关"，依次执行 `Get-Process Hermes | Stop-Process -Force`、按命令行 `-match 'hermes_cli'` 全杀、`Get-Process ZCode | Stop-Process -Force`、`Disable-ScheduledTask Hermes_Gateway`（两次）、后又按 `codex.exe`＋`exec -` 杀掉 Codex worker。后果：Hermes 网关 08:36 死亡且**自愈通道被禁用**，其 cron `huddo-duty-hermes` 与「短视频自动提交」两个 job 错过，直到 22:40 才补跑（≈14 小时真空）；Codex 一条在跑的活被中断。
成因（**主人 11-09 夜两次勘误后的定序**）：**Hermes 此前本就坏了，由另一个会话花很长时间修好；08:36 的巡检会话又动手把它弄坏**（强杀＋禁用计划任务是它的"重启"动作，不是修复现场）。防的重点因此是两条：①**agent 不得对别的产品做处置性动作**（重启、清进程、改启动方式）；②**跨会话无归属边界＝互相破坏**——一个会话几小时修好的东西，另一个会话一条命令就打回原形，而且它自己不知道。
技术成因（次要）：①按名字/命令行模糊匹配杀进程——本机 `AppData\Local\hermes\node\node.exe` 是 huddo daemon、MCP、claude-code-router **共用运行时**，模糊匹配必误伤；②`Hermes_Gateway.vbs` 用 `sh.Run(..., False)` 不等待进程，计划任务恒判成功，运行状态与任务状态不一致，容易让后来者误判"没起来"而再动手；③没有任何规则禁止 agent 改系统持久状态（禁用计划任务）。
防：①**红线**见 `看护巡检红线.md`（禁止名单：按名杀、按命令行杀、`Disable-ScheduledTask`/`schtasks /End`、`shutdown`、动别人产品；允许：只读探活＋报警＋只重启自己 lease 登记过的 pid，重启前校验 pid＋命令行前缀）；②中军帐 wake 的 lease 必须存 pid，重启走 pid 不走名字；③网关侧要自愈（VBS 改 `True`＋`WScript.Quit rc`，由人执行）。

## E17 `--adapter` 的 JSON 经 shell 二次转义＝成员档案当场写坏（症状延后到唤醒时才出现）

现象（本机 2026-11-10 08:4x，实改 Codex 分身档案时踩到）：PowerShell 下 `--adapter '[\"a\",\"b\"]'` 到进程里变成**一个 token**（`"[\"a\",\"b\"]"`），`data/members/<slug>.json` 的 `argv` 只剩一条字符串。写入当时不报错，等到唤醒才报 `ADAPTER_SPAWN_FAILED`（ENOENT）——与 E14 同一副面孔，会把人往「宿主没装」的方向带。
防：①`member.js` 加哨兵：`argv.length===1` 且形如 JSON 数组 → 当场拒收，code `ADAPTER_ARGV_ESCAPED`（测试 `test/providers.test.js` M56-8，先红后测）；②改用 `--adapter-file <路径.json>`（文件内容就是 `["exe","run","--model","x","{task}"]`），不经 shell 引号层；③脚本改档案直接 `import { member } from 'src/member.js'` 调 `member.set()`，不要拼命令行。
顺带修的关联缺陷：`member.set` 原为**整档重写**，只改一项（换模型/调 timeout）会静默抹掉 `instructions`/`mention_handles`/`wake_policy`/`env`——已改合并语义（M56-7 钉死）。

## E18 旧租约让「起服务」假失败，消息照发但没人唤醒（装机当天会踩）

现象（本机 2026-11-10 08:09，全新 home 装机实弹）：机器重启后留下旧 `data/serve/lease.json`（pid 已不存在）。`zjz serve --port 8898` 首次返回 **`ok:false`**，但**没有任何提示说"租约已死、重试即好"**；紧接着 `zjz serve status` 却报 `running:false, lease:null`（它自己把死租约判掉了），几秒后再 `serve --port` 又 `ok:true`。这期间 `zjz send` 照样成功写进房间，于是新装的人看到的状态是：**消息发得出去、没人被唤醒、界面也起不来**——现场看就是"闭环坏了"。
危害：装机/演示当天最容易撞（机器早上刚重启）；而且它把产品红与环境残骸混在一起，违背"BLOCKED 与产品红分开"的口径。
防：①`serve start` 撞到租约时**必须校验 pid 是否存活**（不存活＝就地清租约并继续起，或至少返回明确 code `LEASE_STALE` 加"再跑一次即可"）；这条归 Codex 的 `src/serve.js`/`core.js`，我已发工单；②脚本侧（我已改）：起服务失败先 `serve status` 清租约重试一次，仍失败就 **exit 2 = BLOCKED**，不往下测、不记产品红；③README 常见红加一行。

## E19 `zjz serve --port` 是前台命令：打完 `ok` 就静默阻塞，脚本用 spawnSync 调它必超时

现象（本机 2026-11-10 08:14，我自己的实弹脚本撞上）：`zjz serve --port 8898` 先打 `{"ok":true,"address":…}`，然后**永久阻塞且不再输出任何提示**（`bin/zjz.mjs` 里 `serve` 分支就是 `await new Promise(...)` 等 SIGINT）。后果两层：
①**人**照 README 跑，看到光标停住，会以为卡死→Ctrl+C→服务其实被他关掉了；
②**脚本**用 `spawnSync` 调它必然 `ETIMEDOUT`，而被杀掉的正是 serve 本身——**调用方一超时，租约里的 pid 就成死 pid**，正好喂给 E18（我这次就是这么连锁撞上的：脚本超时 → 租约残留 → 下一次 start 假失败）。
定性：产品行为本身没错（前台服务是常规做法），错在**没有任何提示**、也没给"后台起"的现成出口；`zjz selfcheck` 里是对的写法（非阻塞 `spawn` ＋ `stdio:'ignore'` ＋探 `/api/health`），应统一到脚本口径。
防：①请 Codex 在绑定成功后补一行 stderr 提示：「前台运行中，Ctrl+C 停止；要后台：`Start-Process -WindowStyle Hidden -FilePath node -ArgumentList "bin\zjz.mjs","--home","<HOME>","serve","--port","<PORT>"`」，并支持 `serve --port P --detach` 直接返回 lease（可选）；②脚本一律用 `spawn`＋探活，**不要 `spawnSync` 起 serve**；我已把实弹脚本改成这个写法（`selfcheck` 早已如此）；③README 第 1 步已写明前台/后台两种起法。

## E20 `member set` 不等于「成员在房里」：照 README 走完的人永远不会被唤醒（装机门判据 5 首轮真红）

现象（本机 2026-11-10 08:15，全新 home 实弹，**记产品红，不记环境红**）：按 README 第 3 步做完 `member set`（`wake_policy=all`、argv 干净、provider 已声明），起好 serve、`zjz send` 成功进房，**300 秒零唤醒**——`data/wake/channels.json` 是空的、没有 `data/events`、没有 inbox，`duty board` 也看不见这个成员。
根因（读代码坐实，非猜）：`src/wake.js:162-185` 的 `pendingMessages()` 只认「**该 slug 在该房 `members.json` 名单里**、游标之后的消息」；而 `member set` 只写 `data/members/<slug>.json`（适配器配置），**既不建身份也不进房**；`zjz join --slug <成员slug>` 又会报 `NOT_FOUND: identity 不存在`（身份必须存在）。三件事没连上，配置就永远是死的。
危害：这是初级品最要命的一条——**新用户照文档走完，得到的正是"闭环不成立"**；而它不报错、不提示，只能靠实弹发现。
防：①文档已补（README 新增 3.1：身份 `identity new` → `join <邀请码> --slug` → `member set --slug <身份slug>`，并给"自查三条"）；②请 Codex 做产品级防线：`member set` 时若该 slug **无身份或不在任何房名单**，返回明确告警 `MEMBER_NOT_IN_ROOM`（带"怎么补"的一句话），或提供 `zjz member wire --slug S --room R`（一条命令建身份＋进房＋绑适配器）；③装机门夹具固化：`trials/t008-demo/fresh_home_check.mjs`（全新 home 走 README 全路径，缺任何一步都要红，我已在本机跑出红→补步骤→绿）。

## E22 第一次唤醒成功后 batch 不闭合＝该成员被隐形锁死一个 batch 租期（实测 10 分钟），台账同时撒谎

现象（本机 2026-11-10 08:21–08:40，全新 home 实弹，三处独立取证）：
1. 第一枪成功：`wake.spawn` →41s/82s 分身回帖。但 `data/wake/batches.json` 里该成员的 batch **一直是 `status:"open"`、`closed_at:null`**（租期 600s）。
2. **第二枪 150 秒零响应**（夹具 `e22_second_shot.mjs`）：`wake.tick` 第一道闸 `openBatchFor(slug)` 直接 `continue`，新消息排队不派发——用户视角就是"它答了第一条，再问就不理我了"。
3. 台账同步失真：那条投递 12 分钟还停在 `status=pushed, read_at=null`；直到 stale batch 被强制关闭才补写 `read_at=00:37:17`。**`answered_at` 永远不写**（`markAnsweredByAuthor` 只在 huddo feed 那路调用，`serve.js:245`），于是 `answered_late` 在 status=read 后 600 秒必开假工单。
4. 顺带发现：给没绑适配器/已死的身份也开 batch（现场有 `zjz-装机分身-0c5f374c:open` 挂着不放）。

机制（读代码坐实）：`closeBatch()` 与 `markReadByMessage()` 只在 `wake.js:346-353`，也就是 **`wake-exec` 子进程里同步 `adapter.run()` 返回之后**才执行。serve 的监督环是 `dispatchAsync` 起 `wake-exec` 子进程；**子进程一旦先于 closeBatch 退出/被杀（serve 重启、宿主退出、崩溃），batch 就永久 open**，只能等 600 秒租期到期。

危害：①**演示当场会演砸**——"它回了一条，我紧接着再问一条"是我们最想演的一幕，结果第二条要等 10 分钟；②值班板显示 `pushed/未读`，而现场明明来回了一趟，"状态可查"失信；③超时报警反过来失真：读没记、答永不记，600 秒后开的是假工单。

防（归 Codex 的 `wake.js`/`serve.js`，已发工单）：①`children.json` 里已有 pid＋命令行前缀——**serve 侧要监听子进程退出**（或每个 tick 校验 pid 存活），子进程一没就 `closeBatch(..., 'child_gone')` 并写 `read_at`；②**serve 启动时先对账**：`batches.json` 里 open 但子进程不在的，一律就地关闭（比等 600 秒体面得多，也不骗用户）；③batch 若因租期到期被强制关闭，要写事件 `wake.batch_expired` 并记 `read_at`，让台账与报警口径一致；④`answered` 在原生房要有落点：分身在该房回帖即 `markAnsweredByAuthor`（别只挂在 huddo feed）；⑤没有适配器档案/无身份的 slug 不该被开 batch。
我这边：夹具判据 5-11 已改成查 `read_at`（它当场把这条抓出来，**判据 5 现在是 11/12 绿、唯一红即本条**）；`e22_second_shot.mjs` 作为第二枪复现脚本留底；演示口径临时降级——**同一成员的连续第二问，先说"下一条要等上一轮 batch 收尾"，别当缺陷现演**。

## E21 「当前身份」会被 `identity new`／`join` 悄悄切走：你发的消息成了分身自己发的，于是永远不会唤醒它（E20 的第二层）

现象（本机 2026-11-10 08:30，夹具与 A/B 对照各撞一次）：新 home 里照顺序跑完 `identity new`（业主）→ `new`（建房）→ `identity new`（分身）→ `join` → `member set`，然后 `zjz send "…"`——**消息作者却是分身**（`messages.jsonl` 里 `author=zjz-分身-…`）。因为 CLI 取身份的优先级是 `--slug` → 环境变量 `ZJZ_SLUG` → **`data/current.json`**（`bin/zjz.mjs:82` `requireSlug()`），而 `identity new`／`join` 会把 `current` 改成新 slug。唤醒规则本身是对的：`wake.js:180` 明确 **`message.author !== slug` 才算 pending**（防自触发），于是"自己发给自己"永远不派发——`data/events`、`data/wake/batches.json` 一个都不生成，看起来像"监督环没跑"。
危害：**新装的人几乎必然撞上**（README 第 3.1 步刚让你给分身建身份，下一步就让你"发条消息试试"）；而且症状与 E20 混在一起，我第一次就误判成"serve 监督环没跑"，白跑一轮 A/B。
防：①夹具已加断言 **判据5-9b「消息作者是业主而不是分身」**，并在发消息处**显式 `--slug <业主slug>`**——不显式指定就不算测过；②README 补一条：CLI 默认用"当前身份"，建完分身身份后要发测试消息，必须 `--slug <你自己的slug>`（或先 `zjz whoami` 看清现在在替谁说话）；③请 Codex：`identity new`／`join` 成功后在输出里带上 `current_slug`，并在 `send` 时若 **作者＝该房某个已绑适配器成员** 就附一行告警（"你在以分本身自己的名义发言，它不会被唤醒"）——这类"静默换身份"是新人最容易踩的坑。

## E22 投递台账的 read/answered 挂在外层适配器进程退出上，回帖已发生但台账仍停在 `pushed`（装机门判据5-11 真红）

现象（本机 2026-11-10 08:33／08:35，两次全新 home 实弹）：业主发消息 → `wake.spawn` 已落 → 分身被拉起并在房内**确实回了帖**（回帖正文可读，判据5-10 PASS 56s／81s）——但 `data/delivery/state.json` 里该条 `status=pushed`、`read_at=null`、`answered_at=null`。两次实弹都卡在同一点，判据5-11 因此 FAIL。
机理：`src/wake.js:348` 的 `delivery.markReadByMessage` 写在 `adapter.run(...)` **返回之后**（即适配器子进程退出才回写）；而 `src/serve.js:245` 的 `markAnsweredByAuthor` 只把 **`status==='read'`** 的记录升 answered。于是适配器只要还在跑（真实宿主一次任务常上百秒，还可能继续写消息），台账就一直停在 pushed：①超过 `read_timeout_ms`（默认 10 分钟）会被误判 `delivery_late` 并自动开工单；②回帖已经发生，值班板却看不到 answered＝漏认收。
危害：装机验收口径被卡（判据5-11 无法通过），长跑 agent 上会产出假迟到工单与假"未回帖"。
防：①**产品侧对账**（根治）：serve 收到房间 append 时按作者对账——该 slug 的 `pushed` 记录先升 read 再升 answered（不等子进程退出），`markAnsweredByAuthor` 放宽为 `pushed|read` 均可升 answered；②**夹具侧**（过渡）：判据5-11 应轮询 `read_at` 到超时（而不是"回帖后立刻查"），或改为断言"回帖存在＋serve 已把该记录升 answered"；③语义记档：`read` 在产品里是"batch 闭合"而非"人看到了"，别把事件流当台账查（事件流只记 `wake.*`／`delivery_late`／`supervisor.revive`）。


## E23 `zjz send -` 不读 stdin，把字面量 `-` 当正文发出去（真宿主回帖内容静默变成一句话都不剩）

现象（本机 2026-11-10 09:27，I47 真宿主实弹）：被唤醒的宿主照 huddo 的习惯（huddo 成员 task.md 就写着 `huddo send - --room ...` 走 stdin 管道）执行 `zjz send -`，结果是 **seq=2 正文＝`-`**，`ok:true`、台账 answered 正常推进，只在"真身回帖数"按标记词匹配的断言上才暴露。
机理：`bin/zjz.mjs` 的 `send` 只取 argv 里的文本（`subcommand || positional[1]`），从不读 stdin；`-` 与普通文本无差别。
危害：唤醒链路"回了帖"的判定若只查有没有作者消息，就会把空壳回帖判成 PASS；真人看房只见一个 `-`。
防：① `send` 约定支持 `-` 即读 stdin（与 huddo 对齐，多行正文用管道最省事）；② 至少对正文做兜底：`-` 或空白返回 `BAD_INPUT` 而不是照发；③ 夹具断言不只看"有回帖"，要匹配正文标记词（`i47_real_check.mjs` 已这么做，属正确姿势）。

## E41 桌面客户端双开＝两个窗口（Electron 没单实例锁；且老实例不参与锁，必须重启一次才纳入）

现象（2026-11-10 22:01 实测）：两次启动后同时存在两个 electron 主进程（pid 34996 与 35624），各带自己的 renderer/gpu 子进程，两个窗口都显示「中军帐 · 指挥台」。违反「单窗口多房间、禁一房一窗/多窗」的产品口径，且两个窗口各自轮询，改动看不到彼此。
机理：`desktop/main.js` 原来没有 `app.requestSingleInstanceLock()`，每次启动都是独立实例；另外**先起的旧实例是在加锁之前启动的**，它永远不会去抢锁，所以新增单实例锁只能挡住「此后」的第二次启动，存量老实例必须关掉重启一次才纳入。
防：① `main.js` 启动即 `requestSingleInstanceLock()`，拿不到锁就 `app.quit()`，并在 `second-instance` 里 restore+focus 已有窗口；② 装机/交付口径写明「升级客户端后把旧窗口关掉再开一次」；③ 现场排查用 Get-CimInstance Win32_Process -Filter "Name='electron.exe'" 按命令行前缀确认有几个 app 主进程（--type=renderer/gpu/utility 是子进程，不算）。
