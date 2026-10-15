# 图片拉伸规则

`image-aspect-ratio@1.0.0` 实现 ui-sentinel 候选知识 `UIK-D004` 的一个有限子集：检测 HTML `img` 中栅格图像因浏览器布局和二维变换产生的非等比缩放。原始案例和候选文档不是项目要求，也不是已复现事实。

规则只读取已保存的采集，不加载图片、不下载源文件、不调用页面、不滚动、不等待加载、不调用 agent。调试页的“图片拉伸”插件使用 `ImageAspectRatioTracker` 在正常探索产生新采集时复查。

## 测量与范围

- 采集 `currentSrc`、`complete`、`naturalWidth/naturalHeight`、内容区域、加载代次和动画状态。原始尺寸是浏览器修正密度和默认方向后的 CSS 尺寸，不是直接读取文件像素数。
- 排除 padding 和 border，按 `object-fit` 计算对象尺寸。`contain`、`cover`、`none`、`scale-down` 本身不改变比例；等比裁切不算拉伸。
- 合成图片及 HTML 祖先的二维矩阵，再计算最大和最小缩放因子的比值。旋转、镜像、相互抵消的变换不误报；父元素拉伸和斜切可以检测。原生 top-layer 根之外的祖先变换不参与合成。
- 默认容差为 2%，属于可配置的测量策略，不是设计规范。`relativeTolerance` 支持 0–0.25。结果保存容差、原始尺寸、内容尺寸、对象尺寸、变换和缩放比。
- 限于当前活动弹层；隐藏和零面积图片为不适用。已加载且具有有效布局的视口外图片也能测量，不需要滚动。几何通过不证明图片当前可见、未被裁切或内容正确。
- 资源类型来自已保存响应的 Content-Type 或 data URL 媒体类型，不根据扩展名猜测。接受 PNG、JPEG、WebP、AVIF、GIF、BMP、ICO 媒体类型；不解码像素核验媒体类型或内容。

依据：[CSS Images 的 object-fit](https://www.w3.org/TR/css-images-3/#the-object-fit)、[CSS Transforms 的变换合成](https://www.w3.org/TR/css-transforms-1/#transform-rendering)。

## 结果与限制

| 情况 | verdict / severity | code |
| --- | --- | --- |
| 缩放比例符合容差 | pass / info | IMAGE_ASPECT_RATIO_PRESERVED |
| 测得非等比缩放，未明确意图 | unknown / warning | IMAGE_NON_UNIFORM_SCALING |
| 违反宿主明确的保形要求 | fail / error | IMAGE_ASPECT_RATIO_REQUIREMENT_FAILED |
| 宿主明确允许变形 | not-applicable / info | IMAGE_DISTORTION_ALLOWED |
| 图片未渲染或不在当前弹层 | not-applicable / info | IMAGE_NOT_RENDERED / OUTSIDE_ACTIVE_SCOPE |
| 未加载、加载失败、动画中或缺证 | unknown / info | IMAGE_LOADING / IMAGE_RESOURCE_UNAVAILABLE / IMAGE_MOTION_UNSETTLED / IMAGE_EVIDENCE_UNAVAILABLE |
| 不支持的绘制方式 | unknown / info，observationStatus=unsupported | IMAGE_FORMAT_UNSUPPORTED / IMAGE_RENDERING_UNSUPPORTED |

重复拉伸不会自行升级 error。缺少产品要求和缺少测量证据是不同情况；unknown 不表示必须交给人工，也不意味着等待遍历就一定可以消除。

SVG、背景图片、canvas、iframe/shadow 内部图像不在首版范围；可枚举到的 SVG img 明确报告不支持。三维变换、独立 rotate/scale、运动路径、滤镜、非 HTML 祖先坐标、跳过或碎片化布局、CSS 替换内容、自定义 image-orientation/object-view-box 同样不作通过或错误判断。没有像素分析能力，不能判断源文件已有的变形、透明画布内的有效图案边界、可读性和清晰度。

## 配置与未来接口

显式要求由可信宿主配置，精确绑定会话、文档、DOM 节点和本次已选资源。页面属性、alt 或页面宣称的批准不会成为要求。普通图片的 DOM nodeId 就是文档内的实例标识，不用控件 identityId 代替。

```ts
import { ImageAspectRatioTracker } from '@interaction/rules';

// task、capture、imageNode 来自同一条保存采集；宿主另行确认要求来源。
const image = imageNode.image;
const tracker = new ImageAspectRatioTracker({ rule: {
  relativeTolerance: 0.02,
  requirements: [{
    sessionId: task.sessionId, documentId: capture.documentId, nodeId: imageNode.id,
    resource: {
      currentSrc: image.currentSrc, naturalWidth: image.naturalWidth,
      naturalHeight: image.naturalHeight, loadEpoch: image.loadEpoch,
    },
    kind: 'preserve-aspect-ratio', // 或 allow-distortion
    reason: '项目规范要求此标识保持形状', evidence: ['project-spec:brand/logo'],
  }],
} });
const report = await tracker.run(reader, task);
```

单次调用可通过 `RuleRunner([imageAspectRatioRule])` 使用相同 options，选择目标时显式绑定 captureId/nodeId。新增通用 `DomRule` 入口使用 `targetKind: 'dom-element'`、`targetTags: ['img']`；原有 `ControlRule` 仍默认检查控件。

导出 `ImageAspectRatioRequirementProvider`、`ImageAspectRatioRequirementProposal`、`imageAspectRatioRequirementProposalSchema`，纳入 `ruleRequirementProposalSchema`。提案除公共来源、证据和目标字段外还必须提供 resource。接口仍是 status=proposed 的数据，没有模型调用、规范解析、批准器或自动执行器；不能直接作为运行配置。

## 历史身份

只在同一会话、文档、DOM 实例、页面上下文、作用范围、父节点、标签、资源 URL、原始尺寸和加载代次下比较。采集器通过被动 load/error 事件维护 loadEpoch；即使 URL 和尺寸不变，重新加载也中断旧绑定。它是浏览器加载生命周期证据，不是资源字节哈希。

同一绑定下的正常几何将问题标为 `IMAGE_ASPECT_RATIO_RESTORED`。换图、重建、关闭弹层或后续缺证会保留 `IMAGE_FINDING_NOT_RECHECKED`，observationStatus=historical，同时独立呈现当前对象的结果。首次和最近异常证据保留；历史严重程度不等于当前对象也有错误。

每个跟踪器只接收一个会话的递增任务；同一任务重试幂等。默认最多保留 500 个未解决异常，超限显式失败，不静默丢弃。只读重放不制造探索动作，不延长证据租期。

## 验证

测试站的 `/image-aspect-ratio.html` 包含压扁、父级拉伸、斜切及正常对照，按钮支持原位修复、重建和图片弹层。默认产生警告；宿主配置保形要求后可产生 error。

```sh
pnpm test tests/image-aspect-ratio.test.ts tests/image-aspect-ratio-integration.test.ts
pnpm typecheck
pnpm build
node scripts/smoke-image-aspect-ratio.mjs
```

浏览器测试覆盖 fit、内容尺寸、变换、容差、密度、缺证、要求绑定、来源边界、同 URL 重载、替换不算恢复、原位恢复、重试和次序。集成测试执行真实 DFS，自动检测普通图片和弹层图片，核验调试页展示、手动重放一致性、保存结果和规则不增加动作。
