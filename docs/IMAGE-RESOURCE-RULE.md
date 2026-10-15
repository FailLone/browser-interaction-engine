# 图片资源加载

`image-resource@1.0.0` 和 `ImageResourceTracker` 实现 ui-sentinel `UIK-R005` 中可以客观采集的资源状态部分：普通 HTML img 是否发生了绑定当前来源的原生加载失败。不把原文的替代图、头像或缩写建议当作项目要求，不自动判断替代内容是否属于正确实体。

## 测量和判断

采集器在文档脚本运行前安装被动事件监听，只记录浏览器原生 load/error。不发送请求、不调用 decode、不重试、不修改 DOM，也不等待图片。记录放在 WeakMap 中，随元素释放；source 候选最多 32 项，完整来源键最多 20,000 字符，仍受已有 Capture 总预算约束。

来源键包含 baseURI、src、srcset、sizes、crossOrigin、referrerPolicy 和 picture 中位于图片之前的 source 声明。事件只在来源键和 currentSrc 都与采集时一致时生效。脚本 dispatchEvent 产生的事件不作证据。原生事件与当前 complete、固有尺寸共同判断，HTTP 状态或 URL 扩展名不单独决定结果。

这避免两个常见误判：complete=true 也可能是无资源或失败；零固有尺寸可能是成功加载的 SVG。语义依据见 [HTML 图片状态与 complete 定义](https://html.spec.whatwg.org/multipage/embedded-content.html#dom-img-complete)。

| 情况 | 结果 | code |
| --- | --- | --- |
| 当前来源对应的原生 error，complete=true，固有宽高均为 0 | unknown / warning | IMAGE_RESOURCE_LOAD_FAILED |
| 上述失败违反宿主明确配置的要求 | fail / error | IMAGE_RESOURCE_REQUIREMENT_FAILED |
| 原生 load，或 complete=true 且已取得正的固有尺寸和 selected URL | pass / info | IMAGE_RESOURCE_AVAILABLE |
| 请求未完成或懒加载尚未开始 | unknown / info，当前状态 | IMAGE_RESOURCE_PENDING |
| 没有来源声明也没有 selected URL | not-applicable | IMAGE_SOURCE_ABSENT |
| 显式绑定要求允许此图片不可用 | not-applicable | IMAGE_UNAVAILABILITY_ALLOWED |
| 旧采集、截断、缺少元数据或事件与当前状态矛盾 | unknown / info | IMAGE_RESOURCE_EVIDENCE_MISSING / IMAGE_RESOURCE_STATE_UNCERTAIN |
| CSS 替换内容、content-visibility 跳过绘制 | unknown / info，范围受限 | IMAGE_RESOURCE_RENDERING_UNSUPPORTED |
| 隐藏、无面积、全透明或不在活动弹层内 | not-applicable | IMAGE_NOT_RENDERED / OUTSIDE_ACTIVE_SCOPE |

默认失败是已观察到的资源事实，是否违反产品要求仍是 unknown；不是等待人工确认是否真的发生了原生失败。空 alt、页面 data 属性、重复失败、遍历结束都不会自行授权 error 或免检。缺少 src 不等于业务错误。pending 没有内置超时阈值，不随观察次数升级。

## 被动复核

历史绑定会话、文档、页面上下文、活动作用范围、DOM 实例/父节点、标签及来源键和 selected URL。相同资源的重试可产生新的事件序号：后续原生 load 且当前资源可用时，输出 `IMAGE_RESOURCE_RESTORED`，保留原 issue ID。这里证明同一图片位置和来源现在能够加载，不证明服务端文件字节或实体含义未变化。

更换 URL、重建节点、更换标签、进入/退出作用范围以及事件缺证都不算原资源恢复；旧问题显示 `IMAGE_RESOURCE_NOT_RECHECKED` 历史记录，当前图片单独检查。页面成功换上替代图可以得到资源可用，但替代方案是否足够由上层判断。

此规则只读取已保存 Capture，不引发滚动、重试或点击；探索可以继续。监听从文档开始，不保证取得未连接 DOM 时发生的事件。旧浏览器会话没有新监听器时，缺少资源元数据会明确返回缺证；应新建会话获取完整证据。CSS 背景图、视频、canvas、shadow DOM 和 iframe 内图片不在首版范围。资源可用不代表实际可见、清晰、内容正确或替代方式合规。

## 显式要求及未来接口

```ts
import { RuleRunner, imageResourceRule, ImageResourceTracker } from '@interaction/rules';
const [initial] = await new RuleRunner([imageResourceRule]).run(reader, task, [
  { ruleId: 'image-resource', ruleVersion: '1.0.0' },
]);
const check = initial.checks.find(c => c.target?.nodeId === selectedNodeId);
// 宿主独立核对要求来源后，才传入显式运行配置。
const tracker = new ImageResourceTracker({ rule: { requirements: [{
  sessionId: task.sessionId, documentId: check.target.documentId, nodeId: selectedNodeId,
  resource: check.facts.resource,
  kind: 'no-image-load-error', // 或 allow-unavailable-image
  reason: '项目要求此资源不得加载失败', evidence: ['project-spec:required-image'],
}] } });
const report = await tracker.run(reader, task);
```

导出 `ImageResourceRequirementProvider`、`ImageResourceRequirementProposal` 和 `imageResourceRequirementProposalSchema`，接入统一提案 union。提案仍只有 proposed 状态，需要来源、理由和完整绑定，不能直接作为运行配置。没有规范读取、agent 调用或自动采纳提案的执行器。

## 验证入口

测试站 `/image-resource.html` 提供正常图片、损坏资源、未配置、懒加载、picture/srcset、SVG、CSS 替换、隐藏图片和弹层样例。`?mode=traversal` 保留重试、替代图和弹层路径。测试服务器上的缺失 URL 重试仍会失败；单元测试用受控响应证明相同 URL 的后续成功能解除告警，规则本身不修改服务器状态。

```sh
pnpm test tests/image-resource.test.ts tests/image-resource-integration.test.ts
pnpm typecheck
pnpm build
node scripts/smoke-image-resource.mjs
```
