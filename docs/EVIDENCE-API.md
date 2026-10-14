# 历史观察与详细证据查询

事件可以保持简约，也可以直接交付该次观察的详细快照。调用方通过事件序号或明确的 observationId 查询留存的页面、控件和证据。采集、订阅交付和留存分别配置。本层不调用 LLM，不推断业务意图，也不向调用方暴露 Playwright 元素句柄。

## 已提供的信息

| 内容 | 查询结果 |
| --- | --- |
| 页面 | URL、标题、语言、base URI、字符集、加载状态、meta 标签、焦点节点、区域及上下文 |
| 控件 | role、tag、文案、值、选中状态、原生约束、可操作性、阻塞原因、操作候选及身份依据 |
| DOM | 带实例节点 ID 的父子结构、文本节点、元素属性、原始 HTML、运行时 value/checked/validity 等属性 |
| 关系 | label、ARIA 名称/描述/控制关系、form、datalist、popover 目标、祖先及所属区域 |
| 样式与空间 | 节点矩形、常用计算样式；可配置采集全部计算样式 |
| 可访问性 | Playwright ARIA YAML 快照及自己的时间与缺口；其中的引用不是引擎控件身份 |
| 截图 | 每次观察的视口 PNG；可选整页 PNG。控件/区域提供视口截图上的矩形 |
| 运行信息 | 自本次浏览器启动开始、有界的网络请求元数据、控制台消息、页面异常和 frame 清单 |

HTML attribute 不一定等于当前状态，例如输入框修改后的值以 DOM 节点 properties.value 和 control.value 为准。name 是引擎的语义名称，label 是标签关系结果，displayedText 是原有文本摘要；更长的文本从 DOM 文本节点或控件 content 读取。JSON 内的 HTML、脚本属性和文案均为被观察的数据，不会作为程序执行。

businessIntent.status 为 unknown；表单 action/method、链接目的地址、文案、属性和业务上下文是供上层判断的事实。DOM 和 ARIA 不能证明完整事件处理器集合，也不能证明按钮必然实现某项业务操作。

## SDK

调试界面提供“详细数据”页签，显示当前或在遍历路径中选定的观察。事件列表的“原始 data”保留原载荷；旁边的“查看详细证据”读取事件关联观察，可切换操作前与操作后。面板包含控件详情、DOM/HTML、截图、ARIA、页面与运行记录、采集缺口和完整 JSON，并提供直接打开 API 的链接。界面读取同一套公共查询接口，不触发浏览器动作。

```ts
const observation = engine.observation(sessionId);
const page = await engine.observationDetails(sessionId, observation.id);
const control = await engine.controlDetails(sessionId, observation.id, controlId);
const region = await engine.regionDetails(sessionId, observation.id, regionKey);
const subtree = await engine.dom(sessionId, observation.id, {
  rootId: control.node?.id,
  depth: 4,
  limit: 200,
});
const image = await engine.evidenceArtifact(sessionId, observation.id, 'screenshot');
const context = await engine.eventContext(sessionId, sequence);
```

这些方法同时由 BrowserEngine 和 HTTP InteractionClient 提供。controlId 接受逻辑身份 ID 或本次观察的 localId；若逻辑身份对应多个出现位置，要求用 localId 消除歧义。

observationDetails 返回 observation、该观察的 actions、详细 snapshot、各证据的 availability、能力清单和缺口。snapshot 包含 dom、accessibility、runtime、实际使用的采集上限及语义说明。大页面可以先读取普通 observation 中的 evidence 清单，再通过 DOM 分页或控件查询避免传输整个快照。

DOM 查询是保存的树的投影：depthLimited 表示查询深度隐藏了后代，nextOffset 表示还有当前查询结果未返回，captureTruncated 表示原始采集本身不完整。children 和关系中的节点 ID 可以指向当前分页之外的节点；超出原始采集上限的节点不可从历史查询补造。

## HTTP

所有端点为只读 GET，路径以 /v1 开头：

| 路径 | 内容 |
| --- | --- |
| /capabilities/evidence | 已支持、可选与不支持的证据能力 |
| /sessions/:sid/observations/:oid/details | 历史观察及详细快照 |
| /sessions/:sid/observations/:oid/controls/:controlId | 控件、文案、DOM 节点、关系、祖先、能力和身份依据 |
| /sessions/:sid/observations/:oid/region?key=... | 区域、控件、动作、DOM 根节点和截图矩形 |
| /sessions/:sid/observations/:oid/dom?rootId=...&depth=4&offset=0&limit=200 | 已保存 DOM 的子树/分页 |
| /sessions/:sid/observations/:oid/artifacts/:kind | screenshot、fullPageScreenshot 或 details 的原始证据字节 |
| /sessions/:sid/events/:sequence/context | 原事件及其明确引用的历史观察、完整证据和缺口 |

ID 和区域 key 作为 URL 参数时需要编码；客户端自动编码。不能通过文件路径读取任意证据，没有远程 evaluate / 任意浏览器方法执行接口。二进制证据经注入的 EvidenceStore 读取，内存、SQLite 和其他插件使用同一契约。details 以 JSON 提供，HTML 不在 API 域下执行。

## 事件关联与历史一致性

eventContext 解析事件载荷里明确保存的 observationId、beforeId、afterId、currentObservationId、action.observationId 和 session.currentObservationId。返回每个观察 ID 和对应关系（before、after、actionSource 等），同一观察只返回一次。找不到引用时返回 EVENT_HAS_NO_OBSERVATION_REFERENCE，不会将当前观察冒充事件发生时的观察。

查询不重新采集、不滚动、不展开控件、不启动浏览器，不修改待办，也不会产生动作或观察。查询能否在关闭浏览器或重启后取得详细证据，由留存策略和存储插件共同决定；图和观察的基础记录仍可单独查询。身份依据取对应观察的 occurrence；身份裁决历史按观察时间截取，不混入之后的 lastControl。

详细 DOM 与控件在同一次页面求值中采集。截图、ARIA、网络清单有各自时间，不能宣称是跨浏览器 API 的原子快照。文档切换、采集超时及不稳定继续进入观察缺口。详细证据保存失败不会丢失基础观察。

旧观察或禁用详细采集的观察返回 DETAIL_NOT_CAPTURED / DETAIL_CAPTURE_DISABLED。需要更多信息时显式调用 observe 创建新观察，或以更大的证据预算创建会话；不能补写旧观察或声称复原了旧页面。事件 data 的现有结构兼容保留；本次没有把事件流改为完整的状态重建协议。

## 配置与范围

创建会话可传入部分配置，未指定字段使用默认值：

```ts
await client.createSession({
  url: 'http://127.0.0.1:4174/',
  evidence: {
    enabled: true,
    maxNodes: 5000,
    maxTextLength: 20000,
    maxAttributeLength: 4000,
    maxHtmlLength: 2000000,
    maxDomCharacters: 4000000,
    maxRuntimeEntries: 200,
    styles: 'essential', // none | essential | all
    accessibility: true,
    fullPageScreenshot: false,
  },
});
```

enabled: false 关闭新增的详细证据；原有视口截图与基础观察仍保留。DOM/HTML/ARIA/文本有可配置上限，截断以 gap、标志或 dropped/truncatedFields 计数暴露。更详细的采集增加观察耗时与存储量。控件、区域截图矩形为采集时视口坐标；本版不生成自动滚动后的控件截图，以免查询改变页面。

目前不提供 iframe 内部 DOM、Shadow DOM 内部、完整 JS 堆、React 等框架闭包、完整事件监听器、网络响应正文或业务意图推断。网络仅保存方法、地址、资源类型、状态、content-type、时间与失败原因，不采集 cookie/认证头、请求正文或响应正文。frame 清单提供元数据，不代表能够探索 frame 内部。

后续新增证据种类沿用此模型：在适配器中采集，绑定观察、记录来源和时间，通过插件存储，使用公共接口按 ID 查询。core 保持与 Web、Playwright、HTTP 无关。

## 事件直接交付快照

`observation.created` 是详细快照交付点。动作、差异和进度事件继续引用观察 ID；事件日志也继续保存简约引用，不重复写入 DOM 和截图。旧的 `engine.events.on('event', ...)` 保持引用通知语义。

| delivery | observation.created 的 data.evidence |
| --- | --- |
| reference | 不附加证据，使用原始引用事件 |
| inline | 详细数据、DOM/HTML、ARIA、运行记录，以及 base64 截图 |
| hybrid | 详细数据，截图提供引用和可用性；适合另行下载图片 |

```ts
import type { SnapshotEventData } from '@interaction/browser';

const subscription = engine.subscribeEvents(sessionId, async event => {
  if (event.type !== 'observation.created') return;
  const { observationId, evidence } = event.data as SnapshotEventData;
  // evidence.details.snapshot 是该次观察的数据；不是最新页面。
  // 检查 status / gaps；图片在 evidence.artifacts 中。
  console.log(observationId, evidence?.details?.snapshot?.dom?.nodes.length);
}, {
  after: 0,
  delivery: 'inline',
  maxSnapshotBytes: 8 * 1024 ** 2,
  consumerTimeoutMs: 10000,
  onGap: gap => console.error(gap.lastDelivered, gap.reason),
});
// subscription.close(); await subscription.done;
```

SDK 的 subscribeEvents 默认 inline；HTTP 和客户端事件默认 reference，保留兼容性。SDK 订阅可以在 createSession 返回后续读该会话日志。已有事件只在证据仍可用时附加详细载荷；错过临时窗口不会重新采集。

HTTP：`GET /v1/sessions/:sid/events?after=0&delivery=inline&maxSnapshotBytes=8388608`，响应 SSE。客户端：

```ts
for await (const event of client.events(sessionId, lastSequence, signal, { delivery: 'inline' })) {
  // 完成本次处理后记录 sequence；重连可能重复，按序号去重。
  console.log(event);
}
```

每个订阅按事件日志逐条拉取并等待消费者，没有无界完整快照队列。SDK 超时默认 10 秒，可配置 1–60000 ms；HTTP 等待写入背压最多 10 秒。超时/读取失败通过 onGap 或 SSE `event: gap` 报告最后成功交付序号，并关闭该订阅。HTTP 客户端抛出 `SUBSCRIPTION_GAP`，由调用方决定何时续读。超时不会取消调用方已经开始的异步副作用，调用方仍需自行去重。

maxSnapshotBytes 限制新增的 data.evidence（默认 8 MiB，上限 64 MiB），不改变原有引用事件的大小。超限先省略图片，仍超限则只交付明确的 `SNAPSHOT_DELIVERY_LIMIT`；不会静默截断 JSON。gaps 同时反映原始采集缺口、过期、存储失败与交付限制。交付中的 available 只描述已采集能力，不能代表网页信息绝对完整。

每个订阅获得独立副本。调用方已收到的快照在服务端释放后仍可继续使用或自行归档；服务端无法回收调用方的副本。重连时能续读事件序号，不保证同一完整载荷仍在缓存中。availability 是投影交付时的留存状态，页面内容和采集时间仍来自历史观察。

## 留存与容量

```ts
const session = await client.createSession({
  url: 'http://127.0.0.1:4174/',
  evidenceRetention: {
    mode: 'cache', // transient | cache | persistent
    ttlMs: 300000,
    maxBytes: 64 * 1024 ** 2,
    maxObservations: 100,
  },
});
```

| mode | 默认 TTL | 存放方式与边界 |
| --- | --- | --- |
| transient | 30 秒 | 详细证据只在内存交付窗口内保留；不允许固定基线；容量压力可提前淘汰 |
| cache | 5 分钟 | 内存缓存；时间、容量、观察数量共同限制，支持基线固定 |
| persistent | 0（不过期） | 交给注入的 EvidenceStore；能否跨进程保存取决于插件的 durability |

所有模式的默认预算均为每会话 64 MiB、100 次留存观察。TTL 从观察提交完成开始计时。cache/transient 不能设为 0。BrowserEngine 的 `retention.maxMemoryBytes` 限制所有会话共享的缓存字节，默认 128 MiB；这是证据缓存容量，**不是进程总内存上限**。

未提供 evidenceRetention 的旧会话/SDK 调用保持原有存储方式与保证，不自动淘汰；需要容量控制时显式传入策略。调试界面新建会话默认 cache。MemoryStore 即使选 persistent 也只有进程内保证，availability.durability 会报告 process；配合 SqliteStore 才可跨进程读取。任何模式都不会把详细载荷重复存进事件日志。

cache/persistent 自动保护当前观察和未结束流程的父区域基线；正在采集的观察也受到保护。停止会话后解除自动保护，显式固定仍然有效。TTL 在保护期间不清理，解除保护后若已过期可立即释放。transient 在观察提交后只遵循交付窗口，不自动保护当前观察。

容量不足时缓存按最旧的未保护观察淘汰；不静默删除受保护内容。固定内容占满预算，或持久模式预算已满时，新证据写入报告 EVIDENCE_BUDGET_EXHAUSTED，观察保留基础事实和 critical 缺口，默认探索无法继续使用这个不完整观察。清理/解除固定或增大后续会话预算后，需要显式重新观察。持久模式不会为了写新证据自动淘汰旧历史。

图、控件摘要、身份、动作意图、请求去重、事件和留存清单仍由原 Persistence 插件管理，不纳入详细证据预算。只保留短期证据不等于完全不存任何数据；全内存工作状态可选择 MemoryStore。

## 固定、释放与恢复验证

```ts
await engine.pinEvidence(sessionId, observationId, 'review-baseline');
const checkpoint = await engine.command(sessionId, {
  type: 'createCheckpoint', name: '入口', retainEvidence: true,
});
await engine.unpinEvidence(sessionId, 'review-baseline');
await engine.releaseCheckpointEvidence(sessionId, checkpoint.id);
// 没有其他保护时才可释放；不删除基础观察、图和事件。
await engine.releaseEvidence(sessionId, observationId);
console.log(await engine.evidenceStats(sessionId));
```

pinEvidence 固定整次观察的证据，以 owner 作为解除范围。普通检查点仍验证基础结构化观察，不要求所有详细 DOM/图片。retainEvidence: true 会将该次已成功采集的证据键写入检查点契约并固定；没有成功采集的证据或 transient 模式会拒绝这项保证。固定不补齐原有采集缺口，不改变 UIState 等价规则。

解除检查点固定不删除它的证据要求。如果之后证据过期、被释放、存储失败，或 cache 模式跨进程丢失，reachCheckpoint 返回 UNVERIFIED，不自动重复提交原动作。保留截图/HTML 也不能还原服务器数据；原有业务前提和五类到达结果继续适用。

新增 HTTP 路径（以 /v1 开头）：

| 方法与路径 | 请求 / 结果 |
| --- | --- |
| GET /sessions/:sid/evidence-retention | 容量、状态数量、受保护观察和 owner |
| POST /sessions/:sid/observations/:oid/evidence-retention | `{action: "pin", owner: "review"}` 或 `{action: "release"}` |
| POST /sessions/:sid/evidence-retention/unpin | `{owner: "review"}` |
| POST /sessions/:sid/checkpoints/:cid/release-evidence | 解除检查点显式固定 |

对应客户端方法为 evidenceStats、pinEvidence、unpinEvidence、releaseEvidence、releaseCheckpointEvidence；`client.checkpoint(sid, name, true)` 创建固定证据的检查点。容量统计 logicalBytes 为本会话未压缩逻辑字节；memoryBytes 为全引擎去重后的缓存字节。统计不含旧会话未管理的证据、图/事件数据库、文件系统实际占用、传输副本或浏览器内存。

历史查询 availability 区分 available、not_retained（例如缓存进程重启）、expired、evicted、released、storage_failed、missing。未采集/截断仍使用原有 capture gaps。返回值不会拿当前页面补造旧证据。已过期的二进制读取返回 EVIDENCE_UNAVAILABLE 并附 availability；图片响应使用 Cache-Control: no-store，避免把浏览器 HTTP 缓存误当成服务端留存保证。

## 持久插件与调试入口

SqliteStore 的详细文件采用内容寻址的 16 KiB 独立分块，文本块透明 gzip 压缩，共享相同内容块；PNG 不再 gzip。观察 ID、采集时间和逻辑引用仍独立保存。读取验证分块与完整文件哈希，清理只删除没有其他文件引用的块；旧原始文件继续可读。这不是 DOM 增量链，当前查询仍需重建完整快照后分页。

界面侧栏“详细证据留存”配置新会话；“事件 → 事件交付”选择完整快照后，观察事件出现“打开事件快照”。该入口直接展示已收到的数据；“查看详细证据”则查询服务端当前留存的历史证据。“详细数据 → 缓存容量与固定 / 释放”管理留存，“检查点”可显式固定证据。界面事件缓冲最多 80 条、16 MiB，已打开的一份快照另由当前面板持有；重新加载界面仍依赖服务端留存。

架构与边界见 [证据生命周期](ARCHITECTURE.md#快照交付缓存与持久留存)，DOM 增量、长期归档与更细投影留在 [Roadmap](../ROADMAP.md)。
