# 历史观察与详细证据查询

事件可以保持简约。调用方通过事件序号或明确的 observationId 查询发生当时的页面、控件和证据。本层不调用 LLM，不推断业务意图，也不向调用方暴露 Playwright 元素句柄。

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

observationDetails 返回 observation、该观察的 actions、详细 snapshot、能力清单和缺口。snapshot 包含 dom、accessibility、runtime、实际使用的采集上限及语义说明。大页面可以先读取普通 observation 中的 evidence 清单，再通过 DOM 分页或控件查询避免传输整个快照。

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

查询不重新采集、不滚动、不展开控件、不启动浏览器，不修改待办，也不会产生动作或观察。浏览器关闭以及 SQLite 重启后仍可查询。身份依据取对应观察的 occurrence；身份裁决历史按观察时间截取，不混入之后的 lastControl。

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
