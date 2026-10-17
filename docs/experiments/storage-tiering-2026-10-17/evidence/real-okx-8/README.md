# 第八窗：到达后能继续操作，条件覆盖仍被阻断

运行版本为 `a82f6c5010903f762e0d7740c404c1f903d16df5`，已快进合入 main，包含 autonomous `4857ad5`。发布构建对应产品 `7c1bf9c`；其后仅增加验收工具的恢复异常停止修复及文档，产品包没有变化。分别引用[发布检查点](../step3-release-7c1bf9c/README.md)、[异常停止检查点](../recovery-exception-stop/README.md)及[合并记录](main-merge.json)，不重跑未受影响的完整协议。

本窗 **没有通过第 3 项的真实新覆盖验收**。源码行为与读取成本检查点已经通过，真实页仍需解决以下证据阻断，不能将此次窗口标为整体完结。

## 运行与保留

- 独立任务 `6c56a979-34f0-4599-a5b7-9461c357144d`，继续原 session `412937f3-c4f5-4799-b86c-74adf480f329`，没有重置旧计划、失败债或预算。
- run `01743316-6907-4c32-89ea-d97a2ffc26f9`，2026-10-17 03:54:55–04:05:39 UTC。
- 十分钟缺证复核期限触发 `progress_evidence_unavailable_window`。停止请求在 04:05:28.091、结算在 04:05:31.563；最终控制记录 finished、任务 paused，unknown、executing、未结算 provider 均为零。退出码 2 表示需审计，并非验收通过。
- 原始导出只保留在 `.data/okx-storage-acceptance-20261017-v1/runs/01743316-6907-4c32-89ea-d97a2ffc26f9/`，整套已关闭目录原地封存，不再复用为写入目录。见[增量哈希清单](closed-evidence.json)：5,435 文件、190,653,489 B；相对既有第七窗，4,508 文件未变、924 新增、3 改变、0 删除。没有重复复制整套历史。
- [离线核对](receipt-audit.json)仅打开[独享临时 SQLite 副本](audit-copy.json)。每会话批量查询一次；没有创建 driver，没有查询写入，原始导出前后哈希一致。脚本 `passed=true` 只表示审计过程与计数一致，不表示覆盖通过。

## 分开计数

| 指标 | 结果 | 可支持的结论 |
| --- | --- | --- |
| 来源到达 | `SOURCE_REACHED` 1/1，16,173.522 ms | 返回观察后实际执行了 Trade；`checkpointVerified=false`，不是完整检查点还原 |
| 本窗实际动作 | 探索成功 11、恢复 history 成功 1 | Trade → Spot 后继续图表周期与输入；没有 unknown 或执行中记录 |
| 覆盖条件证明 | 探索 0/11；portable/document 均 0 | 11 项直接原因均为 `identity_pending`；不能把执行成功记成覆盖 |
| 恢复动作覆盖查询 | history 返回 `source_target_not_unique` | 无控件目标的 history 不是探索覆盖样本；不因此否定独立 SOURCE_REACHED 结果 |
| 旧 arrival candidate | 0 | 与 receipt 覆盖是不同口径；本次两者恰好均未建立证明 |
| 新结案计划 occurrence | 0 | 不能以动作次数替代待测范围完成 |
| 计划 | 803 → 874，原 803 项均保留 | 增加 71 项，其中 47 项为区域审阅需求；未证明由价格抖动导致或最终可收敛 |
| 条件完成重核 | 56 项 unverified：32 retained-source、24 identity-pending | 旧无条件证明的成功保持实际尝试，重新留下待测范围；不是自动回填覆盖 |
| 模型调用 | JEV 14，LLM 0；全部结算 | 此窗调用量，不能与不同覆盖路径的旧窗口推断算法提速 |

六条旧路线失败条件原样保留。必要重入、无理由重复与跨会话语义新增尚不能定量；同名动作、共享标识和 document key 均不足以判等。历史动作简表留在审计结果中，未增加自动语义匹配算法。

## 已定位的阻断与下一检查点

1. core receipt 查询对整个 session 的任意 pending 身份直接拒绝。11 个实际目标自身均无 hypothesisId，但 196 条 pending 中仍有与各 before 相关的记录；9/11 份所需集合自身含 pending 模式控件。因此只过滤无关历史不能解决本窗，不能直接删除身份门禁。
2. 所有新回执的 before 依赖图都因 `unretained_native_input` 失败，roots/nodes 为零，after 无 dispatch witness。动作采集排除隐藏 input，依赖采集遇到遗漏原生字段就整体拒绝；这不是已经证实的预算截断。即使处理第一项，仍然没有同文档覆盖证据。

[原生字段与身份诊断](collection-diagnosis.json)另确认每份 before 漏 1–2 个隐藏 input，保留原生控件 6–7 个、页面材料有 7–9 个，不能因为值为空而忽略。必需 selectors/native 的 owner 节点下界为 390–507，未包括全部 IDREF 和目标附加闭包；不能保证补采后通过原 512 节点预算。诊断脚本按原哈希移动到本目录 `collection-diagnosis.mjs` 保存一次，报告中的临时执行路径保留为历史事实，未重新运行。

后续分别补齐 dependency-only 原生字段与显式实例范围内的覆盖契约，先做定向反例检查；portable、到达、重放、unknown 和非唯一实例门槛保持。新增真实窗口必须等到证据链在受控条件下通过，且有明确的产品变化作为重跑理由。旧观察和旧派发证据不回填；任务库进一步压缩与全量读取保持后续。

## 性能与存储边界

此前固定四个真实本地 receipt 的记录读取 44→17、列表读取 56→23，证据仍只在[批量检查点](../receipt-condition-batch/README.md)。本窗的 16.174 秒是单次来源返回，不是受控前后速度比较，也不能推断恢复成功率提高。

本窗关闭后 engine DB 为 114,073,600 B、plugin DB 为 16,781,312 B，均随新历史增长；没有新压缩收益结论。离线审计批量耗时约 299 ms，只描述副本审计成本，不计为生产性能提升。
