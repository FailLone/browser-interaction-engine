# 相似列表的遍历决策

新建浏览器会话默认 `listExploration: 'review'`。识别一组相似选项后，引擎先通知调用方，把该组的自动遍历暂缓，继续其他可执行工作。等待不会自动超时变成穷尽，也不会把列表记为已覆盖。已有会话未保存此配置时保留旧行为；调用方可以显式设置 `listExploration: 'all'`，在会话级决定直接遍历。

## 首版识别范围

浏览器适配器基于原生 select，或同一 `role=listbox` 所属范围里的 button/option 操作，提出结构相似的候选组。至少观察到两个不同操作样本才新建组；分组依据包括列表节点、标签、操作类型、角色和原生能力结构，普通同名按钮、导航栏和相似样式不构成列表依据。

这是结构相似的提议，不证明选项具有相同业务效果。分组不会合并控件身份，也不改变操作依据、风险、重放许可、排除、禁用、遮挡或弹层限制。搜索和关闭操作不因列表待决而一起暂缓；已识别列表的容器滚动会一起暂缓，避免等待时仍先滚完整个列表。虚拟列表短暂没有项目时，只要原滚动容器仍对应同一列表，其等待条件继续有效。

组的 `membership: 'observed-action-cases'` 表示成员是已发现的操作样本。`members.length` 不是列表总长度，也不保证是去重后的业务 item 数；同一个选项在操作依据等条件变化后可产生不同样本。每个成员保留 actionId、observationId、localId、参数、风险和排除状态，调用方可查询对应动作及观察。尚未滚动到的项、没有语义标记的自定义列表和无法建立相似组的项仍属于发现能力的边界。

## 事件、hook 与异步决策

- `exploration.group_detected`：新组的持久事件，包含完整 `ExplorationGroup` 和首批观察依据。同一组反复观察不会重复请求。
- `exploration.group_updated`：发现新的成员样本，提供 groupId、revision、observationId 和新增成员键。虚拟列表按当前组累计，不为每屏重新要求决策。
- `exploration.group_decided`：记录调用方选择、来源、证据和新版本。
- `hooks.explorationGroup(group, ctx)`：每个新组调用一次，可以直接返回决策。返回 undefined、抛错或超时均保留待决；hook 不应等待人工交互，也不能在回调内等待同一引擎的命令队列。

耗时判断使用持久事件和异步命令。事件可通过现有订阅及游标补读，重启后组、决策和未执行记录仍可查询。HTTP 查询为 `GET /v1/sessions/:sessionId/exploration-groups`，SDK 为 `client.explorationGroups(sessionId)`。

```ts
// 上层收到事件后读取最新材料，再作判断。
const { items } = await client.explorationGroups(sessionId, { status: 'pending' });
const group = items[0];
await client.decideExplorationGroup(sessionId, group.id, group.revision, {
  mode: 'all',
  source: 'test-orchestrator',
  evidence: ['已审阅此列表的用途，本轮要求遍历同一列表中的全部相似操作项'],
});
// 异步决策本身不启动浏览器操作；若探索已暂停，由上层继续。
await client.command(sessionId, { type: 'resume' });
```

相同操作也可用通用命令提交：`{ type: 'decideExplorationGroup', groupId, revision, decision }`。内存调用使用 `engine.decideExplorationGroup(...)`。revision 必须匹配最新组，过期返回 `STALE_GROUP_DECISION`；应重新读取、重新判断，不能把旧结论盲目重试到新材料上。

## 决策与执行语义

| mode | 含义 | 未执行项 |
| --- | --- | --- |
| all | 允许调度此组已发现及后续发现的同结构操作样本 | 仍逐项执行和验证，未发现总量不宣称完成 |
| sample | 仅允许指定 `memberKeys`；必须是该组中已观察到且不重复的键 | 其余为 deferred / list_member_not_selected，保留未覆盖 |
| defer | 暂缓整个组，可在之后修改决策 | deferred / list_deferred_by_caller，保留未覆盖 |

所有决策必须包含 source 和非空 evidence。抽样时，成员的 observationId 可以帮助区分当前可见项与历史项；键对应精确操作样本，不是模糊的名称、位置或行号。样本决定不会自动允许继续滚动以穷尽列表。

待决项目为 `deferred / awaiting_list_decision`，现有其他阻塞原因保持原样。`choose` hook 只收到当前可调度任务，无法通过选择一个暂缓 ID 绕过决策。没有其他可执行工作且仍有待决项目时，会话暂停为 `LIST_DECISION_REQUIRED`；明确抽样或暂缓后，未执行成员仍使完成报告保留缺口。已经批准的列表在非弹层调度中排在普通工作之后。

活动弹层不能绕过：列表暂缓后可以执行当前搜索或退出操作，确认关闭后才探索父页面；不存在有效出口时保留 `ACTIVE_BOUNDARY_BLOCKED`。之后批准穷尽时，使用既有入口与恢复机制尝试重新进入，不因列表决策直接取得恢复资格。

每个组绑定浏览器文档、列表节点、结构和声明的业务上下文。列表节点重建、文档重载或上下文改变会产生新的决策范围；同一节点换成另一个业务选项也不能继承旧抽样键。明确的单项 `execute` 仍可用于人工接管或探测，但不会批准其余列表项。

回归见 `tests/list-decisions.test.ts`，覆盖等待与普通工作优先、即时与异步决策、抽样再穷尽、错误及过期决策、虚拟列表和空窗口、弹层退出/重入、无出口、身份与上下文失效、持久化、SDK/HTTP，以及禁用和排除保护。
