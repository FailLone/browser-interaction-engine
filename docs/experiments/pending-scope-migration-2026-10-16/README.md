# 旧待测范围迁移：条件拆分、来源守恒与重启接续

本轮完成旧未执行范围到当前条件范围的可验证迁移。独立同文件对照从 1/5 通过变为 5/5；冻结版本相关回归 38 个文件、413/413 通过。收益是旧账本能够继续调度、逐条件结算，并保留无法核验的来源缺口；迁移本身不产生覆盖，也不授予重放权限。

恢复稳定性没有全面验收通过：首次固定对照中，改造版有一次弹层重入因后置观察未稳定而保留 unknown。随后相同脚本、预算的串行对照各 5/5 通过，首次失败仍计入结果。不能把这次迁移称为整体提速或真实网页穷尽。

## 版本和边界

| 项目 | 本轮事实 |
| --- | --- |
| 工作区 | `/Users/xietian/.codex/worktrees/exploration-layered-refactor/browser-interaction-engine` |
| 分支 | `codex/exploration-layered-refactor` |
| 开始基线 | `2584557248ff04fc9189511308805c49e22eec52`，开始时无未提交差异 |
| 冻结实现 | `a62d37b641b1e54bffd6adf38c70cc09c819f292`，冻结后无未提交产品差异；本报告随后单独提交 |
| 对照基线副本 | 从 2584557 导出的独立临时目录；198 个 packages/apps 文件逐字节对应 Git 对象 |
| 改造版来源核验 | 200 个 packages/apps 文件对应 a62d37b；固定测量前后产品哈希一致 |
| 协议 | 原样复用 e05f511 的四个测量脚本；基线和改造版均调用目标到达接口，未混用严格检查点接口 |
| 环境 | Node 24.22.0、pnpm 10.17.1、Vitest 3.2.7、Playwright 1.64.1；自建 localhost fixture、新浏览器、内存或临时 SQLite |
| 保护工作区 | 原项目仍为 `codex/single-selection-state-rule` / `6e11128`；autonomous-exploration 工作区仍为 `codex/autonomous-exploration` / `4857ad5`；结束前只读核对均无未提交差异 |

未操作原测试浏览器、现有服务或任务数据库。打包检查仅启动并清理自身的临时 fixture、浏览器和服务，使用独立工作区内新建的 `.data/*-smoke-TIMESTAMP`。生成的既有 `docs/build-smoke.json` 已恢复，实际结果另存于本目录。未推送或创建 PR。

## 实际改动与调用链

### 插件：旧粗范围拆成独立义务

`run → assertRecoveryOutcomes → migrateOperationConditions → conditionSplitIssues → 当前观察/调度 → SDK 覆盖核对`。

- 仅处理未尝试的派生旧行；从原始保留观察核验旧键、唯一操作及当前 SDK 条件。不能拿同名控件或其他来源代替缺失证据。
- 一个当前条件仅升级键；多个条件创建确定 ID 的独立 pending 子项。有效和无效来源混合时，有效部分继续，不能核验的来源留为独立 blocked 残余项。
- 原父项以 `superseded` 保留旧键、原始证据和完整转交关系，不能改记成功、排除或本轮执行。上一轮 `multiple_current_conditions` 失效记录可重新核验。
- 子项各自绑定条件。A 的成功不能结清 B；用户选择子项补测也不会解除条件绑定。父项在界面中不可直接选择补测。
- 缺子项、来源未全部转交、条件或权限关系损坏时，恢复必需缺口；损坏的转交记录在新观察、创建会话和派发前阻断。普通来源残余缺口允许其他已核验子项继续。
- unknown 原账本检查先于迁移。迁移不处理已尝试或成功历史，不用新会话消除未知结果。

入口：[policy.ts:61](/Users/xietian/.codex/worktrees/exploration-layered-refactor/browser-interaction-engine/packages/explorer-plugin/src/policy.ts:61)、[plan-state.ts:47](/Users/xietian/.codex/worktrees/exploration-layered-refactor/browser-interaction-engine/packages/explorer-plugin/src/plan-state.ts:47)、[runtime.ts:439](/Users/xietian/.codex/worktrees/exploration-layered-refactor/browser-interaction-engine/packages/explorer-plugin/src/runtime.ts:439)。生命周期、轮次结算、补测和界面共用这一状态语义。

### SDK：旧 representative 采样范围逐来源接续

`capture 的串行存储事务 → migrateSamplingSources → 适配器旧键解码/当前 explorationCase → pending 子项与来源审计 → frontier/coverage 派生展示`。

- 新增适配器可选旧格式解码契约和策略 revision。当前 Playwright 适配器只支持明确的 v1 → v2 条件投影；没有解码器的适配器保留旧失效缺口。
- 对每个旧来源检查完整且稳定的观察、已知上下文、唯一旧操作、控件身份、支持的操作依据和当前条件。完整转交父项退役但保持 `not_attempted`；部分转交父项 blocked，有效子项继续。
- 子项保存父项及原观察/操作关系。子项丢失或绑定损坏时保留悬空引用和缺口，反复审计或重启都不会把它遗忘并新建一个替身。
- `reconcileSamplingScopes(sessionId)` 可在保留证据修复后显式重查；它不观察、不控制浏览器、不执行动作。此次只新增 SDK 方法，没有新增 HTTP 接口。
- 全局 ID 归属检查同步修复：Memory 和 SQLite 均拒绝用同一 ID 跨实体种类或会话覆盖已有记录。正常同种类、同会话更新保留。未声称解决所有并发写入问题。

入口：[sampling-migration.ts:43](/Users/xietian/.codex/worktrees/exploration-layered-refactor/browser-interaction-engine/packages/core/src/sampling-migration.ts:43)、[engine.ts:678](/Users/xietian/.codex/worktrees/exploration-layered-refactor/browser-interaction-engine/packages/core/src/engine.ts:678)、[adapter index.ts:78](/Users/xietian/.codex/worktrees/exploration-layered-refactor/browser-interaction-engine/packages/adapter-playwright/src/index.ts:78)。协议说明见 [API](../../API.md)、[frontier 覆盖](../../FRONTIER-COVERAGE.md)、[插件](../../EXPLORER-PLUGIN.md)。

## 证明改动方向的证据

### 同文件红绿对照

[独立集成测试](/Users/xietian/.codex/worktrees/exploration-layered-refactor/browser-interaction-engine/tests/explorer-migration-split-integration.test.ts) 在基线和冻结版逐字节相同，不导入新版本专有类型或方法制造加载失败。旧键由独立冻结的 v1 编码构造，不用新解码器生成自己的输入。

| 验证内容 | 2584557 | a62d37b |
| --- | --- | --- |
| 真正关闭 host、重建 host 后将保留 A/B 粗行拆分；子项实际各执行一次，父项不记成功 | 失败：未拆分 | 通过 |
| 缺失来源仍为独立必需残余项 | 失败：无拆分子项 | 通过 |
| 未知上下文来源仍为独立必需残余项 | 失败：无拆分子项 | 通过 |
| 子项被静默改为非必需时重新打开账务缺口 | 失败：无拆分子项 | 通过 |
| 持久化 unknown 在新观察/新派发之前阻断 | 通过 | 通过 |

基线已能物理执行 A/B；本轮修复的是旧粗行仍失效、条件账目不能正确接续的问题，不能把这项结果描述为比 2584557 多发现两个分支。实际执行由独立 HTTP 事件日志核验。基线 [原始结果](migration-baseline-five.json) 为 1 通过、4 失败；冻结版 [对应结果](migration-fixed-subset.json) 为 5/5，是 413 项回归的子集，不重复计数。

另外 15 项 SDK 迁移测试包含真实 Chromium + 临时 SQLite + 冷重启、旧代表采样格式、A/B 各一次实际事件、原严格观察不变；其他机制测试覆盖 ID 冲突、歧义、不可用当前条件、残余来源修复、子项丢失及绑定损坏。这是受控旧格式兼容验证，未迁移真实用户任务数据库，也未运行旧二进制生成完整历史数据库。

### 同协议保留已有收益

四个原样脚本每版本 16 个场景各运行一次，共 32 个主对照样本。固定版初次测量与自身回归/构建并发，因而不能用耗时差推断速度。完整数据及逐场景指标见 [comparison-summary.json](comparison-summary.json)，脚本、fixture 和产品哈希见 [source-audit.json](source-audit.json)。

| 指标 | 基线 | 改造版 |
| --- | --- | --- |
| 静态/变化报价的两类嵌套菜单：目标到达并实际输入 | 各 1/1 | 各 1/1 |
| 已就绪输入框 + 持续报价：到达并实际输入 | 1/1 | 1/1 |
| 弹层重入首次对照 | 1/1 | 0/1，unknown 阻断 |
| 局部恢复偏离/预置 unknown：错误到达声明 | 0/2 | 0/2 |
| 跨表单非局部模式 A/B：实际独立分支 | 2，重复 0 | 2，重复 0 |
| 两种报价场景各 100 次变动：图节点 / 重试键 | 各 1 / 1 | 各 1 / 1 |
| 条件场景假覆盖/重复事件 | 0 / 0 | 0 / 0 |
| 冷重启嵌套接续：必要重入 / 无理由重入 / 重复叶子 | 3 / 0 / 0 | 3 / 0 / 0 |
| 恢复失败后接续、unknown 冷重启阻断 | 各通过 | 各通过 |
| A 消失、B 重建、所有者改为 C 的两种输入场景 | 每种实际 A/B/C，8 个对应断言通过 | 同左 |

共享标识场景故意在首次派发前移走 A，双方都只执行 B，仍保留 A 未测；`missingBranches=[A]` 不是一次完成或穷尽。两个价格场景的最终 pending 行数仍分别为 3、5，非局部场景为 4；与基线相同。不能由图节点为 1 推导整个待测账本已收敛。

恢复耗时单样本（毫秒，基线→改造版）：静态嵌套 610→606，变化报价嵌套 1092→1088，已就绪目标 205→188，局部恢复偏离 385→441。弹层为 770→770，但后一结果为失败，不能当成等效速度。没有足够样本给出性能结论或 P95。

模型调用：条件脚本与独立迁移集成测试均为 0；接续脚本的三个场景双方均为显式 mock JEV 8/2/1、LLM 0。这些数字验证调用路径，没有调用真实模型，也没有证明真实站点模型成本下降。

### 保留的弹层异常

首次固定版的恢复操作 `Open panel` 发生后，画面已打开，但 SDK 后置观察为 partial-ready；原点击依赖未确认稳定，动作记 unknown，目标到达返回 `UNVERIFIED`，后续输入阻断。错误成功声明为 0。见 [recovery-fixed.json](recovery-fixed.json)。

源码事实：本次未改动捕获算法；该脚本使用 controls，representative 迁移直接返回。既有 [browser.ts:573](/Users/xietian/.codex/worktrees/exploration-layered-refactor/browser-interaction-engine/packages/adapter-playwright/src/browser.ts:573) 允许任一局部目标就绪后提前结束；602–605 将其他控件标为 unstable；[适配器就绪核对](/Users/xietian/.codex/worktrees/exploration-layered-refactor/browser-interaction-engine/packages/adapter-playwright/src/index.ts:48) 和 [engine 结果判定](/Users/xietian/.codex/worktrees/exploration-layered-refactor/browser-interaction-engine/packages/core/src/engine.ts:569) 随后保守产生 unknown。迁移在结果判定后，不把 unknown 改成成功。

推测：局部窗口与全局窗口开始计时稍有先后，调度停顿可能触发提前退出；目前没有逐次投影 trace 证明这一原因，也不能凭静态路径排除所有间接影响。

在本任务拥有的并发回归和构建全部结束后，按基线/固定版交替顺序各重跑 5 次，脚本与预算不变，双方到达并实际输入均为 5/5。见 [复验清单](modal-followup-manifest.json) 与 `modal-*-2.json` 至 `modal-*-6.json`。合并首次样本为基线 **6/6**、改造版 **5/6**；所有样本错误到达声明为 0。复验说明未稳定重现该回归，不能抹去首次失败或证明并发负载是唯一原因。

后续应针对 partial-ready 的退出依据与“刚执行的操作”后置验证做独立 trace 和回归，保持 unknown 阻断，不能放宽为“目标可见就成功”。

## 成本、缓存与能力边界

完整迁移和部分迁移各连续 100 次 `engine.observe` 的计数适配器测试中：旧来源读取增量为 0、旧键解码次数不再增加、条件子项仍为 2。来源缓存最多 8 份；部分迁移缓存按策略版本、来源关系与子项绑定失效，实时 action ID 变化不会反复触发全量迁移。修复缺失来源后须显式 reconciliation，避免每次观察无理由重读同一缺口。

这是迁移路径的成本证据，**这 100 次观察不是 100 次 Chromium 恢复测量**。每次仍需扫描 frontier 并核对子项关系；完整观察、动作证据及历史行仍增长。本轮没有证明全部查询缓存、总体存储体积或跨页面待测集合有界。

本轮沿用已有的状态图、到达验证、覆盖对应和未知结果账本，未替换执行器、引入爬虫依赖或复制开源代码。此前一手源码对照与借鉴边界见 [来源记录](../../exploration-refactor-sources.md)。登录存储、画面回放与可继续交互的页面恢复仍是不同能力。

尚未完成：由持久化未测范围直接驱动路线选择的调度重构；DFS 工作帧目前仍参与调度。也未解决未观测的任意 JavaScript/网络/自由文本因果，未证明旧已执行粗范围可以无损升级，没有真实 OKX 性能、长时收敛或穷尽结论。

## 检查与复现

- 冻结版本相关测试 38 个文件、413/413：[选择清单和完整命令](regression-selection.json)、[原始结果](regression.json)。不是全仓库测试数量；不把子代理重复运行的子集叠加。
- 类型检查、构建、编译版 SDK smoke 和编译版插件 smoke 均通过，日志及 JSON 在本目录。插件 smoke 使用显式 mock providers，实际浏览器动作 2，结果 `exhaustive:false`。
- 存储归属修复的开发阶段对照为原 12 项中的 8 项失败→12 项通过，修复后连同相关存储测试 39/39；冻结的 413 项回归已覆盖相关文件。
- 复现前检出报告指定的代码 commit，使用相同 Node 版本和依赖。按清单运行新迁移测试；四个测量命令在 [固定测量清单](fixed-measurement-run.json)。基线也使用 `--variant refactor`，因为比较的是两个均已具备目标到达契约的版本。
- 原始恢复测量脚本会记录失败而正常退出，必须检查 `status`、`guardedBranchYield`、`falseArrivalClaim` 和 unknown，不能将进程退出码 0 当成恢复通过。

若出现来源无故丢失、A 子项被 B 成功关闭、迁移授予覆盖/重放权限、unknown 在重启后被绕过、损坏子项自动换新而遗忘原缺口，或相同保留来源不断产生新子项，将推翻本轮迁移正确性的结论。真实旧数据库兼容、较大历史量下的成本和弹层异常的因果 trace 仍是缺少的验证。
