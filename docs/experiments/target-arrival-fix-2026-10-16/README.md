# 目标到达回归修复与同协议复验

**本次修复的实验验收通过。** 静态嵌套菜单、报价变化后的多步嵌套恢复均为 5/5 实际到达并完成 SDK 输入；修复版 30 轮恢复实验没有错误到达声明。A/B 模式覆盖 5/5、unknown 冷重启阻断 5/5 的既有重构收益保留。这支持继续分层重构，并消除了上轮发现的目标到达回归；没有证明任意动态网页可恢复或已穷尽。

产品代码冻结于 `1ed22389d07c34a7cca778f7802ed14c2701d94d`。首次完整回归 143 个测试文件、1417 项测试全部通过，未通过补跑替换失败。

## 冻结版本与隔离

| 对象 | 版本 / 工作区 |
| --- | --- |
| 新一轮基线 | `4857ad571c19995480a4c149abd9b2868a94c965`，共同基线已包含 SDK 分类复用 |
| 上轮失败重构 | `de364fab170a9b92227bc4f982ca78fa6a0a4633`，沿用已保存的历史 80 轮数据 |
| 本轮修复 | `1ed22389d07c34a7cca778f7802ed14c2701d94d`，`codex/exploration-layered-refactor` |
| 修复工作区 | `/Users/xietian/.codex/worktrees/exploration-layered-refactor/browser-interaction-engine` |
| 基线隔离导出 | `/var/folders/s9/dy_jbdrs3fn1qzt_gnsy4tgw0000gn/T/bie-refactor-base-29m9ndte` |
| 原主工作区 | `/Users/xietian/Projects/browser-interaction-engine`，`codex/single-selection-state-rule`，`6e111284ac3a6642844531dbc06bce462ca4293c` |

开始修复时修复分支位于 `e05f511`，无未提交差异；本轮产品差异只有两个实现文件与一个新增测试文件，见 `git show 1ed2238`。正式实验开始前提交并冻结代码，前后逐字节校验 packages/apps 和配置与对应 commit 相同。正式实验期间仅新增验证材料，没有产品修改。[source.json](source.json) 保存前后源码摘要、Node 24.22.0、Playwright 1.64.1、全部执行命令和退出状态。

[结束核对](source-after.json)确认原主工作区与 autonomous-exploration 工作区仍干净、HEAD 未改变，修复工作区产品文件仍等于 `1ed2238`，仅有本轮验证脚本和资料待提交。目录内证据哈希见 [artifact-manifest.json](artifact-manifest.json)。

全部浏览器、HTTP fixture、SQLite/内存存储均为本次创建的隔离实例。未连接或操作正在测试的浏览器、现有服务或任务数据库。unknown 注入仅写各实验自己的临时记录。

## 修复内容与契约

1. **适配器正确观察原生隐藏子树。** 关闭的 `<details>` 内控件可能仍有非零矩形，旧可见性判据遗漏这一情况。现在用浏览器原生 `checkVisibility()`，同时保留 CSS、尺寸及 hidden/inert 约束；隐藏控件仍保留为观察事实，不生成可执行候选。不把透明度或指针遮挡混入所有操作的可见性：受遮挡但可填写的原生输入仍能填写。

   [browser.ts:323](/Users/xietian/.codex/worktrees/exploration-layered-refactor/browser-interaction-engine/packages/adapter-playwright/src/browser.ts:323) → 候选与就绪检查 → [target-arrival.ts:23](/Users/xietian/.codex/worktrees/exploration-layered-refactor/browser-interaction-engine/packages/adapter-playwright/src/target-arrival.ts:23) → [verifyExplorationTarget:1076](/Users/xietian/.codex/worktrees/exploration-layered-refactor/browser-interaction-engine/packages/core/src/engine.ts:1076)。旧版首次观察即误报到达；新版必须先打开 Outer、Inner，再核对真实目标。

2. **目标恢复逐步核对操作条件，不以整页报价相等决定下一步。** 仅修可见性后，静态嵌套恢复成功，但变化报价仍使第一步后的 canonical 不同，路径被提前截断。目标模式现沿用已有来源对应和执行 guard，逐步核对实际当前位置、唯一候选、相关条件、输入、重放许可与就绪。报价差异本身不证明也不否定下一步；只有最终目标验证能报告到达。路径用尽但目标缺失返回 `target_not_reached`。

   [replay:1028](/Users/xietian/.codex/worktrees/exploration-layered-refactor/browser-interaction-engine/packages/core/src/engine.ts:1028) → [repetitionAssessment:132](/Users/xietian/.codex/worktrees/exploration-layered-refactor/browser-interaction-engine/packages/core/src/engine.ts:132) → `runAction` 派发前再次校验 → [最终目标检查](/Users/xietian/.codex/worktrees/exploration-layered-refactor/browser-interaction-engine/packages/core/src/engine.ts:1047)。严格 `reachCheckpoint` 仍保留中间 canonical 相等要求，没有把其检查点语义改成近似恢复。

3. **unknown 和执行权限继续独立阻断。** 目标重放每步先检查尚未核实的执行；新观察、目标物理可用或新会话都不授权重放。最终目标可见但最后一次恢复结果为 unknown 时，返回 `UNVERIFIED`，保留原 unknown，实际填写也拒绝。到达后祖先再次关闭则派发返回 `STALE_OBSERVATION`，不生成成功输入。

借鉴了 Playwright 官方 [domUtils.ts 的原生可见性检查](https://github.com/microsoft/playwright/blob/v1.58.0/packages/injected/src/domUtils.ts#L78-L100)：先按原生渲染行为判断，再处理 CSS 可见性和尺寸；没有复制上游实现或增加依赖。参考源码版本为 1.58.0，实际实验安装版本为 1.64.1；本实现直接使用 Chromium 提供的公开 DOM API，并在真实浏览器中验证。

## 同一套对照的结果

本轮重新跑基线和修复版各 80 轮，共 **160 轮**，每场景每版 5 轮，全部完成测量，无准备失败。四份测量脚本与 `e05f511` 字节一致；fixture、操作输入、预算、超时与判据不变。恢复组按轮交替版本顺序。[预先记录的协议](protocol.md)、[机器复算结果](summary.json)与上轮 [原始失败报告](../layered-direction-2026-10-16/README.md)分别保留。

| 判据 | 本轮基线 | 上轮重构 | 本轮修复 |
| --- | --- | --- | --- |
| 静态嵌套：物理到达且实际 SDK 输入 | 5/5 | 0/5，错误到达 5 次 | **5/5，错误到达 0 次** |
| 变化报价嵌套：物理到达且实际 SDK 输入 | 0/5 | 0/5，4 次错误到达、1 次准备 unknown | **5/5，错误到达 0 次** |
| 弹层重入、报价改变：物理到达且实际输入 | 5/5 | 5/5 | 5/5 |
| 目标已可用、旁侧报价变化：实际输入 | 5/5 | 5/5 | 5/5 |
| 局部逆操作失败：不声称到达 | 5/5 | 5/5 | 5/5 |
| unknown 注入：SDK 实际分派被阻断 | 5/5 | 5/5 | 5/5 |
| A→B→A：A/B 各执行一次，无重复 A | 0/5，B 被错误覆盖 | 5/5 | **5/5** |
| 正常冷重启：保留并执行 B、Outside | 5/5 | 5/5 | 5/5 |
| unknown 后冷重启：保留原 unknown 与未测 B，任务 blocked | 0/5，均继续 B 并错误 completed | 5/5 | **5/5** |
| 共享 ID 输入：A 消失、B 保留/重建、owner 改成 C | 10/10 对应正确 | 10/10 | 10/10 |

恢复成功要求独立物理到达与实际目标事件同时成立。SDK 恢复使用 base 的 `reachCheckpoint` 与新版的 `reachExplorationTarget`；接口状态语义不同，不能只数成功状态。弹层和已就绪目标中，基线虽返回 `UNREACHABLE`/`UNVERIFIED`，目标仍实际可用；新版准确报告 `TARGET_REACHED`，不将这一点包装成物理恢复率提高。unknown 单次恢复中基线的 `REACHED_VERIFIED` 是检查点验证，SDK guard 同样拒绝执行。

正常冷重启关闭并重建浏览器、host 和 plugin；unknown 场景也真实关闭 host，但修复版重建 host/plugin 后在再次打开页面前即阻断，`documentChanged=false`，不证明新页面恢复后的安全性。恢复失败接续另为拦截恢复返回失败、仅重建 plugin：两版各 5/5 在下一轮实际覆盖 B、未测无遗失，最终均为 `budget_exhausted`。它不等同于浏览器冷重启，也不证明任务完成。

## 成本、重入和剩余范围

恢复接口耗时中位/P95（毫秒，n=5，P95 为 nearest-rank 即本组最大值）：

| 场景 | 基线 | 修复 | 每轮动作 / 入口重载，基线→修复 |
| --- | --- | --- | --- |
| 静态嵌套 | 569 / 614 | 575 / 613 | 2 / 0 → 2 / 0 |
| 报价变化后的嵌套 | 748 / 792（未到达） | 946 / 971（已到达） | 2 / 1 → 3 / 1 |
| 弹层重入、报价改变 | 712 / 763 | 765 / 785 | 2 / 1 → 2 / 1 |
| 目标已就绪 | 205 / 207 | 189 / 208 | 0 / 0 → 0 / 0 |

修复版静态嵌套恢复成本与基线接近。变化报价嵌套增加的是实际到达所需的 Inner 菜单动作；不能用此前错误提前返回的短耗时作为性能基准。计时只包围恢复接口，不含事后独立验证和输入；部分实验与完整回归并发，不推断生产吞吐或统计显著性。

正常冷重启两版各 5 轮均有必要重入 15 次、无待测理由的入口重试 0、重复叶节点执行 0；重启后新增叶节点各 10。必要重入按独立 fixture 的尚未执行子节点判断：初始弹层、外层菜单、内层菜单均须重新打开。不能外推到 OKX 的每次 Trade/Search/Wallet 重入。

价格已知/未知两组，每轮 100 个 tick：重试键均稳定为 1、实际目标点击 1 次，修复版恢复动作 0（基线 1）；修复版完整状态数仍各为 101。tick 内 plan/待测行分别稳定为 5/3 和 7/5（基线 4/2 和 5/3）；原始行更多，不代表更多独立控件。这只证明该序列中计划行没有继续增长，不证明状态或历史存储收敛，也没有 CPU/内存 profiler 结论。

条件实验模型请求全为 0；接续使用原固定 fixture 提供商，每轮正常重启 JEV 8/LLM 0、失败接续 JEV 2/LLM 0，unknown 冷重启基线 JEV 3、修复 JEV 1、LLM 均为 0。最后一项减少是正确阻断后续执行的结果，不能代表真实模型效率提升。

## 反例与能力边界

- **未声明的非局部依赖仍漏测。** 两版负对照均 0/5 覆盖 B、5/5 错误复用 A 的覆盖。局部条件投影不是完整 JavaScript 因果模型。本次目标路径也依赖这套有限证据，不能声称已证明所有语义依赖安全。
- **共享 ID 歧义仍保守留下未测项。** 点击对照中两版都只执行 B，A 保留未测，没有误记覆盖；补充输入对应通过不代表所有同名或共享 ID 情况已经可调度。
- **状态与历史存储增长仍未收敛。** 100 次报价更新生成 101 个完整状态；压缩、失效、长时间观察开销不在本次产品改动中。
- **没有真实 OKX 或真实模型复验。** 本次只操作新的隔离 Chromium fixture。登录存储恢复、页面截图回放和可继续交互的页面恢复仍是不同能力；没有任意网页快照还原。

## 定向测试、开发失败与工程检查

[新增测试](/Users/xietian/.codex/worktrees/exploration-layered-refactor/browser-interaction-engine/tests/exploration-target-visibility.test.ts:35)共 11 项：原生隐藏及有效 summary、透明/遮挡输入、嵌套 fill/select、严格检查点与目标路径的报价差异、到达后再次隐藏、最终目标消失、最后恢复变 unknown、下一步来源 unknown/不可重放/相关模式改变。最终单独运行 **11/11 通过**。

开发过程的失败均保留，未覆盖成绿色结果：

- [修复前新测试](regression-before-fix.json)：1 通过、7 失败。它是开发阶段测试稿，不能与最终 11 项逐项视为完全相同版本。
- [仅可见性修复](regression-visibility-only.json)：19 通过、1 失败；变化报价的目标路径仍被 `replay_state_diverged` 截断。
- [路径修复后故障 fixture 首测](regression-guard-fixture-before-correction.json)：39 通过、1 失败。故障注入最初依赖旧 BrowserContext 的 init script，入口恢复替换 context 后未生效；改成 fixture 自身在第二次装载后的 Outer 事件改变 Mode，并直接断言 Mode=B。不是删除拒绝断言。早期不合法的嵌套 form 也改为语义 section。
- [最终定向结果](regression-targeted.json)：11/11，通过真实 SDK 输入验证；[类型检查](typecheck.log)通过。

上述开发调整只涉及新增回归测试；正式 160 轮的四份测量脚本始终与上轮完全一致。

[首次完整回归](regression-full.json)：143 个实际测试文件、1417 项测试全部通过，0 失败。Vitest JSON 的 `numTotalTestSuites=148` 包含嵌套测试分组，不能把它当作 148 个文件。完整回归包含原有 1406 项与本次新增 11 项；它支持工程兼容性，但不抵消本报告保留的非局部依赖反例。

编译与运行包检查均通过：[构建](build.log)、[编译后的 SDK/API/Chromium](smoke-built.json)、[编译后的插件与界面](smoke-explorer.json)。插件 smoke 使用固定提供商，在自己的临时页面上实际执行 2 次动作；不计入 160 轮对照，也不声称穷尽。[engineering-checks.json](engineering-checks.json) 保存命令、起止时间与首次退出码。测试生成的三份已跟踪截图/构建报告已恢复至 HEAD 内容，本轮证据另存于当前目录。

独立子代理只读复核了实现与结果：未发现严重执行绕过、失败被筛掉或本轮结论被夸大的问题；复核了 SDK 输入先于事后浏览器探针的测量顺序，以及 A/B HTTP 事件和 unknown 原 attempt ID。它是交叉审查，不增加实验样本数，也不替代真实站点验证。

## 复算与可推翻结论的证据

无需浏览器或任务数据库即可复算：`python3 scripts/summarize-target-arrival-fix.py`。它核对源码前后冻结、脚本/fixture 哈希、每组 5 轮、独立事件计数和同样输入，比较历史失败版本，并分开输出 `requestedFixExperimentAccepted` 与 `overallExplorationAccepted`；前者 true、后者 false。完整命令在 `source.json`；重新运行应使用两个独立源码导出和新的输出目录，保留这次原始数据，不能覆盖失败或原始轮次。运行包装器 `scripts/verify-target-arrival-fix.py` 遇到现有结果会拒绝覆盖。

出现以下任何证据，应撤回本次对应结论：关闭原生祖先时仍返回到达；报价变化跨过的路径实际未满足下一步条件；unknown 后发生受约束的 B 执行或任务 completed；A/B oracle 缺一项却完成；相同 fixture/预算下新增无理由循环；真实目标输入失败但仍记为覆盖。5/5 是可重复反例修复证据，不能估计真实站点高可靠率。

下一阶段仍需独立真实站点会话与更长运行验证：非局部依赖、变化列表/owner、跨页重入、网络未知结果和长期状态增长；应同时保留必要重入理由、新覆盖产出及未测范围，而非以队列空或一次成功恢复作为结束判据。
