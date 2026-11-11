# T-007-F 验收单 · I38 候选闸门收紧 ＋ I39 检索命中清洗（总管起草 2026-11-09）

> 两条都来自真实语料实跑暴露的缺陷（房② #55102），验收数据＝`trials/huddo-real-20261109/`（318 条真实 Huddo 交流，`node fetch_huddo.mjs && node import_huddo.mjs` 可重建）。

## I38 候选闸门收紧
**现象**：318 条真实交流，`skill.candidates` 扫出 214 条候选（68%）——「收到/确认/PASS」这类词在日常应答里到处都是，候选＝没筛。

**判据（红测先行）**：
1. 真实语料（重建后跑 `skill.candidates(HOME,{})`）：`total / 语料条数 ≤ 0.20`。
2. 纯应答消息（「收到」「确认」「好的」单独成句）不得成为候选。
3. 收紧后**不得误杀**：语料里人工可指的至少 2 条真经验（例：trigram 二字词零命中的实测帖、CCR 保活 session=0 的验收帖）必须仍在候选列。
4. 抽 5 条候选人工判定确为经验（总管做，结果记本文件）。
**实现口径建议**（不强制）：信号词分两类——验证类（实测/验证/复现/红测/对账/intact）与结果类（全绿/PASS/通过/修复完成/召回 100%），**须同时命中两类**或命中单类＋可核验形态（数字＋单位 / 文件路径 / 消息引用）；纯应答词进黑名单。

## I39 检索命中清洗
**现象**：导入消息命中显示 `[huddo:msg_xxx] 正文`，人读着脏，也暴露 `ext_id` 不可见。

**判据（红测先行）**：
1. `search.query` 命中新增 `display_text`：对导入消息＝`stripHeader(text)`；普通消息＝原文。**`text` 字段必须保持原样**（哈希/对账口径不动，I23/I37 不破）。
2. 命中新增 `ext_id`（可空）：经 `data/ingest/<房>.jsonl` 反查；断言该 `ext_id` 能被 `ingest.lookup` 解回同一条消息（往返一致）。
3. CLI `zjz search`／MCP `zjz_search` 默认展示 `display_text`；`skill.get` 已剥头的行为不回退。
4. 性能不回退：318 条真实语料 p95 ≤ 50ms（当前 2–4ms，余量大）。
**实现提醒**：`ext_id` 反查别逐命中全库扫——建 `msg_id → ext_id` 内存映射一次（或索引列），照 Codex 在 skill.audit 用 `listDocs` 的枚举套路。

## 门（不变）
`npm test` 全量绿＋`test/smoke.mjs`＋`test/mcp.smoke.mjs` ALL GREEN＋真实语料复跑数字回写本文件与 PROGRESS.md。一组一提交。

## 验收记录（总管本机实跑后填）
- [x] I38 占比 ≤20%：实际 **43/318＝13.52%**（严格闸门：验证类＋结果类＋可核验证据三者同时命中；纯应答黑名单）
- [x] I38 不误杀：**2 条指定真经验**仍在列（trigram 二字词零命中实测帖、session=0 无窗验收帖）
- [x] I38 抽 5 人工判定（总管 11-09 逐条读原文）：**2/5 为可复用经验**（`msg_fb9173f8` 检索交接含两层召回方法与实测结论；`msg_2578f519` M1 验收含「先红后绿＋不采信自述」方法论），**3/5 为带可核验事实的过程记录**（`msg_88e0baad` 交付摘要、`msg_cc037eda` 验收帖、`msg_1ea8ef5d` 转绿汇报）。**判定 PASS**：候选≠入库，认可门握终审权，闸门职责是降噪不是终审；改进建议（不阻塞、进下轮）——候选分类「经验/决议/过程」并对批复与交付摘要类降权。
- [x] I39 display_text/ext_id 断言绿，I23/I37 不破
- [x] 性能 p95 **10.156ms**（5 查询×20 轮）

实现记录（Codex 2026-11-09）：`search.query` 每次查询只构建一次 `msg_id→ext_id` 映射；`text` 保留导入头原样，`display_text` 剥头，`ext_id` 可经 `ingest.lookup` 往返到同一 `msg_id`。CLI/MCP 透传两个字段并已钉 smoke。

## 总管独立复核（2026-11-09，非转述，脚本独立重跑）
- 门：`npm test` **42/42**；`smoke`/`mcp.smoke` ALL GREEN（51 工具）；`test/red/i38-i39.red.test.mjs` **2/2**。
- I38：候选 **43/318＝13.52%**（与 Codex 报数一致）；纯应答混入 **0**；两条指定真经验（trigram、session=0）**都在列**。
- I39：真实语料命中 `text` 保留导入头、`display_text` 已剥头、`ext_id` 经 `ingest.lookup` **往返解回同条消息**；普通消息 `display_text===text` 违例 **0**；`search.audit intact=true 318/318`、`ingest.audit intact=true`（I23/I37 不破）。性能总管侧 p95 **3.20ms**（Codex 10.156ms，双双达标）。
- nit①：缺参 message 已含完整用法行（含 `--name/--probe-file/--revive-file`）。nit③：**原失败场景复刻**（cwd 在系统 Temp 跑 `zjz resume`）→ `ok=true`，摘要 2616 字。nit②：I29「先取房间锁再读游标」因果已见 PROGRESS。
- **结论：T-007-F（I38/I39＋三 nit）验收 PASS。** 下一批＝M4（`T-005-m4-spec.md`，I40–I44 先红后绿）。
