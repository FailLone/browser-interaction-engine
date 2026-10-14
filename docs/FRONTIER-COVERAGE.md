# 探索待办与输入样本覆盖

新浏览器会话默认使用控件覆盖；本文原有逐状态字段语义仍适用于 stateful 和旧会话。report.controlCoverage 独立统计控件支持操作的实际覆盖，superseded 仅用于已由当前视口替代的未执行滚动意图，不算执行成功。新增 sampling 来源及抽样边界见 [探索与恢复](EXPLORATION-RECOVERY.md)。

控件身份、待办调度状态和样本执行结果是三个独立概念。`Amount` 的值变化不创建新控件身份；逐状态模式中，同一控件在不同界面、上下文、操作及输入值组合下，仍保留独立待办。代表性模式按声明的抽样条件安排任务，实际执行仍绑定具体观察。某个待办 `status: blocked` 不表示这个控件从未探索，也不表示它当前不可操作。

## 单项查询

- SDK：`engine.getFrontier(sessionId)`；原有 `engine.list(sessionId, 'frontier')` 也返回相同扩展字段。
- HTTP：`GET /v1/sessions/:sessionId/frontier`，保留原有分页和 status 过滤。
- 客户端：`client.frontier(sessionId, { status: 'blocked' })`。
- 策略 hook：`choose(items, ctx)` 中的待选项也包含 `coverage`。

返回类型为 `FrontierItemView`，原字段不变，新增 `coverage`：

```json
{
  "status": "blocked",
  "action": { "controlId": "amount-id", "kind": "fill", "value": "0.001" },
  "attempts": [],
  "coverage": {
    "groupId": "stable-control-operation-group",
    "unit": "input_sample",
    "executionStatus": "not_attempted"
  }
}
```

上例表示该界面/上下文中的输入样本 `0.001` 尚未执行，调度受阻。`action.value` 是计划使用的样本，不是控件当前值。`stateId`、`contextKey`、`action.preconditions.context` 指明这条测试的条件。

`coverage.unit` 对 fill 为 `input_sample`，其余操作为 `action_case`。`executionStatus` 为最后一条记录的尝试状态（`executing / succeeded / failed / blocked / unknown`），没有尝试时为 `not_attempted`。尝试记录丢失或中断不确定时保留 `unknown`，不会误报成尚未测试。历史执行成功记录即使没有尝试 ID 也保留 `succeeded`。执行成功表示动作执行及观察完成，不代表业务断言通过。

`status` 和 `reason` 仍描述该条测试的调度状态与原因。例如 `needs_revalidation` 可同时保有历史 `executionStatus: succeeded`；历史成功不自动解除重新验证要求。控件当前可操作性应从当前观察和操作候选的 preconditions 查询，不能从历史待办推断。

## 按控件和操作汇总

- SDK：`engine.frontierCoverage(sessionId)`。
- HTTP：`GET /v1/sessions/:sessionId/frontier-coverage`。
- 客户端：`client.frontierCoverage(sessionId)`。
- `engine.report()` / HTTP report 新增 `frontierCoverage` 摘要，省略各组的 items。

每个 `FrontierCoverageGroup` 按会话内 `controlId + kind` 分组，跨界面、上下文及样本值聚合展示。没有控件身份的动作逐项保留，不按标签猜测合并。组内 `items` 是完整 `FrontierItemView[]`，保留独立状态和结果，不把一个样本的成功传播到其他样本。

| 字段 | 含义 |
| --- | --- |
| `coverageStatus: not_attempted` | 所有已发现测试项均无执行记录 |
| `coverageStatus: attempted` | 存在尝试或不确定记录，当前没有状态为 executed 的测试项 |
| `coverageStatus: partial` | 部分测试项 executed，仍有未完成项 |
| `coverageStatus: complete` | 所有当前已发现测试项均 executed；不宣称覆盖所有可能输入 |
| `counts.total` | 当前覆盖策略下的已发现任务数：逐状态模式为界面/上下文/输入组合，代表性模式为抽样任务；都不是唯一输入值数量 |
| `counts.executed` | 当前调度状态 executed 的项数 |
| `counts.blocked` | 当前调度状态 blocked 的项数 |
| `counts.notAttempted` | executionStatus 为 not_attempted 的项数 |

这些计数允许重叠：一个受阻样本可以同时属于 notAttempted。汇总端点从会话完整待办计算，不受单项接口分页或状态筛选影响。

调试页使用同一汇总接口，把同一个 Amount 显示为一组，并展开每个输入样本、所属界面、调度状态、执行情况及原因。已有成功样本又有受阻样本时显示“已探索，仍有样本受阻”。

coverage 汇总字段在读取时派生，旧会话无需迁移或重跑。逐状态及旧会话保留原有待办去重语义；代表性模式额外持久保存 sampling 来源，不改写观察和控件身份。历史弹层外的重复待办继续按边界规则排除。

## 浏览器界面条件与成功记录对照

业务上下文 `action.preconditions.context` 只包含显式声明或提取的业务字段。没有配置提取规则时它可以是 `{}`，这不表示两个样本所在的界面相同。控件值、订单类型按钮的文案、可见性、选中状态、输入约束等实际条件保存在历史观察中。

浏览器 SDK 与 HTTP/client 的 `frontierCoverage()` 返回 `BrowserFrontierCoverageGroup[]`，在每组中新增 `states`。纯 core 的汇总仍与浏览器无关，报告保持只包含计数摘要。

每个 `states` 条目对应一个 `stateId`：

- `observationId`、`capturedAt`：用于这份摘要的历史观察，来自该状态下待办记录的观察引用。
- `status: available | unavailable`：原始观察是否仍可查询且属于相同会话和状态；缺失时不会代入当前页面。
- `facts[]`：结构化的界面条件，包含 `key / label / field / value / controlId / primary`。`primary` 表示适合默认展示的值、选项和开关；其余事实用于差异比较和展开查看。

摘要用于解释测试条件，不代替完整的状态等价判断。两个不同 stateId 的摘要相同仍不能宣称它们等价。

调试页直接显示所属界面的输入值、选择项及开关，并对照成功记录突出变化。默认优先选择相同输入样本、摘要差异较少的成功记录，也可以手动切换。相同界面下的不同样本明确标为“执行前界面相同，仅输入样本不同”。界面差异和样本受阻原因分别显示，不将相关性当作原因。

“查看历史界面”只切换展示的观察证据，不操作被测页面，也不增加动作次数。空业务上下文显示“未记录业务上下文”，不再显示缺乏解释的空对象。
