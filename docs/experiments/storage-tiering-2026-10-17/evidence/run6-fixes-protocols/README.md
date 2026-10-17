本轮在 `125a10ca6dbc78f8dd859a0e7a2917f83d67b55b` 完成相同的 16 场景、80 次独立本地 fixture 协议，8 条执行命令全部退出 0，原摘要器的 348 项当前完整性检查全部通过。源文件清单包含 459 个文件，执行前后摘要完全一致。

详细行为并不完全相同。与 `70b8cb4`、run5 两个基线分别按协议、场景、重复序号配对后，均为 40 次相同、40 次不同。原摘要的 `aggregateBehaviorEqual` 和 `perScenarioBehaviorEqual` 均保持 `false`；未放宽 oracle，未忽略新的差异字段。唯一汇总行为差异是 `cold_nested_restart` 的 JEV 总数由 30 降为 25。逐次差异还包括计划行数、待测行数、重复待测标签及对应阶段计数，全部保存在 `trial-comparison.json`。

| 场景（各 5 次） | 每次可重复观察到的变化 | 未变化的验证结果 |
| --- | --- | --- |
| public-form-cycle | 初始/最终计划行 5 → 3 | 2 次实际动作、2 个声明分支，待测 0 |
| shared-id-rebuild | 最终计划行 7 → 5 | 2 次实际动作、2 个分支，待测 3 |
| price-known | 最终计划行 5 → 4 | 1 次实际动作、1 个分支，待测 3；100 次 tick 不增长 |
| price-unknown | 最终计划行仍 7，待测 5 → 6 | 1 次实际动作、1 个分支；100 次 tick 不增长 |
| nonlocal-dependency | 最终计划行 8 → 6 | 2 次实际动作、2 个分支，待测 4 |
| cold_nested_restart | 计划 11 → 6；JEV 6 → 5；重复待测 Branch B / Outside 标签各两份 → 各一份 | 三个叶子各实际执行一次；必要重入 3；恢复 1；无遗漏或错误结算 |
| failed_recovery_restart | 计划 6 → 4；重复待测 Branch B 标签两份 → 一份 | Branch B 后续成功；原 checkpoint_unverified 债与 root 未被误结算 |
| unknown_recovery_restart | 计划 6 → 4；重复待测 Branch B 标签两份 → 一份 | unknown 保留；Branch B 未执行；重启后新增 session/attempt/recovery/JEV/LLM 均为 0 |
| 输入身份的 2 个场景 | 10 次逐次详细行为一致 | 40/40 对应检查正确，30 次实际输入成功 |
| 恢复的 6 个场景 | 30 次逐次详细行为一致 | 正向到达与两种负向保护保持原判定 |

续跑协议的原始 `phases[].plan` 能直接解释少行：基线为同一目标分别保存 `observed_in_scope` 和 `operation_not_executed`，当前保留一项 `observed_in_scope`。五个控件在 cold_nested_restart 中由十项变五项，再加原 root；另两场景各两个控件由四项变两项，原 checkpoint/unknown 债及 root 仍保留。`continuation-plan-comparison.json` 按全部 15 次试验提取了原行、状态、来源/尝试数与审阅调用；原始材料未被改写。cold_nested_restart 的调用从一次分类加五次区域审阅变为一次分类加四次区域审阅。此处减少的是实际观测到的一次区域审阅，不能把少行直接当覆盖率提升。

条件协议只保留阶段计数、动作与 oracle，没有完整计划行；因此其少行不能仅凭本协议逐行证明来源安全。变化与本轮未完成义务聚合及全来源完成门相符，但因果和来源安全还需产品专项证据。尤其 price-unknown 多保留一项待测应明确披露，不可为了数量一致删除或改为成功。该场景及 known 场景的 100 次 tick 均无计划/待测增长，原 oracle 仍通过。

本次检查覆盖真实 fixture 事件与 SDK 派发结果，而不是队列是否清空：25 次条件协议全部执行声明分支且误覆盖为 0；15 次续跑的 lostPending、incorrectlySettled、duplicateLeafExecutions、unnecessaryReentries、repeatedNoProgressRecoveries 均为 0。unknown 续跑 5/5 保留原未知且没有后续成功探索；未执行 Branch B 是预期的安全负例。恢复的 20 次正向试验同时证明报告到达、物理到达和受保护分支产出；5 次 local_inverse_diverges 三者均否；5 次 unknown_outcome_injected 虽物理位于目标，却拒绝报告到达和分支产出，并保留原 unknown。全部恢复试验误报到达为 0。

复现材料：`runner.py` 与 `commands.json` 保存八条原执行命令/退出码，`runner.log` 和各命令日志保留原输出。`summarize.py` 是既有 restart-state-protocols 摘要器的原样副本，SHA-256 为 `d3218b0bdaf619aa57c119fededcfd4420fed5a0d56ed1458a65d1bfff09cf8c`，与 run5 校验记录一致。`validation.json`、`comparison.json`、`summary.json` 对照 70b8；`versus-run5/` 使用同一摘要器对照 run5。70b8 自身有 347 项完整性检查，当前与 run5 为 348 项（增加 executionComplete 检查），没有删改检查。脚本、fixture 与测量契约哈希在两次比较中均相等。`analysis-commands.json` 保存摘要/逐次配对的命令与退出码，`files.json` 保存本目录归档文件哈希。

范围：只运行本轮独立本地 fixture，未访问真实 OKX、provider、原实验数据库或用户浏览器。协议不测存储字节/CPU，也未计 unknown 场景的 observe 次数；全量套件/隔离编译同期进行，耗时不用于性能改善结论。结果证明这些有限场景的 oracle，不证明真实站点穷尽。执行完成之后另行发现并修复了 UI 导入 node:crypto 的编译问题；这里的 source-before/source-after 均属于 125a10c，不能把本报告改标为后续修复提交的验收。
