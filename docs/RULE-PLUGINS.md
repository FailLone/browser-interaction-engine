# 调试页规则插件

## 使用

1. 按项目快速开始启动服务和测试站，创建会话时保留“生成 UI 检查任务”和“遍历时自动检查规则”（调试页默认开启）。
2. 点击 **DFS 探索**。每次保存采集后，已安装插件在后台按顺序处理，探索不等待规则完成。
3. 打开 **UI 检查**，从检测记录概览选择采集，查看警告、未判定、通过和不适用的逐控件结果。当前观察、历史记录和检查范围限制按规则输出分别展示；已关闭弹层的记录保留目标名称。
4. 在 **规则插件** 勾选需要的规则，点击 **自动检查使用选中规则** 可更换组合并重新处理历史；也可关闭自动检查。
5. **运行选中规则** 保留手动重放功能，只读取截至所选任务的历史，不使用未来状态。

检测结果保存在当前存储中，不把默认警告转为问题报告中的 error，也不执行规范或 agent 提案。概览按采集统计，同一问题可能多次出现，未判定和警告可能重叠；不能将数量相加当成独立缺陷总数。未判定包括当前警告、历史记录与检查能力限制，不表示都在等待后续滚动或人工处理。规则的算法边界见 [控件检查规则](CONTROL-RULES.md)。

检测只得到历史 `CaptureReader`，没有浏览器操作能力，不主动滚动、不恢复位置、不加入探索命令队列。等待检测 HTTP 请求的只是触发检查的界面，正常探索可以继续。保存的结果绑定会话、检查任务、采集和插件版本；切换任务不会把迟到的结果显示到新任务上。

## 证据与结果

- 五个内置插件是 `observed-occlusion`、`observed-clipping`、`observed-text-truncation`、`image-aspect-ratio`、`observed-text-background`，版本均为 `1.0.0`，以默认设置创建各自的历史跟踪器。图片规则检查普通 DOM 图片，不要求图片具有交互能力；详情见 [图片拉伸规则](IMAGE-ASPECT-RATIO-RULE.md)。文字颜色规则使用有界纯色模型，不是可读性或 WCAG 认证；详情见 [文字同色规则](TEXT-BACKGROUND-RULE.md)。
- 手动检查从会话首条任务重放到所选任务，保留最后任务的完整规则报告。每次最多重放 500 条；超过上限显式拒绝，不静默截掉基线。
- 自动检查每个会话、每版配置持有独立跟踪器，按序增量处理每条任务。启用时补处理历史，重启时重建跟踪状态，已有结果不覆盖、不重复写入。更改配置或关闭检查后，旧任务迟到的结果不会写入。状态中的“已处理”不表示所有规则通过，插件失败会单独显示。
- 手动重放使用独立跟踪器。服务把报告中的 issue ID 绑定到会话、插件版本、首次采集和控件身份，使独立重放能关联同一问题。
- 图片没有通用控件身份。其跟踪器使用文档、DOM 实例、当前作用范围、资源 URL、原始尺寸及加载代次建立绑定，并生成可重复重放的 issue ID。换图、重载同一 URL、重建节点或退出作用范围不会自动解除旧问题。
- 同一次检测中的插件共享每条采集的一次证据读取，并分别得到副本。每个插件独立失败：失败会展示，其他插件仍可完成，缺证不会视为通过。
- 检查不额外注册保留消费者或延长证据租约。使用会话既有的保留策略；过期、释放或重启后丢失的缓存证据，会使新检测输出待核验。已保存的检测结果仍可读取。需要重启后重新检查历史时，应使用 `persistent` 证据保留模式。
- 目前为可信宿主内置插件，不是任意第三方代码的沙箱；插件应及时返回。后台调度独立于探索队列，但仍在服务进程内，不能隔离恶意死循环或长期占用 CPU 的插件。尚未提供安装远程代码或要求提案执行。

## 接口与注册

`RulePlugin`、`RulePluginInfo`、`RulePluginRunRequest`、`RulePluginRun` 由 `@interaction/rules` 导出。服务创建时可传 `createServer(engine, { rulePlugins })` 替换安装列表；空数组表示不安装规则。插件标识必须唯一，`effects` 必须为 `read-history`。服务向浏览器只暴露插件描述，插件实现运行在服务端。

```ts
import { builtinRulePlugins } from '@interaction/rules';
const app = await createServer(engine, { rulePlugins: builtinRulePlugins });

const { plugins } = await client.rulePlugins();
await client.setRuleAutomation(sessionId, {
  enabled: true,
  plugins: plugins.map(({ id, version }) => ({ id, version })),
});
const run = await client.runRules(sessionId, inspectionId, {
  requestId: crypto.randomUUID(),
  plugins: plugins.map(({ id, version }) => ({ id, version })),
});
const { items } = await client.ruleRuns(sessionId, inspectionId);
```

HTTP 对应：

- `GET /v1/rule-plugins`：已安装插件与重放上限。
- `GET /v1/sessions/:sessionId/rule-automation`：配置、状态、已处理采集数和失败原因。
- `POST /v1/sessions/:sessionId/rule-automation`：开启、关闭或更换插件组合；相同配置幂等，失败后重新提交可重试。SDK/API 创建会话不隐式开启自动规则，需显式调用本接口。
- `GET /v1/sessions/:sessionId/rule-run-summary`：每条采集最近一次检测的计数，最多返回最近 500 条，`hasMore` 表示更早记录未显示。
- `POST /v1/sessions/:sessionId/inspections/:inspectionId/rule-runs`：严格验证插件和版本后检测，保存并返回结果。
- `GET /v1/sessions/:sessionId/inspections/:inspectionId/rule-runs`：读取该任务的已保存结果，最近一次在前，不触发检查。

`requestId` 在会话内幂等；重复提交相同任务和选择，返回原结果，包括并发请求。复用同一个 ID 提交不同任务或插件选择返回冲突。缺省不接收规则自定义选项或外部要求；后续扩展应继续区分事实检查、要求提案和明确生效的约定。

## 验证

### 原测试页随遍历检测

`http://127.0.0.1:4174/` 的原 Limit / Market 页面默认植入三处布局缺陷：提交按钮文字硬截断、Reset interface 被遮挡、Other settings 弹层里的 Done 按钮被容器裁切。访问 `/?defects=off` 可使用原来的正常布局，旧回归测试通过构建变量关闭缺陷，保持已有测试前提。

普通调试服务使用默认插件，不为这些控件注入要求。三处缺陷应产生 warning / unknown；没有明确显示或可点击约定，不能仅凭测试意图升级成 error。遍历对被遮挡按钮留下覆盖缺口，完整处理已采集证据也不意味着所有交互都可执行。

`tests/rule-automation.test.ts` 使用原测试页执行正常 DFS，断言三种缺陷与弹层范围，核验每条采集的自动结果、重启去重、慢插件不阻塞探索、关闭后迟到结果丢弃、配置校验及失败隔离。

`tests/rule-automation-ui.test.ts` 从调试界面创建会话并启动 DFS，不调用手动检测接口，核验弹层关闭后可从概览查看裁切结果，刷新后仍保留。

2026-10-15 从构建后的 `http://127.0.0.1:4173/` 调试页对原 `4174/` 页面实测：保持默认控件覆盖、无排除项，启用持久证据，点击 DFS。会话 `91ab1990-13d1-49ae-b561-563865af80dd` 执行 32 个动作，生成 34 条采集及 34 条自动检测记录，三个插件均完成，没有插件执行失败。首次采集 #6 记录遮盖与文字截断，设置弹层 #100—#118 记录 Done 裁切。19 个可操作控件中覆盖 18 个，Reset interface 被遮挡而未能点击，结束原因 `known_frontier_exhausted_with_gaps`。其他证据缺口仍保留待核验，不能声称全页通过。完整结果、覆盖报告及截图在 `work/exploration-rule-checks/`，数据在其中的 `data/`。

### 主动植入缺陷的演示

测试页 `apps/test-site/rule-defects.html` 同时包含持续遮盖、容器裁切、文字硬截断，以及正常按钮和省略号对照。“修复全部缺陷”会保留原控件实例，修复前三种缺陷。

```sh
pnpm build
pnpm demo:rule-defects
```

演示调试页默认在 `http://127.0.0.1:4185`，测试页在 `http://127.0.0.1:4186/rule-defects.html`。也可用 `RULE_FIXTURE_URL` 指定已经启动的测试站中的该页面。`RULE_DEMO_PORT` 和 `RULE_DEMO_DATA_DIR` 分别覆盖调试端口和数据目录。演示会创建专用会话，保存初始检查，执行一次正常探索滚动并再次检查，然后保持服务供查看。

选择演示会话 → **UI 检查**，可以查看并重新运行已保存的错误案例；从 **操作候选** 执行“修复全部缺陷”，再选择新采集进行检查，可以验证错误解除。

| 案例 | 首次检查 | 相关滚动后 | 修复后 |
| --- | --- | --- | --- |
| 确认测试订单按钮持续被挡 | warning | error：违反明确的采样可点击要求 | pass / resolved |
| 保存测试设置按钮被裁切 | error：违反明确的完整显示要求 | error | pass / resolved |
| 文字硬截断 | warning | warning | pass / resolved |
| 正常按钮 | pass | pass | pass |
| 省略号对照 | info / unknown | info / unknown | info / unknown |

`examples/rule-defect-plugins.ts` 由宿主显式绑定这个会话中两个控件的逻辑身份，给已有的遮盖和裁切跟踪器传入带理由、来源的 `requirements`。这不是从测试页文字自动生成要求，也没有实现项目规范或 agent 提案执行。普通服务的默认插件仍把这两类异常保留为 warning；文字规则仍不执行外部要求。

`tests/rule-defects-ui.test.ts` 从真实页面取证，验证上述分级、两个 error 的 UI 展示、正常对照、默认策略不升级、修复后同一问题 ID 的解除，以及修复后的历史错误仍可查看。规则检测不增加动作数或改变滚动位置；演示中的滚动和修复由正常探索动作完成。

`tests/rule-plugins.test.ts` 覆盖普通探索滚动后的恢复、检查前后动作数和位置、历史截止点、并发重试、插件失败隔离、会话绑定、重放上限、重启持久化与缺证。

`tests/rule-plugins-ui.test.ts` 覆盖规则选择、警告展示、空选择禁用、刷新后结果保留、不同任务间迟到结果隔离。原有外部消费者结果仍由 `tests/inspection-ui.test.ts` 验证。

### 2026-10-15 调试页实测

使用实际构建的调试页创建会话、勾选三个插件并运行，结果均已保存。测试服务端口为 4183，测试站端口为 4184，独立数据目录为 `work/rules-debug-demo/data`。摘要、各次完整结果和界面截图保存在 `work/rules-debug-demo/`。

| 测试页面 | 实际结果 |
| --- | --- |
| Limit / Market 首页 | 遮盖、裁切各 12 项通过、2 项待核验；文字 11 项通过、2 项待核验、1 项不适用。没有 error 或 warning。`Order type`、`Other settings` 的部分几何证据缺失，保留 unknown，不能宣称全页通过。 |
| `clipped-control.html` | Target 的容器裁切产生 warning；相关文字也检测到硬截断。 |
| `text-truncation.html` | 文字硬截断产生 warning；控件边界、点击采样通过。 |
| `text-truncation.html?mode=ellipsis` | 省略记录为 info / unknown，没有升级为 warning 或 error。 |
| `observed-occlusion.html?mode=modal` | 首次遮盖 warning；通过引擎执行一次正常容器滚动后，选择新采集再次检测，同一问题 ID 标记为 resolved。 |

各次规则检测未增加探索动作；modal 会话唯一的一次动作来自显式执行的正常探索滚动。相关 126 项自动化测试、类型检查、构建和编译产物冒烟检查通过。此次实测证明了插件到调试界面、历史复核和结果留存的链路；并未消除首页已记录的取证缺口。
