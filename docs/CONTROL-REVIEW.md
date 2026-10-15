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
- 普通控件审阅不跨节点、文档或会话复用；相似列表的[用途条件复用](LIST-EXPLORATION.md)仍是另一套协议。
- [候选控件分类](CONTROL-CLASSIFICATION.md)提供独立的展示/容器/操作入口/需探测/未决判断；分类不授予操作能力。hover 可作为已审阅操作，CSS 自定义提示归属、主动探测策略和整页发现完整性仍待补齐。
- 当前提供 SDK、HTTP、hook 和本地审阅工作台，尚无专用控件审阅面板。操作仍按[操作审计](EXPLORATION-AUDIT.md)计数，审阅记录数量不证明整页穷尽。
