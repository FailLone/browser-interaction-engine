# 可审阅的业务区域候选

当页面没有充分的区域语义时，调用方可以先确认业务边界，再决定探索深度。引擎提供可追溯的结构建议，不根据站点名称、CSS 类名或模型推断业务目的。

## 启用与流程

新会话显式设置 `regionExploration: 'review'`；默认 `off` 保持现有行为。调试页提供“先确认业务区域再探索”选项。此模式代替可选 `decisionScopes` 中的 region/branch 粒度，不允许同时开启这两项，以免确认业务区域后仍须逐个批准所有入口。similar-list、input-space、目的页以及调用方自定义范围仍各自约束操作。

1. 观察生成候选：语义容器、附近标题、flex/grid 或边框布局，以及整页后备。返回容器实例、选择器、矩形、控件成员、父候选和来源证据；同名容器保持不同实例。
2. `region.review_requested` 通知上层有未划分的控件或页面滚动。调用方读取材料，确认、合并、拆分或拒绝建议。
3. 确认只建立划分，随后生成 `kind: reviewed-region` 的待决探索范围。继续通过已有 explorationReview/Decision hook、批量 SDK/API 或调试页选择 all/sample/defer/skip。
4. 未划分项保留为 deferred / region_review_required / not_attempted。允许的工作完成后暂停为 REGION_REVIEW_REQUIRED；不会把遗漏或拒绝建议当成“已测”或“不需要测”。

已识别出口不受划分等待限制；弹层必须验证退出。页面范围继续独立，允许 A 的区域不批准目的页 B。显式单项 execute 仍是上层接管，保留当前目标和风险检查，不自动确认其他控件。

## 材料与确认协议

`engine.regionReviewMaterial(sid)`、`client.regionReviewMaterial(sid)` 或 `GET /v1/sessions/:sessionId/region-review` 是只读查询，包含当前 observationId、候选、可操作控件、当前或最近的审阅记录、unassignedControlIds 和 unassignedPageTraversal。控件 ID 是当前节点实例，不是跨文档身份；已填写过而暂时没有新输入候选的控件仍保留在区域材料中。

```ts
const material = await client.regionReviewMaterial(sessionId);
await client.reviewRegions(sessionId, {
  observationId: material.observationId,
  source: 'test-plan', evidence: ['根据容器标题和成员确认转换器与图表边界'],
  regions: [
    { key: 'converter', label: '转换器', candidateIds: [converterCandidateId] },
    { key: 'chart', label: '图表', candidateIds: [chartCandidateId] },
  ],
  rejectedCandidateIds: [],
});
// 确认返回后，读取 explorationReviewMaterial，决定新区域的探索范围。
```

`POST /v1/sessions/:sessionId/commands` 使用 `{ type: 'reviewRegions', review }`。`regions` 每项包含：

- `key` / `label`：上层指定的唯一键及业务名称。
- `candidateIds`：本次观察中的一个或多个候选；多个候选取成员并集，实现合并。
- `controlIds`：可选的明确子集。省略则采用候选中全部可操作控件；同一候选可按不同子集拆成多个区域。区域之间不得重复分配控件。
- `pageTraversal`：默认 false，可显式将整个页面滚动归给一个区域；同一划分最多一个区域包含它。该区域选 all 才允许自动滚动，sample 不会放行遍历。也支持空 controlIds 的纯页面发现范围。

`rejectedCandidateIds` 记录拒绝的结构建议，不能同时作为确认区域的锚点。拒绝建议不会放行或删除其控件；可通过其他候选重新划分。没有被选中的控件仍待确认。

每次提交是**完整替换当前划分**；需保留的有效区域应一并提交。先验证所有候选、成员、重复和观察版本，再事务写入并退役旧划分及其范围决定，随后执行一次只读观察生成新范围。重新划分不会沿用旧 all，也不会启动探索。确认后若页面在重新观察期间改变，返回记录可能已 invalidated，需要审阅最新材料。

命令在当前会话的浏览器中验证最新 DOM；引用过期观察或现场变化返回 STALE_REGION_REVIEW，非法划分为 INVALID_REGION_REVIEW，未启用为 REGION_REVIEW_DISABLED。不会拿另一个会话的浏览器确认历史记录。

## Hook、事件与持久记录

浏览器 `hooks.regionReview(material, ctx)` 在发现新材料且仍有未划分项时调用。可返回上述 review，或 undefined 转交异步消费者；执行超时 5 秒，错误和迟到结果不写入确认。随后已有探索决策 hook 会收到已确认区域的待决范围。hook 中不要等待同一引擎的命令队列；人工或耗时判断采用事件、查询和命令。

持久事件包括 `region.review_requested`（观察和候选引用）、`region.reviewed`（确认记录）、`region.review_invalidated`（失效区域及原因）。同一未变材料不反复通知；仅重读观察也不重复请求。通过 `GET /v1/sessions/:sessionId/region-reviews` 查询历史，或 SDK 通用 list 查询。事件引用可过期，异步消费者需重新获取材料，不可机械替换 observationId 重试。

调试页支持建议草稿、修改名称、多个候选合并、按成员拆分、拒绝候选及页面滚动归属；草稿期间观察更新会禁用提交。确认后在同页的探索决策面板选择穷尽、样本或暂缓。

## 有效期与边界

确认绑定文档实例、完整 URL、声明业务上下文、容器与祖先节点、标题、成员节点/归属、支持的操作和约束。区域替换、控件移动或增减、业务绑定变化会使受影响区域失效，其他独立区域保留；返回旧条件不会复活批准。纯输入值、选中值、行情正文和绝对位置不作为区域结构绑定。具体操作仍独立验证，不复用用途、身份、重放或执行结果。

布局候选仅表示共同容器，不能证明同一业务功能。候选基于现有主文档控件，最多 500 个容器、每个控件向上检查 24 层；整页后备仍覆盖已观察控件。该机制不新增未知事件操作、iframe/Shadow DOM 或视觉识别。深层结构可由整页后备与显式成员子集划分，但后备锚点绑定较宽，会更保守地失效。虚拟列表窗口或展开后新增控件也可能要求重新确认，尚无“允许结构演化”的区域契约。未声明的服务器状态无法被此机制监控。
