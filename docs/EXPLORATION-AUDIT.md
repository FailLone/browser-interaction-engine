# 已记录操作的完成审计

`engine.report(sessionId).explorationAudit`、SDK `client.report` 和 HTTP report 返回只读审计；调试页显示对应计数。该结果独立于调度状态，不改变待办、上层决定或浏览器行为。

审计单位是 **discovered_action_cases**，不是页面所有可能行为。`status: complete` 仅表示会话已结束、所有已记录操作都有成功证据、等价操作样本证据、明确的范围排除或可解释的旧意图退役。`discoveryComplete` 始终为 false；控件发现、未知入口、输入组合和业务结果仍需独立验收。

| 分类 | 含义 |
| --- | --- |
| succeeded | 最后一次动作成功，目标/操作/样本匹配，前后观察存在且无关键缺口 |
| covered_equivalent | controls 模式下，同一已确认身份（或同一未裁决实例）和操作样本已有成功证据；这一条历史记录本身没有执行 |
| policy_excluded | 上层明确 skip 或 sample 未选中；保留来源、证据与决策版本，未执行 |
| awaiting_decision | 无决定、暂缓或尚未确认探索区域 |
| pending | 仍待执行或正在执行 |
| blocked | 执行失败、记录不足、无可验证的范围引用，或其他程序/环境阻塞 |
| retired | 未尝试的旧滚动、已退出边界、已被新用途候选替代等过时意图；不计覆盖 |

`notAttempted` 是跨分类计数，不能与上表相加。预算停止、当前观察缺失/关键缺口和未关闭边界另见 `stopReasons`。已尝试失败的操作不能被后续 skip 隐藏；配置 exclude 也不自动等同上层的范围判断。

`covered_equivalent` 的 `equivalentTo` 指向真实 `attemptId`、前后观察及采样政策；frontier 的只读 `coverage.equivalentTo` 返回相同证据。原 `attempts`、`executionStatus`、动作和观察不改写，DFS 仅免除已覆盖样本的重复调度。`frontierCoverage.counts.coveredEquivalent` 与 `executed` 分开计数，未派发的等价项仍计入 `notAttempted`。

对账要求相同 URL、声明上下文、操作及输入样本、目标约束、选项、用途与风险。跨实例必须已有身份依据；未裁决的不同实例、仅有当前实例身份的控件、不同值或条件不会归并，失败和未知尝试仍保留。控件审阅的新记录编号不单独制造新操作；新实例仍须获得当前有效的审阅才能派发。采样覆盖不授予区域、身份、重放或派发权限，也不验证筛选结果等业务断言。

页面跳转会撤销实例绑定授权。历史排除只有在原观察、上下文、成员、决策版本/时间及失效观察可以核对时保留，并标成 `policies[].validity: historical`；该记录绝不授权新页面或失效后的操作。无有效失效证据的旧引用保持阻塞。

每一条 case 保留原 `schedulingReason`，所以可以同时看到“上层未选中”和原先的用途/可达性阻塞。读到 complete 仍不能据此宣称整页穷尽。

## 浏览器范围的统一判定

浏览器报告新增 `completionAudit`，SDK 和 HTTP report 同时提供，调试页显示“整页完成判定”。它只读汇总三类材料：

- `recordedActions`：保留上述操作审计的状态、分类计数、待决范围与停止原因；明确排除仍不计执行覆盖。
- `controls` / `unconfirmedControls`：汇总控件覆盖分类，未知控件即使没有形成动作或待办也会列出，保留控件覆盖 ID、历史身份及观察引用。只读显示独立计数；用途批准不算实际执行。
- `scopes` / `gaps`：按完整 URL 和声明上下文分组，分别保留文档实例和观察 ID。合并同范围、同来源、同代码及引用/选择器的重复限制，保留每次关键缺口、消息与当前是否仍存在。观察限制与详细证据清单中的限制分开记录；交互已稳定、重复采集等正向诊断单独标识。

每个范围的 `pageDecisions` 保存对应 page 组 ID、版本、状态、全部历史决定及失效信息；决定包含来源、理由材料、时间和样本键。只有精确 URL 与声明上下文匹配的页面组才归入该范围；历史失效记录保留其状态，不作为新授权。不存在 page 记录不表示页面已经获批。调试页显示最新页面决定，完整历史可从报告读取。

`unit: observed_browser_scope` 包括所有已保存观察及历史目的页，不根据一次 skip 删除其事实。列表或页面排除仅说明调用方选择不测，不授权其他操作，也不因历史缺口要求重新进入已排除页面。范围条件不同或 URL 不同的限制不会合并。

`status` 保留操作审计的 in_progress / awaiting_decision / blocked；操作账本 complete 时，统一状态为 **unverified**，`exhaustive` 始终为 false。即使当前没有未知控件或已记录限制，也缺少“所有可能入口均已发现”的证明，不能自动升级为整页完成。历史关键缺口不会仅凭汇总被重新当作当前派发阻塞；原操作审计和每次现场校验仍独立执行。

当前没有对任意网站的发现完整性证明，也不将“未知控件”自动解释为可交互或不可交互。否定分类、主动发现、受控补采、业务断言及明确范围下的完整性证明仍属后续能力。这个报告不替代上游的用途和深度决定，也不修改调度或已有记录。

候选的上层分类另存于 `completionAudit.controlClassifications`，包括有效、失效、撤销和被替换的历史记录。控件统计新增 display / containers，与原生 readOnly 和执行覆盖分开；同一汇总身份的其他未确认文档/条件不会被当前分类覆盖。弱候选退役带分类来源，不计成功；见[分类协议](CONTROL-CLASSIFICATION.md)。
