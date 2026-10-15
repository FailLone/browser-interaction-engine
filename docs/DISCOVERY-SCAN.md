# 扫描遗漏定位与有界补采

`discoveryScan` 区分“已检查当前有限窗口”和“已经发现全部入口”。每次观察保留扫描数量、首个遗漏位置、重复记录的截断位置和当前补采窗口；补采不执行操作，也不批准候选控件、列表或页面范围。

## 上层接入

监听持久事件 `discovery.scan_requested`，暂停探索并等待在途操作完成后，读取 `discoveryScanMaterial(sessionId)`。事件发布时材料已可查询；文档、扫描范围和限制相同不重复通知。上层可暂不处理，也可以选择材料中一个 `targets[].id`，提交：

```ts
const material = await client.discoveryScanMaterial(sessionId);
const root = material.discovery!.targets.find(t => t.tag === 'html')!;
const record = await client.supplementDiscovery(sessionId, {
  observationId: material.observationId,
  targetId: root.id,
  source: 'ui-inspection-controller',
  evidence: ['当前文档 5000 号节点开始的信号尚未扫描，读取下一个有限窗口'],
  budget: { offset: 5000, elements: 1000 },
});
// 检查 record.status 和 resultObservationId，再读取新材料。
// 需要执行新发现的候选时，仍使用现有控件审阅和探索范围决定。
```

`offset` 相对于选定根节点及其后代的 DOM 前序排列，根自身为 0。材料中的首个遗漏 `index` 相对于整个文档；只有选择 html 根时两者相同。选定根必须来自当前材料，不能提交任意选择器。材料提供文档根、首个遗漏的父节点及已定位的结构截断所有者；根节点还会作为列表归属上下文读取。

SDK 提供 `discoveryScanMaterial`、`discoveryScans`、`supplementDiscovery`。HTTP 分别是 `GET /v1/sessions/:id/discovery-scan`、`GET /v1/sessions/:id/discovery-scans` 和现有 commands 接口的 `{type:'supplementDiscovery',scan:{...}}`。没有同步自动补采 hook；持久请求事件是异步接入口，不会在观察中自行提高预算或递归补采。

## 材料与上限

| 材料 / 参数 | 默认值与限制 |
| --- | --- |
| signal | 基础扫描前 5000 个元素，补采窗口与基础窗口去重合并；记录实际 scanned、omitted 和 firstOmitted |
| budget.offset / elements | 默认 0 / 1000；offset 最大 1,000,000 且必须在当前子树内；elements 为 1–5000，一次最多扫描 10000 个信号节点 |
| budget.templateNodes / templateDepth | 默认 100 / 8；允许提高至 500 / 20，仅对选定根下的记录模板生效 |
| budget.collections | 默认 300，最多 1000；限制当前合并窗口输出的结构列表数 |
| structural.omissions | template_nodes、template_depth、row_window、collections；包含 owner/row ID、选择器、limit 和 observed 下界。最多保留 100 个位置，剩余计入 omittedLocations |
| controls | 语义控件和信号候选的 discovered / collected / limit；主控件上限仍为 1500，超过时保留关键 TRUNCATED，补采不能绕过 |

信号扫描与语义选择器是不同发现路径。某节点不在信号窗口，不意味着其原生按钮或链接一定未被收集；发现了原生操作，也不意味着已识别其所属列表。部分兄弟记录未进入窗口时保留 `row_window` 缺口。

每个会话只有一个活动补采窗口。新请求替换旧窗口并记录 superseded/replacedBy；历史观察不可变，旧窗口发现过的内容不会冒充当前仍存在。上层应分批检查当前材料，不能把多个历史窗口直接合并成当前完整快照。

## 校验与历史

提交时要求最新观察，并再次现场验证文档、完整 URL 和节点拓扑。拓扑由节点实例、父节点实例和标签组成，完整数组仅用于计算摘要，不保存在观察中。节点插入、移除、替换或移动、URL 改变和新文档都会使活动窗口失效；失效后重新采集基础窗口，并要求新的明确请求。恢复旧条件不会复活旧窗口。

文本、属性或声明上下文变化本身不使这个只读采集计划失效；采集计划不承载业务判断或权限。新观察中的控件分类、操作审阅、区域/列表决定和身份继续使用各自更严格的条件校验。提交时仍通过普通前置校验，关键观察缺口不能被补采隐藏。已有活动窗口失效时，动作前置校验先要求新观察，再考虑执行。

记录持久保留 source、evidence、输入观察、预算、拓扑摘要、结果观察和 active / invalidated / superseded / failed 状态。`active` 只说明当前窗口配置生效，不保证新观察没有其他缺口。事件为 `discovery.scan_recorded`、`discovery.scan_completed`、`discovery.scan_invalidated`、`discovery.scan_superseded`、`discovery.scan_failed`。重启后历史记录可查，新浏览器文档不会继承旧计划。

报告的 `discoveryScans` 保留请求历史，`completionAudit.discovery` 保留逐次扫描材料，调试界面显示当前遗漏位置。原来的限制继续作为历史证据；只有新观察确实覆盖相应范围，当前限制才消失。

## 尚未覆盖

这项能力只扩展当前文档中的信号和重复记录扫描。不会扩展候选分类的有限子树、详细证据采集、主控件总量、iframe/Shadow DOM/Canvas 内部，也不会枚举 delegated/addEventListener 事件、主动探测、滚动加载或恢复完整业务状态。即使所有已记录扫描限制消失，`exhaustive` 仍为 false。
