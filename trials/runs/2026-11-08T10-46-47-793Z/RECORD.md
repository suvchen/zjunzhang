# 中军帐 M3 狗粮记录

- 时间：2026-11-08T10-46-47-793Z
- 房间：room_dacbbc6d5d0c965f（M3狗粮房）
- 身份：东家 zjz-东家-9f756bc0 / 值班Codex zjz-值班codex-39824627
- 工单事件链：dispatch → claim → deliver → accept → close，5 条一一对应
- 质检台账：qc_bdf91e199768，证据 3 挂（含 allow_same 豁免 1），机器 2 闸，人工 1 判，状态 closed
- 证据防伪：同哈希跨角色默认拒（EVIDENCE_DUPLICATE），豁免理由随事件流留痕
- 并发事件流：3 进程 × 5 条，seq 1..15 连续，15 个哈希互异，verify intact=true
- 篡改检测：改 1 条 payload → intact=false/reason=hash；恢复后 intact=true
- 双台账互引：actions.jsonl shift.event_id=5f778c3c-503f-46ab-8624-4ce25837dfb5 ↔ 事件流 duty.watchdog_shift.id；epoch=1；引用 duty.shift=abad8081-e3eb-490e-811a-2fbfe7a057d7
- 项目事件总数：狗粮M3 15 条 / 并发M3 15 条
- 哈希链尾：9a4c3b2cf9078d34…
- 结论：**PASS**

| # | 工具 | 结果 |
|---|------|------|
| 1 | zjz_identity_new | ok |
| 2 | zjz_identity_new | ok |
| 3 | zjz_new | ok |
| 4 | zjz_join | ok |
| 5 | zjz_send | ok |
| 6 | zjz_order_dispatch | ok |
| 7 | zjz_order_claim | ok |
| 8 | zjz_order_deliver | ok |
| 9 | zjz_order_accept | ok |
| 10 | zjz_order_close | ok |
| 11 | zjz_qc_open | ok |
| 12 | zjz_qc_attach | ok |
| 13 | zjz_qc_attach | ok |
| 14 | zjz_qc_attach | EVIDENCE_DUPLICATE |
| 15 | zjz_qc_attach | ok |
| 16 | zjz_qc_machine | ok |
| 17 | zjz_qc_machine | ok |
| 18 | zjz_qc_human | ok |
| 19 | zjz_qc_close | ok |
| 20 | zjz_qc_verify | ok |
| 21 | zjz_qc_summary | ok |
| 22 | zjz_event_list | ok |
| 23 | zjz_event_list | ok |
| 24 | zjz_event_verify | ok |
| 25 | zjz_event_verify | ok |
| 26 | zjz_event_verify | ok |
| 27 | zjz_duty_set | ok |
| 28 | zjz_duty_set | ok |
| 29 | zjz_duty_heartbeat | ok |
| 30 | zjz_watchdog_tick | ok |
| 31 | zjz_event_list | ok |
| 32 | zjz_event_verify | ok |
| 33 | zjz_event_verify | ok |
| 34 | zjz_event_projects | ok |

原始记录：trials/runs/2026-11-08T10-46-47-793Z/transcript.json
