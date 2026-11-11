# M3 开工方案（质检台账 + 产线事件流）

> 状态：待总管批。批复前只写测试与文档，不动业务码。
> 基线：M2-B 已验收，`npm test` 21/21 绿（2026-11-08）。
> 需求样本：`E:\h3-qc\README.md` 四栏对照/台账字段、`cases.csv`、留档命名 `*_fixed` / `*_BAD_证据`；产品通用化，不绑死 H3。

## 一、范围边界

### 做（M3）
1. **质检台账**：一个案例一份记录，四栏（现象 / 归因层 / 改法 / 复现值）为关闭闸门；证据留档带 SHA256；机器判定与人工终判分离；可输出一行摘要。
2. **留档钩子**：`qc.attach` 注册证据文件（哈希/字节/角色/备注），重复哈希告警（E5），`qc.verify` 复核文件未变；工单交付可挂 `qc_case_id`。
3. **机器判定接口**：按案例注册 gate，机器逐 gate 写 `pass|fail|insufficient` + metrics + checker；聚合判定不能冒充人工终判。
4. **产线事件流**：每项目一条 append-only 事件流（seq 连续 + 哈希链），工单/换班/质检关键动作自动落事件；可按 seq 拉取与全链校验。

### 不做（后续）
- 不做 Web UI/跨机器（M4）、不做事件压缩/归档轮转、不做外部数据库。
- 不绑死视频：evidence 角色、gate 名、metrics 都是通用字段；H3 只作样本。
- 不自动判审美：人工终判必须由人写，机器只给机器结论。

## 二、数据布局

```
data/
  qc/
    cases/<case_id>.json      # 案例：四栏、状态、证据[]、machine_checks[]、human_verdict
    cases.lock                # 案例写入串行
  events/
    <project_hash>.jsonl      # 每项目一条事件流（每行带 project 原名，读取时校验）
    <project_hash>.lock
```

### 案例字段（通用）
`case_id, project, title, status, variable_layer, baseline_ref, gates[], evidence[], machine_checks[], human_verdict, phenomenon, attribution_layer, fix, repro_count, repro_note, conclusion, owner, created_at, updated_at`

- duty 记录增补可选 `project`（默认 `default`），换班事件落到同项目流。

- 状态机：`open → collecting → machine_checked → human_verdict → closed`；非法跃迁 `BAD_STATE`。
- 证据角色：`baseline|candidate|fixed|bad|request|prompt|ref|other`。
- 机器结果：`pass|fail|insufficient`；聚合规则：任一 fail→fail；有缺 gate/insufficient→insufficient；全 pass→pass。
- 关闭闸门：四栏齐全；`conclusion=baseline` 时 `repro_count>=2`，否则 `QC_NOT_REPRODUCED`。

### 事件字段
`seq, at, project, type, actor, subject, payload, prev_hash, hash`

- `seq` 每项目从 1 连续递增（`.lock` 串行）。
- `hash = sha256(prev_hash + canonical(seq|at|project|type|actor|subject|payload))`；首条 `prev_hash="genesis"`。
- 类型：`order.dispatch/claim/deliver/accept/reject/close`、`duty.shift`、`qc.open/attach/machine/human/close`。
- `event.verify` 重算全链；断链/篡改返回 `EVENT_CHAIN_BROKEN`。文件按 project hash 隔离，读取时校验首行 project，防跨项目串流。

## 三、接口

### 质检（src/qc.js）
- `qc.open(home, slug, {project, title, case_id?, variable_layer?, baseline_ref?, gates?})`
- `qc.get / qc.list(home, {project?, status?})`
- `qc.attach(home, slug, case_id, {path, role, note?})` → 哈希/字节/角色；同 hash 不同角色 → `EVIDENCE_DUPLICATE`
- `qc.verify(home, case_id)` → 逐证据复核存在性/哈希/大小
- `qc.machine(home, slug, case_id, {gate, result, metrics?, checker?, independent?})`
- `qc.human(home, slug, case_id, {verdict, note?})`（仅人工通道）
- `qc.close(home, slug, case_id, {phenomenon, attribution_layer, fix, repro_count, repro_note?, conclusion})`
- `qc.summary(home, case_id)` → `现象→归因层→改法→复现值` 一行

### 事件（src/events.js）
- `event.append(home, {project, type, actor, subject?, payload?})`（内部 API，供 core/qc 调用）
- `event.list(home, {project, after?, limit?})`
- `event.verify(home, project)`
- `event.projects(home)` → 事件流索引（hash→project/条数/最后 seq）
- `event.file(home, project)` → 事件文件绝对路径（测试/运维只读定位）

## 四、哨兵清单（先红后绿，编号自 I18 续）

| 编号 | 断言 | 红测要点 |
|---|---|---|
| I18 | 台账状态机与四栏关闭闸门：非法跃迁拒绝；四栏缺失/复现不足不得 close | open 直接 close → BAD_STATE；缺 fix → QC_INCOMPLETE；baseline 且 repro=1 → QC_NOT_REPRODUCED |
| I19 | 证据留档防伪：attach 哈希互异；跨角色同哈希拒；verify 抓篡改/缺失；同文件重挂幂等 | 两角色挂同一文件 → EVIDENCE_DUPLICATE；改一字节 → EVIDENCE_MISMATCH |
| I20 | 机器判定接口：gate 必须注册；结果枚举合法；机器历史追加不可覆盖；聚合 insufficient 不冒充 pass；人工终判独立 | 未注册 gate → BAD_GATE；缺 gate 聚合 → insufficient；machine 写 human 字段被拒 |
| I21 | 事件流完整性：并发 append 下 seq 无洞无重；哈希链可验；篡改可发现；跨项目隔离；无更新/删除接口 | 10 并发 append → seq=1..10；改一行 → EVENT_CHAIN_BROKEN；A 项目事件不出现在 B |
| I22 | 业务动作落事件：order 五次跃迁、duty.shift、qc 五次动作各产生恰好一条事件，payload 可回放 | 计数/类型/subject 对账；缺事件即红 |

## 五、提交切分（一次一模块）

1. `test(m3): I18-I22 红测 + M3 开工方案`（只测试/文档，先红）
2. `feat(events): 项目级 append-only 哈希链事件流`（src/events.js）
3. `feat(qc): 台账状态机/证据哈希钩子/机器判定`（src/qc.js）
4. `feat(integration): order/duty/qc 关键动作落事件`（core.js + qc 接线）
5. `feat(cli,mcp): qc/event CLI 与 MCP 工具 + smoke`
6. `trial+docs: M3 狗粮记录、SPEC/PROGRESS/error-cards`

每步 `npm test` 全绿（当前 21/21，终局 ≥26/26）；新哨兵先单独跑红。

## 六、风险与对策

- **事件与业务状态双写不一致** → 先做业务校验，再 append；append 失败返回 `EVENT_APPEND_FAILED` 并在结果里带 `event_error`，不静默吞（E3 同类）。
- **并发 append 抢 seq** → 项目级 `.lock` 串行，I21 并发测试。
- **证据哈希重复（E5）** → attach 时跨角色拒；同角色重挂幂等；verify 随时复核。
- **项目名路径穿越** → 文件名用 `sha256(project)`，每行存原名并在读取时校验。
- **机器判定被当人工终判** → 两套字段、两套 API；I20 断言 machine 不能写 human。
- **大文件哈希耗时** → 流式 sha256，不整文件读入内存。

## 七、验收口径

- `npm test` ≥26/26 绿（原 21 + 新 5）。
- 狗粮：开案例 → 挂 baseline/candidate 证据 → 两条机器 gate → 人工终判 → 四栏关闭 → 事件流 verify；全程一条命令可复跑。
- 输出一行摘要：现象→归因层→改法→复现值；异常 0。
