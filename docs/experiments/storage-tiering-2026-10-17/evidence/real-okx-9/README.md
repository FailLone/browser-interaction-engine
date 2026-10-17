# 第九窗：未到达检查点，尚无恢复后的探索覆盖

本窗没有满足第 3 项的真实页面结束条件。一次局部 `Close` 恢复操作成功后，`reachCheckpoint` 仍返回 `UNREACHABLE`，没有进入后续探索。不能把局部关闭成功、审计流程检查通过或未出现 unknown，解释为整体恢复成功。

产品检查点为 `60eaab5`；启动与主分支记录为 `8b9f6934988dd60cccbff74721d13003560317e2`，见 [main-merge.json](main-merge.json) 和 [launch.json](launch.json)。本窗 run ID 为 `de69fc46-de8e-481e-9cc4-bef75e269fcd`，任务 ID 为 `6c56a979-34f0-4599-a5b7-9461c357144d`。

原始输入只保留在冻结目录 `/Users/xietian/.codex/worktrees/exploration-layered-refactor/browser-interaction-engine/.data/okx-storage-acceptance-20261017-v2`。其运行导出位于 `runs/de69fc46-de8e-481e-9cc4-bef75e269fcd/`；文件清单摘要、源数据库摘要和 v1 冻结目录未变检查见 [closed-evidence.json](closed-evidence.json)。不在此复制 HTML、图或数据库。`active-run.json` 于 `2026-10-17T05:23:22.463Z` 正式标记 finished，运行器退出码为 2；provider 已结清，unknown 和在途操作均为 0。

## 本窗行为

| 项目 | 结果 |
| --- | --- |
| 整体检查点到达 | 0 / 1；`UNREACHABLE` |
| 恢复调用耗时 | 23.931 秒 |
| 实际恢复操作 | 1 次 `Close`，`succeeded` |
| 实际探索操作 / 探索成功 | 0 / 0 |
| 本窗已验证 receipt 条件覆盖 | 0 |
| 原 arrival-policy 新候选数 | 0；与 receipt 条件覆盖分别计数 |
| JEV / LLM 调用 | 0 / 0 |
| 新解决计划条目 | 0 |
| 计划行数 | 874 → 876 |

来源是冻结运行导出的 `summary.json`、`coverage-review.json`、`metrics.jsonl`，以及唯一一次离线 [receipt-audit.json](receipt-audit.json)。本窗由 `recovery_not_verified` 停止门触发，原始理由是 `Checkpoint path contains actions without replay permission`。最终任务状态为 paused，不构成穷尽。

## 两个独立缺口

1. **到达路径未获重放许可。** 当前观察与旧检查点未通过整体状态验证；局部关闭弹层后，旧路径包含无重放许可的操作，整体恢复被拒绝。详见 [recovery-diagnosis.json](recovery-diagnosis.json)。不能用新会话可用或一次关闭成功改记检查点到达。
2. **实际 Close 目标的依赖证据未完整保留。** 其 before 观察为 v3 图，库存完整，33 个 selector/native 控件及 1 个额外 native root 均完整；加上 Close 目标后，必需控件仅 33/34 完整，必需 closure 28/29 完整。Close `:729` 的 owner `:726` 未保留 closure，root 原因是 `byte_budget`。全图 480 nodes，必需已保留 union 为 409。已算得的补充只读诊断保存在 [mandatory-diagnosis.json](mandatory-diagnosis.json)，此次整理没有再次打开数据库或调用 SDK。

Close 的 dispatch witness 存在，坐标、action/context/原始 wire 哈希及时间范围检查均通过；这没有补足缺失的目标 closure。SDK 对其回执返回 `actualSuccess=true`、`conditionVerified=false`、`retained_receipt_condition_unverified`。目标证据缺口足以阻断该 document 条件证明，但不能据此认定它导致了前述路径许可失败；两者不是同一原因。

## 计划与失败记录接续

只比较冻结的 `task-before.json` / `task-after.json`：全部旧 plan ID 及出现次数保留，新增 2 行——`click announced` 为 pending，`Go to OKX Wallet` 的 `interface_risk_required` 为 unresolved。计划中的尝试记录数量仍为 169。另有两条旧计划状态从 succeeded 变为 unresolved，标题分别为 `classification_unresolved`、`operation_basis_unconfirmed`，因此不能声称旧计划状态完全未变或本轮新增了完成项。

`routeRetries.routes` 仍为 6 条；条件记录从 10 增至 11，全部旧条件记录逐值不变。仅 USD 路由 `59eb7890…` 增加本轮 source condition `43b39ac4…` 的 1 次 unreachable 记录；其失败结果条件从全局 2 条增至 3 条，旧失败结果记录逐值不变，`completedProgressKeys` 未增加。失败债得到保留，仅新增相应条件记录，没有因重启清空。精简对照见 `mandatory-diagnosis.json` 的 `exportContinuationCheck`；原导出没有另行复制。

## 审计与性能边界

[receipt-audit.mjs](receipt-audit.mjs) 复用固定 SHA 的第八窗脚本，只增加 v3 诊断解码与来源记录；派发校验仍哈希原 wire。仅对独享临时副本执行一次 SDK 批量查询，审计 1 条回执；driver 调用 0，查询写入 0，构造器回执改写 0，副本物理字节未变。`receipt-audit.json` 的 `passed=true` 只表示这些审计流程与一致性检查通过，不表示本窗产品验收通过。

本帧 retained wire 为 130,078 bytes，解码 JSON 为 355,455 bytes；它们是表示大小，不是任务库整体压缩收益。本次未做性能 A/B；23.931 秒是失败恢复耗时，约 93.939 ms 是离线单批查询时间，均不能证明线上恢复提速。没有恢复到达后的新探索覆盖，也没有证据证明真实网页已穷尽。
