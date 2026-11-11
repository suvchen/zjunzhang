# 中军帐（ZJunZhang）— 多智能体协作调度系统

> 第二个产品（第一个是排盘/mingyu）。定位：不止群聊——把「派单-接单-值班-换班-质检-台账」做成一等公民。
> 全部差异化源自 2026-11-08 Huddo 实战踩坑清单。

## 不变量（哨兵断言，开工先测这些）

- I1 每个房间的消息 seq 严格递增、无洞、无重
- I2 身份私钥永不出数据目录；签名校验失败的消息拒绝入库
- I3 房间隔离：A 房消息绝不出现在 B 房的任何读取里
- I4 wait 游标单调：同一条消息绝不对同一成员重复投递两次
- I5 邀请码是入房唯一入口；已归档房间拒收新消息（403 语义）
- I6 空输入不崩溃：空房读取 / 未加入即发送 / 坏签名消息，三个 fixture 全部优雅返回错误而非崩溃
- I7 身份隔离硬保证：每个智能体独立 HUDDO_HOME 等价物（zjz_home），进程环境不串号（串号事故见 error-cards）

## M1 范围（核心管道）

- 身份：Ed25519 密钥对（node:crypto），slug = zjz-<name>-<rand8>
- 房间：create / join(invite) / archive / members / list
- 消息：send（含 reply_to、mention）/ read（分页 before/after）/ wait（游标语义）
- 通道：CLI `zjz` + MCP stdio（工具名 zjz_*），同一核心库
- 存储：data/ 目录纯文件（JSON meta + JSONL 消息），本地优先、可离线
- 测试：node --test 跑哨兵断言 + 手算小 fixture

## M2+（后续）

M2 工单系统（派单/接单/验收/seq 仲裁/催办）+ 值班编排（listen 模式/自动换班/看门狗）
M3 质检台账（四栏对照/留档钩子/机器判定接口）+ 产线事件流
M4 Web UI（localhost）+ 桌面直达入口 + 多机

## 目录

```
E:\zjunzhang\
  PROGRESS.md        进度与待办（每完成一步更新）
  SPEC.md            M1 规格与接口
  error-cards.md     错误模式卡片（同类任务开工先查）
  src/               核心库
  bin/               zjz CLI + zjz-mcp
  test/              哨兵测试
  data/              运行数据（git 忽略）
```
