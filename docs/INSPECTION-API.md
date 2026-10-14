# UI 检查接入（协议 V1）

此能力在 `codex/ui-inspection` 分支实现，使用现有浏览器执行器和历史证据存储，不调用模型。引擎提供检查机会、空间事实和数据缺口；业务规则、设计预期及最终 UI/UX 判断由调用方提供。

## 启用与接入

旧会话不自动启用。SDK/HTTP 创建会话时传入 `inspection: {}` 开启检查任务；调试界面的新建会话表单提供“生成 UI 检查任务”。需要异步重复查询保证的检查程序必须在创建会话时注册：

```ts
const session = await client.createSession({
  url: 'http://127.0.0.1:4174/inspection.html',
  headless: true,
  inspection: {
    profile: {
      id: 'spatial', version: 1,
      required: ['web.environment', 'web.dom', 'web.layout', 'web.styles'],
      optional: ['web.screenshot', 'web.aria', 'web.runtime'],
      onIncomplete: 'report',
    },
    consumers: [{ id: 'ui-checker', leaseMs: 60000, maxLeaseMs: 600000 }],
  },
  evidenceRetention: { mode: 'cache', ttlMs: 300000, maxBytes: 64 * 1024 ** 2, maxObservations: 100 },
});

// 初始检查已经保存。订阅从游标 0 续读，不会因为晚于 createSession 而漏掉初始任务。
for await (const event of client.events(session.id)) {
  if (event.type !== 'inspection.ready') continue;
  const { inspectionId } = event.data as { inspectionId: string };
  const { inspection, deliveries } = await client.inspection(session.id, inspectionId);
  if (deliveries.find(d => d.consumerId === 'ui-checker')?.status !== 'pending') continue;
  await client.receiveInspection(session.id, inspectionId, 'ui-checker');
  const { capture, details, availability } = await client.captureDetails(session.id, inspection.captureId);
  // 按 inspection.focus 和 baselines 查询历史数据，运行上层规则。
  // 长时间检查期间调用 renewInspection；不要把收到事件当作检查完成。
  await client.completeInspection(session.id, inspectionId, 'ui-checker', [
    { ruleId: 'my-rule', ruleVersion: '1', status: 'inconclusive', message: '此处接入自己的检查规则' },
  ]);
}
```

完整可执行的外部示例见 [external-inspector.ts](../examples/external-inspector.ts)，Popover 规则见 [popup-inspector.ts](../examples/popup-inspector.ts)。启动服务后执行 `pnpm exec tsx --conditions=development examples/external-inspector.ts <页面URL>`，在调试 UI 中操作该会话。示例规则明确要求弹层容纳在视口内、不扩大页面滚动范围；不将此预期硬编码进引擎。

## 检查时机与范围

每次启用检查的观察采集都生成新的 Capture 和 Inspection，包含初始、动作后（包括动作失败但获得操作后观察）、主动 observe、预检发现变化、导航及恢复采集。颜色/几何改变即使没有改变 UIState，仍生成新任务。当前没有后台连续监听；未采集的自主变化不会被宣称已经记录。

`inspection.ready` 表示检查记录与可获得的数据已保存，消费者租约已尝试预留，不表示数据一定完整，也不表示 UI 已通过。无法建立记录时发出 `inspection.failed`。这些事件具有 `protocolVersion: 1`；导出的 `InspectionEvent` 是名称与载荷对应的联合类型。原 observation 事件保持兼容；ready 也支持 reference/inline/hybrid 快照投影。

- 无弹层时建议检查 document；有弹层时建议检查最内层的可见弹层。
- 同次采集合并多种原因，例如 `scope_entered` 与 `after_action`。
- 关闭弹层后建议检查恢复的父范围，同时提供进入已关闭弹层之前的 `scopeEntry` 基线。它与上一次采集 `previous`、动作开始前 `actionBefore` 分开。
- 页面最初就已打开弹层时，入口基线明确为 missing。跨文档或视口改变时，基线明确 incomparable；不能当作同坐标快照比较。
- 建议范围不限制查询。页面环境、内部非控件子节点、实际 DOM 祖先与逻辑弹层父级仍可读取。Portal 的这两种关系可能不同。
- 范围或节点因采集缺口无法确认时返回 unknown；调用方不应把空根数组解释成“无需检查”。

## 可查的事实与边界

空间信息随详细 DOM 一起保存，`dom.spatialVersion = 1`；旧 schemaVersion 1 的历史详细快照仍然可读，但可能没有这个可选扩展。

| 数据 | 内容与限制 |
| --- | --- |
| 页面环境 | layout/visual viewport、视口偏移与缩放、DPR、窗口滚动、实际 document.scrollingElement 的双轴 client/scroll 尺寸与位置。浏览器缩放只通过 visual scale 与 DPR 表达，不推断独立浏览器 zoom 值 |
| 节点 | 捕获到的 element/text、属性、live properties、语义关系；包括没有操作候选的容器及文本 |
| 空间 | layout viewport CSS 像素下的 rect、client/scroll/offset、offsetParent、四边 padding/border/margin；变换后的包围矩形不是任意形状的精确覆盖区域 |
| 样式 | essential 组增加宽高/min/max、盒模型、布局、字体、颜色/背景、裁剪等；可按原 evidence.styles 开启 all。computed color 不是经过所有背景、透明和滤镜合成后的最终像素颜色 |
| 关系 | DOM 祖先、滚动及裁剪候选祖先、标签/ARIA 关系、独立逻辑 overlay 关系；关系目标可能超出采集预算，显式 not_captured |
| 命中 | 可见交集中心点的 hitSample，不能据此证明完整可见、完全遮挡或完整裁剪 |
| 图像/ARIA/运行记录 | 沿用现有不可变 artifacts；组件各有时间戳，不承诺截图与 DOM 原子一致。图片像素可按 PNG 尺寸、视口与 DPR 对齐；全页截图沿用旧可选证据接口 |

`capture.profile` 是本次使用的 required/optional 能力要求。能力声明限定主文档 light DOM；iframe/shadow 内部、文字行矩形、伪元素、完整遮挡、受控现场 probe 和中间态采集都未支持。发现 iframe/shadow 等仍保留缺口。当前提供内置版本化采集器描述，不开放任意网页脚本或自定义采集器执行接口。

支持、采集完整度、现在是否还能读取分别由 capabilities、component.status/quality、availability 表达。未知 required 能力在打开浏览器之前拒绝；未知 optional 能力记录 unsupported。运行时截断、禁用、超时或存储失败形成 incomplete。未知协议/组件版本通过 compatibility 单独报告，不作为成功验证。

默认 `onIncomplete: report` 继续流程，规则应返回 inconclusive/unsupported；`pause` 在下一次动作前阻止执行。它不等待外部规则完成，也不绕过 core 已有关键缺口、风险和操作前提阻断。当前 capture 必需数据不完整时拒绝记录 pass。上层仍须检查自身规则所需的入口基线、覆盖和可用性。

## SDK / HTTP 对照

以下路径都相对 `/v1`；`s/i/c/n` 分别为 session/inspection/capture/node ID，URL 中应编码这些 ID。

| SDK | HTTP | 作用 |
| --- | --- | --- |
| inspectionCapabilities / validateCaptureProfile | GET `/capabilities/inspection` / POST `/capabilities/inspection/validate` | 能力及配置协商 |
| listInspections(s, {after, limit}) | GET `/sessions/s/inspections` | 按持久事件序号分页，返回 nextCursor/hasMore |
| inspection(s, i) | GET `/sessions/s/inspections/i` | 不可变任务与当前各消费者状态 |
| captureDetails(s, c) | GET `/sessions/s/captures/c` | capture、兼容性、可用性及历史详细数据 |
| captureNodes(s, c, query) | GET `/sessions/s/captures/c/nodes` | 按 rootId/depth/offset/limit/fields 查子树；depthLimited 和 captureTruncated 分开 |
| nodeContext(s, c, n) | GET `/sessions/s/captures/c/nodes/n/context` | 任意捕获节点、祖先、关系目标和页面环境 |
| regionContext(s, c, key) | GET `/sessions/s/captures/c/region?key=...` | 区域和逻辑弹层关系、整页环境 |
| captureArtifact(s, c, kind) | GET `/sessions/s/captures/c/artifacts/kind` | details/screenshot/fullPageScreenshot 原始 artifact |
| receiveInspection / renewInspection / cancelInspection | POST `/sessions/s/inspections/i/receive`、`renew`、`cancel` | body 为 `{consumerId}` |
| completeInspection | POST `/sessions/s/inspections/i/complete` | body 为 `{consumerId, results}`；空 results 表示仅确认完成，报告由外部保存 |
| observe(s) | POST `/sessions/s/commands`，`{type:'observe'}` | 显式新采集，产生新记录；旧查询永不补写现场数据 |

`fields` 支持 tag/text/attributes/rect/styles/properties/relations/layout，SDK 使用数组，HTTP 使用逗号分隔；节点的 id/parentId/children/nodeType/gaps 始终保留。省略 fields 返回所有已捕获字段。offset 游标必须与同一个 capture/root/depth 配套使用。

旧 observationDetails、controlDetails、regionDetails、dom、eventContext、evidenceArtifact 均保持可用；没有 Capture 的旧观察不伪造新采集。一个节点应由 capture + documentId + nodeId 定位，identityId 仅作为另外的控件身份线索。

## 租约、容量与重启

默认异步检查不阻塞页面操作。已注册消费者在 ready 发布前分别固定当前快照和已有对照快照，有限保护仍计入原证据容量预算。关闭 scope 前暂存基线保护，避免入口基线在固定前被 TTL 清理；暂存 pin 也有过期时间，进程崩溃不会永久遗留锁定。

消费者 ID 在创建会话时声明。后接入者可按事件游标/任务游标续读，但不会追溯创建新消费者的租约。未注册消费者可以只读尚可用的证据，不能假设存在消费保护。

- 事件重放为至少一次，检查程序按 inspectionId + ruleId/ruleVersion 去重。传输游标、receive、complete 三者独立。
- complete 相同结果幂等，不同结果返回冲突；每个消费者完成只释放自己的 pin。
- renew 不能越过创建时的 maxLeaseMs。过期/容量不足/重启丢失产生明确的 expired/unavailable 或 delivery_gap，不会转换成通过。
- cancel 是调用方显式放弃交付保证，可用于确认已失效的任务；原始采集与已有 gap 事件保留。严格策略下，未确认的历史交付失效会阻止后续动作，cancel 后当前采集完整方可继续。
- cache 只保证当前进程内的数据；persistent 的实际耐久性取决于后端。启动后会核验 pending 租约引用的证据。legacy 未配置留存的会话沿用原后端保证，不获得额外容量治理。
- transient 与需要重复查询保证的注册消费者不兼容，创建前拒绝。无消费者的 transient 任务为尽力交付。
- 仅暂停动作调度不能冻结页面自主变化。租约保护历史数据，不提供现场稳定性保证。

## 后续扩展

Capture 预留 phase（settled/intermediate/timeout）、segmentId、sampleIndex、timeWindow、samplingGaps 和可选 observationId。当前生产者只生成 settled/timeout，capabilities 明确不支持 intermediate；闪烁、白屏和瞬时滚动条尚未采集。受控 probe、等待外部检查、文字行、iframe/Shadow DOM、自定义采集器和过程录制继续按 [计划](UI-INSPECTION-PLAN.md) 的 P4 与后续里程碑实施。

## 首轮验证记录

2026-10-15，Node 24.22.0 + 本地 Chromium：全量 24 个测试文件 / 114 项测试通过，类型检查和构建通过。补充动作边界后，相关 4 个测试文件 / 38 项测试也通过；调试 UI 的异步结果刷新另行通过端到端验证。构建产物 smoke 覆盖真实 Chromium、静态 UI、检查查询和完成确认。测试覆盖见 `tests/inspection.test.ts`、`tests/inspection-ui.test.ts` 和 `tests/retention.test.ts`，既有浏览器/恢复/存储/事件测试同时通过。

本地静态测试页（57 个 DOM 节点，settleMs=50）连续采集 10 次：关闭/开启检查协议的中位耗时分别为 109/111 ms；单份 details 59,532 bytes，11 份观察的逻辑证据量 803,671 bytes、去重后缓存证据量 668,381 bytes。两组均使用本分支的空间采集器，此对比只观察检查协议的附加开销，不代表空间采集相对旧版的开销；不含工作记录内存，不作为复杂页面或生产性能承诺。保留默认预算，超限明确报告。
