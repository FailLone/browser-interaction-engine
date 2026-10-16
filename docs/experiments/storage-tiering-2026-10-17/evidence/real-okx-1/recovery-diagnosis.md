# OKX v1 首个恢复与中断状态：只读诊断

诊断日期：2026-10-17（Asia/Shanghai）。下文事件时间均为 UTC；加 8 小时即本地时间。源码解释以提交 `6630dfa8f1dae13aba1bd6e8dcd789f0d2dc23b5` 为准，所列行号是诊断时的行号；后续生命周期修复不改变这里记录的原始实验事实。

**结论：首个恢复是有证据支持的负向结果，应保留 `UNVERIFIED`、未完成义务与重试债务。未发现需要立即放宽 SDK 到达语义或改变审阅优先级的产品缺陷。** 原始日志中的 SIGINT 没有完成结算，留下了另一个确定的生命周期问题；应先处理该问题，再验证续跑。

## 读取范围与证据身份

原实验目录为 `/Users/xietian/.codex/worktrees/exploration-layered-refactor/browser-interaction-engine/.data/okx-storage-acceptance-20261017-v1`。本次先使用 SQLite `mode=ro`、`query_only=ON` 查询原库，再将两个数据库及存在的 WAL/SHM 复制到 `/tmp/okx-first-recovery-tz_4mi90`，所有解码和后续查询都使用副本。复制前后原文件的大小、修改时间一致。未启动引擎、浏览器或 provider，未更改源码或原数据库。

临时副本中的 `copy-manifest.json` 保存大小和 SHA-256，压缩观察通过纯解码程序核验布局、对象、压缩包哈希及长度；任务头通过 zstd 解码核验压缩哈希和长度。临时数据库不纳入仓库。另由主任务建立的永久冻结快照见 [frozen-snapshot.json](/Users/xietian/.codex/worktrees/exploration-layered-refactor/browser-interaction-engine/docs/experiments/storage-tiering-2026-10-17/evidence/real-okx-1/frozen-snapshot.json)；它使用 WAL-aware SQLite backup，文件布局与直接复制的临时副本不同，不能要求二者文件哈希相同。

| 标识 | 值 |
| --- | --- |
| run | `ad6cbc56-6903-49f4-9bb3-96d8b6315d30` |
| task | `6c56a979-34f0-4599-a5b7-9461c357144d` |
| round | `caaad143-1b3f-48b6-8a99-bd8d7c490060` |
| session | `412937f3-c4f5-4799-b86c-74adf480f329` |
| checkpoint | `33702c36-2be8-4004-8807-f8f88a9c0556` |
| 恢复来源 observation | `6b86d43c-8797-4140-8dcc-2132dbeb9073` |
| 恢复结束 observation | `cfc205c1-bab5-4b44-8bc7-9d2b4c498948` |
| 恢复结果 | `3f836dee-0319-4a7b-8533-fda9ee216a94` |

原库读取摘要：engine 有 370 条事件、14 个 observation、5 个 attempt；plugin 有 490 条事件、25 个 decision（24 applied、1 returned）、19 个 plan occurrence、1 个 round occurrence。任务头压缩数据 SHA-256 为 `f8ae0e97f491e934144eaf15315dffa4a4dcb91473d013f45997c816794730b5`，解压后 7,538 字节。原始运行日志见 [metrics.jsonl](/Users/xietian/.codex/worktrees/exploration-layered-refactor/browser-interaction-engine/docs/experiments/storage-tiering-2026-10-17/evidence/real-okx-1/metrics.jsonl)。

## 已确认：为什么恢复、为什么使用 checkpoint

本轮实际 `executionPolicy=interface-only`。程序先对 “Don’t show for 7 days” 依次执行 check true、check false，然后点击 “announced”，从 convert 页面进入帮助文章。

离开前的 Wallet 审阅没有被跳过：

| UTC 时间 / plugin 序号 | 已记录行为与结果 |
| --- | --- |
| 20:14:52.055 / 145 | 对 “Go to OKX Wallet” 发起 `control-risk`，decision `fa378134-b818-4838-8539-c9fd63659ac7`。 |
| 20:14:53.195 / 147 | `interface_click=.03`、`external_click=.17` 被程序解释为 `false/null`，不能建立可执行风险结论。 |
| 20:14:53.431–53.880 / 148–150 | Wallet `probe-risk`：hover/focus 的 interface 值 `.19/.55` 均为 null，未派发 probe。 |
| 20:14:55.210 / 163 | 审阅之后才选中 announced；attempt `492c5f9c-ca38-4621-bd3b-69f0350aeaed` 随后 succeeded。 |
| 20:15:00.365 / 228 | 因 `unfinished_observed_targets` 选择恢复。 |

Wallet 的风险材料只有 native-button/onclick 等事实，没有可证明界面效果的受控目标。`surroundings.complete=false`，唯一原因是 `owner_too_distant`：保留的 dialog 树共 25 个节点、未截断，button 到 dialog 的父链为 5 层，现有规则限 3 层。程序因此不把该关系作为可绑定的完整上下文。在 `interface=false` 且没有完整结构关系时，不刷新或追加 LLM 猜测，而是保留 `operation_risk_unresolved`。这符合 [reviews.ts:298](/Users/xietian/.codex/worktrees/exploration-layered-refactor/browser-interaction-engine/packages/explorer-plugin/src/reviews.ts:298) 和 [control-surroundings.ts:41](/Users/xietian/.codex/worktrees/exploration-layered-refactor/browser-interaction-engine/packages/adapter-playwright/src/control-surroundings.ts:41) 的契约。

审阅调度确实允许 fresh 的本地操作先执行，但显式排除了导航、history 和退出动作；让步前也保留审阅义务。因此这次不是“只要有程序动作就不做审阅”。见 [reviews.ts:74](/Users/xietian/.codex/worktrees/exploration-layered-refactor/browser-interaction-engine/packages/explorer-plugin/src/reviews.ts:74)。

恢复选择分两步：

1. plugin seq226 先拒绝 Wallet click 义务 `f58b6176-6787-4740-a883-edee512eae43`，原因为 `source_target_unverified`。对临时 source JSON 调用纯 `browserTargetConditions` / `browserBranchConditions`，均返回 undefined。来源中背景隐藏 “Open sub-menu” 带待裁决 identity hypothesis，v2 的全体已观测 selector 条件不能建立；不能通过忽略这些条件把结果改为可达。见 [branch-conditions.ts:90](/Users/xietian/.codex/worktrees/exploration-layered-refactor/browser-interaction-engine/packages/adapter-playwright/src/branch-conditions.ts:90)。
2. seq227–228 选中 `1ef09398-468e-4a74-92e2-7122be1c3029`：`reason=operation_risk_unresolved`，scope 为 dialog / Go to OKX Wallet / button，**无 kind**，`required=true`、`dispatchScope=false`、`attempts=[]`。它要求回到可以继续审阅的来源，不是再次执行 announced，也不授予 Wallet 点击权限。

只有带 kind 的具体操作才填写 `targetActionIds`，所以该审阅义务走 `reachCheckpoint`。见 [runtime.ts:666](/Users/xietian/.codex/worktrees/exploration-layered-refactor/browser-interaction-engine/packages/explorer-plugin/src/runtime.ts:666)、[runtime.ts:833](/Users/xietian/.codex/worktrees/exploration-layered-refactor/browser-interaction-engine/packages/explorer-plugin/src/runtime.ts:833)。现有 target API 同样验证风险、能力和准备条件，不能把无 kind 审阅强行转换为可执行目标。见 [engine.ts:1162](/Users/xietian/.codex/worktrees/exploration-layered-refactor/browser-interaction-engine/packages/core/src/engine.ts:1162)。

## 已确认：17.6 秒恢复为何失败

wrapper 记录总耗时 **17,603.644 ms**。checkpoint 的 path 为 checkbox true attempt `2a820db4-4a56-4862-900d-8f882c9bd91e`，再 checkbox false attempt `98e8dbcb-fc34-437a-9e0e-a986760fb9b7`；path 中没有“打开该弹层”的动作。

| 阶段 | 事实 |
| --- | --- |
| history return | attempt `2395fd72-ddb9-4a38-9107-96bffb4da963`，20:15:03.065–08.841，succeeded，返回 convert URL。 |
| history 后观察 | `fbbc4cbf-1482-41ca-b1e5-37c838473d8f`：stable=true、无 critical gaps、boundaries=[]，已观测控件中没有 dialog、Wallet、announced 或该 checkbox。 |
| entry reopen | attempt `8abe673e-257d-482e-8b56-417b0a1cbd3b`，20:15:10.492–16.767，succeeded。 |
| entry 后观察 | `cfc205c1-bab5-4b44-8bc7-9d2b4c498948`：同样缺少上述弹层与控件。 |
| checkpoint replay | 第一项 checkbox true 的精确匹配数：source=1，history 后=0，entry 后=0。本次 `not_unique_or_missing` 实际是 **missing**。未产生第三次恢复派发。 |
| 后续观察 | `c1d95c73-4ec7-44ae-92d3-76c9b37a0fdd` 已 stable=true，弹层依然不在已观测控件中。 |

replay 使用 controlId、kind、value 匹配，匹配数不为 1 即失败。见 [index.ts:93](/Users/xietian/.codex/worktrees/exploration-layered-refactor/browser-interaction-engine/packages/adapter-playwright/src/index.ts:93)、[engine.ts:1103](/Users/xietian/.codex/worktrees/exploration-layered-refactor/browser-interaction-engine/packages/core/src/engine.ts:1103)。

结束 observation 的 `stable=false`，包含 `UNSTABLE critical=false` 和 `INTERACTION_STABLE`。其他 `STRUCTURAL_LIST_SCAN_TRUNCATED`、`STRUCTURAL_DISCOVERY_LIMIT`、`UNSUPPORTED_CANVAS`、`EVENT_LISTENER_COVERAGE` 也非 critical。whole-checkpoint 校验仍要求 stable，因此最终 status 是 `UNVERIFIED`；reason 则保留真实的 replay missing。两者分别解释状态与失败步骤，不能把目标缺失归因于价格变化或非关键 gaps。见 [engine.ts:1036](/Users/xietian/.codex/worktrees/exploration-layered-refactor/browser-interaction-engine/packages/core/src/engine.ts:1036)、[engine.ts:1384](/Users/xietian/.codex/worktrees/exploration-layered-refactor/browser-interaction-engine/packages/core/src/engine.ts:1384)。

诊断结果列出 `verify_current`、`boundary_exit`、`observed_source_return`、`recorded_path`、`declared_local_restore`、`entry_replay`；`dirtyActions=[]`、`resetAvailable=false`。实际只派发 history 与 entry 两项，没有可用的已记录重开路线或局部还原步骤。初始弹层由网站载入时出现，本轮未观测到可确定重开它的交互。

## 已确认：待办、预算与重试债务均有保留

原库 5 个 SDK attempts 全部 succeeded：3 个 external 探索、2 个 recovery；没有 unknown/executing。任务没有 `pendingDispatch`、`unverifiedRecoveries` 或 `unverifiedNavigations`。这里的恢复 `UNVERIFIED` 是到达未验证，不能改记成未知动作执行结果。

19 个 plan occurrences 中 8 succeeded、10 unresolved、1 pending。Wallet 的 `operation_basis_unconfirmed`、`interface_risk_required`、`operation_risk_unresolved`、`probe_unresolved` 四项仍 unresolved，attempts 为空。没有因导航或恢复派发成功而计完成。

保存的 route key 为 `4781b6c8347fe7977def58b6636fb39c8f1c8f0d8582dd8e1123dce010069d29`，condition 为 `a1a0eef525eeba31e0a479f73e7ff106f4fa052469fb38a2c969b8e699edd3d4`，`attempts=1`、`outcome=unverified`、reason 为 `replay_target_not_unique_or_missing`，证据指向结束 observation，attemptKey 为 `984b09fd-f559-4ef0-9e59-5ed3977dcd55`。`scheduling.routes` 也保存 failure、来源 checkpoint/observation 和目标义务。

已有规则禁止同 route/condition 再试；每个 route 最多保留 16 个新条件，unknown 另行闭锁，累计任务/轮次预算仍适用。失败同样推进轮转 cursor。新条件可以获得有限尝试，所以这不是“整个 route 永久只试一次”。见 [obligation-lifecycle.ts:245](/Users/xietian/.codex/worktrees/exploration-layered-refactor/browser-interaction-engine/packages/explorer-plugin/src/obligation-lifecycle.ts:245)、[runtime.ts:830](/Users/xietian/.codex/worktrees/exploration-layered-refactor/browser-interaction-engine/packages/explorer-plugin/src/runtime.ts:830)。续跑不应清掉这些债务。

## 已确认：SIGINT 留下半暂停状态

| 项目 | 原始持久状态 |
| --- | --- |
| task | paused，revision=2，updatedAt=`2026-10-16T20:15:46.575Z` |
| activeSince | `1792181642914`，即 `20:14:02.914Z`，仍未清除 |
| usage | rounds=1，actions=5，durationMs=0，modelRequests=25 |
| budget | rounds=2，actions=100，durationMs=1,800,000，modelRequests=1000 |
| round | running，startedAt=`20:14:08.131Z`，无 endedAt |
| 最后 SDK 事件 | seq370 `interventions.updated`，`20:15:44.851Z` |
| 最后 plugin 事件 | seq489 returned / seq490 resolved，均 `20:15:46.546Z` |
| 最后 metrics 记录 | `stop.requested`，`20:15:46.575Z`，reason=`operator_signal`，prior.status=running |

没有 `task.paused`、`task.stopped` 或 `round.audit` 的最终完成事件，也没有完整 summary。尚有 decision `195c35fd-8f39-48ad-979e-31a30f941697`：purpose=region-review、status=returned、startedAt=`20:15:45.384Z`、elapsedMs=1147、source observation=`c1d95c73-4ec7-44ae-92d3-76c9b37a0fdd`，未 applied/stale。provider.returned 已于 metrics 的 `20:15:46.531Z` 出现；它不是待确认的浏览器派发。

从 activeSince 到最后可信持久活动为 **103,661 ms**。这可以作为恢复结算的持久证据边界，不能声称所有异步工作恰好在该时刻完成。不得把之后的停机时间当作持续探索耗时。

原实现的启动整理仅扫描 `status=running`，会跳过这条 paused + activeSince + running round。见 [store.ts:115](/Users/xietian/.codex/worktrees/exploration-layered-refactor/browser-interaction-engine/packages/explorer-plugin/src/store.ts:115)。直接续跑存在两种时间问题：`start()` 先 checkBudget，elapsed 将 activeSince 到重启时的停机时间也计算进去，达到 30 分钟会拒绝；若未达到，随后覆盖 activeSince 又会漏掉前窗未结算时长。见 [runtime.ts:64](/Users/xietian/.codex/worktrees/exploration-layered-refactor/browser-interaction-engine/packages/explorer-plugin/src/runtime.ts:64)、[runtime.ts:129](/Users/xietian/.codex/worktrees/exploration-layered-refactor/browser-interaction-engine/packages/explorer-plugin/src/runtime.ts:129)。round 仍 running 还会错过 paused round 的重挂分支，可能新建第二轮。见 [runtime.ts:475](/Users/xietian/.codex/worktrees/exploration-layered-refactor/browser-interaction-engine/packages/explorer-plugin/src/runtime.ts:475)。

这是应修复的生命周期缺口，与前面的负向恢复结果不同。修复由生命周期工作负责；本诊断未改动原始记录。

## 推测、限制与后续建议

**不能从本轮证据断言弹层为什么不再出现。** 网站可能依据浏览器存储或自身生命周期决定显示；未采集足以确定因果的事实。checkbox 最后变回 false 不证明站点存储已还原。现有 entry recovery 调用 `driver.reopen()`，先保存 storageState，再建立浏览器，见 [engine.ts:805](/Users/xietian/.codex/worktrees/exploration-layered-refactor/browser-interaction-engine/packages/core/src/engine.ts:805)、[browser.ts:994](/Users/xietian/.codex/worktrees/exploration-layered-refactor/browser-interaction-engine/packages/adapter-playwright/src/browser.ts:994)。

新 session 或进程重启后的 driver attach 使用原 sessionOptions；本轮没有 storageState，因此会创建空 context，**可能**重新看到提示，但不保证。新观察也不证明恢复了原业务状态。见 [engine.ts:416](/Users/xietian/.codex/worktrees/exploration-layered-refactor/browser-interaction-engine/packages/core/src/engine.ts:416)、[browser.ts:472](/Users/xietian/.codex/worktrees/exploration-layered-refactor/browser-interaction-engine/packages/adapter-playwright/src/browser.ts:472)。是否重显应在结算修复后，通过实际 resume 的新证据验证。

通用重启结算建议覆盖 running 及带未结算痕迹的 paused/stopped 组合，保持幂等；使用可信持久活动边界并披露无法确认的尾段，而非直接计至重启时刻。应保留 `pendingDispatch`、原 SDK attempt 状态、unverified recovery/navigation、route 债、累计动作/模型用量和历史 plan occurrence，仅把中断决策标为不可继续应用、归一化轮次与时间。unknown 继续由原始执行账本和恢复校验阻断，不能被新浏览器或归一化消除。可参照 [runtime.ts:350](/Users/xietian/.codex/worktrees/exploration-layered-refactor/browser-interaction-engine/packages/explorer-plugin/src/runtime.ts:350) 的 dispatch reconciliation 与 [runtime.ts:359](/Users/xietian/.codex/worktrees/exploration-layered-refactor/browser-interaction-engine/packages/explorer-plugin/src/runtime.ts:359) 的原 session 恢复结果审计。

恢复诊断可以独立增强：附 `failedAttemptId`、匹配数，并记录 history/entry 各阶段 checks，以直接区分目标缺失、目标歧义与观察未稳定。审阅对象到达和可执行操作到达也可以另立契约研究，但不能为本次实验通过而弱化现有身份、风险、源条件或 checkpoint 验证。

`control-surroundings` 的 3 层限制排除了本次已保留的 25 节点弹层关系，可作为有界证据采集的独立改进研究。更多上下文不保证 Wallet 获批；同一弹层中的关系也不能自动成为风险授权。当前证据不支持把这一限制或不可重放的弹层生命周期直接认定为必须立即修复的到达 bug。
