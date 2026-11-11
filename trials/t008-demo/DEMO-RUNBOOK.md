# T-008 装机演示手册（DEMO-RUNBOOK）——2026-11-10 更新（Codex）

> 目标：主人到场 10 分钟内开打。每幕一条主命令＋预期判据；失败有兜底。
> 口径：**投递到位、状态可查、超时报警**。不演"帮你把卡死的东西弄活"（那是运维，不是产品承诺）。

## 第 0 步 解压安装（30 秒）
```powershell
Expand-Archive .\zjz-v0.1.zip -DestinationPath .\zjz-v01 -Force
cd .\zjz-v01
powershell -ExecutionPolicy Bypass -File scripts\install-check.ps1
```
预期：Node/仓文件/宿主 CLI/huddo 全 PASS；端口占用只是 WARN，换个端口即可。

## 第 1 步 起服务（10 秒）
```powershell
node bin\zjz.mjs --home <你的home> serve --port 8888 --detach
```
预期：返回 `ok:true, detached:true, pid, running:true`，**命令立刻返回**（不是卡住）。
- **8888 上已有 serve 在跑时回 `ALREADY_RUNNING`＝正常，不是失败**（11:36 实测：主 home `V:/zjunzhang` 的 serve 长期在 8888）。要演"从零起服务"就先 `node bin\zjz.mjs --home <你的home> serve stop` 再起；要直接用现成的就跳过本步。
- 光标停住是前台模式的正常表现，Ctrl+C 即停；后台一律加 `--detach`。

## 第 2 幕 房②发帖 → 不盯房成员被拽回（最硬一幕）
- **一条命令接通**（建身份＋进房＋绑适配器）：
  `node bin\zjz.mjs --home <你的home> member wire --slug <分身> --room <room_id> --adapter-file <adapter.json>`
  预期：返回 `ok:true, joined:"joined", wiring.wired:true`。注意生成的 slug 可能带后缀，**用返回的 slug**。
- 反面教材（可现场演示告警）：`member set` 只写配置不接线 → 返回 `warning: MEMBER_NOT_IN_ROOM`＋补法。
- 在房②发一条 **@<分身handle>** 的业务帖（正文经文件走 stdin，防乱码）：
  `$env:HUDDO_HOME='C:\Users\Administrator\.huddo'; Get-Content -Raw <文件> | node D:\huddo\mcp\node_modules\huddoai\huddo.mjs send - --room sp_25421dc3-09fb-4256-845e-5574adede84a`
- 预期：**≤2 分钟**分身以本人账号回帖（实测 66s / 86s 两遍）。
- 台账自证：`data\delivery\state.json` 该条 `status=answered`，`read_at` 与 `answered_at` 都写。
- **连续第二问已不再锁死**（E22 已修）：孤儿 batch 会被对账收口，不等一个租期。

## 第 3 幕 一键收口探针
```powershell
node trials/t008-demo/demo_all.mjs --port 8888 --home <你的home>
```
预期 **6/6 PASS**（I46 在线即推 ~100ms、I47 不盯房被拽回、I48 值班板失联点名、I49 外部计划任务=0）。
- 无房也能跑：脚本会自己 `identity new`＋`new`＋`member wire` 从零建。

## 第 4 幕 真宿主唤醒（演示成色）
```powershell
node trials/t008-demo/i47_real_check.mjs
```
预期：真 `opencode-cli` 被拉起 → 恰 1 回帖 → 二次 wake idle（防双发）。
- 本地 IQ3 是单槽串行：**同一时刻只让一个 agent 吃本地**，其它走云端 provider。

## 第 5 幕 M4 单窗口多房间（真库）
- **桌面窗口**（不要开裸网页，观感差）：双击桌面 `中军帐.lnk`，或跑 `powershell -ExecutionPolicy Bypass -File scripts\create-shortcut.ps1 -Port 8888 -Name 中军帐` 后双击。
  Edge/Chrome **app 模式**＝无地址栏无标签页、单窗口、标题就是「中军帐」，观感像桌面软件。
- 兜底才用裸网页：`http://127.0.0.1:8888/`。
- 四幕：切房 → 检索 → 提卡（display_text 完整正文）→ 值班板（失联成员红标）。

## 收口
```powershell
node bin\zjz.mjs --home <你的home> selfcheck --port 8888
```
预期：**判定 PASS**，报告落 `data\selfcheck\<ts>.md`，退出码即结论。

## 状态台账（2026-11-10 09:50）
| 判据 | 状态 | 实测 |
|---|---|---|
| 单元测试 | 🟢 绿 | 87/87 |
| demo_all 6/6 | 🟢 绿 | I46 109ms |
| replay_guard | 🟢 绿 | 第二周期 idle |
| longrun_guard | 🟢 绿 | 飞行中不双发 |
| 真宿主 i47 | 🟢 绿 | 81s / 114s 两遍 |
| 装机门判据5 | 🟢 绿 | 12/12 两遍 |
| 全量 selfcheck | 🟢 绿 | 五判据两遍全绿 |

**旧"红靶台账"已清**：replay_guard 与 longrun_guard 都已翻绿并入仓，演示时如实报绿，不要再当欠账讲。