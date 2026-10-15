# 通用探索范围决策

列表提议的 `minimumMembers` 默认是 2。生产者有独立集合依据时可显式设为 1，并提供相应 evidence；这样单成员或只有遍历动作的空窗口仍可产生门控。它不生成操作、不改变身份或风险，也不把单个普通控件自动认定为列表。其他通用范围沿用原成员/遍历规则。

引擎负责发现可操作项、记录材料和执行验证，上层负责根据测试目标决定是否深入。列表、页面区域、入口分支、输入样本以及调用方定义的业务范围，共用 `ExplorationGroup` 记录、hook、持久事件和 SDK/HTTP 命令。

## 提出范围与作出决策

`hooks.explorationScopes(actions, ctx)` 在每次观察生成并约束当前候选后调用。返回范围提议数组：

- `key`：同一种 kind 内稳定且唯一的范围键，不使用 observationId 或当前成员数量。
- `kind`、`label`：场景类型和可读名称；kind 是开放字符串，core 不依赖 DOM 或业务词汇。
- `actionIds`：属于范围的当前动作 ID，可以只有一个入口或操作。
- `traversalActionIds`：用于继续发现范围的动作，如列表滚动。它们随范围等待，不能被 sample 单独放行。
- `binding`：默认 `instance`，绑定当前文档/实例；显式 `context` 允许同声明上下文和条件下跨文档保留调度决定，适用于页面范围授权，不代表操作语义相同。
- `conditions`：可选 JSON 条件，如测试目标版本、目标对象、结构版本。条件改变，需要新的决策。
- `evidence`：非空观察依据，结构与 ActionEvidence 一致。
- `collection`：可选的审阅整理依据 `{ key, label, evidence }`，只组织展示，不共享身份、业务效果或授权。保持来源稳定，不放入每次变化的 observationId；来源改变会增加范围版本。

调用方每次根据当前观察提出范围；同一 kind/key 在同一批中不能重复。动作必须来自本次候选且在组内不重复。允许同一动作同时属于不同范围，所有范围均允许时才可自动执行。已识别的边界退出动作不进入范围，避免范围等待本身封死退出路径。

`hooks.explorationDecision(group, ctx)` 对每个新范围调用一次。它可以直接返回决策，或者返回 undefined 交由外部异步处理。已有 `explorationGroup` 保留兼容；两者同时配置时只调用 explorationDecision。新成员增加组版本并发出更新事件，不重复询问同一有效范围。all 接纳同范围的新成员；sample 不自动扩充样本。

```ts
const engine = new BrowserEngine({
  persistence,
  hooks: {
    explorationScopes(actions, { observation }) {
      return [{
        key: 'business-object-detail',
        kind: 'business-branch',
        label: '业务对象详情',
        conditions: { testGoalVersion: 'detail-v2', object: observation.context.object ?? null },
        actionIds: actions.filter(a => detailControlIds.has(a.controlId)).map(a => a.id),
        traversalActionIds: [],
        evidence: [{ source: 'test-plan', rule: 'declared-detail-scope/v1', facts: { goal: '详情流程' } }],
      }];
    },
    explorationDecision: group => decideFromTestPlan(group),
  },
});
```

示例中的 `detailControlIds`、测试目标和决策来自上层配置，不是引擎内置业务规则。完整可复用的 hooks 示例见 [examples/hooks.ts](../examples/hooks.ts)。

## 决策语义

| mode | 调度结果 | 完成口径 |
| --- | --- | --- |
| all | 允许当前和后续发现的同范围成员，继续受预算限制 | 每项仍需实际执行；不承诺发现全部可能行为 |
| sample | 只允许指定的非重复、已观察 `memberKeys` | 其余 deferred，保留未覆盖；不是按名称或位置匹配 |
| defer | 暂缓此范围，先处理其他可执行工作 | 其他工作结束后以 EXPLORATION_DEFERRED 暂停，等待修改决策 |
| skip | 本轮不测此范围 | skipped，保留来源、依据和 not_attempted；可结束并报告缺口 |

所有决策必须有 `source` 和非空 `evidence`。skip 可通过新的版本匹配决策改成 all/sample；“本轮”指当前 session，resume 不会清除它。sample 未选项不会使会话无限等待，完成报告保留缺口。

未答复范围为 `deferred / awaiting_exploration_decision`；没有其他可执行工作时以 `EXPLORATION_DECISION_REQUIRED` 暂停。仅有相似列表待决时保留原来的 `LIST_DECISION_REQUIRED`。重叠范围采用限制合并：skip 优先于等待，等待优先于 defer，再到 sample 未选；任何一个 all 都不能解除其他范围的限制。禁用、排除、身份和风险等原有阻塞保留原原因。

非弹层调度中，未分组工作优先于已允许的范围工作。活动弹层仍遵守退出和恢复验证：允许退出不证明已经退出，无有效出口时仍为 ACTIVE_BOUNDARY_BLOCKED。恢复过程中如果新观察使所选范围失效或重新待决，调度会重新检查，不沿用恢复前的批准执行目标。choose 只收到可调度候选。显式单项 execute 是人工/上层接管，可操作待决或跳过中的单项，但仍须通过当前目标、安全和能力检查，也不会批准其他成员。

## 浏览器内置范围

新建会话可设置 `decisionScopes: ['region', 'branch', 'input-space']`，分别启用以下生产者。默认是空数组，按目标选择所需类型即可。

| 类型 | 已观察范围 | 边界 |
| --- | --- | --- |
| region | 直接归属同一语义区域的动作及滚动，绑定区域节点、URL、名称等 | 嵌套区域独立决定；不是任意视觉矩形，也不是整棵未知流程 |
| branch | 原生链接、summary、展开/受控入口、tab/menuitem 的单个点击入口 | 允许入口不预先批准其目的地；未知事件处理器不自动理解为分支 |
| input-space | 同一输入控件的 fill/select/check 候选样本，绑定节点、约束、选项和原生能力结构 | 只消费现有 samples/发现能力，不生成全量组合 |

列表继续默认 `listExploration: 'review'`，由原生 select/listbox 生产 `similar-list`。其至少两个成员的初次识别规则保持不变；通用范围支持单成员。列表与通用范围可重叠，`listExploration: 'all'` 只关闭列表待决机制，不会批准其他范围。列表详情及用途审阅见[列表协议](LIST-EXPLORATION.md)。

无语义容器可另选 `regionExploration: 'review'`，先确认业务区域再使用本协议的探索决定；它代替可选 region/branch 粒度，列表、输入样本和目的页约束仍独立。见[区域候选审阅](REGION-REVIEW.md)。

## 页面范围优先于 DFS 顺序

新浏览器会话默认 `pageExploration: 'review'`。入口页面是首次完整初始观察的实际 URL（包括启动重定向后的落地地址）。DFS 只决定已获准范围内的顺序，不代表沿所有链接继续深入。

1. 当前页面的普通工作优先于已知离页入口。无法从候选预知的按钮导航，在动作后的观察中识别。
2. 到达其他 URL 后，产生 `kind: 'page'` 的范围请求，沿用 `explorationDecision`、持久事件及 `decideExplorationGroup` 命令。未获准前，不自动操作目的页业务控件。
3. 没有决定、defer、skip，或指定样本已无当前可执行项（包括深度上限阻塞）时，先退出目的页的活动弹层，再尝试原生历史返回来源页，继续允许的工作。有效出口仍可执行；没有有效出口则保留 ACTIVE_BOUNDARY_BLOCKED。
4. all 允许深入该页面，但 B 通往的 C 会有独立请求。sample 只放行选中的已观察操作样本，defer 留待后续，skip 保留未测。调试页目的页面板支持允许、暂缓和本轮不测；“范围决策”页及 hook/SDK/HTTP 也支持指定样本。

```ts
const session = await engine.createSession({
  url: 'https://example.test/a',
  pageExploration: 'review', // 新会话默认值；all 显式采用原来的跨页探索策略
});
// 已有 explorationDecision hook 可根据 group.kind === 'page' 和 group.conditions.url 判断。
// 异步决定仍使用 client.decideExplorationGroup(...); 决定本身不触发浏览器操作。
```

页面范围以**完整 URL** 区分，包括 query 和 hash；同源不代表同页。这样覆盖 SPA 路由，但普通锚点/展示参数也可能被保守地分成新范围。URL 不变的弹层、标签和业务视图仍由已有区域/分支/输入范围控制，不承诺识别所有业务页面边界。上层将页面组明确设为 all 或使用 pageExploration all 时，上层已经选择允许跨页，DFS 仍可能深入获准的 B；若要先完成 A，应保留 B 待决或暂缓。

页面组采用 `binding: 'context'`，因此返回 A 后仍可批准 B，重新访问 B 时无需只因文档重载重问页面范围。授权绑定准确 URL 和声明上下文；普通区域、用途审阅及每次目标验证继续遵守自己的失效规则，允许 B 不会批准其子页面。业务条件改变时旧页面决定失效。

返回必须使用同一浏览器会话里仍存在的已观察 GET 历史条目，并遵守排除、预算、业务副作用和当前目标检查。返回后重新验证完整观察、目标 URL 和声明上下文；只发布 `exploration.page_returned` / `stateRestored: false`，不声称金额、服务器状态或检查点已恢复。没有可信路径（例如 location.replace、POST 来源、未处理副作用）或返回结果不符时，以 `PAGE_RETURN_BLOCKED` 暂停并发布 `exploration.page_return_blocked`；上层需恢复来源页后重新观察，或明确允许当前目的页，不会自动猜 URL 或重置环境。

允许范围内无可执行工作但有待决页面时暂停为 `PAGE_DECISION_REQUIRED`；只有暂缓页面时为 `PAGE_EXPLORATION_DEFERRED`。静态无控件页面也保留请求；skip 不计覆盖，结束仍报告缺口。`report.pageExploration` 保存入口、已观察返回链和最近返回结果。

显式单项 execute 属于上层接管，不自动遍历或返回，也不代表批准整个页面。已持久化但缺少 pageExploration 字段的旧会话保持原行为，不做静默迁移。独立回归覆盖意外跳转、B → C、同文档 URL 变化、异步抽样、弹层退出、受阻返回、上下文失效、旧会话和调试界面。

## 统一审阅材料与批量决定

`engine.explorationReviewMaterial(sessionId)`、同名 client 方法或 `GET /v1/sessions/:sessionId/exploration-review` 返回只读快照，不观察页面、不执行操作。响应包含：

- `observationId`：查询时最新观察。
- `groups`：本会话所有未失效范围的完整材料，包括早先页面的待决请求；每组自带 `observationId`，不保证目标仍在当前页面或仍可操作。
- `collections`：整理组的名称、来源证据及 `groupIds`。浏览器按准确 URL、文档实例、直接所属区域及边界节点整理；同名区域不会因此合并。调用方可在 proposal 中提供带依据的 collection；声明的 key、label 或 evidence 不一致则分开，无声明时只按 kind 展示。返回的 collection key 是整理依据的摘要，不是可提交决定的范围 ID。
- `overlaps`：共享精确动作键的 `groupIds` / `caseKeys`。涉及的范围须共同允许该操作；caseKeys 也可能含发现用的遍历动作，不能直接作为 sample 成员，应选择各组 `members[].key`。
- `requestedGroupIds`：同步 hook 本次新发现的范围；普通查询为空。

这解决已发现入口的审阅组织和逐条提交成本，不表示引擎已理解无语义业务区域、相同功能或未知目的地。一个 document 整理组可能仍包含大量不同业务链接；上层可以选择其中一部分，不能仅凭同组就推断用途相同。

`hooks.explorationReview(material, ctx)` 在一次观察产生新范围时调用一次，拿到完整材料及本次新范围 IDs，优先于 `explorationDecision` 和兼容别名 `explorationGroup`。可返回显式 `{ groupId, revision, decision }[]`，也可返回 undefined 或空数组，交给异步消费者。它只能决定当次材料包含的范围版本；不存在的组、过期版本、无效样本会拒绝整批。超时和异常保持原决策，迟到结果无效，不回退到逐范围 hook。仅增加成员或材料更新不重复调用该 hook，消费者应监听 group_updated 并重新查询。

发现新范围时同时发布持久 `exploration.review_requested`，包含 observationId、requestedGroupIds 及新范围 ID/版本，避免事件重复携带所有历史成员。事件引用不是永久材料快照；异步消费者重新查询并审阅当前版本。既有单范围 detected/updated/decided/invalidated 事件继续保留。

```ts
const material = await client.explorationReviewMaterial(sessionId);
// 上层按测试目标选择明确的范围；可为不同范围选择不同 mode。
const selected = material.groups.filter(g => selectedGroupIds.has(g.id));
if (selected.length) {
  await client.decideExplorationGroups(sessionId, selected.map(g => ({
    groupId: g.id, revision: g.revision,
    decision: { mode: 'defer', source: 'test-plan', evidence: ['当前先完成转换器，导航稍后决定'] },
  })));
}
```

批量命令为 `{ type: 'decideExplorationGroups', resolutions }`，返回同顺序的最新范围数组。单次 1–1000 个范围 ID，不允许重复。先校验全部归属、版本、有效性和样本，再在一个存储事务中写入，并统一更新重叠待办；任一失败整批不写入，也不发布部分决定。成功发布各组原有事件及 `exploration.groups_decided`（原始 resolutions 和 changedGroupIds）。所有决定完全相同时仍可产生批次审计事件，但不重复增加组版本。旧单范围命令保留。

一次批量 all **只批准列出的范围**；未来新范围、B 通往的 C 都需独立决定。同一已批准范围的后续成员仍遵守原 all 语义。决定本身不启动探索，也不改变用途风险、身份、重放或恢复许可。版本过期应重新读取材料并判断，不能直接替换 revision 自动重试。

调试页的“范围决策”按来源展示范围、样本、依据和重叠约束，可一次选择多个范围，提交穷尽、指定样本、暂缓或本轮不测。所选版本在后台变化后禁止提交，提示重新选择；新增范围不会自动加入已有选择。操作历史和覆盖率仍按实际执行记录。

## 材料、异步接入与失效

沿用 `client.explorationGroups(sessionId)` / `GET /v1/sessions/:sessionId/exploration-groups` 查询全部类型，返回条件、版本、成员材料和历史决策。成员是已观察的操作样本，不是业务对象总数或已发现路径总数。

事件为 `exploration.group_detected`（完整新组）、`exploration.group_updated`（成员增量）、`exploration.group_decided` 和新增 `exploration.group_invalidated`（失效组、版本、观察及原因）。事件已持久化，可使用现有游标续读。慢消费者或人工判断应使用事件和命令，不在 5 秒 hook 中等待，也不在 hook 内等待同一引擎的命令队列。

```ts
const group = (await client.explorationGroups(sessionId, { status: 'pending' })).items[0];
await client.decideExplorationGroup(sessionId, group.id, group.revision, {
  mode: 'skip', source: 'test-plan', evidence: ['本轮目标不包含该范围'],
});
await client.command(sessionId, { type: 'resume' });
```

命令仍是 `{ type: 'decideExplorationGroup', groupId, revision, decision }`。提交决策本身不操作浏览器或自动恢复探索。revision 必须匹配；新成员、新遍历项、整理依据变化或新决策都可能改变版本，过期返回 STALE_GROUP_DECISION，应重新读取材料判断。

通用范围默认绑定文档/实例范围、声明上下文及 conditions。默认 binding 下文档或上下文改变，或同 kind/key 的 conditions 改变时，旧组标为 invalidated，旧未执行待办保留为 superseded / exploration_scope_invalidated；不能计为覆盖。对失效组提交决策返回 EXPLORATION_SCOPE_INVALIDATED。重新回到旧条件也创建新请求，不复活旧批准。浏览器区域节点重建在派发前检测，重新观察后要求新决策。

`binding: context` 的范围仅豁免文档实例变化；声明上下文或同 kind/key 的 conditions 改变仍使旧批准失效，回到旧条件也不复活。它允许零成员范围，用于记录没有控件的待决目的页。成员仍是精确操作样本，sample 不按名称匹配新文档的控件；all 可以接纳同条件下新发现的成员。该权限不扩展用途审阅、身份、重放或检查结果的有效期。

暂时省略范围提议不会释放仍匹配其精确成员键的候选；持续吸收新成员需要生产者继续提出该范围。业务目标变化时，应更新 conditions 或声明 context，然后 observe。引擎不能监控未声明的服务端状态或外部闭包变化；条件稳定仅表示在声明范围内可复用调度决定，不证明业务效果相同。

范围生成失败、无效引用或超时会保留观察事实，记录关键缺口 EXPLORATION_SCOPE_HOOK_FAILED 并停止自动探索；修复后 observe 可继续。决策 hook 失败、无效或超时则保留待决，超时后迟到的结果不能写入决策。

遍历决定不授予用途风险、重放、恢复或身份许可。已有列表用途审阅复用保持独立，不能用通用 region/branch 组来申请列表用途授权。每次目标验证、实际尝试、效果检查和覆盖率记录仍独立进行。

独立回归见 `tests/exploration-scopes-core.test.ts` 和 `tests/exploration-scopes-browser.test.ts`：非浏览器单动作、业务目标选择、重叠范围、条件失效、迟到决策、异常恢复、弹层退出、输入抽样、原有安全阻塞以及 SDK/HTTP。

[OKX 目标驱动实测](experiments/exploration-decisions-2026-10-15/README.md)另验证了待决期间继续其他工作、all/sample/defer/skip、金额样本、列表暂缓后自动重入，以及导航后的条件失效。实测发现并修复旧文档退出待办引发的多余返回；范围决策不提供未知退出方式的自动语义判断，默认实例绑定的旧批准也不会复活。此结果不构成全页面或全列表穷尽证明。

## 已确认区域的深度决定条件复用

一次 `all/sample/defer/skip` 决定仍只按原范围协议生效。新文档里的已确认区域默认待决；允许复用须另行 opt-in，再对当前映射显式接受。程序负责比较证据、映射当前操作、校验及执行；人或 LLM 负责是否深入、适用范围及是否接受复用。`businessScope` 可以只是“公开页面 UI 巡检”，不要求交易等业务目的。

这一版支持 `kind: 'reviewed-region'`，且区域本身已声明同 URL/已知上下文的复用条件。其他列表、输入、分支或自定义范围仍能通过通用决定接口恢复，但暂不提供跨文档深度复用。页面范围原有的 context 绑定授权不变。

1. 提交本次深度决定后，调用 `reviewExplorationDecisionReuse(sessionId, { observationId, groupId, revision, businessScope, source, evidence })` 注册其可复用条件。选择样本时，每个样本必须是当前操作；历史累积成员不能充当当前样本。决定和注册均不执行浏览器动作。
2. 返回 A 后，重新观察并先显式复用区域划分、独立处理当前操作用途。`explorationDecisionReuseMaterial(sessionId)` 返回 `candidates`、`unavailable` 和可注册的 `reusableGroupIds`。候选包含来源决定、完整条件、当前操作 ID、成员 key、参数和是否选中；不可复用材料给出原因和 `fresh_decision` / `review_region` / `review_purpose` 路径。
3. 接受当前候选：`reuseExplorationDecisions(sessionId, { observationId, businessScope, source, evidence, decisions: [{ reviewId, groupId, revision, conditionKey }] })`。整批先验证版本、来源链、完整操作集合及现场目标，再事务提交；一项无效整批拒绝。sample 精确映射为当前成员 key，不照搬旧 key，不靠同名或序号匹配。
4. 再调用 `explore(sessionId)` 继续工作。独立页面、列表、输入范围、用途、身份和其他执行约束仍须满足。决定本身不产生成功记录，也不会重放旧操作。
5. `revokeExplorationDecisionReuse(sessionId, { reviewId, source, reason })` 撤回来源。派生决定失效并重新待决，不回退到更早的批准；上游可提交新的普通深度决定后恢复。区域来源撤回及来源决定被替换也会阻断派生引用。

程序比较准确 URL、已知上下文、完整区域结构与成员池、所选目标、操作种类及参数、风险、可重放声明、依据、用途来源和调用方排除条件。当前结构对应不唯一、新增操作、参数或约束变化会拒绝复用；原生和用途审阅的现场校验仍逐次执行。用途审阅只有已显式复用同一来源链时才能对应；深度复用不会替代用途判断。

接受后，操作完成可能使它从当前集合消失（例如唯一输入样本已填入）。仅在同文档、本次接受之后有真实成功记录支持时，允许继续剩余获批操作；原因不明的消失、新增或变化仍使决定失效。该规则不复制覆盖率、检查结果、身份或历史状态，返回页面也不等于恢复服务器业务状态。

上层可订阅持久事件 `exploration.decision_reuse_requested` 后读取材料并异步提交。也可提供 `hooks.explorationDecisionReuse(material, ctx)`，返回同一接受输入或 `undefined`；hook 超时/失败保持待决，迟到结果不写入。接受决定和 `explore` 分开，避免上游尚未准备好就开始派发。

所有上述方法均有同名 client 方法及命令；只读 HTTP 地址为 `GET /v1/sessions/:sessionId/exploration-decision-reuse`。审计集合为 `exploration-decision-reviews` 和 `exploration-decision-applications`，分别保存来源注册和当前接受记录。事件还包括 `exploration.decision_reuse_registered`、`exploration.decision_reused`、`exploration.decision_reuse_revoked`、`exploration.decision_invalidated`。失效记录保留原决定与原因；报告不将失效 skip/sample 继续当作有效排除。

调试页范围面板把失效决定显示为“等待重新决定”，保留原决定、来源和失效原因；当前版本的新决定可解除待决，仍需另行启动 DFS。尚无专用复用面板，上述接受操作通过 hook、SDK 或 HTTP 完成。`explore` 会先重新观察，先前未提交的接受候选可能因此过期；上游应重新读取当前材料，不替换旧候选里的版本字段后直接重试。OKX 的待决零动作、显式接受和再次 DFS 往返见[本轮验收](experiments/exploration-decision-reuse-2026-10-15/README.md)。
