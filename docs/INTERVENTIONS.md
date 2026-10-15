# 上游待办与验证后继续

引擎负责能够确定执行的工作；用途、范围、身份、恢复条件不能确定时，把原因和证据交给调用方。调用方作出决定或修复现场后，引擎重新验证，再继续已获准工作。协议版本为 `interventions/v1`。

本功能不依赖模型。人工、LLM 或业务程序均通过相同接口接入；原有区域、控件、列表、身份与检查点协议仍是批准和执行的依据。

## 统一材料

SDK：`client.interventionMaterial(sessionId, since?)`。

HTTP：`GET /v1/sessions/:sessionId/interventions?since=<revision>`，响应禁止缓存。

材料包括当前观察、修订号、按依赖和优先级排列的 `items`、`readyIds`、`sessionBlockerIds` 和 `changes.added/changed/retired`。

每项包含：

- `id` / `conditionKey`：事项身份与本次答复必须绑定的条件。
- `kind` / `reason`：观察缺口、弹层退出、区域划分、控件用途、探索深度、身份、恢复、环境、发现、未知执行结果或预算。
- `affected`：关联的操作待办、控件、探索组和实际尝试。
- `dependsOn`：建议先处理的事项。例如先确定所属区域，再决定相应范围；深度选择无需先确认每个未知成员的用途，可以选择已知样本。
- `evidence` / `material` / `subject`：观察与记录 ID、诊断和原有协议的查询入口。按具体接口读取完整材料，不根据标题猜测控件身份。
- `options`：当前允许答复的命令及其效果。仅列出选项不代表已批准。
- `status`：等待决定、暂缓、本轮不测、阻塞或失败；`blocking` 区分会话阻塞、局部工作限制和提示。
- `current`：与当前文档/范围的关联；历史范围和原审计仍保留。

同一个恢复结果影响多个操作时合并为一项，并保留全部关联；不同失败结果不会仅因文案相同而合并。上一次继续验证失败或中断，也会提供检查原因和原记录。

`readyIds` 是处理顺序提示，不表示可以执行其中全部操作。暂缓、不测不会被外部示例自动重审。可以显式重新答复当前事项，也可继续使用原有领域接口。`retired` 只表示该请求已不再出现，不代表测试成功、业务恢复或发现完整。

引擎在材料变化时发布持久事件 `interventions.updated`，包含 `revision`、变化列表和可处理事项 ID。消费者可保存事件游标并查询最新材料；事件中的版本已经留存为差异基准。`since` 不存在时返回 `UNKNOWN_INTERVENTION_REVISION`，调用方应重新读取当前全量材料。读取本身不产生决定或执行。

## 提交上游答复

```ts
const material = await client.interventionMaterial(sessionId);
const item = material.items.find(i => i.subject.groupId === group.id)!;
const result = await client.respondToIntervention(sessionId, {
  requestId: crypto.randomUUID(),
  interventionId: item.id,
  conditionKey: item.conditionKey,
  command: {
    type: 'decideExplorationGroup',
    groupId: group.id,
    revision: group.revision,
    decision: {
      mode: 'sample', memberKeys: selectedCurrentMemberKeys,
      source: 'caller', evidence: ['本轮目标只要求这些样本'],
    },
  },
});
```

HTTP 使用原命令入口，命令类型 `respondToIntervention`，参数为 `response`。答复只封装当前事项 `options` 支持的原命令。不能通过此入口嵌套自动探索、任意执行或另一个答复；批量探索决定也限于当前事项的组，多组操作仍可使用原来的批量接口。

条件检查在执行队列内进行。即使底层组修订号未变，只要观察或当前事项条件改变，旧答复仍以 `STALE_INTERVENTION` 拒绝；跨事项目标也拒绝。领域接口自己的现场校验继续执行。程序不会替调用方把旧答案改绑到新观察。

返回 `{ response, material }`：

- `response.status: applied` 表示命令已应用，**不表示动作效果成功**；实际记录 ID 和可用状态在 `outcome`，完整结果仍查原记录。
- `rejected` 包含错误代码、原因和新的材料。重新决定需新的 `requestId`。
- 相同 `requestId` 和相同参数返回同一请求，不重复执行；不同参数返回 `REQUEST_CONFLICT`。
- 进程重启将未完成请求标为 `interrupted`，不重放。当前关联事项会附上中断记录；调用方核对原记录后重新决定。

慢速人工或模型审阅应在引擎队列之外进行。完整的有界调用方示例见 [external-interventions.ts](../examples/external-interventions.ts)：读材料、逐项让调用方决定、提交当前答复，再请求验证并继续。示例不自动接受任何待办；迟到答复拒绝后停止本轮提交。

## 验证后继续

```ts
const current = await client.interventionMaterial(sessionId);
const result = await client.continueExploration(sessionId, {
  requestId: crypto.randomUUID(), observationId: current.observationId,
  source: 'caller', evidence: ['本轮审阅完成，继续其余已批准工作'],
});
```

HTTP 命令类型为 `continueExploration`，参数为 `continuation`。此步骤会：

1. 等待正在执行的操作结束，再核对请求绑定的观察；不同活动会话不会被接管。
2. 连接现场、重新观察，验证稳定性、关键观察完整性和已声明上下文。
3. 让既有条件失效规则重新作用于控件用途、区域、深度决定等；文档或相关条件变化不继承旧批准。
4. 验证显式恢复条件及未知结果。合格后启动 DFS；未决的独立范围继续保留，已经批准的工作可继续。

返回 `{ continuation, material, session }`。`continuation` 保留前后观察、文档/URL/上下文变化、待办变化和逐项 `checks`，以及 `started` / `needs_review` / `failed` 等结果。`started` 仅表示本次验证后启动了调度，不表示一定存在可执行动作，更不表示整页完成。预算沿用原会话，重复请求不重置预算、重放动作或再次暂停。

旧 `explore` / `resume` 仍可使用。存在尚未核实的未知执行结果时，自动探索会暂停；直接恢复旧 runner 不会消除该限制。

## 外部恢复与业务状态

仅从页面能验证的条件由程序验证。例如一次已审阅的弹层退出导致保留字段改变，调用方修正字段后，在同文档、同 URL/上下文、原父边界及全部原保留字段一致，并且操作结果已知、会话没有业务状态变更标记时，可以重新核验原退出契约。

如果涉及业务状态变更、未知动作结果，或不能重新验证的退出结果，需要显式提交预期：

```ts
await client.continueExploration(sessionId, {
  requestId: crypto.randomUUID(), observationId: current.observationId,
  source: 'test-environment', evidence: ['外部恢复操作记录的引用'],
  recovery: {
    url: expectedExactUrl, context: expectedDeclaredContext,
    boundaryKeys: expectedBoundaryStack, predicates: expectedPredicates,
  },
});
```

引擎验证准确 URL、已知上下文、边界栈和谓词。需要确认业务状态时，运行引擎的服务进程还必须配置 `hooks.verifyExternalRecovery(material, context)`，返回 `{ result: 'pass' | 'fail' | 'unknown', evidence: string[] }`。该验证器由调用方实现，应检查实际应用/测试环境状态；用户提交“已经恢复”的文本不能代替验证器。

验证器在现有有限 hook 时限内运行；报错、超时、未知、失败或缺少有效证据均保留待处理状态，迟到结果无效。验证器通过后再次观察，验证文档和交互状态未变化、预期仍成立，才清除本次已确认的业务变更标记。验证器内不应调用同一引擎的排队命令；外部修复先在队列外完成。

每次确认保留独立 `verifiedRecovery` 及来源。旧失败、未知结果、未执行项和覆盖缺口均不改写，不由恢复推断旧操作成功，不给旧动作重放资格。正常继续当前独立工作不等于业务恢复，仍可能保留 `dirty` 标记。

本功能提供外部恢复的验证入口，未实现自动服务器重置、环境分支隔离或任意返回路径生成。

## 记录与调试界面

- `GET /v1/sessions/:id/intervention-responses`：答复记录。
- `GET /v1/sessions/:id/continuations`：继续验证记录。
- `interventions.responded`、`interventions.interrupted`、`exploration.continuation`：请求结果事件。
- 调试页“上游待办”：查看原因、关联证据、依赖和处理接口，跳转现有范围/身份/检查点审阅；“重新验证并继续”展示本次核验结果。

服务端业务验证器需要由集成方配置，调试按钮不会替代它。新的统一材料是原记录的汇总视图，不是第二套授权。覆盖结论仍以 [完成审计](EXPLORATION-AUDIT.md) 为准。
