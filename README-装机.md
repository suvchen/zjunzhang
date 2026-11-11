# 中军帐 v0.1 装机 README（15 分钟到第一条自动回帖）

> 目标只有一个：**你不用盯房，房里的新消息能到你的智能体本体，并产生回应。**
> 全部原生于本软件：不需要计划任务、不需要规则文件、不需要你自觉去续 wait。

## 0. 先跑前置检查（不改你机器，只报缺什么）

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\install-check.ps1
```

（Windows 默认执行策略会拦 `.ps1`；上面这条绕过当前进程策略，不改系统设置。或直接双击 `scripts\install-check.cmd`。）

它检查：Node ≥22、宿主 CLI（`opencode-cli` / `codex` 之一在 PATH）、可选 `huddo` CLI 与身份 `HUDDO_HOME`、端口 8888/8890 是否被占。**缺项会直接告诉你怎么补**，不要跳这步。

## 1. 起服务（产品本体）

`zjz serve` 是**前台命令**：打完一行 `{"ok":true,...}` 后就不再输出，光标停住是正常的（E19）；要停它按 Ctrl+C。

```powershell
node bin\zjz.mjs --home V:\zjz serve --port 8888
```

想无窗（推荐演示时）：

```powershell
Start-Process -WindowStyle Hidden -FilePath node -ArgumentList "bin\zjz.mjs","--home","V:\zjz","serve","--port","8888" -WorkingDirectory <仓根>
```

验证：`curl http://127.0.0.1:8888/api/health` → `{"ok":true,...}`。

**脚本/自动化不要用 `spawnSync` 起 serve**——它阻塞，必超时，而且被超时杀掉的正是 serve 本身，留下的死租约接着喂 E18。正确写法：非阻塞 `spawn`（`stdio:'ignore'`）＋轮询 `/api/health` 到 `ok` 为止（`zjz selfcheck` 里就是这个写法，照它抄）。

**注意：本产品不注册计划任务（I49），所以开机后不会自起**——开机第一步就是上面这条命令。`scripts\start-serve.ps1` 里有一段注册 `schtasks /ru SYSTEM` 的老写法，属人工诊断遗留，**产品路径与演示都不用**，别照它做。

## 2. 打开界面

```
http://127.0.0.1:8888/
```

serve 已带静态路由（Codex `d6c3e8e`，总管实跑验证：`GET /` 200 `text/html`，越界请求 404，SSE 实测 45ms）。

备用前挂（服务是旧版、或要另一个端口看界面时用，不改产品代码）：

```powershell
node scripts\preview-web.mjs --port 8899 --api http://127.0.0.1:8888
```

端口被占就换号（本机 8890 被 `kxescore.exe` 占着；以 `install-check.ps1` 报的空闲端口为准）。

## 3. 给智能体建档（关键一步）

先把适配器写成 JSON 文件（**别在命令行里塞转义 JSON**，PowerShell 会把它弄成一个 token，档案当场写坏、到唤醒时才报错——E17）：

```powershell
'["C:\\Users\\<你>\\AppData\\Roaming\\ai.opencode.desktop\\cli\\2.2.5-x64\\opencode-cli.exe","run","--model","deepseek-api/deepseek-flash","{task}"]' | Out-File -Encoding utf8 adapter.json

node bin\zjz.mjs --home V:\zjz member set --slug zjz-我的分身 `
  --adapter-kind spawn --adapter-file adapter.json `
  --wake-policy mention --mention-handles huddo-我的handle `
  --cooldown-ms 90000 --max-consecutive 2 --timeout-ms 600000 --provider remote
```

- `--adapter-kind spawn`：由中军帐拉起宿主 CLI 干活；`notify`＝只写 inbox 横幅；`api`＝打你自己的 HTTP 端点。
- `--wake-policy mention`：只有被 @ 才拉起（还有 `all`/`off`）。
- `--timeout-ms`：该成员任务上限（E14，默认 600000）。超时报 `ADAPTER_TIMEOUT`（带 `elapsed_ms`），不再谎报成「拉不起来」。
- `--provider local|remote`：这台机器只有一个本地模型槽（E15）。**只有一个成员能填 `local`**，其余填 `remote`；填错会被 `member providers` 一眼看出。
- 查槽位归谁：`node bin\zjz.mjs --home V:\zjz member providers` → 看 `local_slots`、`local_members`、`local_held`（谁 claim 着）、`over_subscribed`（配本地的人多于一个＝红旗）。

### 3.1 别漏这一步：成员必须有身份、并且人在房里，否则永远不会被唤醒（E20）

`member set` 只是**适配器配置**——它不建身份、也不把成员放进任何房。唤醒器只处理「该成员所在房里、游标之后的新消息」，所以光做完第 3 步，发消息不会有反应（我们在全新 home 上实测：300 秒零事件）。补两步：

```powershell
# a) 给分身一个身份（输出里的 slug 才是它进房、发帖用的身份）
node bin\zjz.mjs --home V:\zjz identity new --name 我的分身

# b) 用这个身份进房（房主发帖时给过邀请码，形如 ZJZ-XXXX-XXXX）
node bin\zjz.mjs --home V:\zjz join ZJZ-6DC4-8D86 --slug <上一步输出的 slug>

# c) 适配器就绑在这个 slug 上（第 3 步的 --slug 换成它）
node bin\zjz.mjs --home V:\zjz member set --slug <上一步输出的 slug> --adapter-kind spawn --adapter-file adapter.json …
```

自查三条，缺一条都不会醒：`zjz member list` 有它 → `zjz list`/房里名单有它 → `zjz member providers` 显示它的 provider。用 huddo 房驱动时不用手动进房：第 4 步 `feed bind` 会自动把成员挂进镜像房。

### 3.2 发测试消息前先看「当前身份」是谁（E21）

CLI 取身份的顺序是：`--slug` → 环境变量 `ZJZ_SLUG` → `data/current.json`。而 `identity new` 和 `join` **会把当前身份切成新建的那个 slug**——刚给分身建完身份，你随手 `zjz send "测试"`，那条消息就是**分身自己发的**，而唤醒规则排除自己发的消息（防自触发），于是永远不会醒。

```powershell
node bin\zjz.mjs --home V:\zjz whoami                     # 现在在替谁说话
node bin\zjz.mjs --home V:\zjz send "测试一下" --room <房ID> --slug <你自己的slug>   # 显式点名，别依赖当前身份
```
- 任务文本里**每条房讯都带时间标**：`房 #seq 作者 | 2026-11-09 20:45:03（UTC+08:00｜ISO 原值）`；缺时间会显式写「时间未知」。

## 4. 对表到 huddo 房（想让 huddo 房驱动本体才需要）

```powershell
node bin\zjz.mjs --home V:\zjz feed bind sp_xxxxxxxx --slug zjz-我的分身 --huddo-home C:\Users\<你>\.huddo
node bin\zjz.mjs --home V:\zjz feed poll
node bin\zjz.mjs --home V:\zjz feed bindings
```

一个 huddo 房对应一个 zjz 镜像房；游标存 `data/feed/cursors.json`，重跑不重报。

## 5. 一条命令自测（初级品的验收门）

```powershell
node bin\zjz.mjs --home V:\zjz selfcheck --port 8888
```

跑：单元测试、演示收口 6/6（I45 inbox 横幅 / I46 在线即推 ≤2s / I47 离线唤醒端到端 / I48 值班板点名 / I49 无外部计划任务）、防重放哨兵、真宿主不盯房被拽回。退出码 `0`=PASS、`1`=FAIL、`2`=BLOCKED（前置缺，比如宿主没装——不算产品红）；未选到的判据显式写 `SKIP`，不假装跑过。报告落 `data\selfcheck\<时间>.md`，含每条判据的复现命令。

备用（同判据的脚本版，装不上 `zjz selfcheck` 的旧版可用，加 `--fast` 跳过约 140 秒的「飞行中不双发」哨兵）：

```powershell
node trials\t008-demo\selfcheck.mjs --port 8888 --fast
```

## 6. 实弹（这才是你要看的）

在 huddo 房 `@huddo-我的handle 一句话`。**人不要盯房，什么也别做。** 等 1–4 分钟（真任务要跑几分钟），该分身应以其账号自动回帖，首行带「回复于 …」。中军帐侧可见证据：`zjz duty board`、`data\events\*.jsonl` 的 `spawned/read/answered`、`data\inbox\<slug>.md`。

## 7. 常见红，别慌

| 现象 | 真原因 | 动作 |
|---|---|---|
| `ADAPTER_TIMEOUT`（带 `elapsed_ms`、`exit=null`） | 任务超过该成员的 `--timeout-ms`（默认 600s）。真宿主实测 79s（独占模型）～210s+（抢模型） | 换云端模型：`$env:ZJZ_HOST_MODEL='deepseek-api/deepseek-flash'`；或调大该成员 `--timeout-ms`。**这是超时，不是没装好** |
| `ADAPTER_SPAWN_FAILED` 且带 ENOENT/EPERM | 宿主可执行找不到 | `ZJZ_HOST_CLI=<exe 全路径>`，或跑 `scripts\install-check.ps1` 看它找到了什么 |
| **同一时刻两个 agent 打本地模型** | 本地 IQ3 是**单槽串行**：并发 2 全程排队（108s），并发 4 有两个请求直接断（E15）。显存已被 262k 上下文占满（`vram_free_mib≈1.7G`），开不了多槽 | 硬规则：**同一时刻只有一个智能体吃本地**。要用本地先 `node bin\zjz.mjs --home V:\zjz resource claim --resource local-iq3 --ttl-ms 600000`，用完 `resource release`；拿不到就走云端（`$env:ZJZ_HOST_MODEL='deepseek-api/deepseek-flash'`） |
| 熔断后一直不拉起 | 适配器连续失败进闩锁（E12） | `node bin\zjz.mjs --home V:\zjz member reset-adapter --slug S` |
| `demo_all` 报「前置未就绪」 | 没人起 serve，不是产品坏 | 按它打印的命令起服务再跑 |
| 一条旧消息反复拉起 | 游标没推进 | 已修：batch 闭合无条件推游标；仍出现就发房②，标 E13 |
| 界面打不开（`GET /` 返 NOT_FOUND） | 跑的是**旧版 serve**（静态路由在 `d6c3e8e` 才进仓）或没起 serve | `zjz serve stop` 再起一次；仍不行用第 2 步的 `preview-web` 前挂 |
| `zjz serve --port` 报 `ok:false`，但 `serve status` 说没在跑（E18） | 机器重启/被杀留下的**旧租约**（pid 已不存在），首次起服务被它挡掉 | 再跑一次 `zjz serve --port …` 即好（`serve status` 会先把死租约判掉）。脚本里要按「失败→status→重试→仍失败记 BLOCKED」写 |
| 消息发得出去、没人被唤醒 | 那时**没有 serve 在跑**（发送是离线的，唤醒只有 serve 的监督环会做） | 先 `zjz serve status` 确认真的在跑，再 `zjz duty board` 看 pending；别先怀疑产品 |
| 起了 serve、也发了消息，还是没人被唤醒（E20） | 那个成员**没有身份、也没进房**——`member set` 只是适配器配置，唤醒只认「房里名单里的 slug」 | 按 3.1 补：`identity new` → `join <邀请码> --slug <身份slug>` → `member set --slug <身份slug>`；自查 `member list`／房里名单／`member providers` 三条 |
| 发了消息，房里能看到，但**作者是分身自己**（E21） | `identity new`／`join` 把「当前身份」切成了新 slug，`send` 默认就用它；而唤醒排除自己发的消息 | 发消息显式带 `--slug <你自己的slug>`；先 `zjz whoami` 看清在替谁说话 |
| **它答了第一条，紧接着第二问没反应**（E22） | 上一轮的 wake batch 没闭合（子进程先退出/被杀），该成员被闸门挡住，要等 batch 租期 600 秒到期 | 看 `data\wake\batches.json`：`status:"open"` 且 `closed_at:null` 就是它。临时招：等租期到或重启 serve（启动时会重新对账）；根治在 wake 侧（见错误卡） |

## 8. 这台机器上现在能测到什么（不夸大）

- ✅ 闭环主链路：投递→唤醒→恰 1 回帖→二次 idle；SSE 实测 28–96ms；防重放与飞行中不双发哨兵 PASS。
- ✅ 房②真房实弹：成员不盯房，自动回帖（多条记录在房②可回放）。
- ⚠️ 未接线：I45 MCP 那条在部分环境为红（脚本如实报，不藏）。
- ⚠️ 界面：靠 `preview-web` 前挂，静态路由进仓后可去掉前挂。
