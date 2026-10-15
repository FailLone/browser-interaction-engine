# 复合控件、外部解释和显式探测

引擎提供事实、操作与一致性校验，不依赖调用方是否为人工、规则程序或模型。浏览器规则只从页面声明和可记录的结构生成分组；不向 DOM 注入业务含义，不把自写属性当成识别证据。

## 分组和成员

`Observation.components` 保存 `id/kind/name/members/basis`，浏览器另外提供根节点 `rootNodeId` 和 `rect`。fieldset、ARIA group/radiogroup/tablist/menu/listbox 和 `data-component-kind` 是页面声明；定位浮层关系与同角色直接兄弟只构成 tentative 分组。声明是页面的说法，不是独立验证的业务事实。

五个星形按钮可以属于同一个 `choice-group`，但仍有五个 `localId`、五个身份和各自的点击动作。没有显式值时成员的 `value` 缺省，不能从 DOM 顺序生成 1～5 分。组件 ID 绑定当前 document 的根节点实例；不承诺跨刷新对应关系。嵌套组通过 `parentId` 连接，各组保留自己的直接成员。

页面可以提供 `data-component-kind` 和 `data-component-value`；这些是可选的页面声明，不能消除重复节点的身份歧义。引擎自身的节点跟踪使用 WeakMap，不写入这些属性。

## 查询

| HTTP GET | SDK/client | 返回 |
| --- | --- | --- |
| `/sessions/:sid/observations/:oid/components` | client.components；SDK observation.components / componentDescriptions | 分组及这次观察的外部解释 |
| `/sessions/:sid/observations/:oid/components/:componentId` | componentDetails | 成员、动作、祖先、局部子树、嵌套组、状态、截图引用和区域、来源解释、同实例历史及缺口 |

详细查询只读已提交历史，不触发观察或浏览器操作。局部子树最多 500 节点；截断后用现有 `dom({rootId,offset,limit,depth})` 分页。历史最多 20 次，返回 `timelineTruncated`；历史关联只使用同一 document 中的同一根实例，不跨刷新猜测。每个历史项保留 observationId、时间、触发动作及其 beforeId/afterId。证据失效时仍返回基础分组，并说明 DOM 或截图不可用，不用最新页面补造过去。

调试页面的“详细数据 → 复合控件”展示成员和显式值，分别展示页面/结构依据与外部解释，也能打开该组件的 DOM 子树。

## 提交外部解释

SDK/client 都提供 `describeComponent(sessionId, description)`，HTTP 使用统一 commands 路径：

```json
{
  "type": "describeComponent",
  "observationId": "current-observation",
  "componentId": "component:root-instance",
  "kind": "rating",
  "name": "页面评分",
  "members": [{"localId":"member-instance","role":"button","value":1}],
  "source": "application-reviewer",
  "reason": "解释依据及其限制",
  "evidence": [{"observationId":"captured-observation","componentId":"component:root-instance"}]
}
```

示例省略其他成员；实际请求必须恰好覆盖被描述组件的所有成员，不能重复或混入别的控件。引用必须属于同一会话，指向存在的观察/控件/组件。引用有效只证明来源存在，不证明解释正确或大块证据仍可读取；调用方需检查 availability/gaps。

提交必须针对当前观察，并在队列内重验页面。节点、声明绑定或组件成员改变后返回 `STALE_OBSERVATION`。通过后新增 `ComponentDescription` 和 `component.described` 事件，保留 source/reason/evidence。它不会重写原观察、清除身份假设、赋予重放资格，或自动迁移到下一次观察。多个来源的解释可以并存；引擎不替调用方选择“正确答案”。

若要依据解释执行值选择，调用方在当前观察中找到对应成员，再选择它的既有 ActionCandidate，经普通 execute 执行。不得将成员列表索引当成值。

## 主动探测

```ts
const before = await client.observation(sessionId);
const attempt = await client.probe(sessionId, before.id, memberLocalId, 'hover', requestId);
const after = await client.componentDetails(sessionId, attempt.afterId!, componentId);
```

HTTP 命令为 `{type:'probe', observationId, localId, kind:'hover'|'focus', requestId}`。进程内 SDK 参数相同。core 仅通过适配器 `probeAction` 扩展点理解平台能力；浏览器实现 hover/focus，不导入模型或判断业务类型。

探测必须显式请求，默认发现/DFS 不批量添加 hover/focus。它沿用串行队列、动作前检查、当前节点绑定、业务上下文、弹层边界、遮挡、预算、幂等 requestId、动作记录及动作后的采集/检查通知。即使历史身份未解决，也可以明确探测当前唯一节点实例；不会因此解决历史身份。

探测的 `source` 是 `external-probe`，`risk` 为 `unknown`，不自动重放。hover/focus 可能改变页面或触发请求；引擎不宣称可逆，不自动恢复鼠标或焦点。重复 requestId 和参数返回同一个 attempt，参数不同返回 `REQUEST_CONFLICT`。目标或观察过期必须重新选择。动作成功只表示浏览器操作完成，前后证据才支持行为解释；例如 hover 显示五颗星不证明 click 的服务器副作用。

## 身份判断校验

`identityDecisionCommand` 接受实际导出的 `image:<observationId>`，拒绝不存在或不可用的图片引用，并自动携带 `guard:{observationId,revision}`。HTTP 和进程内 resolveIdentity 共用当前观察/修订、节点连续性、声明绑定与候选冲突校验；拒绝 `STALE_IDENTITY_REVIEW` 时不能强行提交旧结论。历史目标缺席时，客户端额外携带 `scope:"historical"`，只授权历史对账；当前实例换绑仍拒绝。旧调用方可省略 guard，但只能获得调用开始后的排队/现场校验，无法证明其先前阅读的版本仍然有效，建议升级。

这些检查验证结构、引用和时效，不评价调用方推理质量。原始 evidence 字符串保留为外部陈述，不是引擎认证的事实。
