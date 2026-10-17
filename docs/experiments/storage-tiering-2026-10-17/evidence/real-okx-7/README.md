第 7 窗正常完成停止与结算，但没有达成严格恢复或穷尽。原始自动停止原因是 `recovery_not_verified`：第二次 `reachCheckpoint` 返回 `UNREACHABLE`，理由为 `Checkpoint path contains actions without replay permission`。随后收敛到 `paused / user_paused`；后者是暂停后的通用状态，不能覆盖原始停止原因。进程结束后的 operator stop 返回 `NO_ACTIVE_OWNED_RUN`，不是本次终止原因。进展审计窗口尚为 pending，未到 600 秒期限，也没有被记作本次停止原因。

本轮固定产品提交 `069b65b47d951cdcced4d895e2abe33738267e5a`，runId `e38c02f1-d0b9-4c8c-bb9d-474cb0c1db1e`，沿用任务 `6c56a979-34f0-4599-a5b7-9461c357144d`。记录窗口 347130 ms；它与任务累计 duration 的增量口径不同，历史中断不确定性仍保留，不能宣称任务累计时长精确。事实从 [summary](run/summary.json)、[metrics](run/metrics.jsonl)、task/plan-occurrence 前后 JSON 和 [freeze](freeze.json) 核对；[facts.json](facts.json) 保存输入 SHA、逐动作对应、计数和时间区间。本次分析只读取已导出文件，没有打开数据库、浏览器或 provider，没有改产品。

两次恢复采用不同契约，不能合算为一次“成功恢复”或拿来宣称成功率改善：

| 调用 | 结果与耗时 | 事实边界 |
| --- | --- | --- |
| `returnToObservedSource` | `SOURCE_REACHED`，14761.087 ms；单次 history 动作 succeeded；11 checks 全 pass | 源 `b1d59647…`，结果观察 `22adf3b5…`。只达到观察过的位置；`checkpointVerified / sourceStateRestored / currentExecution / executionAuthorized` 全为 false。 |
| `reachCheckpoint` | `UNREACHABLE`，11424.335 ms；attemptIds 空 | 检查点 `b1e80845…`，旧源 `5f80a3df…`，选中历史 `identity_unresolved / Open sub-menu` 事项 `35a22c35…`。当前可观察状态检查失败，路径含没有 replay permission 的动作，未执行回放；触发自动停止。 |

实际新增 8 个独立 succeeded attempt：7 个探索入口动作，另 1 个恢复 history。SDK 中这 7 个动作的 purpose 是 `external`、executionProfile 是 `interface-exploration`，报告中的“探索动作”采用此运行用途，不改写 SDK purpose。

| 顺序 | 实际动作 | 输入/计数 |
| --- | --- | --- |
| 1 | check `Don’t show for 7 days` | `true` |
| 2 | check `Don’t show for 7 days` | `false`；与 true 是不同输入样本，不能按标签算重复动作 |
| 3 | click `announced` | 1 次 |
| 4 | history `Return to observed page` | 1 次，归恢复 |
| 5 | click `Trade` | 1 次 |
| 6 | click `Open Spot sub-menu` | 1 次 |
| 7 | click `1W` | 1 次成功；较早另一次选择因 `STALE_OBSERVATION` 失效，没有对应完成 attempt，不能算第二次执行 |
| 8 | click `1M` | 1 次 |

实际 provider.decide 调用 JEV 27 次、LLM 0 次，27 次均返回、无失败/取消、结算后 pending 为 0。JEV 用途为 region-review 22、probe-risk 2、control-classification 1、identity-review 1、control-risk 1；累计调用耗时采用 summary 受控 wrapper 的 19222.407 ms；逐条 provider.returned 的 elapsedMs 相加为 19201.336 ms，二者采样/汇总口径不同（差 21.071 ms），均保留于 facts.json，不混用。这是 provider 接口调用数，不能替代计费 HTTP 请求数。最终无 unknown 或 in-flight attempt。

计划从 721 行增加到 803 行（+82），未删除旧 item。前后 occurrence 数也为 721→803，均无重复 occurrence key，原前缀完整保留；这只核实记录结构，不证明不同来源在语义上互不重复。

| 状态 | 前 | 后 | 增量 |
| --- | ---: | ---: | ---: |
| unresolved | 509 | 579 | +70 |
| pending | 181 | 189 | +8 |
| succeeded | 30 | 34 | +4 |
| untested | 1 | 1 | 0 |

82 个新行的最终状态恰为 unresolved 70、pending 8、succeeded 4；721 个保留行的最终状态与运行前一致（不代表中间没有 reopening）。新行 reason 为 region_review_required 49、observed_in_scope 12、classification_unresolved 7、operation_basis_unconfirmed 7、operation_not_executed 3、pointer_intercepted 2、identity_unresolved 1、Control is not visible or enabled 1。新增行不能仅凭同标签/hash视为可合并；此次事实报告不执行语义去重。计划导出 JSON 从 1480384 B 到 2885667 B，这是导出文本字节，不能当作任务库物理增长或写入量。

7 次探索成功全部仍为 `target_conditions_unavailable` 的 unkeyed success；本轮 `newOperationConditionCandidates=0`，`semanticCoverageEstablished=false`。4 个新增 succeeded 计划行、7 个成功 receipt 和 0 个新增条件候选是不同指标。已有调度 key/规范化审计不能替代 SDK 条件证据，更不能据此声称新语义覆盖、可回放进展或整页穷尽。

已有成本与待查原因分开记录：

- `scope.audit` seq5138（00:55:36.104Z）到 `recovery.selected` seq5369（00:56:20.084Z）间隔 **43.980 秒**，期间记录 229 个 `obligation.route_unavailable` 和 1 个 `obligation.selected`。这是候选筛选阶段的事件墙钟窗口；具体 CPU/数据读取归因仍待 profile，不能把整段直接认作某函数耗时。
- Trade 后有 **5 批 region 审阅，各跟随一次新 Observation**，对应 5+5+5+5+1 共 21 次 region JEV 调用；另 1 次 region 调用发生在前面的弹窗阶段。五个 `region.reviewed → observation.created` 事件间隔为 4232、4268、4261、4277、4301 ms，合计 21339 ms。重复审阅/采集周期是已观测成本；这些区间不是底层 capture 的纯 CPU 计时，也尚未证明每次都可安全省略。

关闭后磁盘与第 6 窗关闭后的同一任务历史比较如下（字节）：

| 项目 | 第 6 窗关闭后 | 第 7 窗关闭后 | 增量 |
| --- | ---: | ---: | ---: |
| engine DB | 74858496 | 93876224 | 19017728 |
| plugin DB | 6598656 | 11325440 | 4726784 |
| evidence manifests | 2362245 | 3015629 | 653384 |
| evidence blobs | 12174588 | 15154692 | 2980104 |
| runner/logs | 14470129 | 23930296 | 9460167 |
| 总计 | 110464114 | 147302281 | 36838167 |

两次关闭后 DB 的 WAL/SHM 均为 0。run7 首个运行中 sample 总计 113980327 B，包含当时 WAL/SHM 和新日志，不能当作第 6 窗关闭基准。稍后 freeze 为 4511 文件、147334611 B，比 summary 的关闭测量多 32330 B；该差额来自关闭测量之后写入的 summary/元数据，属于不同采样时点，不是矛盾、DB 增长或压缩收益。冻结记录确认原目录复制前后及副本全 SHA 一致、两个 SQLite integrity 均 ok、无进程、无 WAL/SHM；本次只引用已有检查结果，没有重开库。以上是同一历史任务持续增加证据的体积变化，不是新库、同工作量性能对照或压缩效率结论。

后续先定位和优化 route candidate calculation；任务库进一步压缩、减少全量读取安排在之后。当前没有启动新的真实实验，不宣称穷尽、恢复成功率提升或整体性能提升。
