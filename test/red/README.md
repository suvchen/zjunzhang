# T-007 I27-I35 红测

这组测试是需求①的产品化契约，当前刻意保持 RED，不进入 `npm test`。

运行：

```powershell
node --test test/red/i27-i35.red.test.mjs
node --test test/red/i38-i39.red.test.mjs
```

实现顺序建议按 I27、I28、I29、I30、I31、I32、I33、I34、I35 逐条转绿。每实现一条，都应同步补对应模块测试，并保持 `npm test`、`test/smoke.mjs`、`test/mcp.smoke.mjs` 全绿。
