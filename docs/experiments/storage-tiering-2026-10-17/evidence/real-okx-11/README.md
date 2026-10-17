# 第十一窗：修复命中，严格恢复仍未通过

产品 `f3c4316`，运行 source/main `d71f1d52a4d4840526f282f923769c7d037ec525`；run `01958656-8614-4f9b-b571-a182b5cd8bbc`。本窗唯一新增验证理由是检查 `current_review_occurrence_present` 后不再回退该 item 的旧 checkpoint。窗口于 `2026-10-17T06:05:46.611Z` 结算，launcher exit 2，原停止原因 `recovery_not_verified`。最终 `paused/user_paused` 是停机收束，不替代原失败原因。

- **修复命中：** `metrics.jsonl` sequence 10924 的 header item `a244066d-3c7a-41c2-a430-5a579f67f3ba` 按 `current_review_occurrence_present` 延后，`retainedInPlan=true`、`coverageGranted=false`。随后失败的是另一 item `e5ecf883-54ce-49a5-ad77-804ec9ebd537`（Main menu / Trade / generic，历史 `classification_unresolved`），不是上一窗 header item 的旧 route 再试。本窗点击的 Trade 不能仅凭同名视为该 generic 审阅目标已完成。
- **实际探索与条件覆盖：** 4 次成功为 check `true`、check `false`、Close、Trade；唯一离线批量审计得到 **4/4 同文档条件覆盖**。Close 的只读 transition 验证退出 `dialog:okd-dialog-window`，未换文档、未导航；其 afterId 与 Trade 的 beforeId 相同，证明退出后继续实际操作并取得条件覆盖。4 个回执的 identity/replay/arrival 授权均为 false；legacy arrival candidates 仍为 0。跨会话语义新增及必要重入仍未被本审计证明。
- **严格恢复：** checkpoint `d43e6f7d-2d7d-4b84-82df-962f68aa9455` 返回 `UNREACHABLE`，理由为路径包含无重放许可的操作，耗时 **15.885 秒、0 个恢复动作**；停止门按原规则触发。可见弹层退出与严格 checkpoint/source 到达是不同证据，**第 3 项结束门仍未通过**。
- **待测范围与旧债：** 导出的 plan 为 **1106 → 1194（+88）**，旧 ID 全保留、无重复 ID；旧 scope/prerequisites/required/dispatchScope/operationConditionKey 均未改变。新增为 83 个 region review、2 个未执行操作、2 个 pointer intercepted 和 1 个 succeeded observed-in-scope；增长是否代表新语义范围尚不明确。原 7 条 route 债完整不变，仅新增 `00ca1220…` 的一次 unreachable 条件：routes **7→8**、conditions **12→13**、failed-result conditions **4→5**，无完成进展键。
- **完整性与调用量：** 本窗 4 个回执的必需控件分别 33/33、35/35、36/36、34/34 完整，每个原生根 1/1 完整，原始 wire 派发 witness 均匹配。非必需图仍有 broad-owner/byte-budget 拒绝，不能据此宣称整页完整。JEV **6**、LLM **0**、unknown **0**、在途操作 **0**，provider 已结算。

唯一审计结果见 [receipt-audit.json](receipt-audit.json)，SHA256 `d9ee7835cccc5ace2141ec786eb70d4bfaa12e39148bb1e3423bfd1517c2aee5`。其 `passed` 仅表示审计流程检查通过。一次 batch 查询之外未补写成功；driver/query writes/constructor receipt changes 均为 0，副本字节未改变，host/store 已关闭并释放。关闭时 engine.sqlite SHA256 为 `1bb29aa58e368d0371eba9e505378301dd65d3419d94268b5fdcdd522c889c50`；副本清理由主线程单独记录。

原始来源只引用冻结的 `.data/okx-storage-acceptance-20261017-v4/runs/01958656-8614-4f9b-b571-a182b5cd8bbc/`（summary、task-before/after、coverage-review、metrics）及本目录 `closed-evidence.json`；原 v3/run10 冻结树校验未变。首个 launcher 在生成模块解析时因说明文字引号失败，未启动子进程、未打开数据库，记录于 `preflight-invocation-error.json`；修正说明文字后的第二次才是本窗。运行时该说明文字修正尚未提交，前后哈希保留在上述记录；产品源码无未提交差异。临时副本已按 `audit-copy-cleanup.json` 的所有权及指纹校验清理，冻结原件保留。没有性能重测、全页穷尽或整体通过结论。
