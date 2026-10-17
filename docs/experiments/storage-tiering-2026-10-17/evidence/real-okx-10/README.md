# 第十窗：局部退出后取得实际条件覆盖，严格恢复仍未通过

产品 `2bee1db34b01c29e39066344bfb865351b7222c5` 已完成隔离发布检查；源码/main 为 `4f868d68494dd59853f2a6d03afb5d80e695e532`，包含 autonomous。窗口 `717bba24-03b5-487f-a96a-b60ef8cd9972` 已正式关闭，launcher exit 2；原始停止原因是 `recovery_not_verified`。最终 paused/user_paused 是停止结算状态，不能替换原始原因。

本窗 4 次实际探索均成功，唯一离线 SDK batch 的 4/4 receipt 获得 `browser-document-coverage-v1` 条件证明：

| 实际操作 | 输入 | 有效 document 条件覆盖 | 必需控件完整数 | 额外原生根完整数 |
| --- | --- | --- | --- | --- |
| Don’t show for 7 days / check | `true` | 是 | 33/33 | 1/1 |
| Don’t show for 7 days / check | `false` | 是 | 35/35 | 1/1 |
| Close / click | — | 是 | 36/36 | 1/1 |
| Trade / click | — | 是 | 34/34 | 1/1 |

两次同名 check 的布尔输入及条件 key 不同，不能直接记作重复。Close 的现有 `interactionTransition` 查询返回 `verified=true`、`documentChanged=false`、`exited=[dialog:okd-dialog-window]`、`entered=[]`、`navigated=false`；边界从该 dialog 变为空。Trade 的 beforeId 精确等于 Close 的 afterId（`d85c8536-8efe-4b97-9d47-9482d53f6f4d`），随后实际执行并获得有效条件证明。这支持“可见局部退出后继续产生本窗实际覆盖”，不证明跨会话语义新增或必要重入。

四份 receipt 的 `identityAuthorized`、`replayAuthorized`、`arrivalVerified` 全为 false。工具旧 arrival candidate 仍为 0，与上述 document receipt coverage 口径不同。后续严格 `reachCheckpoint` 对 `fab896e5-dae5-45e7-a62f-fd5755eae2b3` 返回 `UNREACHABLE`：历史路径含没有重放许可的动作，耗时 14,232.741 ms、恢复动作 0。可见边界退出不能替代 checkpoint/source/operation 到达验证，**第 3 项的真实到达及接续验收门仍未通过，本项未完结**。

冻结 exports 的计划/失败债对照见 `continuation-check.json`：876→1,106，旧 ID 全部保留，旧 scope、前置路径、required、dispatchScope 及 operationConditionKey 未改；新增 230 条中 221 条为待区域审阅、5 条 pointer_intercepted、2 条 operation_not_executed、1 条 action_basis_unconfirmed，另 1 条实际成功。新增行数量的语义意义尚未确定，不能等同 230 个新 UI 分支。逐计划条件结案只有 1 条 verified，另 58 条 unverified；4 份有效新 receipt 不足以结清所有历史来源。六份旧路线债逐记录不变；路线/条件/失败落点数从 6/11/3 变为 7/12/4，仅增加本窗一份 unreachable 记录，未清除旧债。新 route key 的必要性不能由计数证明。

JEV 6、LLM 0；unknown、在途动作和待返回 provider 均为 0。全部新 receipt 的派发原 wire 哈希及时间校验通过，必需依赖没有诊断缺口。审计只对授权的独立临时副本执行一次 batch，并已关闭 host/store；构造改写、查询写入、driver 调用均为 0，副本字节未变。`receipt-audit.json` 中的 `passed=true` 仅表示审计流程检查通过，不是整体验收或穷尽。该窗没有性能/存储对照；恢复失败耗时和离线查询耗时均不作提速结论。

原始证据只保留在 `.data/okx-storage-acceptance-20261017-v3/runs/717bba24-03b5-487f-a96a-b60ef8cd9972`；冻结目录及输入哈希由 `closed-evidence.json`、`receipt-audit.json` 与 `continuation-check.json` 引用，没有复制完整输入。冻结 v2 全树哈希保持。此报告整理只读既有 JSON，未再开 DB、查询 SDK 或重跑测试；保留第八/九窗负面结果，不回填旧回执成功，也不因第三门未过而重复开窗。

随后完成的[有界选路诊断](recovery-diagnosis.md)确认一个独立问题：近期来源已经通过现有实例连续性条件，调度却只跳过该候选，继而为同一未完成审阅项选择旧来源。诊断未运行恢复或增加覆盖。唯一临时数据库副本在审计和诊断都结束后已清理；所有权和前后指纹核对见 `audit-copy-cleanup.json`，原始冻结数据保留。
