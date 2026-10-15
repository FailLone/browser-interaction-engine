# 上层审阅的弹层退出

自定义弹层不一定响应 Escape 或入口重复点击。引擎保留这些尝试的真实结果，同时提供外部点击候选：上层判断一个当前位置是否值得尝试取消，引擎执行并验证。此能力不选择列表项，也不把动作派发成功视为返回成功。

## 接入

- `boundaryExitMaterial(sessionId)` / `GET /v1/sessions/:sid/boundary-exit`：当前观察、弹层、候选位置、现有控件出口、尝试和验证结果。
- `hooks.boundaryExitReview(material, context)`：可返回下述审阅，也可不答复。相同弹层实例及候选条件不重复调用；候选或尝试状态改变会重新提供机会。
- 持久事件：`boundary.exit_review_requested`、`boundary.exit_reviewed`、`boundary.exit_review_invalidated`、`boundary.exit_result`。
- `reviewBoundaryExit(sessionId, review)` / HTTP `commands` 中的 `reviewBoundaryExit`；调试页“范围决策 → 弹层退出审阅”使用相同协议。

```ts
await client.reviewBoundaryExit(sessionId, {
  observationId: material.observationId,
  boundaryKey: material.boundary!.key,
  source: 'caller-reviewer',
  evidence: ['根据当前截图和交互约定，批准此位置的一次取消尝试'],
  decision: {
    mode: 'attempt',
    candidateId: selectedCandidate.id,
    preserveControlIds: selectedCurrentControls.map(c => c.localId),
  },
});
```

也可提交 `decision: { mode: 'defer' }`。不答复或暂缓均不产生外部点击权限；上层后续可审阅当前材料。批准不会立即点击，而是生成一个 `dismiss` 动作，可显式执行，也可在弹层内已允许工作完成后由探索调度执行。已有实际控件出口继续使用 `reviewControls.exitBoundary`，标准 Close / Escape 保留现有协议。

## 绑定与验证

最多提供八个可见、命中验证通过的外部位置；排除已观察的交互目标，嵌套面板的位置必须留在父边界内。位置是几何建议，不是安全取消的证明；页面委托事件仍可能产生未知效果，必须由上层决定是否尝试。

提交绑定当前观察，并现场验证文档、地址、声明上下文、边界和目标；执行前以及指针移动后，再验证节点实例、父节点、属性、命中位置、视口、面板几何和指定控件事实。目标替换、位移、遮挡或保留字段改变时拒绝点击。与退出无关的背景区域变化不阻塞此操作，但不会获得区域重新批准。

每次批准只允许当前弹层实例的一次候选尝试；无效点不会因再次观察而自动重试。退出后重新打开同一面板需要新批准。外部点击不授予历史重放权限，也不改变原区域、列表或目的页决定。

结果分别记录：

| 字段 | 含义 |
| --- | --- |
| `dispatched` | 引擎动作状态，不能单独证明取消效果 |
| `closed` | 在完整结果观察、同文档/地址/声明上下文下，原边界消失 |
| `parentReady` | 原边界关闭，父边界栈符合预期，观察稳定且没有局部未就绪缺口 |
| `preserved` | 上层指定的当前控件实例、语义和字段值保持相等 |
| `status` | `verified` / `not_closed` / `changed` / `unverified` |

空 `preserveControlIds` 不验证业务字段。`verified` 仅证明上述范围，不表示检查点完整恢复或未声明的服务端状态恢复。

`changed` / `unverified` 后自动探索以 `BOUNDARY_EXIT_UNVERIFIED` 暂停，单纯重新观察不会解除；由上层检查并显式执行恢复操作后再继续。`not_closed` 保留当前边界和覆盖缺口，可审阅其他尚未尝试的出口。

## 当前边界

仅实现顶层 DOM 的有限外部点候选，不覆盖任意坐标、iframe、Shadow DOM、拖拽取消或站点内部事件协议。未发现合适位置时仍可能需要控件用途审阅、人工恢复或业务环境重置；不会自动推断可安全选回当前项。
