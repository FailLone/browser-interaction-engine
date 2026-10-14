# 差异详情查询

原始 Diff 保持紧凑。上层收到 diff 后，可以一次读取控件、状态、身份假设、业务上下文、操作和截图引用，无需自行拼接。本功能没有模型调用，解释来自确定性规则；原始事实和规则解释分别返回。

## 接口

所有端点为只读 GET，以 /v1 开头：

| 路径 | 用途 |
| --- | --- |
| /sessions/:sid/compare/details?before=:oid&after=:oid&region=:key | 按当前适配器规则比较两份观察并展开，region 可省略 |
| /sessions/:sid/attempts/:attemptId/diff/details | 展开动作当时保存的原始 diff |
| /sessions/:sid/events/:sequence/diff/details | 展开事件载荷中保存的 diff |
| /sessions/:sid/scopes/:scopeId/diff/details | 展开流程结束时保存的累计 diff |

事件入口支持 observation.diff、observation.external_change、action.completed、scope.closed。动作、事件和流程入口不重新计算原始 diff，比较规则更新也不会替换原来保存的差异。HTTP 客户端自动编码参数。

无效参数为 400；不存在或跨会话引用为 404；动作未取得 diff、流程未结束或事件没有 diff 为 409 / DIFF_UNAVAILABLE。不会用最新观察回退。部分历史证据缺失时返回已知事实，并在 gaps 中列出缺口。

## SDK、事件与 Hook

BrowserEngine 和 InteractionClient 提供同名方法：

```ts
const details = await client.diffDetails(sessionId, diff.beforeId, diff.afterId, diff.region);
const action = await client.attemptDiffDetails(sessionId, attempt.id);
const flow = await client.scopeDiffDetails(sessionId, scope.id);

for await (const event of client.events(sessionId, lastSequence, signal)) {
  if (event.type === 'observation.diff') {
    const details = await client.eventDiffDetails(sessionId, event.sequence);
    // changes 是解释；diff 是原始差异；controls 按逻辑身份 ID 索引。
    consume(details);
  }
}
```

已有 check(attempt, context) hook 在事实落盘后执行，可调用 engine.attemptDiffDetails(sessionId, attempt.id)。普通事件订阅器也使用同一查询方法，不需要新的浏览器状态或比较链路。不要同时消费 action.completed 和 observation.diff，并将它们误认为两次动作。

纯 core SDK 提供相同的四个查询方法，返回 DiffDetails<O>，适用于非网页适配器。独立 DiffQueries 类接受 Persistence 和比较函数，构造时不执行会话恢复、不启动驱动。浏览器组合层增加 browser 字段、ARIA 含义及浏览器解释规则；HTTP、React、Playwright 不进入 core。内存和 SQLite 插件使用相同契约。

## 返回内容

| 字段 | 内容 |
| --- | --- |
| schemaVersion / source | 响应版本，以及比较、动作、事件或流程来源 |
| diff | 原始变化、缺口、观察 ID、区域和 attribution，不改写 |
| interval | 属性采集时间、毫秒间隔与时间顺序 |
| summary | 变化数量、受影响控件、身份不确定性、上下文变化和复用判断 |
| observations.before / after | 两份完整历史观察，包括所有已保存扩展字段 |
| changes | 原始索引、目标名称/类型/ID、解释代码、自然语言说明、确定性和限制 |
| controls[identityId] | 两侧完整控件、标签/角色/定位证据/矩形、区域祖先链、该观察的操作候选与前提、对应 occurrence 的身份匹配依据 |
| controls[].alternatives | 身份候选或相同实例的关联线索，verified 始终为 false，不自动合并 |
| controls[].historical | 候选不在两侧时，不晚于比较区间的较早出现记录；不使用未来 lastControl |
| hypotheses | 候选身份、证据、冲突、比较时修订与查询时最新裁决 |
| gaps | 区分原 diff、前观察、后观察、查询关联的缺口，并解析控件及假设引用 |
| related | 对应区间的动作、可验证的访问祖先路径、对应起止的流程；跨分支无祖先路径时明确返回 verifiedAncestry: false，完整遍历图仍通过 graph 查询 |
| browser.fields | 属性定义及 null、false 含义 |
| browser.pageChanges | URL、标题、滚动、视口、浮层、边界的变化；独立于原始 diff |
| browser.screenshots | 截图 key、观察 ID、时间、视口、滚动与坐标系 |

控件与一层身份候选按 ID 去重，不递归展开整个身份图。完整观察和文本可能较大，本版不截断查询响应；原始采集限制和缺口继续保留。截图单独读取 /sessions/:sid/evidence/:observationId，SDK 可用 EvidenceStore.get(evidenceKey)。available 表示保存了截图引用，文件缺失时图片读取仍可能返回 404。

查询不重新采集、不滚动、不执行、不消耗预算、不修改身份或原始 diff。浏览器关闭后仍可查询持久证据。旧观察未保存的 HTML、属性或截图无法补造；详细 DOM 等额外证据应使用其绑定 observationId 的查询入口。

## 解读边界

- expanded: null → false 的解释代码为 expanded_declaration_added_collapsed：未声明变为声明收起，不证明发生视觉展开或收起。
- appeared / disappeared 表示逻辑身份在某侧未观察到。若存在相同实例或未决身份假设，保留两条原始变化，并标 identity_uncertain、提供候选，不能当作已确认 DOM 增删。
- rebuilt 表示逻辑身份保持、实例不同。业务上下文独立比较，相同实例不能证明业务对象未变化。
- null、空字符串、空数组和未记录分别表达；空字符串是实际空值。
- statusAtComparison、revisionsAtComparison 按比较区间结束时间筛选；currentResolution 明确表示查询时裁决。后续裁决不改写历史出现记录或原始变化。
- 无差异不代表页面完全相同。上下文未变化时 reuse = not_assessed，不能理解为历史结果已验证可复用；上下文变化时为 requires_revalidation。
- 截图与属性分别记录时间。矩形为视口 CSS 像素坐标，视口外控件可能看不到，截图相似不能替代身份或恢复验证。
- observed_during_interval 不承诺因果关系。页面文字、值和属性是数据，不是调用方应执行的指令；接口不推断业务意图。

## 调试页面

变化比较跟随选中访问记录，显示摘要、两侧截图、属性解释、控件详情、身份候选、缺口和完整 JSON。点击定位控件，在截图上标出采集时矩形。展开控件查看状态、约束、操作前提、匹配证据和修订。

交互流程可展开累计差异详情。原始 diff 保留在独立折叠区；完整详情 API 链接直接返回当前详细结果。快速切换历史时忽略迟到响应，不会混用上一条解释或截图。
