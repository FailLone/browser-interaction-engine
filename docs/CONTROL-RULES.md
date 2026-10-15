# 可配置的控件检查规则

`@interaction/rules` 是已有 Inspection 协议的消费者插件。它读不可变 Capture，按配置运行已注册规则，输出并保存逐控件结果。core 不引入检查策略，BrowserEngine 不默认执行规则，也不调用模型。可运行入口是 [rule-inspector.ts](../examples/rule-inspector.ts)。

此设计延续 ui-sentinel 的规则概念：**规则 = 适用条件 + 预期 + 检查方法 + 证据要求**，具有稳定 ID 和版本；规则与本次目标绑定分开。参考原项目的 `docs/rules-and-rule-library.md`、`src/rules/types.ts` 和 UIK-D002/UIK-D010。那些文档中的审批、学习与发布流程是原项目的工作约定，本插件没有移植这些流程。

## 如何写好遮盖规则

“矩形相交”“画面看不清”“指针被拦截”“操作无法完成”是不同主张，不能用同一份单点证据证明。建议分别构建视觉遮挡、指针命中、操作可达性规则，并共享底层采集与探测能力。

一条规则依次回答：

1. **此时目标应不应该可见/可操作？** 根据当前交互范围与明确的设计要求判断。正常 modal 的背景是明确例外；modal 内的关闭按钮仍要检查。Popover/tooltip 有意覆盖背景不等于可随意遮住当前必要操作，不能仅按 role 全部豁免。
2. **观察到什么损害？** 矩形交集只筛候选；记录具体采样位置、实际命中节点及祖先、可读内容、目标有效区域。区分视觉遮挡与 `pointer-events: none` 的透传；单点被挡不等于整控件不可操作。
3. **普通操作能否解除？** 需要跨捕获的滚动等受控探测，明确目标、容器链、方向、预算、恢复与重新验证。`position: sticky/fixed` 只是线索；滚到底也可能向反方向恢复。嵌套滚动、横轴、sticky 状态切换、固定控件自身不随容器移动等都会改变结论。
4. **证据支持多大结论？** 有限尝试失败只能证明“已尝试路径未恢复”；预算耗尽不能叫“永久不可达”。跨文档、视口变化、目标歧义、虚拟化替换、布局自主改变时，旧新结果不能直接拼接为同一控件的恢复证据。

建议的判定表（完整视觉/操作可达性仍是设计目标；本版主动恢复规则仅判断五个指针采样点，具体范围见下文）：

| 证据 | 结论 | 严重度 |
| --- | --- | --- |
| 明确不要求当前可操作，例如正常 modal 背景 | not-applicable | info |
| 实际检查通过 | pass（注明检查范围） | info |
| 采样点被挡，意图、影响或恢复未知 | unknown | warning |
| 当前遮挡影响已确认，普通滚动后确实恢复 | 可按声明的体验规则判 fail | warning |
| 当前必须可操作，必要有效区域被挡，且相关恢复路径在明确范围内被证伪 | fail | error |
| 必需证据缺失、采集不稳定、规则异常 | unknown | info |

`verdict` 和 `severity` 独立。warning 不意味着已经证明 bug；not-applicable 不计为健康样本。每个新规则应有真实通过、违反、不适用、证据不足样本，涉及恢复的再补反向滚动、嵌套容器、边界与目标替换样本。

## 注册与选择

```ts
import { RuleRunner, sampledOcclusionRule, toInspectionResults } from '@interaction/rules';

const runner = new RuleRunner([sampledOcclusionRule]);
const catalog = runner.catalog(); // ID、版本、描述、必需能力、参数 JSON Schema

// engine 或 InteractionClient 均可作为 reader；inspection 来自 inspection.ready。
const reports = await runner.run(reader, inspection, [{
  ruleId: 'sampled-occlusion', ruleVersion: '1.0.0',
  options: { includeDisabled: false },
  // targets: [{ captureId: inspection.captureId, nodeId: control.localId }],
}]);
await reader.completeInspection(inspection.sessionId, inspection.id, 'rules', toInspectionResults(reports));
```

消费前须在创建会话时注册 `inspection.consumers: [{ id: 'rules' }]`，收到事件后 `receiveInspection`；详细租约流程见 [检查 API](INSPECTION-API.md)。规则插件的 reader 类型仅需要 `captureDetails`，运行本身不会调用 complete。调用方负责保存/完成、事件续读与必要的租约续期。多个规则累计耗时可能超过租约，慢消费者应持续续期。

配置是 JSON，外部 LLM 可以查询目录并为每次 Inspection 选择已注册的规则、版本、参数及目标。配置未知版本、重复规则、重复目标或不合法参数时在执行前报错；`enabled: false` 的条目不执行。未选择规则返回空列表，不表示页面通过。省略 targets 检查本次观察的全部控件（包含背景控件，由规则判断适用性）；显式空 targets 是 not-applicable。每次最多选择 32 个规则，每条最多 1000 个控件；默认目标超限返回 unknown，要求调用方明确缩小范围。

目标始终使用 Capture + documentId + nodeId。配置中的 captureId 与当前任务不符、控件不存在或 DOM 缺失时返回 unknown，不按名称猜一个控件，不用最新快照替代历史快照。变更规则判断时提升 version；每份报告保留本次选择和参数，不跨配置缓存。不同配置复查同一任务时使用独立消费者，避免覆盖已有完成记录。

自定义规则实现 `ControlRule`：`configure(options)` 验证参数并返回 `evaluate(context)`。context 提供冻结的历史任务、Capture、Observation、DOM 和当前控件，以及用于协作取消的 signal。返回 `RuleAssessment`，包括 verdict、severity、code、expected、actual、evidence，可附 facts 和 nextSteps。插件逐个隔离异常和非法返回值，记录 RULE_ERROR；每条规则默认 5 秒，超时记录 RULE_TIMEOUT。超时不是沙箱，无法抢占同步死循环或强制停止不响应 signal 的外部代码。仅注册可信的宿主代码，不执行 LLM 返回的源码。

检查前验证本次 Capture/Observation/Document 绑定、协议、所需组件的兼容性与可用性、采集完整度和稳定性。数据不足不运行依赖它的判断。传输或读取调用失败则向调用方抛出，不确认完成。已知失败优先于其他控件的 unknown；有 unknown 而没有 fail 时汇总为 unknown；至少一个 pass 且其余只有不适用时汇总为 pass。逐控件结果始终保留，汇总只描述选中目标和规则，不能作为全页健康证明。

## 第一条规则的实际边界

`sampled-occlusion@1.0.0` 检查采集时控件与视口交集的中心点命中：

- 正常禁用（默认）、隐藏、inert、视口外或已观察到的 modal 背景为不适用；modal 的逻辑子弹层控件继续检查。
- 命中自身或后代时，只给该采样点 pass。透明装饰可能透传指针，即使有视觉遮挡也可能得到此结果。
- 命中别的节点时输出 `unknown + warning`，记录实际 blocker、其 fixed/sticky 祖先、所属 overlay、tooltip 线索和建议补证步骤。没有因 CSS 定位方式直接给 warning/fail 的严重度判定。
- blocker、样本或兼容的几何证据缺失时 unknown。没有自动滚动、自动关闭弹层、像素可读性判断或“永久不可达”的 error。

被动规则保持不修改页面。需要实际探测时，显式调用下面的主动规则；`nextSteps` 本身不会触发动作。

## 主动滚动恢复规则

`scroll-recovery@1.0.0` 通过 `inspectScrollRecovery` 或 `scrollRecoveryRule.run` 执行，输出同样的 RuleReport。它有独立元数据、参数 JSON Schema 和 `effects: controlled-scroll`，不能注册到只读 RuleRunner。上层可以按配置选择被动检查或主动调查；不要自动对每一个 probe 产生的 inspection.ready 再运行主动规则，否则会形成循环。

```ts
import { inspectScrollRecovery, toInspectionResults } from '@interaction/rules';

const report = await inspectScrollRecovery(client, inspection, control.localId, {
  requiredNow: {
    reason: '此状态下用户应能使用这个控件',
    evidence: ['product-requirement:current-primary-action'],
  },
  maxScrolls: 8,
  maxDurationMs: 15000,
});
await client.completeInspection(inspection.sessionId, inspection.id, 'rules', toInspectionResults([report]));
```

`requiredNow` 是调用方的明确适用要求及来源，不从按钮名称或定位样式推断，也不会由插件自动认证为正确的产品要求。未声明时可以保存恢复事实，但不会产生 fail/error。完整可运行入口见 [scroll-recovery-inspector.ts](../examples/scroll-recovery-inspector.ts)。

流程与证据：

1. 校验初始 Capture 的完整性、可用性、目标与作用范围。要求当前观察仍匹配，然后重新观察；开始前目标、命中、容器位置或视口发生变化时停止。
2. 读取中心及四个内缩角的五点命中记录。任一点可命中即判采样检查 pass；缺失网格或 blocker 证据为 unknown。Modal 背景沿用不适用结果。
3. 沿实际 DOM 祖先查找允许用户滚动且有非零范围的容器，最内层优先；在双轴上尝试原位置两侧的 60% 容器尺寸位移及两端位置。保留前一容器的探测位置，允许后续尝试组合；这仍不是穷尽全部位置。活动弹层的祖先搜索止于弹层根，不能滚动背景。
4. 每步保存 requestId、attemptId、前后 observationId、滚动目标位置和五点结果；核验 document、DOM 实例、语义绑定、控件尺寸和直接父节点、视口、业务上下文、弹层范围、滚动容器范围。替换、虚拟列表重绑定、范围改变或缺证立即停止。
5. 为恢复原位置预留动作预算，结束时逐个恢复已操作容器并核验最终位置。响应丢失或动作后证据不可信时保留请求 ID，不盲目重复操作，也不拿动作前快照宣称恢复完成。恢复失败返回 unknown/warning，facts 仍保留曾经观察到的恢复事实。

当前判定：

| 实测事实 | 有 requiredNow | 未声明 requiredNow |
| --- | --- | --- |
| 初始至少一个采样点可命中 | pass/info | pass/info |
| 五点起初均被挡，受控滚动后同一控件出现可命中采样点，原位置已恢复 | fail/warning | unknown/warning（保留 recovered） |
| 五点均被挡，当前作用范围内没有非零可用滚动路径且无已知路径缺口 | fail/error | unknown/warning |
| 有限探测未恢复、预算不足、发生变化、缺证或未能确认恢复原位置 | unknown/warning 或 info | 相同 |

error 的主张限于“声明要求下的五点指针检查失败，当前没有普通祖先滚动路径”，**不是**证明整块可点击区域、键盘路径或整个业务操作永久不可达。固定目标在多个尝试位置始终被挡，仍不能仅凭这些有限尝试给 error。滚到末端仍尝试反方向。

当前支持主文档 light DOM 中 horizontal-tb、LTR 的标准祖先滚动。RTL、其他书写方向、有剩余范围但不能正常用户滚动的裁剪容器等保留能力缺口；不修改 overflow 或 scroll-snap，不关闭弹层。滚动监听器、懒加载和服务端副作用无法由回滚滚动位置撤销，因此每次 probe 都按 unknown risk、不可自动重放记录。恢复指滚动位置的可观察恢复，不表示业务世界回滚。

默认最多 8 次搜索滚动（0–32 可配），另有恢复动作；15 秒是停止安排新搜索动作的时间预算，已发出的动作、取证及恢复仍受各自执行超时约束。会话预算也生效，可能阻止恢复。消费者负责足够的租约或持续续期；原任务和中间任务使用已有证据留存规则。报告保存采样测量，所引用截图/DOM 的长期可读性仍取决于留存配置，必要时由调用方显式固定。

低层 SDK/HTTP 命令 `scrollProbe(sessionId, observationId, localId, options, requestId)` 可单独使用。options 指定 `documentId`、`containerNodeId`、`left/top` 和 `expectedLeft/expectedTop`；动作入队后核验目标实例、实际祖先、作用范围、原滚动位置及坐标范围。相同请求幂等，不同参数复用 requestId 冲突；不会因为普通点击被遮挡而禁止必要的滚动探测。

## 交付与验证

检查协议新增 `not-applicable`、可选 severity 与 JSON details；保留既有 pass/fail/inconclusive/unsupported。插件的 unknown 映射为 inconclusive，原始四态及逐控件报告完整保存在 details，每条 rule/version 只提交一个汇总结果。UI 显示严重度并可展开报告。已有完成去重、冲突检查、证据租约与节点归属验证沿用原协议。旧版消费者可能不识别新增字段/枚举，跨进程部署时同步升级 SDK 和服务端。

`tests/rules.test.ts` 使用真实 Chromium 验证命中自身/后代、指针透传、modal 背景/内部、popover、tooltip、fixed、sticky、不可滚动、滚动末端、滚动前后历史隔离；另检查配置、缺证、过期绑定、异常、超时以及 HTTP 保存与幂等重放。合成自定义 fail 只用于验证插件与传输，不代表已实现完整遮挡缺陷判断。

`tests/scroll-recovery.test.ts` 另覆盖纵向/横向/嵌套恢复、从底部反向恢复、无滚动路径、有限探测失败、目标替换/重绑定/尺寸变化、恢复失败、响应丢失、预算预留、弹层范围和 HTTP 幂等；实际 error 样本仍限定于上述五点合同。

启动 `pnpm demo` 后运行：

```sh
pnpm exec tsx --conditions=development examples/rule-inspector.ts 'http://127.0.0.1:4174/rules.html?mode=fixed'
```

进入该会话的“UI 检查”查看报告；后续操作和重新观察会产生新的检查任务。

## 跟随正常探索的持续遮挡复查

默认推荐 `ObservedOcclusionTracker`。它只读取历史 Capture，不调用 observe、scrollProbe、恢复或暂停探索；`scroll-recovery` 仍是独立、显式选择的主动诊断。两者不会互相自动调用。

```ts
import { ObservedOcclusionTracker, toInspectionResults } from '@interaction/rules';

const tracker = new ObservedOcclusionTracker({
  // 默认空数组：不推断产品要求，只报告疑似遮挡与观察到的恢复。
  requirements: [{
    identityId: target.identityId,
    kind: 'sampled-pointer-at-observed-position',
    reason: '此控件在每个被检查的位置至少需要一个可命中的采样点',
    evidence: ['product-requirement:visible-action'],
  }],
});
// 每个会话使用一个实例，按 inspection.sequence 顺序消费。
const report = await tracker.run(client, inspection);
await client.completeInspection(sessionId, inspection.id, consumerId, toInspectionResults([report]));
```

`observedOcclusionRule` 提供版本、effects 和参数 JSON Schema，供配置/agent 发现。这是有历史状态的消费者，不注册进单快照的 RuleRunner。完整独立运行例子见 [observed-occlusion-inspector.ts](../examples/observed-occlusion-inspector.ts)；示例启动正常探索并同时消费检查事件，不要求探索等待检查完成。

### 身份与可比性

问题按会话、document、URL、声明/采集的业务上下文、逻辑控件 identityId 和弹层打开周期 scopeId 关联。同一个弹层关掉后再打开，不自动沿用上次的复查结论。存在 hypothesis、多个匹配项或身份缺失时不自动合并。

逻辑身份可以跨 DOM 重建关联，但“同一节点在滚动后恢复”的判断额外要求 instanceId、业务绑定、目标尺寸/父节点、视口和祖先容器范围保持可比。虚拟列表重用节点不是同一业务控件。整个复合组件的 component.id 仍跟随根 DOM 实例；这里复用的是控件身份，不宣称已建立任意复合组件的跨重建身份。

复查读取目标实际祖先的双轴位置差，不以动作名称为依据。因此滚动其他容器、滚动被 scroll-snap/监听器取消、只提交了动作但位置没改变，都不会被算作相关滚动证据。偏移变化与采样结果只表示同一观察区间内发生，因果关系未证实。

### 判断的修订

| 当前证据 | 当前结果 | 问题状态 |
| --- | --- | --- |
| 第一次完整五点被挡 | unknown/warning | suspected |
| 可比目标至少一点恢复命中 | pass/info，保留原始证据 | resolved |
| 可比目标仍被挡，没有明确当前位置要求或没有相关偏移变化 | unknown/warning | suspected |
| 前后五点都被挡、相关祖先实际滚动、可比性通过，且该 identityId 有明确当前位置要求 | fail/error，限定于已声明的五点合同 | confirmed |
| 已确认的同一失败仍持续 | 保留 fail/error | confirmed |
| 移出视口、被裁剪、禁用、缺证、身份不明、作用范围/上下文改变或 DOM 重建 | unknown/warning，不将消失当作修复 | unverified |

error **不是**“无法通过任何滚动恢复”的证明，也不是整个控件所有像素/键盘交互不可用。仅重复看到遮挡、滚到端点或有限位置尝试失败不能证明永久阻挡。要求“任意时刻都可操作”的产品契约必须由调用方提供；未配置时不产生 error。

每个问题有 issueId 和递增 revision，保留首次证据与最近 32 份证据引用、确认时的引用；报告包含当前采样和用于复查的实际偏移差。关闭警告不删除历史报告。未能复查时保留历史 confirmedAt，当前结果不会假装重新验证了此前错误。

tracker 在消费者内存中维护状态，默认最多 500 个已跟踪问题（可配 1–1000，包括已解决问题）；满额抛出 TRACKER_CAPACITY_EXCEEDED，不静默丢弃警告。调用内部串行化、最近任务重送幂等、较旧任务和跨会话调用明确拒绝。重启消费者应使用新 tracker 按顺序重放保留的历史检查，缺失历史不推断恢复。不是跨进程持久化状态服务；报告通过原 Inspection 协议持久保存。底层快照的长期可读性仍取决于租约和留存配置。

### 探索器的容器滚动

浏览器适配器复用探索器已有的滚动控件：modal 根/内部和嵌套容器按当前控件实例绑定，使用明确的双轴滚动增量；执行前验证当前作用范围、目标和滚动位置，并把指针移到已采样的目标点。页面根滚动使用 `source: scroll-traversal`，明确绑定 document、容器实例、当前位置、尺寸和范围。活动弹层期间，背景滚动候选被阻止。不会为同一容器再生成第二套滚动动作。

每步移动容器尺寸的 75%，可正向、反向并到达端点；与其他探索动作共用预算、队列和前后快照。滚动位置进入状态和遍历去重，旧位置上尚未执行的滚动候选会被淘汰。它属于正常探索，不会为检查恢复原位置，也不自动重放。滚动监听器、懒加载等副作用仍可能发生。

`scrollContainers` 补充观测目录最多扫描 5000 个元素、保留 128 个可到达容器；超限或不支持的书写方向会记录缺口。该目录用于根滚动和证据比较，元素滚动候选继续使用探索器的控件发现与预算。iframe、Shadow DOM 和任意自定义滚动实现不保证覆盖；可到达性是有限采样，不声称穷尽所有滚动位置。

`tests/observed-occlusion.test.ts` 验证实际 modal/嵌套/横向探索滚动、被动警告修订、显式要求下升级、历史读取不发起动作、DOM 重建/绑定变化/懒加载/移出视口/弹层关闭/缺证的保守处理、身份和过期容器保护。

## 裁剪规则 clipped-control

`clipped-control@1.0.0` 是第二类控件规则，检查控件 border box 与祖先矩形裁剪区域的关系。它与遮盖规则独立：另一个元素盖住按钮不会被算作裁剪；按钮未被任何元素遮挡，也可能被祖先 `overflow` 切掉一半。

| 当前证据 | 默认结论 |
| --- | --- |
| 控件矩形完整位于已验证的裁剪区域和视口内 | pass / info，仅限矩形几何 |
| 部分或全部位于页面视口外 | unknown / info，等待普通探索观察 |
| 被 `overflow: auto/scroll` 边界裁剪 | unknown / info，正常滚动待复查 |
| 被 `overflow: hidden/clip` 边界裁剪 | unknown / warning，设计意图未确认 |
| 上一行且违反调用方明确声明的控件要求 | fail / error，限当前位置、当前要求 |
| 当前弹层之外、隐藏、禁用或没有已知操作 | not-applicable，禁用控件可显式纳入 |
| 复杂裁剪、旧版或不完整证据 | unknown，不用缺失信息证明通过 |

静态调用可加入已有 RuleRunner，与遮盖规则一起选择或独立运行：

```ts
import { RuleRunner, clippedControlRule } from '@interaction/rules';
const runner = new RuleRunner([clippedControlRule]);
const reports = await runner.run(client, inspection, [{
  ruleId: 'clipped-control', ruleVersion: '1.0.0',
  options: { tolerancePx: 1, includeDisabled: false },
}]);
```

规则目录提供 JSON Schema；配置验证为严格模式，容差限制在 0–2 CSS px。静态报告保存控件矩形、可见矩形交集、裁剪祖先 ID、各轴 overflow、面积比例及捕获引用。比例表示矩形几何交集，不是像素可见度，也不证明文字完整或按钮可操作。

如有明确产品要求，可按已确认的控件 identityId 配置：

```ts
const options = { requirements: [{
  identityId: target.identityId,
  kind: 'unclipped-by-nonscroll-container',
  reason: '提交按钮不能被非滚动容器裁掉',
  evidence: ['product-requirement:submit-button-visibility'],
}] };
```

这种要求只对当前可观察的 `hidden/clip` 裁剪产生 error。`hidden` 仍可能被程序滚动，改变布局也可能解除裁剪，因此不宣称永远无法访问。视口外或普通滚动边界仍然待复查；不会因为重复观察、滚动到底或按钮名称而升级。

### 跟随正常探索复查

```ts
import { ClippedControlTracker, toInspectionResults } from '@interaction/rules';
const tracker = new ClippedControlTracker({ rule: options, maxTracked: 500 });
// 按 inspection.sequence 顺序投递；也可在探索结束后消费历史积压。
const report = await tracker.run(client, inspection);
await client.completeInspection(sessionId, inspection.id, consumerId, toInspectionResults([report]));
```

持续报告的规则 ID 是 `observed-clipping@1.0.0`。它复用静态规则，并增加 issueId、revision、生命周期和历史捕获引用。初次普通滚动裁剪是 pending，非滚动裁剪是 suspected；配置要求被违反时是 confirmed；可比控件恢复完整矩形时是 resolved。此前已有 warning 的控件后来只部分进入滚动区域，仍保留待验证警告。

关联要求同一会话、文档、URL、业务上下文、弹层周期、逻辑身份及 DOM 实例与业务绑定。缺失、离开视口/弹层、身份歧义和节点重建进入 unverified。证据中断或实例改变后的第一次观测只建立新基线，不能直接关闭历史问题；随后仍需一份可比的完整证据。允许同一实例的布局修正恢复完整，因此不会把尺寸变化一律当作错误。

报告记录 DOM 祖先的实际双轴位置变化，不以“发生过 scroll 动作”替代位置证据，也不将同时发生的滚动和恢复当作因果证明。检查器只读保存的 Capture，不调用 observe、滚动、恢复或暂停探索，检查完成不是进一步探索的前置条件。有限租约和证据缺失仍按通用检查协议处理。

Tracker 在内存中保留有界状态；每个实例只接受一个会话的递增任务，相邻同一任务重试返回相同报告，倒序任务拒绝，超过容量明确报错且不提交部分修订。重启后需要按序重放仍可用的历史 Capture；不宣称自动恢复内存状态。运行入口见 [clipped-control-inspector.ts](../examples/clipped-control-inspector.ts)。

### v1 的几何范围

支持主文档 light DOM 中轴对齐、单片段矩形控件的双轴和嵌套 overflow 裁剪，使用 client 边界排除边框/滚动条。新快照在 layout 中增加可选 `clipping.version: 1`，保存原生 top-layer 状态和片段数，并补充相关 computed styles；旧 Capture 不修改，缺新字段时返回 unknown。

原生 modal、Popover 和 fullscreen 的 top-layer 祖先外部裁剪不计入，其自身内部裁剪仍检查。普通 role、tooltip 名称或高 z-index 不构成豁免。依据 [CSS Top Layer](https://www.w3.org/TR/css-position-4/#top-layer) 的祖先隔离关系，并通过真实 Chromium 场景验证。

固定定位可以脱离普通祖先 overflow；绝对定位遇到不能确定的包含块关系时返回 unknown，而不是直接按 DOM 父链判错。参照 [CSS overflow 与包含块](https://www.w3.org/TR/CSS2/visufx.html#overflow-clipping)。Transforms/zoom、clip-path、mask、非默认 containment、圆角裁剪、扩展 overflow-clip-margin、body overflow 传播、复杂绝对定位和多片段盒子暂不作确定判断；矩形边界的依据见 [CSS Overflow](https://www.w3.org/TR/css-overflow-3/#overflow-properties)。iframe、Shadow DOM、文字截断和像素遮挡不在本规则范围。

`tests/clipped-control.test.ts` 覆盖上述基础通过/失败/待定场景、边框、嵌套/双轴滚动、原生弹层、普通元素遮盖、被取消的滚动、身份/实例变化、历史积压与旧证据兼容。

编译后运行 `node scripts/smoke-clipped-control.mjs`，可复现真实 Chromium + HTTP 的配置要求、顶层弹窗内外裁剪、普通滚动后恢复和报告保存检查。
