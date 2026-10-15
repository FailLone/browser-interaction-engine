# 相似列表的遍历决策

列表现已作为[通用探索范围决策](EXPLORATION-DECISIONS.md)的一个内置场景；统一 hook 为 `explorationDecision`，原 `explorationGroup` 保留兼容。

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
| skip | 上层明确决定本轮不测，可后续修改 | skipped / exploration_skipped_by_caller，保留未覆盖 |

所有决策必须包含 source 和非空 evidence。抽样时，成员的 observationId 可以帮助区分当前可见项与历史项；键对应精确操作样本，不是模糊的名称、位置或行号。样本决定不会自动允许继续滚动以穷尽列表。

待决项目为 `deferred / awaiting_list_decision`，现有其他阻塞原因保持原样。`choose` hook 只收到当前可调度任务，无法通过选择一个暂缓 ID 绕过决策。没有其他可执行工作且仍有待决项目时，会话暂停为 `LIST_DECISION_REQUIRED`；明确暂缓且没有其他工作时，以 `EXPLORATION_DEFERRED` 暂停；抽样或 skip 可结束，未执行成员仍使完成报告保留缺口。已经批准的列表在非弹层调度中排在普通工作之后。

活动弹层不能绕过：列表暂缓后可以执行当前搜索或退出操作，确认关闭后才探索父页面；不存在有效出口时保留 `ACTIVE_BOUNDARY_BLOCKED`。之后批准穷尽时，使用既有入口与恢复机制尝试重新进入，不因列表决策直接取得恢复资格。

每个组绑定浏览器文档、列表节点、结构和声明的业务上下文。列表节点重建、文档重载或上下文改变会产生新的决策范围；同一节点换成另一个业务选项也不能继承旧抽样键。明确的单项 `execute` 仍可用于人工接管或探测，但不会批准其余列表项。

## 穷尽与用途审阅复用可以同时启用

遍历决定回答“执行多少项”；用途审阅回答“这些操作的用途和风险是什么”。选择 all 仍然可以只审阅一次满足条件的共同用途，然后对每个当前目标分别执行和验证。共享的是上层判断，不是控件身份、执行结果或覆盖记录。

`engine.purposeReviewMaterial(sessionId, groupId)` 输出当前组的审阅材料，SDK 同名，HTTP 为 `GET /v1/sessions/:sessionId/exploration-groups/:groupId/purpose-material`。材料按更严格的条件分组：同一文档、URL、列表节点及标签、完整声明上下文、所属区域、操作类型、原生能力证据、约束、表单和派发属性。相同列表中的不同结构可能产生多份材料。只允许受支持的 select 或 listbox 选项点击；表单提交、链接和未证实能力不提供复用材料。

材料明确列出允许变化的部分：成员节点、选项标签和选项值。上层必须检查材料及对应观察，确认共同用途和业务范围适用于当前及后续匹配成员，再提交有来源的判断。引擎不自行推断业务用途。`businessScope` 是上层对范围的说明；需要机器持续校验的账号、业务对象、模式等条件，应通过 context/contextRules/context hook 输出。任何声明上下文为 unknown 时均不能复用。未暴露的服务端状态、JavaScript 行为或隐藏业务条件不在自动验证能力之内。

```ts
const material = await client.purposeReviewMaterial(sessionId, group.id);
// 上层审阅 material.conditions[0] 及其成员的观察材料后：
await client.reviewListPurpose(sessionId, {
  groupId: group.id,
  revision: material.revision,
  observationId: material.observationId,
  conditionKey: material.conditions[0].key,
  purpose: '切换公开计算器的展示币种',
  businessScope: '当前计算器与声明上下文，不包含交易或账户操作',
  risk: 'interface',
  reuse: 'matching-list-members',
  source: 'test-orchestrator',
  evidence: ['此处填写上层实际审阅的依据'],
});
// 记录判断本身不操作浏览器；刷新后重新生成带复用依据的候选。
await client.command(sessionId, { type: 'observe' });
// 使用刷新后的组版本决定 all/sample/defer，再按需要 resume。
```

通用命令为 `{ type: 'reviewListPurpose', review }`，材料版本或观察过期返回 `STALE_PURPOSE_REVIEW`。记录、刷新、列表决策及继续探索是独立步骤；读取材料到提交期间可以暂停探索，避免版本变化。新增成员无需重复确认共同用途，但仍必须匹配全部条件；不匹配的成员继续保留其原有审阅需求。列表待决、sample 或 defer 不会因用途审阅而放行。all 决策也不会自动产生用途审阅。

复用证据保留在每个 action 的 `conditional-purpose-review/v1` 中，可以追溯 reviewId、原始观察、条件键和上层依据。它只解除 `operation_requires_review`，不解除其他明确排除、禁用、遮挡、边界或身份限制，不额外授予重放权限。每次派发仍校验当前观察、节点实例、目标可达性和声明上下文；列表相关派发属性及表单端点改变也会令旧动作过期。旧观察不改写，每个实际操作仍产生独立尝试和结果。

同一当前目标在相同用途条件下生成新审阅候选后，旧的未执行待办可以退役为 `superseded / purpose_review_replaced`；已失效或撤销的审阅待办为 `purpose_review_invalidated`。这避免为了旧判断重复恢复分支。原有已执行记录不变，退役记录仍是 not_attempted，不能当作新增覆盖。

文档、URL、业务上下文或列表所属节点改变后，记录失效并发出 `purpose.review_invalidated`，恢复旧上下文也不会自动重新启用。结构不匹配的当前操作不会使用旧判断。关闭后临时不可见不等于节点重建，也不授权操作当前不可见项。记录持久化后可查询，但重启浏览器形成的新文档需要重新审阅。

`client.purposeReviews(sessionId)` / `GET /v1/sessions/:sessionId/purpose-reviews` 查询记录，`purpose.review_recorded`、`purpose.review_invalidated`、`purpose.review_revoked` 可通过现有事件订阅读取。上层可用 `client.revokePurposeReview(sessionId, { reviewId, source, reason })`，或 `{ type: 'revokePurposeReview', revocation }` 撤销；撤销后即便动作已生成，执行前也会拒绝，刷新后恢复原有用途限制。

同一条件的新审阅会将旧审阅标记为 superseded，记录 replacedBy 并发出 `purpose.review_superseded`。撤销新审阅不会使旧判断重新生效；历史尝试仍保留当时使用的审阅来源。

回归见 `tests/list-decisions.test.ts`，覆盖等待与普通工作优先、即时与异步决策、抽样再穷尽、错误及过期决策、虚拟列表和空窗口、弹层退出/重入、无出口、身份与上下文失效、持久化、SDK/HTTP，以及禁用和排除保护。

条件复用回归见 `tests/purpose-reuse.test.ts`，覆盖一次审阅逐项穷尽、抽样/暂缓独立性、后续成员、结构差异、当前节点替换、上下文与列表重建、派发表单变化、撤销、持久化和 SDK/HTTP。
