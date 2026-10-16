# 探索宿主契约与插件职责

探索插件保持可选，core/SDK 不引用插件或模型提供商。真实网站穷尽任务已通过公开暂停接口停下，保留累计 13 轮、136 次动作、2785 次模型请求及原预算；本次职责审查不恢复该任务。公共契约验证使用真实本地浏览器页面和显式注入的模拟提供商，不代表真实网站已经穷尽。此前真实任务运行记录见[OKX 效率实测](experiments/autonomous-okx-performance-2026-10-16/README.md)。

| 层 | 负责 | 不负责 |
| --- | --- | --- |
| core | 观察绑定、执行约束、样本证据、身份投影、前沿与审计、交互范围生命周期 | 模型、任务意图、任务数据库和轮次 |
| 浏览器适配器 / SDK | 浏览器控件对应提示、操作条件、审阅有效性、导航意图、弹层及恢复事实 | 替用户决定任务范围或接受未测内容 |
| 探索插件 | JEV/LLM 路由、提示词、任务范围、预算、顺序、补测计划、历史证据是否用于调度、未测例外和调试展示 | 从 DOM 证据规则重新推断导航或独立决定动作是否可派发 |

## 操作对应与历史证据

`browserControlCorrespondence(control)` 返回不透明匹配提示、来源依据和失效条件。旧任务中 `explorer:record:v1`、`explorer:context:v1` 及已有稳定键的编码保持兼容；这些前缀是历史数据协议，不代表 SDK 依赖插件。`browserOperationKey` 同样保留历史重试账本的编码。

`engine.operationCorrespondence(sessionId, {observationId, actionId, source: {sessionId, attemptId}})` 读取原始成功尝试及前后观察，核对唯一对应、声明上下文、操作种类与样本、目标属性、语义绑定、表单及选项。它复用 `coverage-reconciliation` 的样本有效性规则与适配器已有的 `controlCase` 条件投影。缺少证据、结果未知、非唯一对应或条件变化均返回具体拒绝原因。

批量接口 `engine.operationCorrespondences(sessionId, {observationId, requests: [{actionId, source}]})` 返回 `{sessionId, observationId, results}`，结果顺序与请求一致。它与单项接口共用同一实现；缺失或错误归属的证据只影响对应项。一次同步调用共享观察、会话、身份投影、唯一性索引及样本，返回后全部释放。样本按动作对象区分，避免同一候选 ID 在不同尝试中携带不同输入值时被误合并。

插件的 `completedOperations` 只选择符合任务范围的历史成功证明，去重后交给批量接口；不再逐候选、逐计划行重复解释对应关系。它只为当前同步筛选提供历史调度参考，不修改任务成功、身份、派发许可或引擎覆盖计数。模型等待或检查点等待后重新读取；审阅、观察、历史证据或任务完成账本变化后也重新构建。恢复检查仍核对每个保留来源中的成员，消失的控件不会因此变成成功。旧任务数据无需迁移；新版插件启动时会检查宿主是否提供批量接口。

没有稳定提示时，同会话可复用当前实例连续性或已有 `identityResolver` 投影；跨会话仅在两端身份各自已确认、适配器语义签名相同且各自唯一时提供参考。对应策略核对目标所属区域，活动弹层及退出次数由当前执行约束和弹层生命周期另行核对。引擎原有 `reconcileCoverage` 仍保留更严格的会话内覆盖条件，跨会话参考不写入它的成功计数。

结果包含两端的观察/动作引用、策略版本、证据和失效条件，并固定标注：

```ts
{ identityAuthorized: false, replayAuthorized: false, currentExecution: false }
```

这是只读的操作样本对应结果。调用方仍决定任务范围是否匹配、历史证据是否足以跳过本轮调度。它不修改身份、旧观察、执行账本或新会话的覆盖计数，也不自动迁移旧任务范围。输入组合和业务效果仍超出该样本对应证明。

## 可执行性与派发

```ts
const availability = engine.actionAvailability(sessionId, observationId);
const allowed = availability.actions.find(x => x.actionId === actionId);
if (allowed?.executable) {
  await engine.execute(sessionId, actionId, requestId, undefined, {
    observationId,
    profile: 'interface-exploration',
  });
}
```

查询返回观察 ID、版本、动作和结构化阻碍。保守的自动探索配置要求界面风险、支持的操作依据、当前定位、边界约束、有效审阅、抽样成员和执行状态均允许操作。范围分组规则与现有前沿使用同一个 `explorationGates`；实际派发在队列内再次运行共享约束与 SDK 审阅校验，然后进行浏览器现场 preflight。查询通过不是许可预约，也不保证现场仍然有效。

分组阻碍还包含 `selection`：`pending / invalidated / skipped / deferred / unselected`、分组 ID、版本和成员键。前沿投影、查询与派发复用同一决定；插件不再解析 `_member_not_selected` 等字符串来推断抽样。插件将宿主阻碍映射为任务缺口，并在 `scope.audit` 中保留观察版本及原始结构化阻碍，便于调试页面关联未完成原因。

不传第五个参数的原手动执行接口保持外部调用语义。任务范围、模型决定、用户授权及任务总预算仍由插件检查；宿主会话预算继续独立执行。稳定请求 ID 仍用于恢复原尝试结果，不会因重试生成第二次操作。

## 一致审计快照

`engine.explorationSnapshot(sessionId, observationId, {includeCompletionAudit: true})` 合并现有前沿覆盖、探索审计和浏览器审阅材料。过期观察 ID 被拒绝。快照包含动作可执行性、待审阅事项、身份歧义、发现缺口、未知结果、能力不足、有效非交互分类和恢复事实。完整历史完成审计可按需请求，默认不重复构建该重型报告。

快照在一次同步读取中产生。观察、尝试、前沿和覆盖计算在本次调用内复用；没有跨请求缓存许可。观察变更、审阅撤回或分组决定变更后必须重新查询。`revision` 反映当前约束和审阅材料，不能当作跨观察的永久授权。

只需要更新控件审阅账本时，使用 `controlInterpretationSnapshot(sessionId, observationId, {retainedClassifications})`。它复用完整审计的分类和操作审阅投影，但不构建历史前沿或覆盖报告。分类记录、区域约束和遍历决定校验材料仅在本次同步调用内共享；实际派发重新读取。没有跨观察、跨审阅变更或跨重启的许可缓存。

`retainedClassifications` 可传入历史分类证明的会话、观察、记录 ID 和分类。SDK 复用已有条件匹配器核对该来源场景：后来场景变化导致的失效仍可保留为历史依据，显式撤回、替换、来源不匹配或证据缺失则拒绝。返回值固定 `currentApplicability: false, executionAuthorized: false`。插件只据此更新自己的任务审阅缺口，不再自行解释底层分类记录状态；当前目标仍须依据本轮观察重新判断。

`operationCoverageCandidates` 与快照的 `operationCandidates` 复用 core 对活动边界外操作的过滤规则。它们表示该观察中可见的操作义务，不代表可执行性；不可达、禁用和未审阅仍可能是阻碍。历史来源中尚未执行的成员继续保留，不因当前隐藏或被弹层遮挡而变成成功。

插件将这些事实按任务范围过滤并写成自己的缺口，保留各自观察与尝试引用。任务树、父子目标、完成标准、用户接受的未测范围和补测轮次不进入 core。画布等不支持的内容仍为未测；用户接受例外不会产生执行成功，也不会消除未知结果。

接受某类能力不足不会排除共享同一页面地址的其他可操作控件。用户明确排除的任务范围、代表样本外成员仍按原策略保留为未测。任务数据库格式及历史范围键未改变。

## 导航、弹层和恢复

适配器 `navigationIntent` 给出有原生 HTTP 链接依据的目标地址，明确 `destinationVerified: false`。SDK 的 `navigationIsolation` 基于已有尝试及恢复记录返回是否具备隔离条件；插件决定是否结束旧轮次并开启新会话。旧尝试始终保留 `unknown`，新的浏览器会话不是恢复证明，也不能重试已隔离的来源/目标对。

`boundaryState` 复用 core 已有交互范围记录，为每次弹层进入提供独立范围 ID。文档替换中断旧范围，不将旧弹层记为已验证关闭。`interactionTransition` 提供有观察依据的进入、退出、页面变化和新控件；插件仅维护任务路径。`recoveryAssessment` 与 `continueExploration` 使用同一已验证恢复账本，边界退出及检查点仍通过原接口执行和验证。

普通动作与观察探测都使用 `interactionTransition` 更新插件路径，不再分别比较弹层数量或自行推断新控件。`continueExploration` 会启动内置遍历，因此插件自己的调度不调用它接管任务；它仅复用同一恢复证明事实，再自行决定继续、暂停或隔离。

`interactionTransition.retainedControls` 只报告同一文档内、两端都唯一的实例连续性；文档替换或观察不完整时不提供此证明。文本改变后仍可能是同一个节点，但操作等价必须另行核对。插件用它避免为了询问仍在当前页面的未知用途而重开页面，不据此结清旧缺口或继承授权。已明确操作的物理不可达、遮挡等阻碍仍可交给模型评估恢复。

插件可先执行独立、已获宿主校验的当前页面操作。离开前同时记录明确操作与待审阅义务：未定用途候选不作为已确认操作样本；历史未知导航不加入恢复重试目标。该顺序优化仍是串行调度，有界并发模型请求留在后续工作中。

## HTTP 与调试

以下是宿主接口，不需要启用探索插件：

- `GET /v1/sessions/:sessionId/action-availability?observationId=...`
- `GET /v1/sessions/:sessionId/exploration-snapshot?observationId=...&completionAudit=true`
- `POST /v1/sessions/:sessionId/operation-correspondence`
- `GET /v1/sessions/:sessionId/recovery-assessment`
- 原 `execute` 命令增加可选的 `guard`，内容与 SDK 第五参数相同。

插件保留模型请求、回答、转交和决定的原始关联。派发前增加“核对宿主执行约束”记录，关联观察、约束版本和结构化拒绝原因；实际执行仍以引擎动作结果为准。历史依据、本轮操作和未测例外继续分开显示。

插件自己的 `/tasks/:id/updates` 以事件序号增量读取，并返回这些事件关联的最新决策记录，包含已存在决策的状态更新；`/tasks?summary=true` 提供任务摘要。任务内容以已保存 JSON 的 SHA256 判断变化，不依赖毫秒时间戳。旧接口和数据库格式保留。首次选择加载完整历史一次，后续空更新复用页面快照；切换任务取消旧请求，迟到响应不能覆盖新任务。上述接口属于插件，不扩展原 SDK 客户端。

## 本次验证（2026-10-16）

环境：Node 24.22.0，本地 Chromium。真实网站任务维持暂停，未调用真实模型服务。

| 验证 | 结果 |
| --- | --- |
| 插件已有回归：运行、服务商、语义判断、调试页面 | 172 项通过 |
| core / SDK / 适配器相关回归（29 个文件） | 283 项通过，包含 12 项新增公共契约测试 |
| 新增调试关联断言及公共 API 边界检查 | 定向重跑 2 项通过，包含于上述插件测试 |
| TypeScript 检查、完整构建 | 通过 |
| 编译产物，插件关闭 | 原有 HTTP、浏览器执行、证据、检查与探测流程通过 |
| 编译产物，插件启用 | 本地双按钮目标完成，2 次真实浏览器动作；模拟 JEV 6 次、模拟 LLM 1 次，目标内未完成项为 0 |
| 旧任务匹配键兼容 | 对照重构前代码检查已保存观察中的 293 个控件、207 个动作，差异为 0；只读检查，无执行或模型调用 |
| 开发服务重启及旧数据读取 | 新宿主接口正常读取旧观察；原任务仍暂停，12 轮 / 109 次动作 / 2283 次模型请求及累计时间均保留，历史未知导航仍为未知 |

新增及已有用例覆盖跨会话对应、同名不同目标、上下文/表单/选项变化、审阅撤回、抽样限制、过期决定、弹层重新进入、文档替换、未知结果、重启恢复、总预算累计及用户接受的未测范围。没有改动任务数据库格式，新增弹层范围 ID 为可选字段，旧记录继续可读。

验证日志保存在工作区 `.data/boundary-refactor-*.log`。编译后浏览器验收报告及截图位于 `.data/explorer-smoke-1792119690708/`。本地双按钮目标完成仅证明该测试目标，不代表真实网站或画布内部穷尽。画布内部观察和操作、未知执行结果的业务效果、尚未发现的交互仍保留为能力或证据缺口。

重启后的旧观察只读检查中，207 个动作的可执行性查询约 311 ms，一致审计快照约 1457 ms；这是单次本地测量，不是性能基准。相关材料在一次调用内共享，完整历史完成审计按需构建；未使用需要跨观察失效管理的持久缓存。

### 当前事实与历史完成审计的读取成本

`explorationSnapshot(sessionId, observationId, {includeHistoryAudit:false})` 复用同一执行校验、区域、分类、操作审阅、发现、恢复和边界材料，返回当前观察的一致事实。它不读取全部历史观察；`historyAuditIncluded:false` 明确表示未提供历史覆盖，`frontier`、`explorationAudit`、`completionAudit` 为 `undefined`。省略选项仍返回原来的完整历史快照。轻量选项与 `includeCompletionAudit:true` 冲突时拒绝请求，不能用当前事实冒充完成审计。

插件在普通调度和探测前使用轻量选项，结束时仍进行完整历史审计；历史操作对应证明继续由专门的批量接口验证。两种快照共用底层事实和规则，没有跨调用缓存。审阅撤回、抽样成员变化、重新进入弹层和未知执行结果都会在下次查询中重新核对，实际派发仍重新验证。

缺口记账使用本次同步审计已经持有的观察引用，不再为每个缺口重复反序列化相同观察。这只改变读取成本，不改变缺口内容、来源或成功判定。对真实 OKX 保留观察的只读测量及后续真实运行结果见 [OKX 实测记录](experiments/autonomous-okx-performance-2026-10-16/README.md)。

### 后续职责审查与效率验证（同日）

保留了开始审查时的 12 个未提交文件，在已有公共契约上收敛结构化抽样阻碍、历史分类证明和实例连续性，没有另建一套对应或覆盖规则。架构回归明确检查 core、SDK、适配器不依赖探索插件或模型提供商。

本轮相关回归去重合计 **406 项通过**：core/SDK 190 项（包含 15 项公共契约）、插件运行 90 项、语义 57 项、顺序与失效 36 项、服务商 20 项、既有调试页面 7 项、增量同步 5 项及切换任务页面 1 项。TypeScript 检查、完整构建通过；插件关闭的原有执行/观察/证据流程通过；插件启用的编译产物完成本地 Alpha/Beta 两次真实浏览器动作，模拟 JEV 6 次、模拟 LLM 1 次，没有目标内未完成项。这些用例不证明真实网站穷尽。

新增恢复用例核对了隐藏的待审阅控件、被区域审阅阻挡的原生操作、仍可见但物理不可达的控件、非交互分类结清审阅但不生成执行成功，以及未知导航不加入恢复重试。旧的跨会话、同名不同控件、上下文变化、审阅失效、弹层再入、过期决定、未知结果、重启和累计预算用例继续通过。

开发服务部署后通过公开接口读取原任务：13 轮、116 次动作、2729 次模型请求、24,058,437 ms 及预算完全保留；部署检查时任务仍暂停，未产生新模型或浏览器动作。旧未知导航仍是 `unknown`，画布仍是用户接受的未测例外。实测闲置增量响应 140 字节，五个任务的摘要 3092 字节。首次打开历史以及运行中变化的完整任务仍有读取开销，有界模型并发尚未实现。

本轮最终日志：`.data/boundary-review-host-final.log`、`.data/boundary-review-contract-plugin-final.log` 中公共契约部分，以及修复后重跑的 `.data/boundary-review-runtime-final.log`、`.data/boundary-review-semantic-scheduling-final.log`、`.data/explorer-sync-final-tests.log`；编译验收为 `.data/boundary-review-smoke-{disabled,enabled}.log`。重启兼容检查为 `.data/boundary-review-postdeploy.json`，本地浏览器报告及截图位于 `.data/explorer-smoke-1792125197579/`。

### 批量对应优化验收

最新一轮共验证 **438 项不同用例**，包括新增批量公共契约 13 项、插件历史证明选择 2 项及已有身份判断 17 项。最终复用范围匹配器、共享探测前审计材料后，相关审计、范围、未知结果和探测场景另定向重跑 70 项，全部通过。类型检查、完整构建及插件开关两种编译验收均通过。开启插件的本地 Alpha/Beta 目标实际执行 2 次，模拟 JEV 6 次、模拟 LLM 1 次，目标内未完成为 0，`exhaustive` 仍为 `false`。调试页面回归继续区分模型输入输出、采用影响、分类证明、实际执行和未测。

针对保留的真实 OKX 观察做只读对比：2058 条计划记录、212 个动作，原逐项判断与批量判断都得到相同的 23 个历史对应样本；这不是新增的 23 次操作，也不代表本轮执行成功。

| 单次同步筛选 | 原逐项读取 | 批量读取 |
| --- | ---: | ---: |
| 总耗时 | 2.761 秒 | 0.982 秒 |
| 记录读取次数 | 272 | 107 |
| JSON 解析量 | 500.7 MB | 177.1 MB |
| 对应提示计算次数 | 20,512 | 8,622 |

这是同一保留观察上的本地单次测量，未调用模型或浏览器。完整历史审计和初次加载大任务仍有成本，没有引入跨请求缓存。真实页面原有未知导航、未审阅义务及画布能力缺口仍保留，重复进入搜索或 FAQ 不计为新增覆盖；本次不继续真实穷尽。

最新验证日志：`.data/boundary-batch-{contract-tests,runtime-tests,host-tests,audit-final-tests,typecheck,build,smoke-disabled,smoke-enabled}.log`、`.data/correspondence-batch-final-tests.log`；此前完整顺序测试见 `.data/boundary-batch-plugin-tests.log`（其中新增测试最初的夹具写入错误已在 `contract-tests` 修正重跑）。只读基准为 `.data/review-correspondence-batch-bench.json`；编译产物报告及截图为 `.data/explorer-smoke-1792126529189/`。

开发服务已加载新版代码，旧任务读取正常，仍暂停且无待派发命令；累计时间 24,647,738 ms、13 轮、136 次动作、2785 次模型请求和全部预算与暂停时完全一致。原未知尝试仍为 `unknown`，已接受的画布仍为 `untested`。重启核对证据为 `.data/boundary-batch-restart-verification.json`。
