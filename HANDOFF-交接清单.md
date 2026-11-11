# 中军帐项目 · 交接清单（新窗口接手用）

> 用途：新对话窗口凭此清单完整接手中军帐项目所有工作。日期：2026-11-11

---

## 一、项目定位
- **中军帐 = 多智能体协作指挥台**（人与 AI、AI 与 AI 协同）。核心概念：**一人成军**、**多个智能体攻坚部队**。
- **品牌主体**：宁波奉化海钺信息技术服务部（品牌：海钺造物）。
- **产品之道**：民主集中制的多智能体组织（民主·集思广益／集中·收敛决断）。
- **商业模式**：免费版(开源)打底 + 会员版(收费)——免费给工具、会员给智慧。
- **广告主线**：「你的精力时间跟不上智能体的步伐 → 中军帐帮你解决 · 一人成军」。

## 二、当前状态（截至 2026-11-11）
- **免费版已开源上 GitHub**：`github.com/suvchen/zjunzhang`（源码 + README 门面 + 法律五件套 + MIT LICENSE）。
- **装机包** `中军帐-Setup-0.1.0.exe` 在 GitHub **Releases (v0.1)**，含安装引导。
- **桌面客户端**（Electron，`V:\zjunzhang\desktop`）：Huddo 质感、深/浅色、消息按人分组、智能体管理、房间增删、升级/会员位置、空状态品牌化。
- **后端**（`V:\zjunzhang\bin\zjz.mjs` + `src\`）：项目房、消息、智能体、唤醒/回执/超时报警、值班板。
- **参谋长**（收费版招牌）核心闭环已开发：planner(拆解)→scheduler(派活)→summarizer(汇总)→prodder(督战心跳)→supervisor(监督官·干和查分离)。三端已通（CLI `zjz参谋长`、API `POST /api/chief`、界面聊天框说「参谋长：」）。
- **测试**：`npm test` 162/162 全绿。

## 三、环境（新窗口必知，否则会卡住）
1. **盘古代理 `127.0.0.1:51081`**：下载/推送(git/curl/pip/uv/hf)必挂，否则 Connection reset。
   - 挂法：`export HTTP_PROXY=http://127.0.0.1:51081` ＋ `HTTPS_PROXY` 同值 ＋ `git config http.proxy/https.proxy`。
   - 详见 `V:\3003\knowledge_base\pitfalls\solutions\下载推送走对通道_盘古代理51081.md`
2. **GitHub 凭据**：`suvchen` / `12496275@qq.com`，凭据（登录密码、访问令牌 `ghp_...`）见 `V:\3003\knowledge_base\pitfalls\solutions\GitHub账号凭据_本机私有.md`（本机私有、不入仓库）。
   - **git 推送用令牌**：`git push https://x-access-token:<token>@github.com/suvchen/zjunzhang.git <branch>`（token 从上面那个文件读）。
   - 详见 `V:\3003\knowledge_base\pitfalls\solutions\GitHub账号凭据_本机私有.md`
3. **ego-browser**：浏览器任务(带用户登录态)用它，先跑 `ego-browser skill` 拿手册。
4. **IQ3 本地模型**：`http://127.0.0.1:8081`（qwen3.8-flash-next-iq3_s）。
5. **出图/临时件**放 `V:\zjunzhang\.work\`，不占系统盘。

## 四、关键文件 / 位置
- **仓库**：`V:\zjunzhang`（git，已连 GitHub）
- **H3 知识库**（环境/避坑）：`V:\3003\knowledge_base\`（README 有网络通道入口；pitfalls\solutions\ 有代理/凭据/避坑）
- **全局规则**：`C:\Users\Administrator\.config\opencode\AGENTS.md`
- **进度**：`V:\zjunzhang\PROGRESS.md`；**错误卡**：`V:\zjunzhang\error-cards.md`（E1-E37）；**装机**：`README-装机.md`

## 五、纪律 / 规则（务必遵守）
- **AGENTS.md 红线**：不按名杀进程、不改系统持久状态、重启只针对自己登记的对象、碰基础设施先 `zjz resource claim`。
- **文件所有权**：Codex 持 `wake.js/serve.js/delivery.js/core.js/bin/zjz.mjs`；总管持 `inbox/member/adapter/feed/ingest/public/scripts/trials`。实际并行开发常交叉（改动要房②同步 Codex）。
- **并发协作**：Codex 也在推同一 GitHub 仓库，推送前先同步(git pull/merge)，**不要强推盖他**。
- **房②**（中军帐研发·huddo）：`sp_25421dc3-09fb-4256-845e-5574adede84a`（和 Codex 沟通）。**项目房**（参谋长）：`room_e9261e9df19b171e`（用 `zjz send`）。发 huddo 房用 `huddo.mjs send`，发 zjz 房用 `zjz send`。
- **房内信息要带时间标**。

## 六、待办 / 下一步
- **收费版·参谋长**继续开发：拆解升级为真懂意图（用大模型领会）、督战接活到完成、界面更顺。
- **免费版完善**：UI 逐页精修（检索/技能卡/工单/智能体页）、升级流程、搜索/工单页。
- 待推的若没上 GitHub 就推（挂代理+令牌）。细节查 `PROGRESS.md`、`error-cards.md`。

## 七、怎么干活
- 用中军帐管中军帐（自举，自证一人成军）。
- 推送挂**盘古代理** + **令牌**。
- 保持 `npm test` 全绿。
- 任务文本/界面/回帖**带时间标**。
- 不确定规则主动问，不要乱猜。

---
*本清单由总管（MiMo）交接时生成，凭此新窗口可完整接手中军帐项目。*
