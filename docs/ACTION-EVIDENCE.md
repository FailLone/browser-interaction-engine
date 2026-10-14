# 操作候选与证据

采集到元素，不等于发现了操作。`Control.actions` 可以为空：弹窗容器、可聚焦文案等仍保留观察、身份和区域关系，不生成兜底 click。Playwright 适配层解释网页；core 处理通用的操作依据、待办、执行与恢复语义。

## 三类独立信息

| 信息 | 字段 | 含义 |
| --- | --- | --- |
| 操作依据 | `ActionCandidate.basis`、`Control.actionBasis[kind]` | 为什么登记操作；包含状态、来源、规则版本和事实 |
| 当前前提 | `preconditions`、控件 `actionable` | 是否可见、可用、可编辑、有遮挡、位于当前弹层内 |
| 实际结果 | `ActionAttempt`、后续观察与 diff | 执行结果、观察完整性及期间发生的变化 |

`basis.status = supported` 表示依据足以登记候选，不能断言实现正确或业务效果成立。ARIA 记录 `implementation: unverified`。`succeeded` 表示驱动执行完成且没有关键观察缺口；diff 使用 `observed_during_interval`。没有变化不会自动证明元素没有用途；试探成功也不会自动升级操作依据。

## 浏览器规则

| 证据 | 结果 |
| --- | --- |
| 原生 button、按钮类 input、有 href 的 a、details 的首个 summary | 支持 click |
| 原生文本输入、textarea、contenteditable | 支持 fill；只读、禁用状态另行阻塞 |
| select、原生 checkbox/radio | 分别支持 select/check |
| ARIA button/link/tab/menuitem/option/combobox | 声明 click，实现未验证 |
| ARIA checkbox/radio/switch/menuitemcheckbox/menuitemradio | 声明 check，实现未验证 |
| 只有 onclick 属性或 onclick property | 疑似 click，`basis.status = tentative` |
| 只有 tabindex、cursor:pointer、aria-expanded、aria-controls | 保存 `interactionHints`，不生成 click |
| dialog/region 容器、长文案、包含按钮、可见、命中测试通过 | 不构成自身的 click 依据 |
| file/color/range 等未支持的输入 | 记录能力缺口，不兜底成 click |

`discovery` 保存实际命中的选择器和补充信号，不能用“有 role”冒充操作依据。多个弱信号不会相加变成受支持操作。后代按钮独立登记。

补充扫描最多检查 5000 个元素的 onclick property 和鼠标样式；原生/语义选择器独立采集，仍受总控件预算约束。继承 pointer 样式不会把全部后代登记成目标。未扫描范围记录 `SIGNAL_SCAN_TRUNCATED`。html/body 上的事件和焦点线索保存到 `Observation.actionDiscovery.documentHints`，不把文档根登记成操作目标，也不因 React Portal 留下的文档级事件代理破坏界面状态归并。

不枚举 addEventListener、委托监听器或框架内部事件，观察保留 `EVENT_LISTENER_COVERAGE`。处理器代码不用于推断业务用途。

## 疑似操作

疑似操作写入 action，并发出持久化 `action.tentative` 事件。控件覆盖模式不为其生成自动探索待办，在 controlCoverage 中单独报告未确认范围；representative/stateful 保留 blocked 待办，原因为 `action_basis_unconfirmed`，其他更直接的阻塞条件优先显示。自动探索均跳过它，不将其视为已完成。

外部明确调用 `execute(sessionId, actionId, requestId)` 可以试探候选。UI 按钮标为“试探”。试探仍使用统一队列、最新观察、目标唯一性、弹层边界和预算检查。疑似操作及其迁移不可自动重放，恢复也不会把它作为自动关闭动作。

调用方可以通过 actions hook 提交判断，保留原有证据并追加来源。例如，依据绑定到当前观察的调用方判断：

```ts
actions: (actions, { observation }) => actions.map(action => {
  const judgment = callerJudgments.get(action.controlId);
  if (!judgment || judgment.observationId !== observation.id) return action;
  return {
    ...action,
    basis: {
      status: 'supported',
      evidence: [
        ...(action.basis?.evidence ?? []),
        { source: judgment.source, rule: judgment.ruleVersion, facts: judgment.facts },
      ],
    },
  };
})
```

补充针对观察目标的操作也应提供依据；浏览器操作缺少依据时按 tentative 处理。core 验证依据结构，不能代替调用方验证真实性。无效 hook 输出记录 `hook.error`，观察事实仍保存，依赖分支受阻。已有通用适配器及历史动作的可选 basis 字段保持兼容。

## 历史与验证

新观察契约为 `observable-v3`。规范化包含操作依据，执行前依据变化会触发过期检查。不同规则版本不归并状态；逻辑身份仍独立关联。旧观察、动作和尝试不回写，缺少 basis 的历史记录显示“未保存依据”。新规则在下一次观察或新会话生效。

测试覆盖弹窗长文案、静态焦点目标、弱信号、原生与 ARIA 控件、只读和不支持输入、默认 DFS、外部试探、hook 判断、前提过期、历史身份、Portal 状态归并，以及 HTTP/UI 读取同一证据。
