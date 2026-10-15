# 调试页规则插件

## 使用

1. 按项目快速开始启动服务和测试站，创建会话时保留“生成 UI 检查任务”。
2. 打开 **UI 检查**，选中要检查的采集任务。
3. 在 **规则插件** 勾选控件遮盖、控件裁切、文字截断，点击 **运行选中规则**。
4. 查看警告、待核验、通过和不适用的逐控件结果。“检测依据”保存规则代码、目标、证据和跟踪状态。
5. 正常探索产生新采集后，选择新任务再运行。服务按序重放截至该任务的采集，因此即使第一次运行时已经滚动，也能利用先前证据复核；不会读取该任务之后的状态。

首版采用手动触发，每次可选规则，检测结果保存在当前存储中。它不自动运行、不把默认警告转为问题报告中的 error，也不执行规范或 agent 提案。规则的算法边界见 [控件检查规则](CONTROL-RULES.md)。

检测只得到历史 `CaptureReader`，没有浏览器操作能力，不主动滚动、不恢复位置、不加入探索命令队列。等待检测 HTTP 请求的只是触发检查的界面，正常探索可以继续。保存的结果绑定会话、检查任务、采集和插件版本；切换任务不会把迟到的结果显示到新任务上。

## 证据与结果

- 三个内置插件是 `observed-occlusion`、`observed-clipping`、`observed-text-truncation`，版本均为 `1.0.0`，以默认设置创建各自的历史跟踪器。
- 检查从会话首条任务重放到所选任务，保留最后任务的完整规则报告。当前每次最多重放 500 条；超过上限显式拒绝，不静默截掉基线。
- 每次运行创建独立跟踪器，避免不同会话、版本和历史选择之间污染状态。服务把报告中的 issue ID 绑定到会话、插件版本、首次采集和控件身份，使独立重放能关联同一问题。
- 同一次检测中的插件共享每条采集的一次证据读取，并分别得到副本。每个插件独立失败：失败会展示，其他插件仍可完成，缺证不会视为通过。
- 手动检查不额外注册消费者或延长证据租约。使用会话既有的保留策略；过期、释放或重启后丢失的缓存证据，会使新检测输出待核验。已保存的检测结果仍可读取。需要重启后重新检查历史时，应使用 `persistent` 证据保留模式。
- 目前为可信宿主内置插件，不是任意第三方代码的沙箱；插件应及时返回。尚未提供安装远程代码、后台自动调度或要求提案执行。

## 接口与注册

`RulePlugin`、`RulePluginInfo`、`RulePluginRunRequest`、`RulePluginRun` 由 `@interaction/rules` 导出。服务创建时可传 `createServer(engine, { rulePlugins })` 替换安装列表；空数组表示不安装规则。插件标识必须唯一，`effects` 必须为 `read-history`。服务向浏览器只暴露插件描述，插件实现运行在服务端。

```ts
import { builtinRulePlugins } from '@interaction/rules';
const app = await createServer(engine, { rulePlugins: builtinRulePlugins });

const { plugins } = await client.rulePlugins();
const run = await client.runRules(sessionId, inspectionId, {
  requestId: crypto.randomUUID(),
  plugins: plugins.map(({ id, version }) => ({ id, version })),
});
const { items } = await client.ruleRuns(sessionId, inspectionId);
```

HTTP 对应：

- `GET /v1/rule-plugins`：已安装插件与重放上限。
- `POST /v1/sessions/:sessionId/inspections/:inspectionId/rule-runs`：严格验证插件和版本后检测，保存并返回结果。
- `GET /v1/sessions/:sessionId/inspections/:inspectionId/rule-runs`：读取该任务的已保存结果，最近一次在前，不触发检查。

`requestId` 在会话内幂等；重复提交相同任务和选择，返回原结果，包括并发请求。复用同一个 ID 提交不同任务或插件选择返回冲突。缺省不接收规则自定义选项或外部要求；后续扩展应继续区分事实检查、要求提案和明确生效的约定。

## 验证

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
