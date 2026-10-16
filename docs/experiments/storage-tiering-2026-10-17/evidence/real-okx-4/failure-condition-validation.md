# Run 4 失败落点条件离线验收

新迁移路径在真实冻结材料上阻止了 Wallet 的重复恢复，并保留原待测项。原始行为和原因见 `recovery-diagnosis.md`；本次结果及逐文件 SHA256 见 `failure-condition-validation.json`。

实际调用的是 `ExplorerPlugin.scheduledRecovery`，不是只调用 ledger helper。输入为原始 `task-before.json`，plan 仅保留原来的 URL 根授权 `bf26248e…` 与 Wallet 项 `93cb64e4…`；旧 route、round、ledger、来源和检查点保留。当前观察使用本轮第二次恢复前的真实 `9ca9a659…`。`host.observation/actions/list/interactionTransition/session` 来自独享临时 SDK 副本；没有模拟 observation 内容。

| 核验 | 结果 |
| --- | --- |
| 868e8b47 旧行为 | `613636…` 被视为 `new_condition`，allowed=true |
| 新 legacy 迁移 | 读取旧 `cfc205c1…`，重算条件一致，保存 `replay-target-unavailable` 负证据 |
| 新资格判断 | allowed=false，reason=`failed_result_condition` |
| 实际 scheduledRecovery | 不返回恢复候选，deferred 原因为 `route_retry_failed_result_condition` |
| 原始尝试 | `a1a0…` 仍 attempts=1；除新增 resultCondition 外，原记录逐字段不变 |
| 条件数量 | 入场条件仍只有一个，失败落点没有被计为第二次动作 |
| plan | 内容、scope、状态完全不变，Wallet 仍 `unresolved` |
| 二次调用 | ledger 与事件数量均不变，迁移幂等 |

另用真实本轮最终观察 `c4fae20b…` 和实际 reason `Entry replay verification: UNVERIFIED` 检查不稳定边界。该帧 stable=false，虽然有 `INTERACTION_STABLE`，helper 仍不保存负条件。为完整覆盖迁移分支，把这对真实观察/reason 反事实关联到旧 Wallet ledger，再调用 `scheduledRecovery`：它返回 Wallet 候选，未补 resultCondition，attempts 仍为 1，未执行恢复。这是明确标注的反例构造，不是声称历史 ledger 存在这项关联。它只证明未尝试的落点 B 不因不完整结果增加负 alias；原始入场 A 的预算仍已消费，若原本从 B 入场再落回 B，不能以纯 UNSTABLE 自动重试。

该脚本只验恢复选择，不运行完整 step。availability 使用空集合：目标 Wallet 本来就不在当前帧中，因此不会用这份集合评估它的当前可执行性；这也不能用于统计当时其他本地工作的可执行数量。

源码基于 HEAD `868e8b47afd31782161deba4f8bd7a14e0349430` 加本轮未提交修复，全部 `packages/**/src/*.ts(x)` 的内容清单 SHA256 为 `d1f3b174dbec03db89a3326084e093298602ae61c62c64432f22e5bfccdc7851`。运行前后逐文件 hash 相同；JSON 保存全部源文件 hash，避免把 dirty 源码标成旧 commit。此验证不是计时基准。

脚本没有连接原运行库或冻结库，而是复制两个已冻结 SQLite 文件至独享临时目录。冻结库、task-before 和旧诊断 JSON 的前后 SHA256 均一致。浏览器启动、网络调用、非白名单 host 方法调用均为 0；临时副本已关闭并删除。没有修改产品源码、raw 材料或真实浏览器。
