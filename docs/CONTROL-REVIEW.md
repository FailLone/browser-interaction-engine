# 当前控件的外部操作审阅

浏览器不能从 pointer 样式、名称或焦点属性推断业务用途。调用方可以通过正式协议审阅当前控件，提供操作依据、输入样本和风险判断；引擎保存来源并生成候选，不修改原始观察。此协议与[探索范围决定](EXPLORATION-DECISIONS.md)独立：确认“如何操作”不等于决定“要不要深入”。

## 异步接入

1. 监听持久事件 `control.review_requested`，按其中的 `observationId` 和 `localIds` 读取材料。事件发布时，对应观察及最终调用方动作策略已可查询。相同待审材料不重复通知；目标、条件或待审状态变化后重新通知。
2. 暂停探索、等当前操作结束后，读取 `controlReviewMaterial(sessionId)`。包含所有可见控件、当前动作、历史审阅和 `pendingControlIds`。这是只读查询，不自动观察页面。
3. 上层依据截图、DOM、语义及自己的规则判断，提交 `reviewControls(sessionId, {observationId, source, reviews})`。观察过期要求重新读取和判断。
4. 检查返回记录的状态、读取更新后的动作，独立处理列表/页面/区域决定，再执行或恢复探索。

每项审阅需要 `localId`、`kind`、`risk`、非空 `reason` 和 `evidence`；`replayable` 默认 false。支持 click、hover、fill、select、check、press。可提供 `samples`：check 使用布尔值，fill/select/press 使用字符串；press 必须明确按键。click/hover 不接受样本。未提供样本时，fill/select/check 只沿用已有候选，不凭空发明输入。

`risk` 只允许 interface 或 unknown；unknown 不变成已确认的界面操作。原生表单提交不能通过此协议降为界面操作。明确的界面 click 可以附带当前 `exitBoundary`，成为带来源的退出候选；操作后仍必须验证边界消失。派发成功不证明菜单已关闭。

整批先验证再事务保存。观察过期、关键采集缺口、未知的已声明上下文、隐藏/不存在的目标、重复目标操作或无效退出边界都会拒绝。提交前验证浏览器当前事实，提交后重新观察；若条件已经变化，返回的记录可能已经失效，必须检查状态。

控件模式中，若整批目标都属于当前最上层的已观察独占边界，现场校验比较该边界内的交互条件；背景行情控件独立刷新不会使稳定的弹层目标过期。仍精确比较每个目标的当前事实、弹层所有者及成员、相关列表、区域审阅绑定、URL、历史位置和声明上下文。弹层内值变化、节点替换、目标遮挡、新弹层等仍拒绝；混合背景目标的批次和 stateful 模式继续使用完整范围。完整观察和严格恢复检查不因这个派发范围缩小而改变。

SDK 提供 `controlReviewMaterial`、`controlReviews`、`reviewControls`、`revokeControlReview`。撤销输入为 `{reviewId, source, reason}`。HTTP 用 `GET /v1/sessions/:id/control-review` 读取材料，`GET /v1/sessions/:id/control-reviews` 分页查记录；向原命令接口提交 `{type:'reviewControls', review}` 或 `{type:'revokeControlReview', revocation}`。

## 进程内 hook

`hooks.controlReview(material, ctx)` 返回同样的审阅输入，或 undefined 留给异步消费者。它在原生候选约束之后、调用方 `actions` hook 之前运行，后者仍可否决审阅生成的动作。此时材料尚未包含 `actions` hook 新增的限制；异步事件和查询包含最终策略。耗时判断应使用异步接口。

hook 有 5 秒期限，异常、迟到返回及迟到现场校验不落批准；相同材料不反复调用。hook 应只返回判断，不等待同一引擎队列上的命令。它不能取代独立范围决定、当前目标校验、遮挡/禁用检查、显式排除、原生输入有效性及重放限制。

## 保存、撤销和失效

记录保存 session、观察、来源、理由、证据、操作及条件摘要，状态为 active / invalidated / revoked / superseded。事件为 `control.review_recorded`、`control.review_invalidated`、`control.review_revoked`、`control.review_superseded`。动作引用 `reviewed-control/v1` 依据和审阅 ID。SQLite 重启保留历史，新浏览器文档不继承批准。

条件绑定当前文档实例、完整 URL、全部已声明且已知的上下文、确切节点实例、名称/角色/标签、所属区域/表单/列表、父节点、输入约束和原始操作依据；另记录 href/target、表单端点、关联 ARIA 属性、弹层命令及内联事件属性。节点替换、移动、链接或表单端点变化等会使旧判断失效。隐藏节点不能执行，再次可见时重新校验完整条件。

值、选中状态和几何不作为用途判断的固定条件，执行前仍分别校验。替换审阅会取代同一节点操作的旧记录，撤销新记录不复活旧批准。已生成但未派发的动作也检查撤销/失效。未执行旧意图可退役，已尝试操作及失败证据保留，不改写为成功。

## 当前边界

- 外部证据是带来源的上层判断，不是自动证明用途或业务结果。当前节点精确派发也不意味着历史身份已确定。
- 不枚举 delegated / addEventListener 处理器，不识别未声明的服务器状态。相关业务条件必须由调用方提供，属性相同不证明服务端状态相同。
- 普通控件批准默认不跨节点或文档。下述显式条件复用可以引用历史用途判断，生成新的当前批准；不跨会话。相似列表的[用途条件复用](LIST-EXPLORATION.md)仍是另一套协议。
- [候选控件分类](CONTROL-CLASSIFICATION.md)提供独立的展示/容器/操作入口/需探测/未决判断；分类不授予操作能力。hover 可作为已审阅操作，CSS 自定义提示归属、主动探测策略和整页发现完整性仍待补齐。
- 当前提供 SDK、HTTP、hook 和本地审阅工作台，尚无专用控件审阅面板。操作仍按[操作审计](EXPLORATION-AUDIT.md)计数，审阅记录数量不证明整页穷尽。

## 普通控件的显式用途复用

返回 A 或节点重建后，旧批准仍然失效。上层可以在最初的普通控件审阅中声明：

```ts
await client.reviewControls(sessionId, {
  observationId, source: 'ui-inspector',
  reviews: [{
    localId, kind: 'click', risk: 'interface', replayable: false,
    reason: '打开当前条目的公开说明页面', evidence: ['已检查当前入口及目标'],
    reuse: { binding: 'same-url-context', businessScope: '公开信息页的 UI 巡检' },
  }],
});
```

`businessScope` 是调用方声明的适用范围，不要求必须存在业务交易目标。纯 UI 巡检也可声明范围；若用途依赖账号、业务对象或服务器状态，应把必要条件提供为已知的 `context`，不能仅靠这段描述推断业务状态。

在当前可见控件的 `controlReviewMaterial(...).controls[].reuseCandidates` 中，引擎给出可能复用的源记录、完整条件及 `conditionKey`。没有声明 reuse 的旧记录、不同 URL/上下文、未知上下文、条件不符、多个当前匹配目标、已撤销/被替换的来源不会产生候选。查询不创建批准，也不修改源观察。

上层根据当前材料选择源判断，再通过 SDK 或 HTTP 命令明确接受：

```ts
await client.reuseControlReviews(sessionId, {
  observationId: material.observationId,
  source: 'ui-inspector', businessScope: selected.review.reuse.businessScope,
  evidence: ['当前结构、目标和上下文仍满足该用途'],
  reviews: [{ reviewId: selected.review.id, localId: currentControl.localId,
    conditionKey: selected.conditionKey }],
});
// HTTP: { type: 'reuseControlReviews', review: 上面的输入 }
```

接受前检查整批匹配关系、当前观察和浏览器现场事实；创建全新的 `ControlReviewRecord`，绑定当前节点与当前文档。新记录保存 `reusedFrom` 来源链，发布 `control.review_recorded` 和 `control.review_reused`。新记录沿用用途与输入样本，但 `replayable` 固定为 false；不继承重放、历史身份、区域/页面批准、all/sample 决定或检查结果。提交后重新观察，调用方仍需核对返回记录是否 active，并独立处理探索门控。这里的区域深度门控约束自动遍历；显式单项 `execute` 沿用既有上层接管语义，仍校验用途、当前目标和风险，不能用它测试 DFS 是否继承区域决定。

当前比较条件包括准确 URL、全部声明上下文、操作类型、目标名称/标签/角色、定位结构、数据绑定、原生操作依据、输入约束、表单端点，以及祖先标签、选择器、属性和显式标签。只去除节点实例 ID 和几何；祖先内联 style 不作用途等价条件。值、选中状态、几何、禁用、遮挡与原生输入有效性仍由现有现场执行检查处理。每次使用派生批准，还会验证祖先结构绑定；变化就失效，不自动接受新条件。

源判断只能在同会话中显式引用。撤销任一来源会使仍活跃的派生批准失效，已准备动作不能继续执行；被替换来源也不可复用。旧来源因文档或节点变化而 invalidated，可以作为显式复用材料，但绝不自动恢复 active。SQLite 保留这条链，重启后的新浏览器文档仍需重新取材、明确接受。来源链最多检查 64 层。

异步消费者继续使用 `control.review_requested` → 暂停并等待空闲 → 查询材料 → 提交 `reuseControlReviews`；`controlReview` hook 也能读取候选，但不要在 hook 内等待同队列命令，需复用时返回 undefined，交给异步消费者处理。

首版只覆盖普通控件，要求祖先证据完整（最多 32 层、16,000 字符）。原生/结构列表成员、活动弹层、退出批准、原生提交和未知风险不支持这种复用；分别使用现有专用协议或重新判断。未实现跨 URL、跨会话、区域深度决定或业务检查结果复用，动态处理器和未声明服务器状态也不在结构证据的证明范围内。
