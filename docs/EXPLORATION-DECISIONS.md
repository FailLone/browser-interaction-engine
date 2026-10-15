# 通用探索范围决策

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

## 页面范围优先于 DFS 顺序

新浏览器会话默认 `pageExploration: 'review'`。入口页面是首次完整初始观察的实际 URL（包括启动重定向后的落地地址）。DFS 只决定已获准范围内的顺序，不代表沿所有链接继续深入。

1. 当前页面的普通工作优先于已知离页入口。无法从候选预知的按钮导航，在动作后的观察中识别。
2. 到达其他 URL 后，产生 `kind: 'page'` 的范围请求，沿用 `explorationDecision`、持久事件及 `decideExplorationGroup` 命令。未获准前，不自动操作目的页业务控件。
3. 没有决定、defer、skip，或指定样本已无当前可执行项（包括深度上限阻塞）时，先退出目的页的活动弹层，再尝试原生历史返回来源页，继续允许的工作。有效出口仍可执行；没有有效出口则保留 ACTIVE_BOUNDARY_BLOCKED。
4. all 允许深入该页面，但 B 通往的 C 会有独立请求。sample 只放行选中的已观察操作样本，defer 留待后续，skip 保留未测。调试页支持允许、暂缓和本轮不测；指定样本通过 hook/SDK/HTTP 提交。

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

命令仍是 `{ type: 'decideExplorationGroup', groupId, revision, decision }`。提交决策本身不操作浏览器或自动恢复探索。revision 必须匹配；新成员或新决策都可能改变版本，过期返回 STALE_GROUP_DECISION，应重新读取材料判断。

通用范围默认绑定文档/实例范围、声明上下文及 conditions。默认 binding 下文档或上下文改变，或同 kind/key 的 conditions 改变时，旧组标为 invalidated，旧未执行待办保留为 superseded / exploration_scope_invalidated；不能计为覆盖。对失效组提交决策返回 EXPLORATION_SCOPE_INVALIDATED。重新回到旧条件也创建新请求，不复活旧批准。浏览器区域节点重建在派发前检测，重新观察后要求新决策。

`binding: context` 的范围仅豁免文档实例变化；声明上下文或同 kind/key 的 conditions 改变仍使旧批准失效，回到旧条件也不复活。它允许零成员范围，用于记录没有控件的待决目的页。成员仍是精确操作样本，sample 不按名称匹配新文档的控件；all 可以接纳同条件下新发现的成员。该权限不扩展用途审阅、身份、重放或检查结果的有效期。

暂时省略范围提议不会释放仍匹配其精确成员键的候选；持续吸收新成员需要生产者继续提出该范围。业务目标变化时，应更新 conditions 或声明 context，然后 observe。引擎不能监控未声明的服务端状态或外部闭包变化；条件稳定仅表示在声明范围内可复用调度决定，不证明业务效果相同。

范围生成失败、无效引用或超时会保留观察事实，记录关键缺口 EXPLORATION_SCOPE_HOOK_FAILED 并停止自动探索；修复后 observe 可继续。决策 hook 失败、无效或超时则保留待决，超时后迟到的结果不能写入决策。

遍历决定不授予用途风险、重放、恢复或身份许可。已有列表用途审阅复用保持独立，不能用通用 region/branch 组来申请列表用途授权。每次目标验证、实际尝试、效果检查和覆盖率记录仍独立进行。

独立回归见 `tests/exploration-scopes-core.test.ts` 和 `tests/exploration-scopes-browser.test.ts`：非浏览器单动作、业务目标选择、重叠范围、条件失效、迟到决策、异常恢复、弹层退出、输入抽样、原有安全阻塞以及 SDK/HTTP。

[OKX 目标驱动实测](experiments/exploration-decisions-2026-10-15/README.md)另验证了待决期间继续其他工作、all/sample/defer/skip、金额样本、列表暂缓后自动重入，以及导航后的条件失效。实测发现并修复旧文档退出待办引发的多余返回；范围决策不提供未知退出方式的自动语义判断，默认实例绑定的旧批准也不会复活。此结果不构成全页面或全列表穷尽证明。
