# 分层重构方向验证：有收益，但当前版本未通过验收

结论：**继续分层重构有实证依据，置信度中等；当前 `de364fa` 不能作为恢复可靠性已通过的版本合入。** 模式相关的操作证据、跨会话未知结果阻断各有稳定收益；目标到达与快照相等分开也有契约价值。但独立浏览器实验发现：原生 `<details>` 关闭时，新接口提前报告目标到达，静态嵌套恢复从 base 的 5/5 降到 0/5。这是本轮发现的明确回归，不能以 1406 项既有测试通过抵消。

没有证据要求整体替换探索架构，也没有证据支持当前实现已经能可靠持续探索任意动态页面。下一步应先补实 SDK/适配器的可交互到达契约，再验证恢复调度；保留已经验证有益的条件化覆盖与未知结果账本。不能把这轮结果概括成“全部方向验证成功”。

## 冻结对象与隔离

| 对象 | 本次实际代码 |
| --- | --- |
| base | `4857ad571c19995480a4c149abd9b2868a94c965`，`codex/autonomous-exploration` |
| 重构 | `de364fab170a9b92227bc4f982ca78fa6a0a4633`，`codex/exploration-layered-refactor` |
| 重构工作区 | `/Users/xietian/.codex/worktrees/exploration-layered-refactor/browser-interaction-engine` |
| base 实验副本 | `/var/folders/s9/dy_jbdrs3fn1qzt_gnsy4tgw0000gn/T/bie-refactor-base-29m9ndte`，来自上述 commit 的独立源码导出 |
| 原主工作区 | `/Users/xietian/Projects/browser-interaction-engine`，`codex/single-selection-state-rule`，`6e111284ac3a6642844531dbc06bce462ca4293c` |

最新分类复用改动已在两版共同祖先中，本实验不把它算作本分支收益。开始时三个工作区均无未提交差异；结束时原主工作区和 base 工作区仍干净，重构产品文件没有差异，仅新增本轮实验资料与脚本。回归生成的两张跟踪截图已恢复为冻结 commit 的内容。前后校验见 [source.json](source.json)、[source-after.json](source-after.json)；结束校验额外包含三个构建配置文件，因此校验文件数不同。

运行环境 Node 24.22.0、仓库已安装的 Playwright/Chromium。只使用自建临时 HTTP fixture、全新浏览器和临时存储；没有操作现有服务、正在测试的浏览器或真实任务数据库。所有产品代码冻结，不为使实验通过而修补。临时源码副本可删除后按 commit 重建。

## 比较方法和证据强度

[预先制定的协议](protocol.md)与[机器可重算汇总](summary.json)一起保留。正式比较共 **160 轮**：条件/覆盖 50、SDK 恢复 60、插件接续 30、补充输入身份 20；每场景每版本 5 轮。恢复中有 1 轮准备动作结果未知，作为失败保留，未补跑替换。独立重复不等于随机站点抽样，不能从这组小样本给出生产可靠率。

- 公开插件流程：A/B 模式循环、正常冷重启、恢复失败后续跑、未知结果后冷重启，均使用 `start/waitForIdle`。
- 单步机制实验：共享 ID、100 次报价变化、非局部依赖，通过相同外部事件流调用插件实际 `step`，不宣称是完整端到端调度测试。
- SDK 恢复：base 调 `reachCheckpoint`，重构调 `reachExplorationTarget`。接口契约不同，所以同时记录接口声明、独立物理就绪检查和 SDK 实际输入事件；不将状态名直接比较为成功率。
- 输入身份补测：公开 SDK 的受约束输入与 `operationCorrespondences`，相同输入样本，外部控制 DOM 变化；不代表插件自己会选择所有这些操作。
- 独立判据：点击/输入产生的 HTTP 事件由 fixture 服务端保存，重载和重启不会清空；恢复目标还用当前真实页面的 DOM、Playwright 试点击/可编辑检查及实际输入事件核对。队列清空、任务完成和 `attempt.succeeded` 都不能单独充当覆盖判据。
- 未知结果及不可用恢复是明确故障注入：只改实验私有临时记录或拦截实验对象的方法，分别记录真实浏览器动作与注入结果。它们证明状态机分支，不证明网络故障的自然发生率。
- 没有真实 JEV/LLM 请求。条件实验的计数提供商若被调用会抛错；接续实验采用固定 fixture 决策提供商，调用量只代表程序请求数量。

## 主要对照结果

下表每个比例的分母均为该场景 5 轮，不混合互不相同的目标。

| 场景与独立判据 | base | 重构 | 判断 |
| --- | --- | --- | --- |
| 同一表单 A→B→A；公开插件实际覆盖 A、B | 0/5；每轮只执行 A，却认为当前 B 已覆盖 | 5/5；每轮 A、B 各执行一次，回到 A 不重做 | 明确改善，支持操作等价包含相关模式条件 |
| 嵌套菜单、初始弹层；A 后关闭浏览器/host/plugin，再完成 B 与 Outside | 5/5 | 5/5 | base 已有接续能力，本次保留，不能归为新能力 |
| 首轮恢复返回 UNVERIFIED，重建 plugin 后新增一轮完成 B | 5/5 | 5/5 | 待测未丢失，本场景无新增收益；此项保留 host，属插件重建，并非浏览器冷重启 |
| 实际恢复后持久化结果置 unknown，再冷重启 | 5/5 继续执行 B 并把任务标 completed；原 unknown 仍在 | 5/5 保持 blocked，B 保留未测，原 unknown 仍在 | 明确改善：新会话不能绕过原未知结果。base 没有把原 attempt 改为 succeeded，缺陷在任务层放行/完成判断 |
| 两个同名共享 ID 控件，A 消失，B 重建两次 | 两版均只实际执行 B 一次，A 保留未测 | 同左 | 歧义保守拒绝，不是 A/B 身份完全解决；未出现把 A 当 B 完成 |
| A/B 输入框共享 ID；A 消失、B 保留/重建、owner 再变 C | 两种命名方式各 5/5 正确拒绝 A→B、接受 B→同 B、拒绝 B→C | 同左 | 已有机制工作；不应重建这一层，也不能把结果算作重构收益 |
| 不同表单中的选择器控制 Run 行为，依赖未声明 | 0/5 覆盖 B；5/5 出现 B 未执行却复用 A 覆盖 | 同左 | 保留的反例；局部结构不是完整的因果依赖证据 |

输入补测中两版各产生 30 个实际输入事件；4 个对应检查 × 10 轮，均符合预期。它验证的是操作样本的覆盖证据对应，不授予任意身份合并或重放权限。

## 恢复：语义改善不能掩盖执行回归

| 场景 | 物理到达 base→重构 | SDK 实际目标事件 base→重构 | 新版错误到达声明 | 每轮恢复动作 base→重构 | 恢复接口耗时中位/P95，毫秒，base→重构 |
| --- | --- | --- | --- | --- | --- |
| 静态原生嵌套 details | 5/5→0/5 | 5/5→0/5 | 5/5 | 2→0 | 615/620→176/192 |
| 单弹层重入，重载后报价改变 | 5/5→5/5 | 5/5→5/5 | 0/5 | 2→2，均含 1 次入口重载 | 766/812→778/845 |
| 目标已在场，旁边报价持续变 | 5/5→5/5 | 5/5→5/5 | 0/5 | 0→0 | 188/204→200/206 |
| 嵌套 details + 报价改变 | 0/5→0/5 | 0/5→0/5 | 4/5，另 1 轮准备阶段 unknown | 2→0（新版只统计 4 次有效测量） | 792/885→180/183（新版 n=4） |
| 声明的局部逆操作导致目标消失 | 0/5→0/5 | 0/5→0/5 | 0/5 | 1→1 | 369/375→369/372 |
| unknown 结果注入 | 两版目标物理可用 5/5 | 两版均阻止 SDK 分派 5/5 | 新版未声称到达 | 0→0 | 170/174→0.84/1.01 |

**静态 details 的 176ms 不是性能提升**：它是错误提前返回，后续 `locator.fill` 在 1500ms 超时，实际目标事件为零。基线通过两步菜单重放真正到达。新版两种 details 场景共 9 次错误到达声明，实际分派均失败；没有把失败输入记为实际覆盖。

单弹层和旁侧报价场景，base 虽返回 `UNREACHABLE`/`UNVERIFIED`，实际目标仍能输入；新契约正确识别这两类情况。这里证明的是“目标可用”和“严格检查点一致”应分离，**没有证明物理恢复率、重载数量或耗时已经改善**。unknown 场景中 base 的正状态只表示检查点画面验证，不应解读为它授权未知结果后的执行；其 SDK 执行 guard 同样拒绝了请求。

计时只包围恢复接口，不包含事后独立验证/输入；P95 为 nearest-rank，小样本时即观测最大值。部分运行与完整回归并发，不做生产速度或显著性推断。原始逐轮数据在 `recovery-*-r*.json`，聚合见 [recovery-summary.json](recovery-summary.json)。

## 缺陷定位与调用链

1. **已证实的新回归：关闭的 details 中输入框被判为到达。** 调用链为插件 `step` → `reachExplorationTarget` → `reachInternal.verify_current` → `verifyExplorationTarget` → `browserTargetReady`。适配器可见性只检查矩形、CSS 与 hidden/inert，遗漏原生闭合祖先；fill 的就绪检查没有发现这一差异，于是新恢复入口提前退出，没有执行 base 成功的路径重放。事实是冻结代码、独立就绪检查和实际 SDK fill 失败三者一致；推断是应先修 SDK 观测/到达契约，并用反例验证所有相关操作，而不是让插件靠重复重试弥补。

   - [可见性事实采集](/Users/xietian/.codex/worktrees/exploration-layered-refactor/browser-interaction-engine/packages/adapter-playwright/src/browser.ts:323)
   - [操作前置条件，fill 与点击的差别](/Users/xietian/.codex/worktrees/exploration-layered-refactor/browser-interaction-engine/packages/adapter-playwright/src/policy.ts:58)
   - [目标就绪判据](/Users/xietian/.codex/worktrees/exploration-layered-refactor/browser-interaction-engine/packages/adapter-playwright/src/target-arrival.ts:23)
   - [core 消费到达证据](/Users/xietian/.codex/worktrees/exploration-layered-refactor/browser-interaction-engine/packages/core/src/engine.ts:1070)
   - [首次验证成功即返回](/Users/xietian/.codex/worktrees/exploration-layered-refactor/browser-interaction-engine/packages/core/src/engine.ts:1127)
   - [插件使用目标到达结果](/Users/xietian/.codex/worktrees/exploration-layered-refactor/browser-interaction-engine/packages/explorer-plugin/src/runtime.ts:659)

2. **已证实的能力边界：未声明的非局部依赖仍可能过度归并。** 分开表单后的选择器不进入目标的模式条件，B 分支被 A 的历史证据覆盖。调用链为 `browserBranchConditions` → operation correspondence → `completedOperations` → 插件跳过候选。这是两版共有问题，本轮不是新增回归。现实现已在代码/文档声明不推断非局部 JavaScript 因果关系；因此当前可承诺的是有限的观测条件采样，不能承诺任意 UI 分支穷尽。

   - [局部条件范围](/Users/xietian/.codex/worktrees/exploration-layered-refactor/browser-interaction-engine/packages/adapter-playwright/src/branch-conditions.ts:78)
   - [插件仅消费 SDK 对应证据](/Users/xietian/.codex/worktrees/exploration-layered-refactor/browser-interaction-engine/packages/explorer-plugin/src/completion-evidence.ts:9)

3. **已证实仍有增长：报价没有膨胀重试键，但底层状态没有收敛。** 每轮 100 次报价变化，两版均只有 1 个目标操作键、1 次实际目标点击、101 个被观察到的 `stateId`。新账本不能自动解决 canonical observation 将输入值纳入状态的问题。状态保留量、观察/前沿/审阅材料重复构建的 CPU/内存成本，本轮没有 profiler 数据，尚未证实成本是否可接受。

   - [包含控件值的 canonical 状态](/Users/xietian/.codex/worktrees/exploration-layered-refactor/browser-interaction-engine/packages/adapter-playwright/src/model.ts:7)
   - [重试条件与观察 ID/报价分离](/Users/xietian/.codex/worktrees/exploration-layered-refactor/browser-interaction-engine/packages/explorer-plugin/src/obligation-lifecycle.ts:28)

## 重入、待测增长、模型量

正常冷重启每轮两版都需要 3 次重复入口点击（关闭初始弹层、打开菜单、打开子菜单），它们发生时尚有相应未测叶节点，归为必要重入。两版各 5 轮累计必要重入 15、无待测理由的入口重试 0、重复叶节点执行 0；重启后新增叶节点各 10。这个结果反驳“所有重复入口都来自覆盖遗失”，但不证明真实 OKX 中每次 Trade/Search/Wallet 重入都合理。

恢复不可用注入每轮只有 1 次失败调用，两版都没有同条件重复失败，重建 plugin 后每轮新增 B 一项；两版最终均为 `budget_exhausted`，即使固定叶节点 oracle 已齐。它说明任务状态不能单独代替覆盖判断。此实验不证明新版重试账本在长时间、A→B→A 或多轮失效下优于 base。

报价已知/未知条件的 100 个 tick 内，base 原始 plan 行数稳定为 4/5、待测行数 2/3；新版稳定为 5/7、待测行数 3/5。新版保守保留更多行，不能把这些数当作不同控件数；本轮没有单独统计投影后的唯一活跃 obligation。可以证明这 100 次 tick 没有继续增加待测行，不能证明旧失效范围长期不会累积。base 每轮额外发生 1 次恢复动作，新版 0 次；该现象来自单步机制实验，不能外推为真实站点恢复成本全面下降。

条件实验全部 0 次模型请求。接续实验每轮固定提供商请求为：正常冷重启两版 JEV 8/LLM 0；失败接续两版 JEV 2/LLM 0；unknown 冷重启 base JEV 3、新版 JEV 1，LLM 均 0。最后一项减少来自正确阻断后续探索，不是模型质量或单位新覆盖成本改善。

## 测量修正、失败保留与复现

保留所有预检/测量失败，未将其混入正式分母：

- `conditions-*-pilot.json` 使用页内数组，reload 会清空；其报价/非局部覆盖数不能用于结论。正式版本改为独立 HTTP 日志，并统一 `observeTimeoutMs=1000`。未改产品。
- `recovery-refactor-pilot.json` 的弹层测量保留了恢复前的 Page 句柄；入口重载替换 Page 后句柄失效。正式版本重新取得活动 Page，并在接口声称到达时也尝试 SDK 分派，因此保留并证实了 details 反例。
- `input-identity-*-sample-mismatch.json`：首轮把执行值 `sample` 与候选默认样本比较，SDK 正确拒绝操作等价。随后 `*-current-value-noop.json`：固定同样本后，控件当前值已是 sample，候选生成器正确省略无变化 fill，测量找不到候选。正式补测在 B 重建时显式清空起始值，并记录源/目标目的值均为 sample，比较的是同一输入操作。这两次都是测量前提修正，不是产品修复，也不用于宣称产品缺陷。
- 正式 `recovery-refactor-r1.json` 的 `nested_changed_quote` 准备阶段返回 `unknown: Post-action dependencies did not settle`。它仍占 5 轮中的一轮；其余 4 轮全部错误到达。未补跑替换，不将它武断归因为机器负载。

复算不需要浏览器：

```sh
python3 scripts/summarize-exploration-direction.py
```

该脚本检查两版 fixture/测量脚本哈希相同、逐场景样本数、独立事件与汇总一致、输入样本相同，并重算 `summary.json`。数据完整性通过与产品验收通过是两个字段；本轮后者为 false。

在分别检出两个冻结 commit 的独立源码树、安装该仓库依赖并复制相同脚本后，用 Node 24 执行：

```sh
pnpm exec tsx --conditions=development scripts/verify-exploration-conditions.ts --revision=COMMIT --output=/absolute/conditions.json --runs=5 --ticks=100
pnpm exec tsx --conditions=development scripts/verify-exploration-recovery.ts --variant baseline --revision COMMIT --replicate 1 --output /absolute/recovery.json
pnpm exec tsx --conditions=development scripts/verify-exploration-continuation.ts --label baseline --revision COMMIT --repeats 5 --out /absolute/continuation.json
pnpm exec tsx --conditions=development scripts/verify-exploration-input-identity.ts --revision COMMIT --runs 5 --output /absolute/inputs.json
```

重构使用对应 commit、label/variant `refactor`。恢复重复编号 1–5，本轮交替版本先后顺序；每组完整输出另存，不能覆盖这次原始结果。`regression-full.json` 保存本轮一次完整回归的逐项结果：147 文件、1406 测试全部通过；实验脚本也通过类型检查。仅文档和测量代码变动，不需要重跑整套产品测试来掩盖独立实验失败。

## 下一步验收与推翻结论的证据

第一道验收应是上述静态 details 恢复重新达到 5/5，**错误到达声明为 0、实际目标事件 5/5**，并扩展到 select/focus、原生闭合祖先、遮挡和动态失效。不能简单给 fill 加“必须命中中心点”：可编辑目标的遮挡/滚动/原生隐藏各有不同语义，需要用操作适用的机械就绪条件验证。

随后在相同固定预算下复核：A/B 覆盖维持 5/5；unknown 时违规继续与错误完成为 0；重启后的待测丢失为 0；每条同条件失败路线重试不得因观察 ID、报价或重启自动增殖；必要重入和无新证据重试分开计数。恢复耗时只比较**实际到达且可执行**的样本，并报告中位/P95、重放步数、初始化次数。新覆盖用页面事件计数，不能用 plan 行数替代。

尚缺：真实进程崩溃而非有序 close 的恢复、原始 unknown 经 SDK 明确验证后仅释放一次对应路线重试的完整浏览器流程、不可安全重放动作的真实站点路径、未声明跨区依赖的处理策略、长时间列表/状态保留与缓存失效性能、实际模型调用量，以及独立授权的新 OKX 会话复核。本轮没有登录恢复测试；storage state、trace 画面和可继续交互的页面状态仍是三件事。

若到达契约修复后仍反复把计划目的地当作真实位置、待测账本在长序列中丢失或不能有界调度，或真实站点必须靠不可安全重放才能到达大部分未测分支，就会削弱“保留核心机制、分层重构”的判断，应重新评估恢复/调度架构乃至其可实现目标。若 A/B 的收益在同预算独立站点实验中消失，或代价是大量误复用/无进展增长，也不能继续用本 fixture 结果支撑泛化结论。

开源借鉴依据沿用已核对的一手源码和官方文档，见 [source references](../../exploration-refactor-sources.md)。这轮反例恰好说明：状态图、局部抽象和可验证重放是可复用的设计；更换 Playwright/Cypress/Crawljax 的名称不会自动获得任意网页快照还原。
