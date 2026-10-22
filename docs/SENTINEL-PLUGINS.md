# UI Sentinel 规则插件

本实现按 `ui-sentinel/docs/rule-library/rule-catalog.md` 与各规则正文的文档修订 1 对照开发。23 个知识条目中，4 项复用已有测量，19 项新增独立检查器。运行接口采用本项目当前的 `CrawlPlugin → RulePlugin → RulePage`，不移植旧项目的执行器或审批 API。

**新增检查器是语义绑定后的判定能力，尚不是任意网址上的自动语义识别器。** 普通 DOM 不提供“当前请求是哪一轮”“哪些内容必须共存”“哪个 token 版本有效”等事实。宿主通过 `collect` 提供已核实的要求、对象和观察记录；没有这些信息时，检查返回 `unknown / UIK_BINDING_REQUIRED`。默认服务注册了 `sentinel`，但未配置产品专属采集器，因此不会伪造通过或缺陷。

## 对照与开发顺序

运行时 `sentinelCatalog` 给出全部 23 项的映射；`createSentinelRulePlugins()` 返回新增的 19 项，顺序为缺陷规则、体验规则各按 ID 排序。以下“实现”均指列出的范围，不表示原 Jira 问题已复现或旧规则库已经批准启用。

| 文档 ID | 运行检查 / 源文件 | 实现范围与必需输入 |
| --- | --- | --- |
| D001 | `rules`：`observed-clipping`、`observed-text-truncation` | 复用控件/文字裁切测量；必要性和替代全文路径仍需额外证据，不宣称覆盖全部非控件内容 |
| D002 | [overlap.ts](../packages/rules/src/sentinel/overlap.ts) | 绑定共存对象、排除有意浮层，结合几何与可读/可操作观察判断破坏性重叠 |
| D003 | [reachability.ts](../packages/rules/src/sentinel/reachability.ts) | 核实操作许可和支持的视口变化，消费各滚动路径的目标/视口几何及穷尽记录 |
| D004 | `rules`：`image-aspect-ratio` | 复用资源精确绑定的栅格缩放测量；源图自身变形与有效透明边界不是已交付能力 |
| D005 | `rules`：`observed-text-background` | 复用控件标签的颜色与截图检查；不扩张为任意图表图形或 WCAG 合规 |
| D006 | [transient-state.ts](../packages/rules/src/sentinel/transient-state.ts) | 同一 operation/attempt 的有序时间线，区分进行中、明确标注的旧结果、真实终态和关闭清理 |
| D007 | [selection.ts](../packages/rules/src/sentinel/selection.ts) | 可信实际选择与完整视觉线索清单；一种可识别线索存在即可，不强制下划线 |
| D008 | [chart.ts](../packages/rules/src/sentinel/chart.ts) | 可信系列映射、可达可读标识与注释锚点，排除单系列和可达替代解释 |
| D009 | [decoration.ts](../packages/rules/src/sentinel/decoration.ts) | 精确容器归属、有效圆角边界及当前捕获的实际绘制区域；不把 DOM 外框当像素 |
| D010 | `rules`：`observed-occlusion` | 复用采样点指针可达性；不重复注册，也不扩大为整个控件事件接收证明 |
| D011 | [tokens.ts](../packages/rules/src/sentinel/tokens.ts) | 校验同一解析上下文，展开别名链，对比规范化有效值；像素颜色不作为解析值 |
| R001 | [consistency.ts](../packages/rules/src/sentinel/consistency.ts)：字体 | 对照已绑定等价角色的字体样式，保留已说明的变体 |
| R002 | 同上：组件 | 比较同角色/状态/密度/平台/断点/版本中的样式；不检查源码是否使用同一个组件 |
| R003 | [alignment.ts](../packages/rules/src/sentinel/alignment.ts) | 比较声明的分组与对齐意图，排除内容自适应、光学对齐，不强制卡片同高 |
| R004 | [theme.ts](../packages/rules/src/sentinel/theme.ts) | 消费同内容不同主题的辨识性观察；保留品牌固定底色和主题资产差异 |
| R005 | [image-fallback.ts](../packages/rules/src/sentinel/image-fallback.ts) | 读取原生资源状态，审查文本身份、替代实体和布局；懒加载不当缺图 |
| R006 | [feedback.ts](../packages/rules/src/sentinel/feedback.ts) | 已激活区域的真实状态、反馈引用和上下文；不规定 spinner 或等待超时值 |
| R007 | [navigation.ts](../packages/rules/src/sentinel/navigation.ts) | 已记录的进入/离开路径、预期与实际去向及上下文；不强制返回按钮 |
| R008 | [continuity.ts](../packages/rules/src/sentinel/continuity.ts) | 有序同目标时间线，扣除滚动位移，区分内容/断点变化、有意重排和动效偏好 |
| R009 | [affordance.ts](../packages/rules/src/sentinel/affordance.ts) | 对照实际可用性与观察到的视觉暗示，保留静态标签和替代线索 |
| R010 | [focus.ts](../packages/rules/src/sentinel/focus.ts) | 消费实际键盘访问、活动元素和可见焦点证据；只有点击截图仍为 unknown |
| R011 | [scroll-cue.ts](../packages/rules/src/sentinel/scroll-cue.ts) | 在已确认阅读方向的逻辑滚动坐标中比较边缘提示和剩余内容 |
| R012 | [image-clarity.ts](../packages/rules/src/sentinel/image-clarity.ts) | 资源身份、解码像素、实际绘制尺寸、DPR 与辨识性；天然尺寸不是文件像素数 |

缺陷检查只有适用性和违反事实完整时返回 `fail`。所有 `R` 项的审查信号返回 **`unknown + warning + UIK_REVIEW_SUGGESTED`**，在调试页作为审查意见展示；健康 `pass` 只证明记录范围内的比较已完成。缺证的 `unknown + info` 默认不生成问题卡片，但保留检查摘要。

## 接入

`pnpm demo` 的插件列表可选择“UI Sentinel 语义审查”，HTTP 请求使用：

```json
{ "url": "https://example.com", "plugins": ["rules", "sentinel"] }
```

命令行使用 `CRAWL_RULES=1 CRAWL_SENTINEL=1 pnpm crawl OUT_DIR URL`。命令行的 inspection 日志分别记录四种结论数量，不把全 unknown 打印成 `ok`。

在自己的宿主中用 `sentinelPlugin({ collect })` 替换默认工厂。下面展示字体角色已由项目提供时的接法。`titleRoles` 是**项目维护的语义绑定**，不能从相似文案或全页 `h2` 自动推断所有对象等价：

```ts
import {
  bindSentinelTarget,
  sentinelPlugin,
  type RulePage,
  type SentinelBinding,
} from '@interaction/rules';

// 宿主实现：按当前捕获定位唯一对象，并核实它们属于同一文字角色和变体。
declare function titleRoles(page: Readonly<RulePage>): {
  targetNodeId: string;
  peerNodeId: string;
  specification: string;
  role: string;
  state: string;
  variant: string;
  density: string;
  platform: string;
  breakpoint: string;
  version: string;
}[];

const plugin = sentinelPlugin({
  rules: ['UIK-R001'],
  collect(page): SentinelBinding[] {
    return titleRoles(page).map(({ targetNodeId, peerNodeId, specification, ...context }) => ({
      ruleId: 'UIK-R001',
      target: bindSentinelTarget(page, targetNodeId),
      applicability: 'yes',
      source: specification,
      reason: '项目定义这两个实例属于相同文字角色和有效变体',
      evidence: [page.capture.id, specification],
      data: {
        context,
        peers: [{ target: bindSentinelTarget(page, peerNodeId), context }],
        allowedDifferences: [],
      },
    }));
  },
});
```

每个检查文件导出自己的 `*EvidenceSchema`。宿主可以提前调用 `.parse(data)`，也可以让检查器把缺失/格式错误报告为 unknown。`createSentinelRulePlugins({ rules, collect })` 返回常规 `RulePlugin[]`，可以组装进已有 `rulesPlugin`，无需新的执行引擎。

### 绑定与证据约束

- `bindSentinelTarget(page, nodeId)` 绑定 session、document、observation、capture、node，以及节点、祖先、控件与显示环境的指纹。名称或布局改变后重新绑定；过期、同 ID 多目标、缺失祖先、循环和同规则重复绑定都不选第一个继续。
- `collect(page, signal)` 每个捕获只调用一次，19 项共享不可变副本。首屏和每个滚动画面分别采集；不要把首屏的绑定原样用于滚动画面。默认 10 秒超时，可用 `collectTimeoutMs` 配置 1–120000 毫秒，结束/超时时触发取消信号。不会给回调传递浏览器或执行器。
- `applicability: 'no'` 必须有宿主确认的例外及来源；未找到对象、无法确认用途和 `collect` 返回空数组都不意味着通过。
- `source`、`reason`、`evidence` 是需要宿主核实的输入。解析 schema、页面属性或模型建议本身均不会建立产品要求。视觉模型可以提供观察，产品要求仍由宿主核实；这里没有自动审批或启用模型生成规则。
- 时序采样需要真实同对象记录。D006 还校验 operation、attempt、时间顺序和末样本与当前 capture 的时间一致。D003 的 `requiredPaths` 必须包含全部明确可用路径；抽样列表不算穷尽。D009 的 `painted` 是实际可见像素区域，不是元素外框。
- `wantsPixels(page)` 可按需申请同一捕获时刻的截图。读入后位于 `page.snapshot.pixels`；不会为所有画面无条件截图，也不让规则自行滚动或 hover。
- `RulePlugin.sweepTargets: 'dom'` 让静态图文区域也在爬虫滚动时被检查。首屏之外发现的意见附在该屏截图上，保留原有去重和异常隔离。

## 新增一个插件的步骤

1. 读文档中的触发、必要事实和正常例外；先定义证据 schema，不将业务名称或原 ticket 选择器写入规则。
2. 在 `packages/rules/src/sentinel/` 实现独立检查，使用 `defineSentinelRule`，显式区分四态。审查类使用 `review()`，它不会输出 fail。
3. 在 `sentinel/index.ts` 中按文档 ID 加入定义。宿主通过 `collect` 绑定它；插件自身只消费不可变证据。
4. 添加异常、真实健康 pass、合法例外、证据不足测试，并覆盖引用过期、名称/布局变化、歧义和跨操作错配。涉及可读性或副作用的路径要用真实浏览器夹具验证。
5. 运行定向测试、类型检查、既有规则回归和构建。更新本表中的实现范围，避免把候选知识或有限测量写成全域保证。

## 验证与边界

[sentinel.test.ts](../tests/sentinel.test.ts) 使用合成冻结捕获逐项验证 19 个检查器的四态、例外和绑定边界。它验证判定逻辑，不是原 Jira 问题的实测。

[sentinel-browser.test.ts](../tests/sentinel-browser.test.ts) 在 Chromium 中实际测量字体差异、名称和布局变化后的重新绑定、hover 导致的选中线索消失、键盘焦点，以及无交互控件的首屏外区域。页面动作全部由测试或爬虫执行。

尚未实现通用产品语义识别、任意网页图表数据绑定、设计工具 token 提取、完整连续录屏采样或真实移动浏览器工具栏模拟。相应检查器可以消费这些证据，但默认服务不会自动取得它们。4 项已有测量的完整语义扩展仍按对照表列出的范围限制处理。
