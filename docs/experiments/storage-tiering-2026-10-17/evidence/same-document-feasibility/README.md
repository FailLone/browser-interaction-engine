# 同文档条件接续：真实冻结材料可行性

结论仅为 **potential**：7 个真实观察对中，1 对具有完整捕获条件下的窄接续潜力。没有实现 SDK 契约，没有授予身份、执行、覆盖、恢复或重试许可，也没有证明最终计划行数会下降。

分析源码为冻结的 `e7edfe24bd1cbab34e2568b6c42661f11377d194`。读取此前已经解码的 run4 JSON，并把 frozen-4 engine DB 复制到独享临时目录，以 `mode=ro&immutable=1`、`query_only` 读取另外 2 帧和候选动作；逐层校验共享块及 Observation hash。临时副本已删除。原/冻结库未建立连接或写者；源码、输入 JSON 和冻结 DB 的前后 SHA 一致。没有浏览器、provider、网络、测试或 benchmark。详细实例、字段差异及哈希见 `feasibility.json`，诊断脚本为 `analyze.py`。

| 真实观察对 | selector 唯一实例连续 | 捕获条件差异 | 潜力 |
| --- | ---: | --- | --- |
| first `5f80a3df` → scroll 后 `c446073e` | 26 / 26 | 无 | **有** |
| `c446073e` → pre-1h `f6c6f3c2` | 26 / 26，另新增 2 | 1 个状态、4 个语义变化 | 无 |
| pre-1h `f6c6f3c2` → pre-24h `d0b567f7` | 28 / 28 | 3 个状态、6 个语义及组件事实变化 | 无 |
| pre-24h `d0b567f7` → after-24h `9ca9a659` | 28 / 28 | 2 个状态、2 个语义及组件事实变化 | 无 |
| first `5f80a3df` → pre-24h `d0b567f7` | 26 / 26，另新增 2 | 状态、语义及组件事实变化 | 无 |
| first `5f80a3df` → after-24h `9ca9a659` | 26 / 26，另新增 2 | 1 个语义变化；即使原周期恢复也不能忽略新增依赖 | 无 |
| after-24h `9ca9a659` → final `c4fae20b` | 0 | browserSession、documentId、instanceScope 均变化，final 不稳定 | 无 |

有潜力的最小真实样例是 **1W**：

- 来源观察 `5f80a3df-8355-444a-8499-4a625cb89577`，action `c1c617b1-ff8b-4941-99d9-baa7b1dff835`。
- 目标观察 `c446073e-8db5-49cd-b6d3-0052622bb861`，action `8671649f-ab45-487f-a33f-aaea3aba408b`。
- session、文档、浏览器实例、URL、ruleVersion、已知 context、边界一致。全部 26 个 selector 均以 instanceId 在两帧所有 controls 中唯一对应，包含 4 个隐藏 selector 和 2 个不能提供 portable 身份的 selector。
- 目标及全部 selector 的捕获绑定、状态、动作语义一致。全部组件事实（除 viewport rect）一致；本 pair 的目标可见性/可用性/actionable 也没有差异。
- 同一观察对中的 `1h`、`24h` 和两个独立 `Trade` 动作也各自唯一对应，共 5 个潜在 action pair。两个 Trade 没有按名称互相合并。

拒绝原因按观察对计数（可重叠）：selector 语义变化 5 对、新增 selector 4 对、状态变化 4 对、组件事实变化 4 对；最终重建观察另有浏览器/文档变化、不稳定及全部 selector 替换。35 个目标 action 比较中，10 个有目标语义变化，最终 5 个缺少原实例及唯一动作；其余目标即使本身未变，仍被非局部条件变化阻断。

本诊断同时比较 reviewBinding、purposeBinding、reviewAttributes、identityContext、form/owner、structural record binding、reviewReuseBinding、classificationBinding、约束/选项、actionBasis、interactionHints 等捕获语义。保持所有 DOM 实例 ID，仅在内存副本把目标的 `reviewBinding.attributes.data-record-id` 改成另一业务记录，结果明确变为 `target_semantics_changed`、potential=false。该反例是诊断投影的边界检查，不是历史真实事件；没有写回任何 Observation。

边界仍需保持：这些是**全部已捕获 selector**，不是页面业务状态完整性证明。真实帧保留非 critical 的结构扫描、event-listener 和 canvas 缺口；未捕获 JavaScript 状态及自由文本依赖仍需要声明的 context。此方向若进入实现，应使用独立的同文档来源接续 policy；不能替代 portable correspondence、成功覆盖或 checkpoint 恢复。状态/语义变化必须保留新条件待测；未知执行债不能通过关联来源消失。

后续最小验证应围绕这个 1W pair，而非扩大为任意同 DOM：完整保留非局部和隐藏依赖，加入同节点业务重绑定、selector 增删/换实例/缺状态、A→B→A、文档重建与 unknown 的拒绝用例，再单独检查插件是否确实减少长期独立义务。当前未实现或运行这些产品测试。
