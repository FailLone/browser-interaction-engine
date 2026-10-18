# 源码对照与采用边界

上游固定 `a9e14583e85569f6a7775fa6391c13cf53b3fd6d`，本地只读目录 `/Users/xietian/Experiments/crawljax-okx-20261018/upstream`。逐字节研究索引见 `/Users/xietian/Experiments/crawljax-fraggen-layered-20261018/reports/SOURCE-MAP.md`。本次复查了以下 Java 方法；没有重新把 TypeScript 近似实现称作原始 Java oracle，也没有复制或改动上游许可。

|上游逻辑|本次产品对应|采纳与边界|
|---|---|---|
|`Fragment.java:385 getEquivalentCandidate`、`:517 getEquivalentNode`|`packages/adapter-playwright/src/component-correspondence.ts`，复用 `fragment-projection.ts`、`fragment-id-binding.ts`|采用完整局部树和相对目标坐标；宿主采集片段替代 VIPS。完整组件在同一 owner 内改变绝对 DOM 路径的浏览器测试通过。没有实现通用 APTED 编辑映射或任意跨 owner 搬移。|
|`XPathHelper.java:51/90` 局部路径与兄弟位置|完整片段中的唯一当前目标及局部引用绑定|路径用于证据和定位关联；仍检查唯一性、记录、目的地、参数、模式和可交互性。绝不以 first-match 处理重复目标。|
|`ElementResolver.java:47/105` 旧 XPath 优先、ID/文本/属性 OR 后取首个|候选数量上限4，完整 guard 和当前 SDK 核验|没有照搬 OR 与首个命中。重复同名 record、不同 href/参数、IDREF 缺失和业务属性变化的反例拒绝。|
|`Fragment.java:422`、`FragmentManager.java:276/399` 等价/重复访问传播|`packages/core/src/engine.ts:264/448` 的直接材料对及重验|不采用访问状态传播。外部 yes 只支持当前目标对应/必要重复，不能给普通 operation coverage、身份并集或传递关系授权。|
|`Crawler.java:616/1124/1141` 恢复、重新定位和实际触发后的检查|`runtime.ts:1498/1639/1763`、`operation-source-completion.ts:123`|选择原待办、保留派发前精确关联、实际执行后再核验指定回执。新 child 不随父组件对应而完成。|
|`Fragment.java:211` 结构及图像比较；`AptedUtils.java:35` 可见性标签|本次没有接入图像或 Java 原始比较器|没有截图/图像费，也没有把颜色直方图相同当业务等价。本次结论不外推到完整视觉 FRAGGEN。|

插件新增独立 `component-correspondence` 疑问契约，入口在 `packages/explorer-plugin/src/component-correspondence.ts` 与 `program-model-gap.ts`；没有借 `control-risk` 偷渡匹配。JEV 用原生 noul，保留原始值和概率；0.1/0.9 是待校准的决策带。LLM 只处理有价值的未决，最多一次。

`fragment-records.ts`、`fragment-session.ts`、`fragment-store.ts` 将问题材料和结果纳入已有共享存储，schema7；导出、导入、压缩整理保留花费、失败和否定结果。`providers.ts`、`router.ts` 负责明确超时、输出限制和传输统计。验证的额外全局收费上限由 `paid-budget.mjs` 在 HTTP 前写入共用账本实施。

实际派发和当前 locator 的检查仍在原 `packages/adapter-playwright/src/browser.ts:875/1107`。原 OKX worker 的 `execute/readDOM` 包装会触发现有“非默认实现不授予见证”的保护。本次没有放宽这一保护。`check-dispatch-instrumentation.ts` 用真实浏览器对照复现：两边都打开相同 details，但包装版本缺少见证，原 record 条件回执保持未验证；便携原生操作则可通过其原有独立证据路径，见第一份探针记录。
