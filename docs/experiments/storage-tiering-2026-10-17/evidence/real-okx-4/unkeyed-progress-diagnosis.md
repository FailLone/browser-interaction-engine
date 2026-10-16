# Run4 无键成功与进展保护诊断

结论：7 次成功都正确读到了实际 before Observation，均不具备 SDK 要求的可跨观察复用条件。它们被记为 unkeyed 有真实证据依据，并非验收工具漏读 key；目前没有证据确认 SDK 到达或条件计算缺陷。原验收工具对这类不确定性的处理过于持久：一次仍有效的无键成功会令本次调用中的无进展/重复路线保护持续延后。可修的是工具的复核期限，不是把缺失条件当成已知或把成功次数当新覆盖。

本诊断绑定 run `5f350d86-b9dd-43e5-ac07-43a79a9e30f0`、源码 `868e8b47afd31782161deba4f8bd7a14e0349430`。源码 SHA 在诊断时与该提交逐一相符；后续父任务授权的工具修复另行测试，不属于原 run4 的行为。

## 实际证据

- 9 个成功 action attempts = 7 个探索动作 + 2 个恢复动作；7 个均为 external / interface-exploration，无 repetitionSource，未将恢复计入探索。
- 每个目标 localId 恰好 1 个、无 hypothesis、有 identityId 且与 action.controlId 相等；全部 before Observation stable=true、无 critical gaps、context={}，browserTargetReady=true。
- 实际纯函数复算 7 次 browserOperationKey 都返回字符串；browserBranchConditions、browserTargetConditions、operationConditionCandidate 均返回 undefined。不是目标缺失、目标身份错配、匿名 boundary 或 selector 数量溢出。
- 6 个来源观察包含两个隐藏 `Open sub-menu` selector；expanded=false，但身份仍为 hypothesis，且除去 hypothesis 仍有完全相同的 portable binding。单纯删除 hypothesis 后重算依然没有 branch conditions，这只是反事实验证，不是许可修复。
- `1h` 的来源观察是 Trade 菜单已展开时：`Open Spot sub-menu` 与两个 `Open sub-menu` 可见、有 identityId，但 identityScope=instance。它们的 stableKey 含 record-instance / 当前文档局部 ID，不能充当跨观察条件。`24h` 来源再次回到两个隐藏歧义 selector。

| Attempt 前缀 | 动作 | Before Observation | 纳入 selector 数 | 条件拒绝原因 |
|---|---|---|---:|---|
| `8d791a88` | check Don’t show for 7 days=true | `5017a84c` | 26 | 2 个隐藏 Open sub-menu：hypothesis + portable binding 碰撞 |
| `592416bf` | check Don’t show for 7 days=false | `571adda1` | 28 | 2 个隐藏 Open sub-menu：hypothesis + portable binding 碰撞 |
| `40255e62` | click announced | `eaae6e16` | 29 | 2 个隐藏 Open sub-menu：hypothesis + portable binding 碰撞 |
| `f9b63cd2` | scroll Scrollable generic | `5f80a3df` | 26 | 2 个隐藏 Open sub-menu：hypothesis + portable binding 碰撞 |
| `797f216e` | click Trade | `c446073e` | 26 | 2 个隐藏 Open sub-menu：hypothesis + portable binding 碰撞 |
| `0ffb08c8` | click 1h | `f6c6f3c2` | 28 | 3 个可见 selector 仅 instance identity |
| `e46636b7` | click 24h | `d0b567f7` | 28 | 2 个隐藏 Open sub-menu：hypothesis + portable binding 碰撞 |

完整 attempt/observation ID、目标、selector binding、hypothesis、碰撞组、条件结果和原始字节 SHA 保存在同名 JSON。碰撞投影采用当前 SDK canonical/formBinding；最终 undefined 结论由实际 SDK 函数复算，不依赖诊断中的分类推断。只有持久证据，不启动引擎。

## 调用链与能力边界

原 harness 在 [operationConditionCandidate](/Users/xietian/.codex/worktrees/exploration-layered-refactor/browser-interaction-engine/scripts/okx-storage-acceptance.ts:82) 先验证唯一目标/身份，再调用 browserTargetConditions；运行入口读取 `host.observation(attempt.sessionId, attempt.beforeId)`（原提交第 351 行）。[target-arrival.ts](/Users/xietian/.codex/worktrees/exploration-layered-refactor/browser-interaction-engine/packages/adapter-playwright/src/target-arrival.ts:7) 首先要求 branch conditions。

[branch-conditions.ts](/Users/xietian/.codex/worktrees/exploration-layered-refactor/browser-interaction-engine/packages/adapter-playwright/src/branch-conditions.ts:69) 明确把全部已捕获 selector（包括隐藏、跨区域/表单）纳入条件，结构或可见性不证明行为独立；第 35 行拒绝 hypothesis/instance-only binding，第 102–105 行拒绝不明状态、绑定碰撞或数量超过 32。本次 count 为 26–29，未触发上限。

[browserOperationKey](/Users/xietian/.codex/worktrees/exploration-layered-refactor/browser-interaction-engine/packages/adapter-playwright/src/exploration.ts:56) 只是调度提示；第 74–78 行在 branch 不可用时仍生成带 `sourceConditions.status=unverified` 的稳定重试标记。不能把其非空字符串直接拿来增加覆盖或恢复旧成功。相同文件第 90–94/129–131 行的操作样本也拒绝缺失 branch；核心 [operation correspondence](/Users/xietian/.codex/worktrees/exploration-layered-refactor/browser-interaction-engine/packages/core/src/engine.ts:257) 保留 `operation_conditions_unavailable` 拒绝。当前目标可执行/实际成功，与跨观察可证明等价是两种证据。

这是有明确保守理由的能力边界。现有材料没有证明两个隐藏 selector 与目标无关，也没有稳定的 portable selector binding，所以不能通过忽略隐藏节点、删除 hypothesis、使用 localId/instanceKey、裸 operation key 或恢复 v1 可见性过滤来“修绿”。有价值的 SDK 后续能力是返回结构化拒绝原因/条件依赖供审阅；是否可以补更强绑定或显式独立性证明，需独立设计与证据，不能从这 7 个成功倒推出许可。

## 为什么保护一直延后，以及本轮实际是否漏停

原 AcceptanceProgress.snapshot（原提交第 135 行）直接以本 run 的 `unkeyedSuccessfulAttemptIds.length > 0` 置 progressGuardsDeferred；不随时间或后来 keyed success 清除。watchRoute（原第 383 行）遇此标志直接返回，连 route 计数都不更新；main loop（原第 573 行）也跳过无进展阈值。纯 ledger 反例确认：一个 unkeyed 成功后再有一个有效新 candidate，newOperationConditionCandidates=1，但 deferral 仍为 true。未知/执行中、provider、budget、磁盘及负向恢复保护独立保留。

原日志：第 182 行，21:39:23.533 首次 deferral；第 430/1417 行，两条不同 recovery route 分别延后一次。实际本轮约 229,950ms，stallMs=600,000ms；两个 route 各一次，均没有达到三次同路线。因此 **本轮没有已到原进展阈值却漏停的证据**。最后于 21:42:51.165 被独立 recovery_not_verified 保护请求停止，21:42:56.290 写出 summary。该负向恢复结果保持 UNVERIFIED，没有因底层 navigate action succeeded 被改记成功。

coverage-review 的 9 个新解决 occurrence / 12 个证据刷新与这 7 次探索成功是不同指标；planProgressIsSemanticCoverageProof=false。本文不据这些数字宣称语义覆盖，计划增长由另一专项分析。

## 最小通用修复（诊断后获授权，单独验证）

验收工具保留每个 unkeyed 的精确 source reference 与原因分类；SDK 只返回 undefined 时如实记 target_conditions_unavailable，不另造简化条件算法。另设独立 stallMs 审计期限：当前最早仍有效 unkeyed 成功开始计时，新 unkeyed/keyed 都不能延长；历史 unkeyed 单独披露，从本次 start 获得完整窗口，不计停机。期限届满原因是 progress_evidence_unavailable_window / progress_audit_required，请求正常 pause/settle；不是动作失败、没有进展或穷尽证明。

最终 ledger 将成功撤销为 unknown/executing/failed 时，审计债只按剩余有效成功重算；unknown/executing 仍由原保护独立阻断。重复事件、无效/未来时间戳不能无限续期。时间窗内仍允许正常探索，不因第一个无键成功立即中断。该修复不修改 SDK 成功/未知语义，也不解除原条件屏障。

## 只读与可复验边界

冻结输入 `/Users/xietian/.codex/worktrees/exploration-layered-refactor/browser-interaction-engine/.data/okx-storage-acceptance-20261017-v1-frozen-4`，2709 个文件与 frozen manifest 全量 SHA 相符，读前/读后所有 SHA 相同，未发现 WAL/SHM。只用 SQLite `mode=ro&immutable=1` + query_only 读取冻结 engine 数据库；未连接原库、未创建 SDK store/engine、无浏览器/provider/network。7 个结构化 Observation 的完整字节、7 个 layout、1806 个共享对象及 143 个 pack 均验 SHA/长度/owner。

engine.sqlite SHA-256：`3ce36c03015dff7482c7dcedf1fcee850e991f1b0b44a11e9cd6d09a3c693357`；manifest SHA-256：`fa5db265c62a968a74b946dc53fc84ded6b35986414beb45d29de18e4b4a03fe`。输入 raw summary/metrics/coverage-review 与 5 个相关源码哈希附于 JSON。临时抽取与纯函数脚本留在 `/tmp/okx-run4-unkeyed-9TLnw4`，不提交数据库副本。此次是轻量元数据诊断，不是计时基准。
