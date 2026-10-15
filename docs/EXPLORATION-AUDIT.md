# 已记录操作的完成审计

`engine.report(sessionId).explorationAudit`、SDK `client.report` 和 HTTP report 返回只读审计；调试页显示对应计数。该结果独立于调度状态，不改变待办、上层决定或浏览器行为。

审计单位是 **discovered_action_cases**，不是页面所有可能行为。`status: complete` 仅表示会话已结束、所有已记录操作都有成功证据、明确的范围排除或可解释的旧意图退役。`discoveryComplete` 始终为 false；控件发现、未知入口、输入组合和业务结果仍需独立验收。

| 分类 | 含义 |
| --- | --- |
| succeeded | 最后一次动作成功，目标/操作/样本匹配，前后观察存在且无关键缺口 |
| policy_excluded | 上层明确 skip 或 sample 未选中；保留来源、证据与决策版本，未执行 |
| awaiting_decision | 无决定、暂缓或尚未确认探索区域 |
| pending | 仍待执行或正在执行 |
| blocked | 执行失败、记录不足、无可验证的范围引用，或其他程序/环境阻塞 |
| retired | 未尝试的旧滚动、已退出边界、已被新用途候选替代等过时意图；不计覆盖 |

`notAttempted` 是跨分类计数，不能与上表相加。预算停止、当前观察缺失/关键缺口和未关闭边界另见 `stopReasons`。已尝试失败的操作不能被后续 skip 隐藏；配置 exclude 也不自动等同上层的范围判断。

页面跳转会撤销实例绑定授权。历史排除只有在原观察、上下文、成员、决策版本/时间及失效观察可以核对时保留，并标成 `policies[].validity: historical`；该记录绝不授权新页面或失效后的操作。无有效失效证据的旧引用保持阻塞。

此阶段审计仍有边界：未形成 frontier 的疑似控件在 `controlCoverage.counts.unconfirmed`，采集缺口在报告 `gaps`，它们尚未归并成统一的整页完成判定。读到 complete 不能据此宣称整页穷尽。每一条 case 保留原 `schedulingReason`，所以可以同时看到“上层未选中”和原先的用途/可达性阻塞。
