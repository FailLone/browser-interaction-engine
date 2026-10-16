# 探索宿主契约与插件职责

探索插件保持可选，core/SDK 不引用插件或模型提供商。真实网站穷尽任务已暂停；本次公共契约验证使用真实本地浏览器页面和显式注入的模拟提供商，不代表真实网站已经穷尽。

| 层 | 负责 | 不负责 |
| --- | --- | --- |
| core | 观察绑定、执行约束、样本证据、身份投影、前沿与审计、交互范围生命周期 | 模型、任务意图、任务数据库和轮次 |
| 浏览器适配器 / SDK | 浏览器控件对应提示、操作条件、审阅有效性、导航意图、弹层及恢复事实 | 替用户决定任务范围或接受未测内容 |
| 探索插件 | JEV/LLM 路由、提示词、任务范围、预算、顺序、补测计划、历史证据是否用于调度、未测例外和调试展示 | 从 DOM 证据规则重新推断导航或独立决定动作是否可派发 |

## 操作对应与历史证据

`browserControlCorrespondence(control)` 返回不透明匹配提示、来源依据和失效条件。旧任务中 `explorer:record:v1`、`explorer:context:v1` 及已有稳定键的编码保持兼容；这些前缀是历史数据协议，不代表 SDK 依赖插件。`browserOperationKey` 同样保留历史重试账本的编码。

`engine.operationCorrespondence(sessionId, {observationId, actionId, source: {sessionId, attemptId}})` 读取原始成功尝试及前后观察，核对唯一对应、声明上下文、操作种类与样本、目标属性、语义绑定、表单及选项。它复用 `coverage-reconciliation` 的样本有效性规则与适配器已有的 `controlCase` 条件投影。缺少证据、结果未知、非唯一对应或条件变化均返回具体拒绝原因。

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

不传第五个参数的原手动执行接口保持外部调用语义。任务范围、模型决定、用户授权及任务总预算仍由插件检查；宿主会话预算继续独立执行。稳定请求 ID 仍用于恢复原尝试结果，不会因重试生成第二次操作。

## 一致审计快照

`engine.explorationSnapshot(sessionId, observationId, {includeCompletionAudit: true})` 合并现有前沿覆盖、探索审计和浏览器审阅材料。过期观察 ID 被拒绝。快照包含动作可执行性、待审阅事项、身份歧义、发现缺口、未知结果、能力不足、有效非交互分类和恢复事实。完整历史完成审计可按需请求，默认不重复构建该重型报告。

快照在一次同步读取中产生。观察、尝试、前沿和覆盖计算在本次调用内复用；没有跨请求缓存许可。观察变更、审阅撤回或分组决定变更后必须重新查询。`revision` 反映当前约束和审阅材料，不能当作跨观察的永久授权。

`operationCoverageCandidates` 与快照的 `operationCandidates` 复用 core 对活动边界外操作的过滤规则。它们表示该观察中可见的操作义务，不代表可执行性；不可达、禁用和未审阅仍可能是阻碍。历史来源中尚未执行的成员继续保留，不因当前隐藏或被弹层遮挡而变成成功。

插件将这些事实按任务范围过滤并写成自己的缺口，保留各自观察与尝试引用。任务树、父子目标、完成标准、用户接受的未测范围和补测轮次不进入 core。画布等不支持的内容仍为未测；用户接受例外不会产生执行成功，也不会消除未知结果。

## 导航、弹层和恢复

适配器 `navigationIntent` 给出有原生 HTTP 链接依据的目标地址，明确 `destinationVerified: false`。SDK 的 `navigationIsolation` 基于已有尝试及恢复记录返回是否具备隔离条件；插件决定是否结束旧轮次并开启新会话。旧尝试始终保留 `unknown`，新的浏览器会话不是恢复证明，也不能重试已隔离的来源/目标对。

`boundaryState` 复用 core 已有交互范围记录，为每次弹层进入提供独立范围 ID。文档替换中断旧范围，不将旧弹层记为已验证关闭。`interactionTransition` 提供有观察依据的进入、退出、页面变化和新控件；插件仅维护任务路径。`recoveryAssessment` 与 `continueExploration` 使用同一已验证恢复账本，边界退出及检查点仍通过原接口执行和验证。

## HTTP 与调试

以下是宿主接口，不需要启用探索插件：

- `GET /v1/sessions/:sessionId/action-availability?observationId=...`
- `GET /v1/sessions/:sessionId/exploration-snapshot?observationId=...&completionAudit=true`
- `POST /v1/sessions/:sessionId/operation-correspondence`
- `GET /v1/sessions/:sessionId/recovery-assessment`
- 原 `execute` 命令增加可选的 `guard`，内容与 SDK 第五参数相同。

插件保留模型请求、回答、转交和决定的原始关联。派发前增加“核对宿主执行约束”记录，关联观察、约束版本和结构化拒绝原因；实际执行仍以引擎动作结果为准。历史依据、本轮操作和未测例外继续分开显示。

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
