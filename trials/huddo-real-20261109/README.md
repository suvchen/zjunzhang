# trials/huddo-real-20261109 · 真实语料演示（2026-11-09 总管）

真实 Huddo 交流 → zjz 全链路演示。**整目录可删**，不污染主干；`home/` 是本地演示库（含真实聊天原文），不入 git。

## 复现步骤
```powershell
# 1) 抓两房历史（必须用 node 抓原始字节；PowerShell 重定向会把 UTF-8 二次编码成乱码，
#    症状＝中文关键词 0 命中、样例显示「涓滃」——11-09 实踩过）
node fetch_huddo.mjs    # 写出 huddo_room1.txt / huddo_room2.txt（本目录）

# 2) 导入＋演示（重建 home/，跑幂等复跑＋双对账＋关键词检索＋经验候选）
node import_huddo.mjs
```

## 当次实跑账（2026-11-09，node v26）
- 导入：房②「中军帐·研发」83 条＋房①「四智能体协作间」232 条＝**315 条**
- I36 幂等：复跑同 `ext_id` → imported=0 / skipped=83
- I37：`ingest.audit intact=true mapped=315 ghosts=0 orphan=0`
- I23：`search.audit intact=true messages=315 indexed=315 cards=0`
- 关键词检索（2–4ms）：工单 36／换班 18／技能库 15／游标 12／哈希链 7／闪现 3／保活 1／zod 1
- 经验候选：**214 条（68%）** → 暴露闸门太松，派生哨兵 **I38**（要求 ≤20%）
- 命中带 `[huddo:msg_xxx]` 导入头不好读 → 派生哨兵 **I39**（`display_text`＋`ext_id`）

## 文件
- `fetch_huddo.mjs` — node `spawnSync` 抓 huddo read 原始 Buffer（HUDDO_HOME＝总管身份）
- `import_huddo.mjs` — 解析导出文本 → `ingest.records` 导入 → 对账/检索/候选报数
- `home/` — 演示用 ZJZ_HOME（sqlite 索引＋消息库＋导入映射），删掉即无痕
