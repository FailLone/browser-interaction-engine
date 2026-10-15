# 文字与背景同色

`text-background@1.0.0` 和插件 `observed-text-background@1.0.0` 实现 ui-sentinel `UIK-D005` 的有限子集：控件 DOM 标签的文字填充色，是否在受支持的纯色背景模型中消失。原候选文档的业务案例和审批过程没有成为本项目的执行要求。

**这是颜色模型检查，不是像素识别、最低对比度检查或 WCAG 合规检查。** 默认白底白字产生 warning；“这段文字是必要信息”“存在等效表达”等产品判断不自动推断。明确配置的 error 只表示违反了绑定标签的颜色区分要求，不扩大为完整可读性结论。

## 测量

- 检查按钮、链接、菜单项等 DOM 标签，以及表单字段通过 label / aria-labelledby 关联的可见文字。input 值、placeholder、title、aria-label 不代替可见文字。
- 使用 `-webkit-text-fill-color` 获取实际声明的文字填充色，不只读取 color。支持捕获的 sRGB `rgb/rgba`，逐层合成透明背景直到找到不透明背景，再合成文字 alpha。
- 背景必须覆盖完整文字 Range 矩形。矩形内的安全圆角中心区域可以检查；无法证明覆盖的圆角、inline 背景、渐变和图片背景不猜测。控件自己的不透明背景可以隔开祖先渐变。
- 检查祖先效果、伪元素、动画和相交绘制层。pointer-events:none 的层仍可能影响绘制，不用点击命中结果证明背景。原生 top-layer 之外的页面内容不作为弹层内的相交绘制层。
- 默认 RGB 最大通道差为 0 时算同色，计算误差容差为 1e-7。`channelTolerance` 可配置 0–2，单位是 0–255 RGB 通道值，不是对比度标准。默认 `rgb(254,254,254)` 在白色背景上只表示颜色不同，不代表足够可读。
- 样本保存文字节点、原始前景、合成背景、合成前景、通道差和背景节点。默认不检查隐藏或禁用控件，includeDisabled 可配置。

合成公式参考 [W3C Simple alpha compositing](https://www.w3.org/TR/compositing-1/#simplealphacompositing)；背景范围参考 [CSS background-clip](https://www.w3.org/TR/css-backgrounds-3/#background-clip)。

## 结果与能力限制

| 情况 | verdict / severity | code |
| --- | --- | --- |
| 至少一段标签文字在模型中与背景同色 | unknown / warning | TEXT_BACKGROUND_MATCH |
| 违反宿主明确配置的颜色区分要求 | fail / error | TEXT_BACKGROUND_REQUIREMENT_FAILED |
| 全部可测文字的颜色不同 | pass / info | TEXT_BACKGROUND_DISTINCT |
| 明确允许此绑定标签同色 | not-applicable / info | TEXT_BACKGROUND_MATCH_ALLOWED |
| 无支持的可见标签、隐藏或非当前作用范围 | not-applicable / info | NO_DOM_LABEL / NO_RENDERED_DOM_TEXT / INACTIVE_CONTROL / OUTSIDE_ACTIVE_SCOPE |
| 缺少采集、字体/动画未稳定、没有已知不透明背景 | unknown / info | TEXT_BACKGROUND_UNAVAILABLE |
| 绘制超出纯色模型 | unknown / info，observationStatus=unsupported | TEXT_BACKGROUND_UNSUPPORTED |

阴影、描边、伪元素、混合模式、滤镜、group opacity、变换、遮罩、原生 appearance、彩色表情、宽色域颜色、强制颜色模式等不在首版的确定性测量范围。背景不能从浏览器默认白色猜测。生成内容的矩形不可得时，可能影响目标的定位伪元素会使结果保守地不支持。相交绘制检查不尝试完整重建 CSS 绘制顺序。

颜色模型不会检查每个像素、源字体内部的彩色字形、visited 链接的隐私保护颜色差异、图片内文字、图表或 CSS first-letter 等所有特殊绘制。`coverage` 明确记录此限制。实际视觉判断可由未来 agent/视觉规则补充，当前没有自动调用。

有可靠同色样本而其他片段缺证时，保留同色警告及 limitations；没有可靠异常时，不能把缺证或不支持当作通过。反复观察到同色不会自行升级 error，也不会因为遍历结束而视为已解决。

## 要求和接口

显式宿主配置以会话、文档、控件 DOM 实例和完整文字节点/内容绑定。更换文字或重建节点后旧要求不自动转移。页面属性和页面文字不能替宿主授权。

```ts
import { RuleRunner, textBackgroundRule, TextBackgroundTracker } from '@interaction/rules';

const [initial] = await new RuleRunner([textBackgroundRule]).run(reader, task, [
  { ruleId: 'text-background', ruleVersion: '1.0.0' },
]);
// 从当前报告中选择目标，并独立核对实际要求来源。
const check = initial.checks.find(c => c.target?.nodeId === selectedNodeId);
const tracker = new TextBackgroundTracker({ rule: {
  requirements: [{
    sessionId: task.sessionId, documentId: check.target.documentId, nodeId: selectedNodeId,
    label: check.facts.labelBinding,
    kind: 'distinct-solid-label-colors', // 或 allow-matching-label-colors
    reason: '项目要求该标签在纯色模型中有不同的前景和背景',
    evidence: ['project-spec:control-label-colors'],
  }],
} });
const report = await tracker.run(reader, task);
```

导出 `TextBackgroundRequirementProvider`、`TextBackgroundRequirementProposal`、`textBackgroundRequirementProposalSchema`，并接入统一的 `ruleRequirementProposalSchema`。提案需要来源、目标绑定、label、理由和证据，状态只能为 proposed。没有 provider 注册、模型调用、规范读取或接受提案的执行器；提案不能直接作为运行配置。

## 被动复核

`TextBackgroundTracker` 使用现有控件历史机制。比较同一作用范围下的控件身份、实例、文字节点和内容。原位修改颜色后可输出 `TEXT_BACKGROUND_RESTORED`；换文字、重建、关闭弹层或证据不足会保留历史记录，当前对象独立检查。

规则只读取 Capture，不产生页面操作，不要求探索等待检查完成。采集新增有界的 computed-style 和伪元素/动画事实；没有为本规则增加滚动、主题切换或截图修改。旧采集缺少 paint 元数据时明确返回证据不足。

## 验证入口

测试站 `/text-background.html` 有同色、透明文字、正常颜色、透明背景合成、填充色覆盖、关联标签、复杂绘制等对照。`?mode=traversal` 只保留遍历所需按钮，支持原位修复和进入同色文字弹层。

```sh
pnpm test tests/text-background.test.ts tests/text-background-integration.test.ts
pnpm typecheck
pnpm build
node scripts/smoke-text-background.mjs
```

测试包含测量和例外、严格要求来源/绑定、缺证、同一文字恢复、改名/重建/作用范围变化不误算恢复、真实 DFS 自动检查、调试页展示、HTTP 字段投影及历史重放不增加动作。
