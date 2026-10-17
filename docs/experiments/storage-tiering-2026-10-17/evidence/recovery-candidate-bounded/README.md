# 新版单次 240 秒有界候选扫描

结论：新版也超时；本次证明主要成本位于恢复候选扫描中的反复事实复核与材料构建，尚未证明总体提速、完整选择语义等价或恢复成功率提升。未延长上限、重跑基线或追加第二个新版样本。

## 版本与范围

- 固定产品：`fe3cb7a70585de64c6638c6b43584bce141d969a`。工作分支 `codex/exploration-layered-refactor`，记录开始时 HEAD `8c6ce549055e64d74e8bf528c491546ec210c832`；两者产品源码相同，后者只增加此前证据。
- 工作区：`/Users/xietian/.codex/worktrees/exploration-layered-refactor/browser-interaction-engine`。本次无产品修改；新增诊断工具和本目录证据，保留既有未跟踪文件。
- 子代理 `/root/candidate_bounded_run` 执行唯一新版样本，主代理独立核对原日志、输入和工具哈希、进程退出及临时目录删除。
- 与[此前基线](../recovery-anchor-material/execution.json)使用相同冻结输入、Node/内存上限和 240 秒进程期限。输入来自已关闭的第十二窗最终事实，只在内存把 task.status 从 paused 改为 running；不是原长扫描时点的精确回放。
- 使用自有临时数据库副本；未连接原浏览器、源任务数据库或真实服务。保留 InspectionCoordinator 原有计时器，计时器读取单列为 unattributed。
- 新版增加阶段及调用遥测，基线没有这些计数。两个未完成样本不能用于计算加速比、比较实际吞吐或断言完整行为一致。

## 阶段与实际处理量

下表的调用次数/耗时来自完整 `worker.jsonl` 的外层 host begin/end；最后一个完整材料调用未完成。耗时包含内部工作及遥测开销，不能再与内层 store 耗时相加。

| 阶段或外层调用 | 实际处理量 | 耗时 |
| --- | --- | --- |
| 输入、导入、构造、当前事实准备 | 全部完成，进入 scheduled_recovery | 1.130 秒 |
| 当前 actionAvailability 复核 | 544 次完成 | 95.028 秒 |
| 完整 recoverySourceMaterial | 2773 次开始，2772 次完成 | 已完成累计 79.840 秒 |
| 轻量 recoveryAnchorMaterial | 857 次完成 | 12.026 秒 |
| 直接当前 observation / actions | 各 544 次完成 | 分别 7.082 / 7.159 秒 |
| checkpointRecoveryCandidates | 1 次完成 | 2.118 秒 |
| 候选返回、最终回调、完整语义核验及序列化 | 均未进入 | 无结果 |

最后一次汇总在 worker elapsed=239.775 秒：

- `deferObligation` 已处理 826 个不同 item，调用 826 次；其中仅 38 次新增 `obligation.route_unavailable` 事件。事件数不能替代处理量，暂缓也不代表新覆盖。
- 暂缓原因：source_target_unverified 497、retained_checkpoint_unavailable 248、current_review_occurrence_present 69、route_retry_condition_attempted 6、unchanged_unresolved_review 3、source_review_target_not_available 2、checkpoint_no_known_path 1。
- 完整材料已开始 2770 次，来源只有 58 个，同来源重复访问 2712 次；后续日志还有 3 次开始、3 次完成，最后停在下一次完整材料读取中。
- 轻量材料涉及 35 个不同来源；当前 observation 的 raw get 已达 4948 次。raw get/require 有嵌套，不能相加当作独立查询、物理 I/O 或磁盘解压次数。
- 这些是处理量下界，不是 1241 条计划的完成比例；候选是否全部检查、最终选择及 callback 结果均未知。没有浏览器操作、新到达或新覆盖证据。

## 定位与下一补丁边界

1. `packages/explorer-plugin/src/runtime.ts:724` 的 resume 每次重新读取 observation、actionAvailability、actions 并核对摘要。其 `actionAvailability` 进入 `packages/core/src/engine.ts:446`，再次读取当前 observation/actions 并执行完整约束校验。544 次复核累计约 95 秒，是明确热点；同一同步复核内存在重复读取当前帧的路径。
2. `packages/explorer-plugin/src/runtime.ts:781` 的完整材料缓存限制为 8 个来源，且在 `:806` 的 invalidate 清空。`packages/browser/src/index.ts:124` 每次构建完整材料都重新读取来源动作及当前观察，计算 transition。2772 次完成只涉及 58 个来源，重复构建成本已实测。
3. 轻量 API 确实执行（857 次），但不能由此推出相对于旧版节省了多少调用或耗时。此前对分类复用历史解码的热点猜测仍缺少足够归因，不作为下一补丁依据。

用户随后指出“补正确性增加成本、补成本又威胁正确性”的循环风险。当前数据支持前半段的成本问题，但没有证明本次轻量优化引入新的正确性回归；完整运行仍未完成。下一步先审查不可变事实、可变判断及有效期的契约，再决定实施范围。一次同步复核共享读取只能减少局部成本，不能解决跨批次全面重建的结构性问题。若采用变更版本或读视图，必须覆盖所有相关写入、跨实例变化及自定义读取；现有 detached 声明和 observation ID 本身都不是新鲜性证明。不直接跨 yield 缓存权限或负面判断，不减少最终验证，也不扩大时间预算代替优化。暂不追加产品补丁或测试。

## 证据与清理

- [execution.json](execution.json)：唯一 worker PID 2334 在 240 秒上限后 SIGTERM 退出（−15），未使用 SIGKILL；临时副本在确认退出后删除。
- [setup.json](setup.json)、[source-manifest.json](source-manifest.json)：固定版本、隔离归档和输入绑定；引用既有冻结输入，不复制原库。
- [worker.jsonl](worker.jsonl)：阶段、外层调用及处理量的唯一原始记录；stderr 为空，没有 forbidden/worker.error 事件。超时使完整 worker report 和结尾语义断言未运行，不能把它们记为通过。
- 工具唯一位于 `../recovery-selection-profile/runner.py` 与 `worker.ts`。该目录原为未执行的诊断准备，已改为本次新版运行；没有执行额外的 60 秒基线诊断。
- 主代理复核源输入、工具与引用的旧证据哈希一致；临时主库哈希与源一致、WAL 为零字节，运行日志含 query_only 守卫。进程已不存在、临时目录已不存在。超时前没有完整 total_changes 终值，不虚构该断言通过。

行为检查沿用[轻量材料行为检查点](../recovery-anchor-material/README.md)，不重复已过测试。第 3 项的真实到达及后续新覆盖门仍未通过，本次不构成发布或合入 main 的新性能依据。
