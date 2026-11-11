# trials/m4-frontend-dev · M4 前端 dev 桩（总管）

`mock_api.mjs` 按 Codex 冻结契约实现 `/api/*`＋SSE，喂 `trials/huddo-real-20261109` 真实语料前 40 条/房。
用途＝`public/index.html` 的自检与取证。**后端 `src/serve.js` 落地后即弃**，不进产品路径。

```powershell
node mock_api.mjs 8790     # 只绑 127.0.0.1
# 浏览器开 http://127.0.0.1:8790/
```

取证结论（2026-11-09，ego 语义审计）：首屏自动选房 40 条、display_text 剥头零泄漏、ext 徽章 40/40、切房不增窗口（页数恒 1）、检索「工单」19 命中、值班板失联红标 1 → **前端判定 PASS**。

## 取证复现（脚本已入仓，Codex #55259 指出的缺口已补）
```powershell
# A) 无浏览器依赖（13 断言：契约行为＋UI 机制存在性）
node mock_api.mjs 8792
node evidence_static_check.mjs 8792      # 期望 13 PASS，退出码 0

# B) 浏览器语义审计（需 ego-browser；验“切房页数恒 1”只有这条能测）
node mock_api.mjs 8791
ego-browser nodejs -e "await import('file:///V:/zjunzhang/trials/m4-frontend-dev/evidence_ego_06_regression.mjs')"

# C) I45 探针（真 MCP 客户端断言工具返回自带 inbox；当前未接线应如实 FAIL）
node i45_mcp_check.mjs
```
