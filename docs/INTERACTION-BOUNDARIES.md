# 弹层优先探索

浏览器适配器将 modal、dialog、popover、浮动 menu/listbox 识别为独占交互范围。观察中的 `boundaries` 按外层到内层排列，最后一项是当前范围。即使非模态 popover 允许用户直接点击背景，默认探索也先完成弹层内可执行操作，再尝试退出。

## 识别与证据

- 原生 `dialog:modal`、打开的 `dialog`、`:popover-open`。
- ARIA dialog、alertdialog、aria-modal，以及有展开控件关联或定位证据的 menu/listbox。
- `aria-controls` / `aria-owns` 将展开控件与浮动区域关联；`popovertarget` 关联原生弹出层。支持 Portal，归属不要求 DOM 包含关系。
- 对没有语义的自定义弹窗，仅在存在覆盖视口的固定半透明背景及独立交互面板时推断，并保留启发式证据。不会仅凭 CSS 类名识别弹窗。
- 内联展开区域不会仅因 `aria-expanded=true` 成为独占范围。

`Observation.overlays` 保存浏览器证据、成员控件、候选退出控件和父范围。core 只解释通用 `InteractionBoundary`、动作归属和阻塞前提，不引入 DOM、Playwright 或 HTTP 依赖。

## 执行与 DFS

1. 执行前重新检查观察和目标。弹层突然出现或命中测试变化时，刷新观察并拒绝过期请求。
2. 当前范围外的动作保留在操作候选中，阻塞原因是 `outside_active_boundary`，并记录范围 ID、证据和解除条件；不为每个弹层状态重复生成背景操作待办。已发现的父页面待办保留，关闭弹层后根据新的完整观察安排探索。初始即打开弹层时，背景操作待办在观察到父页面后建立。
3. 当前范围内先选择普通动作，再选择退出动作。识别退出操作使用原生关闭语义、明确的关闭名称及 Escape 候选；执行退出不代表已关闭。已支持的非提交退出动作属于界面操作，不把会话标为业务状态已改变。按钮是否提交取决于实际关联的表单、按钮类型及提交方法；`type=button` 的取消按钮与 `method=dialog` 的原生关闭不属于业务提交。真正的提交按钮即使名为 Done / Close，仍保留提交风险。
4. 嵌套弹层成为当前范围；其消失后先恢复外层弹层，再恢复父页面。不会在弹层打开时跳到历史分支或直接重开入口。
5. 当前范围没有可继续的操作或有效退出方式时暂停为 `ACTIVE_BOUNDARY_BLOCKED`，保留待办。退出无效的动作不会无限重复。
6. 达到深度限制时仍可执行退出操作，但动作数和时间预算继续生效。受阻、未执行或超出预算的内部操作始终保留，不宣称覆盖完成。

SDK、HTTP、默认 DFS 与外部策略共用约束。`choose` hook 只能从当前可执行范围中选择；手动执行被阻塞动作会返回 `ACTION_BLOCKED`。遮挡与排除规则分别记录，不把临时遮挡永久排除。

## 比较、恢复与界面

自动 `InteractionScope` 保存 `boundaryKey`、`parentScopeId`、入口基线和累计操作。完整观察验证范围消失后才结束范围并比较父区域。初始即打开的弹层标记 `already_open`，关闭后的差异报告包含 `SCOPE_ENTRY_BASELINE_UNAVAILABLE`，不会伪造打开前的状态。

恢复逐层尝试退出并验证；若无法退出，返回不可达原因，不通过重新加载绕过当前范围。观察不完整时保留原范围，等待后续验证。

自动恢复只选择允许重放、可操作且属于界面操作的退出候选，不通过提交表单来关闭弹层。关闭操作不会清除之前真实提交留下的业务状态标记。仅在未能验证目标检查点、没有可用返回路径且业务状态阻止重开入口时，才报告需要重置环境。

旧会话中未执行的 `outside_active_boundary` 待办仍保存在原始存储中供审计，但 SDK / HTTP 待办集合、报告、剩余数量和默认 DFS 不再把它们计为独立探索项。历史操作候选、观察和执行记录保持不变；不会把另一界面状态下的成功操作伪记为这些历史候选已经执行。旧会话已记录的停止原因和恢复结果仍保留原始事实。

事件包括 `interaction.boundary_changed`、`interaction.boundary_unverified` 和 `exploration.boundary_blocked`。调试界面显示当前范围链和阻塞原因，禁用父页面执行按钮。

## 本地验证

- `/overlays.html?initial=modal`：原生模态对话框。
- `/overlays.html?initial=aria`：ARIA 弹窗及 Portal popover。
- `/overlays.html?initial=custom`：带遮罩的自定义弹窗。
- `/overlays.html?initial=popover`：独立原生 popover。
- `/overlays.html?initial=stuck`：无法关闭的弹窗，验证父页面保持受阻。
- `/boundary-cases.html?scenario=hidden-popup`：预渲染、没有 role、由展开控件关联的浮动区域。

回归测试覆盖关闭按钮位于 DOM 首位、嵌套范围、隐藏 opener 歧义、退出无效、动态遮挡、外部策略约束、深度预算和父页面恢复。不保证识别所有缺少语义的自定义弹层；未能识别区域但发现遮挡时仍保留 `pointer_intercepted` 阻塞证据。
