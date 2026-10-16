# 非局部模式与动态状态记录：修复及同脚本对照

结论：本轮两项修复在已观察 UI 模式与受支持只读报价场景中通过验收，保留嵌套恢复、A/B 覆盖及 unknown 跨重启阻断。继续采用分层重构。图节点压缩的证据充分，但没有证明任意 JavaScript 依赖已可识别、总存储已收敛或真实网站整体提速。

## 版本、工作区与实验完整性

- 产品提交：`88704cd`；分支 `codex/exploration-layered-refactor`。
- 工作区：`/Users/xietian/.codex/worktrees/exploration-layered-refactor/browser-interaction-engine`。
- 本轮起点 `253a0fd55b607e590419e33590517d3ad86059fb`，开始时无未提交修改；其产品版本为 `1ed22389d07c34a7cca778f7802ed14c2701d94d`。
- before 使用 `1ed2238` 的独立临时源码副本；after 使用冻结的 `88704cd`。每个版本 80 次，共 160 次，16 类场景各重复 5 次；两个产品在实验前后的源码哈希一致。
- 四个 `verify-exploration-*.ts` 与 `e05f5118821a75f6f0c010b7027cfc30012a85b7` 字节一致。此前 recovery 脚本按 variant 切换 API；本轮两边都传 refactor，均走 `reachExplorationTarget`，仅文件名/来源标签不同。
- Node 24.22.0、Playwright 1.64.1；私有临时 HTTP fixture、独立 Chromium 和临时存储。没有操作原项目/基础分支的工作区、正在测试的浏览器、现有服务或任务数据库。
- [source.json](source.json) 保存源码、脚本哈希、每次命令和时间；[summary.json](summary.json) 可由新汇总脚本重算。旧失败报告和上轮成功报告保持原样。

## 实际修改

| 问题与触发场景 | 修复与边界 | 入口 |
| --- | --- | --- |
| Run 在另一张表单读取 Mode；旧规则把不同表单/区域视作独立，模式 B 错复用 A | v2 把所有已捕获模式纳入条件，包括隐藏控件。DOM 分区只作来源说明。歧义、不稳定、缺失或超过 32 个条件时拒绝等价，不截断 | [branch-conditions.ts:81](/Users/xietian/.codex/worktrees/exploration-layered-refactor/browser-interaction-engine/packages/adapter-playwright/src/branch-conditions.ts:81) |
| 只读价格每次更新生成一个严格状态节点 | controls/representative 增加非授权图分组；完整观察、canonical/fingerprint 保留。节点只留首末两个引用和累计数；带交互信号、关系、可编辑值、模式、约束或绑定变化继续区分 | [model.ts:13](/Users/xietian/.codex/worktrees/exploration-layered-refactor/browser-interaction-engine/packages/adapter-playwright/src/model.ts:13)、[identity.ts:105](/Users/xietian/.codex/worktrees/exploration-layered-refactor/browser-interaction-engine/packages/core/src/identity.ts:105) |
| 同图分组可能被旧消费者当成已返回父状态或等价路径 | 工作帧、当前工作、恢复失败共享核对严格观察；路径按成功可重放 attempt 的真实 before/after 连续性建立，不能跳过同组中的步骤。摘要按 observationId 取事实 | [engine.ts:1030](/Users/xietian/.codex/worktrees/exploration-layered-refactor/browser-interaction-engine/packages/core/src/engine.ts:1030)、[runtime.ts:608](/Users/xietian/.codex/worktrees/exploration-layered-refactor/browser-interaction-engine/packages/explorer-plugin/src/runtime.ts:608) |
| 条件策略换版让旧插件 pending 键失配 | 先核验原始来源与旧键，只有唯一新条件才迁移调度键，保留审计，不记成功。缺失/歧义/多条件保留 invalidated 缺口；unknown 先于迁移阻断 | [policy.ts:57](/Users/xietian/.codex/worktrees/exploration-layered-refactor/browser-interaction-engine/packages/explorer-plugin/src/policy.ts:57)、[runtime.ts:438](/Users/xietian/.codex/worktrees/exploration-layered-refactor/browser-interaction-engine/packages/explorer-plugin/src/runtime.ts:438) |

图分组不压缩 JS 堆或保存任意页面快照。严格检查点仍可因报价不同而拒绝验证；目标恢复由独立对应、就绪和重放许可证明。旧状态和原始观察不删除、不改写。stateful 保持严格状态规则。

## 160 次正式对照

| 指标（每场景 5 次） | before | after |
| --- | --- | --- |
| 非局部 A/B 两分支均实际执行 | 0/5，均只 A | 5/5，A/B 各一次 |
| 非局部错误覆盖 | 5/5 场景出现 | 0/5 |
| 已知/未知条件下，100 次报价更新的状态节点 | 两组均 101 | 两组均 1 |
| 报价阶段实际点击 / 恢复 / 重试键 / 模型调用 | 1 / 0 / 1 / 0 | 1 / 0 / 1 / 0 |
| 报价期间计划行、待测行增长 | 0 | 0 |
| 普通 A/B 交替实际执行，无重复 | 5/5 | 5/5 |
| 静态 / 变化报价嵌套：实际到达并通过 SDK 输入 | 各 5/5 | 各 5/5 |
| 弹层重入 / 已就绪目标：实际到达并输入 | 各 5/5 | 各 5/5 |
| 预置逆操作失败，虚假到达 | 0 | 0 |
| unknown 单会话派发阻断 / 冷重启阻断 | 各 5/5 | 各 5/5 |
| 正常冷重启：三个叶分支全部执行 | 5/5 | 5/5 |
| 正常冷重启：每次必要重入 / 无理由重入 / 重复叶执行 | 3 / 0 / 0 | 3 / 0 / 0 |
| 两组 A/B/C 输入对应：实际输入与错误等价 | 各 15 次 / 0 | 各 15 次 / 0 |

已知报价的计划/待测行保持 5/3，未知条件报价保持 7/5；不是把未测项清空。非局部场景新增正确分支后，计划行从 5 变 8、待测行从 3 变 4，其中仍有未就绪操作；不能把新增真实范围当成无效增长。

共享 ID 歧义场景仍只执行实际 B，A 留为缺口；两版均没有把 B 成功误转给 A。这不是该歧义已解决的证据。部分条件试验用固定事件流调用单步机制；普通 A/B、额外四组跨分区/隐藏模式测试和重启场景另走公共插件生命周期。

## 性能、重放与模型成本

本轮可确认的是图索引从 101 个节点降到 1 个、归组成员引用最多两项。没有减少原始观察数量：额外持久化测试确认 101 份严格观察在 SQLite 重启后完整可查。身份 occurrences、sampling 引用、动作和事件仍可增长；不能据此声称总内存或磁盘已恒定。

路径查询只解压实际边引用的观察；当前来源比较和摘要在一次同步调用内复用读取，不跨观察缓存。归组投影本身增加计算，CPU/内存收益未作专门剖析。

恢复耗时中位数/P95（毫秒）分别为：静态嵌套 603/620 → 611/619；变化报价嵌套 951/1014 → 911/1046；弹层 704/713 → 718/758。报价 100 次更新整轮中位数约 8.16 秒 → 8.15 秒（已知）、9.31 秒 → 9.28 秒（未知）。同期还有回归测试，样本少，时间仅描述本次运行：**没有证据宣称整体提速或恢复提速**。

报价和非局部条件试验 JEV/LLM 都为 0。冷重启菜单每次计数 provider 的 JEV 仍为 8、LLM 为 0，必要重入仍为 3；本轮没有降低该项模型成本。计数/固定应答 provider 不是真实模型质量或延迟实验。

## 工程回归与保留的失败

完整回归 **147 个文件、1458/1458 通过**（`regression-full.json`）；冻结后的插件回归 **5 个文件、117/117 通过**（`regression-final-plugin.json`）。两组有重叠，按文件和测试名去重为 148 个文件、1464 项，不是又跑了一次全量。类型检查、构建、编译 SDK/UI 与编译插件/浏览器 smoke 全部 exit 0，见 [engineering-checks.json](engineering-checks.json)、[构建 SDK 结果](built-runtime-result.json) 和 [构建插件结果](built-explorer-result.json)。全量在旧任务迁移整合过程中启动；最后增加的迁移用例与受影响插件在冻结后重跑，不能称作第二次冻结版全量。具体边界保存在 [verification-context.json](verification-context.json)。

新增验证覆盖：18 个动态状态场景、9 个精确路径及旧采样升级场景、8 个消费者场景、6 个跨分区模式场景、6 个旧格式任务迁移场景。来源迁移夹具使用独立的旧版编码并实际关闭/重开 SQLite 插件库；不是对受保护真实任务库的迁移演练。

开发首轮 readonly onclick 负例暴露了实际 guard 缺口：仅看 actions 无法排除隐含交互。已补 interactionHints 与处理器属性限制。另一个 unknown 夹具初值恰等于输入样本，已修正夹具后复测。首轮及边界失败结果保留为 `development-grouping-first.json`、`development-grouping-edge.json`，没有用最终通过覆盖历史结果。

## 仍缺的证据与可推翻结论的反例

- 此次修复针对已捕获 selector 模式，不能推断任意闭包、网络状态或自由文本因果。全局模式过多可能增加保守采样；超过 32 个模式拒绝复用。
- 图归组只支持有依据的只读非交互输入/文本区，以及已有 native-link readout 证据；任意动态文本、时间和列表内容不保证归组。结构、模式、绑定和约束仍区分；新结构不因“相似”自动覆盖。
- SDK representative 的旧采样 frontier 尚未自动迁移；明确保留 `sampling_policy_changed`，旧项仍未执行，审计不能完整。不能把新样本执行当作结清旧范围。默认 controls 遍历键不受此次换版影响。
- 原始历史留存仍增长；真实 OKX 多轮表现、长时间成本、任意网页恢复和整体穷尽尚未验证。
- 若同组不同事实导致跳过恢复、拼接不连续路径、授予覆盖，或已捕获跨区域模式 B 仍被 A 结清，将推翻本轮正确性结论。
- 若纯报价刷新继续增加图节点/重试额度/活动范围，或 unknown 因重启、迁移被清除，将推翻本轮收敛和阻断结论。
- 真实站点必须另做隔离的相同预算对照；一次恢复成功、模拟测试通过或队列清空都不证明穷尽。
