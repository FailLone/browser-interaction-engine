# 候选控件的上层分类

浏览器发现的 focus、pointer、事件属性线索可能来自操作入口、展示内容或父容器。`controlClassification` 让上层解释一个当前节点；[控件操作审阅](CONTROL-REVIEW.md)回答怎样操作，[探索范围决定](EXPLORATION-DECISIONS.md)回答要不要深入。三者分别记录，不互相授予权限。

## 协议

监听持久事件 `control.classification_requested`，暂停并等待在途操作完成后读取 `controlClassificationMaterial(sessionId)`。材料包含当前可见控件、操作依据、有限子树、当前动作、历史分类和 `pendingControlIds`。事件发布时材料已可查询，相同条件不重复通知。

提交 `classifyControls(sessionId, {observationId, source, classifications})`，每项是 `{localId, classification, reason, evidence}`。reason 和 evidence 必须非空。支持五种分类：

| classification | 含义 | 引擎处理 |
| --- | --- | --- |
| interaction | 上层认为是操作入口 | 仍需独立操作依据及范围决定，不自动生成动作 |
| display | 该候选自身仅用于展示 | 减少该节点的未知操作请求及未尝试的推测候选；不算成功覆盖 |
| container | 该候选自身为聚合容器 | 与 display 相同，子控件仍独立发现、审阅和执行 |
| probe_required | 需要受控探测才能判断 | 保留未知用途；不授权探测，不提高动作优先级 |
| unresolved | 当前材料不足以判断 | 保留未知用途和理由，等待上层后续处理 |

分类批次先整体校验再保存。陈旧观察、关键缺口、未知的已声明上下文、隐藏/不存在的目标、重复节点和无效材料会被拒绝。提交前现场校验，提交后重新观察；必须检查返回记录是否仍 active。控件分类 hook 也有 5 秒期限，迟到结果或迟到现场校验不会写入记录。

进程内 `hooks.controlClassification(material, ctx)` 返回相同输入或 undefined。该 hook 在控件操作审阅 hook 之前运行；最终调用方 actions 策略和列表用途审阅之后，再校验分类是否与确定能力冲突。返回 interaction/probe_required/unresolved 后，相同分类材料不反复请求；操作用途未确认仍留在控件审阅材料中。

SDK 提供 `controlClassificationMaterial`、`controlClassifications`、`classifyControls`、`revokeControlClassification`。HTTP 材料为 `GET /v1/sessions/:id/control-classification`，分页记录为 `GET /v1/sessions/:id/control-classifications`。原命令接口接受 `{type:'classifyControls', classification}` 和 `{type:'revokeControlClassification', revocation:{classificationId, source, reason}}`。

## 条件与失效

分类绑定文档实例、完整 URL、已声明上下文、确切节点、原始操作依据/线索及有限子树。子树最多 200 个元素、8,000 字符文本、16,000 字符材料，单属性最多 1,000 字符。截断材料仍可供上层记录未决或探测需求，但不能据此判为展示/容器。旧观察没有子树材料时，也不能追认否定分类。

展示/容器分类不能清除原生、ARIA、滚动或其他来源已支持的操作。即使控件被禁用、遮挡或范围未批准，已有支持能力仍存在；整批负向分类会被拒绝。后续操作审阅或 actions hook 提供支持依据时，冲突分类失效，支持操作继续交给独立策略处理。

节点替换、移动、子树/属性/文本变化、操作依据、URL 或声明上下文变化均会使受影响分类失效。新文档不继承旧分类。恢复原条件不会自动复活旧记录。事件为 `control.classified`、`control.classification_invalidated`、`control.classification_superseded`、`control.classification_revoked`；状态保留 active / invalidated / superseded / revoked。

已连接会话撤销后重新观察，恢复候选及待审请求；未连接时只保存撤销，后续观察再生成候选。未尝试的弱操作可保留为 `control_classified_noninteractive` 退役记录，带分类 ID、条件摘要、来源、理由和证据；已执行或失败的尝试不被改写。后续观察重新产生相同候选时，仍可重新进入待办。

## 完成报告和边界

`controlCoverage` 将 display、container 与原生 read_only、未确认和已执行能力分开计数。只有同一汇总项所有观察条件都由有效分类覆盖，才移出未确认项；当前判断不能抹去同一逻辑身份在其他文档/上下文留下的未知条件。支持操作始终优先，分类本身不产生成功覆盖。

`completionAudit.controlClassifications` 保留完整分类历史及来源，调试页显示展示/容器数量。分类不移除观察缺口，不证明事件处理器完整、服务器状态或整页发现完整。完整子树仅指所采集的有界 DOM 材料，不能证明没有 delegated/addEventListener 处理器、Shadow DOM 或 Canvas 内部交互。

当前提供协议及报告，尚无专用分类编辑面板。自动主动探测、说明归属、扫描截断位置与有界补采继续在 roadmap 中推进。
