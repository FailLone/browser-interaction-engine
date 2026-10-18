# 异步内容就绪与新增控件发现：独立开发线交付

产品提交：`1fde4056b7d1e05ca3b8363c622acc565f56974c`。分支 `codex/async-region-readiness`，基线 `82ba9c7f6e725656fd5b1133f19a5fdf5af0d5f6`（产品 `83c435f7e286cb463b77e949f27d25c29aea6c88`）。工作目录为 `/Users/xietian/.codex/worktrees/async-region-readiness/browser-interaction-engine`。

本次完成的是导航披露区域的有界内容采集、未知义务保留，以及真实插件发现并执行迟到子控件的本地验证。没有发起新的 OKX 运行，没有调用付费或联网模型，没有改动另一开发线、原始证据、goal 或 automation。原 OKX 严格验收仍须由整合后的冻结版本证明。

## 原始失败发生在哪里

只读来源：`/Users/xietian/.codex/worktrees/broader-ui-exploration/browser-interaction-engine/.data/broader-ui/local-effects-broad-1`。原 `fragment-audit.json` SHA256：`6625635d778d3a27b5850a7255a08b31a8aa134f71a590b97fb35965fefce532`。[诊断脚本](diagnose.mjs)先复制已关闭的数据库，再通过 SDK 读取自己的副本；[完整诊断结果](evidence/diagnosis.json.gz)保留控件、候选、尝试和时间线。

| 时间（UTC） | 保留证据 | 能得出的结论 |
| --- | --- | --- |
| 12:06:41.588–42.496 | origin `1ee5755e-8033-4bb4-8d42-b3bf2edd8ed9`；908 ms 采集；10 节点子树；可见 `aria-live="polite" role="region"` 占位内容；无 aria-busy；结果却标为 INTERACTION_STABLE | 入口控件稳定被过早用作内容采集已经足够的依据 |
| 12:06:45.074 | 再次选择入口，candidateCount=1；派发前的新鲜度检查触发新观察 | 此时没有立即再次点击入口 |
| 12:06:46.639 | observation `f81c7659-e793-4357-870e-984dac91adf5` 已有 13 个局部控件、15 个动作，局部目标仍 unready | 后续采集确实刷新了候选，不能声称发现管线永远遗漏子控件 |
| 12:06:48.290 | observation `c704e2ae-3af2-46c4-bac5-7af425041009` 同一局部库存已 ready | 就绪子控件已经存在 |
| 12:06:51.489 / 52.425 | 仍选入口，candidateCount=2，随后真的派发 | 这部分重复还涉及执行条件／已完成目标选择，不能全归因于内容等待 |
| 12:07:00.521 | 已选择 USDT，candidateCount=32 | 更晚的发现和派发继续发生 |

第二个指定 origin `61c642fe-93b8-473d-8aba-97cb34f49307` 属于另一个 document，采集 5017 ms、112 个局部节点。这两次截面不能给出精确的加载完成时刻，也不能独立证明主页面报价变化必然是无关的被动漂移。Crypto 带来的链接目的地／结果树变化保留在原始证据中，不被归一化抹掉。

## 实现边界和整合点

沿用 adapter 的采集循环和现有 deadline，没有另建轮询、恢复或调度框架。

- `navigation-readiness.ts` 在已有 navigation scope 内增加 disclosure 子范围：原生 details/summary、aria-expanded、唯一 aria-controls、局部 li/listitem/treeitem 或近邻所有者。保留祖先属性、引用解析、原生表单值和完整范围 markup。缺失／歧义引用、节点／引用／字节上限仍是 unknown；超过 24 个披露入口也显式留下范围不完整记录。
- 可见 aria-busy 和未完成 progress 是 pending 信号；没有可操作子内容的 live/status 区域是“尚不能确定”，不按文案判断 loading。闭合 details 的后代使用真实可见性检测，避免把隐藏占位内容当成可见待办。
- 相关内容尚未取得时，不用入口控制属性稳定证明子内容已取得。既有循环在原观察预算内继续采样，记录信号、前后控件库存和新增 ID。普通等待仍为 50 ms，内容待定时为 100–250 ms；这是采样间隔，不是无条件的就绪睡眠。存在独立就绪操作时，相关等待最多占用现有 deadline 中的 1 秒；普通观察可直接让独立工作继续。
- 两次采样证实同文档、同 URL／边界、同入口实例和范围的 false→true 展开，可以完成“入口展开”的观察。`disclosureCapture` 绑定 before/action/root，不授予子控件完成、身份合并或重放权限；子内容仍通过 `ASYNC_CONTENT_PENDING`、局部 readiness 和既有插件 `interaction_unstable` 义务保留。
- 细节采集沿用同一 deadline，细节中的新增异步信号也会撤销全局交互稳定。不会为了补采细节再得到一份完整超时额度。

`packages/adapter-playwright/src/index.ts` 只有一处小整合：导入 `disclosureObservationReady`，在 `actionObservationReady` 识别新的局部证明。[单文件整合补丁](index-integration.patch)仅供解决另一开发线同位置冲突，不能脱离其他 adapter 改动单独安装。

完整产品提交还修改 `browser.ts`、`capture-readiness.ts`、`navigation-readiness.ts`、`types.ts`，新增独立测试站点文件和测试／计量脚本。没有修改 core 的 `engine.ts`／`ports.ts`、插件的 `runtime.ts`／`fragment-session.ts`、身份／操作对应关系、效果分类、输入采样、模型路由或存储架构。

## 同预算的真实插件前后对照

两边均运行 `ExplorerPlugin → SDK → Playwright → 测试站点`，无模型。每个场景独立浏览器和 HTTP 服务，60 秒／40 次计量上限；两次操作预算、同一 HTML、同一脚本、同一计量器。入口调用、每次 DOM 读取、history 读取、原生执行和采样等待均计数；每次 capture 预留 screenshot 和 document verification 两项。原生动作的 locator／actionability 是一个复合原生执行。超预算时在调用原方法前拒绝，不通过扩大预算取得结果。

基线使用本地 `git archive 82ba9c7` 副本和独立依赖。唯一产品文件上的计量改动是把原有 50 ms sleep 包成可计数方法，时长和行为不变：[补丁](baseline-meter-only.patch)、[版本／计量清单](evidence/comparison-manifest.json.gz)。测试驱动退出码只表示脚本正常导出；成功判据使用 SDK 回执、站点事件、预算拒绝数和保留义务。

| 场景 | 旧版命令／等待／耗时 | 新版命令／等待／耗时 | 实际结果 |
| --- | --- | --- | --- |
| 延迟 aria-busy 子链接 | 40 / 0 / 835 ms | 38 / 1 / 895 ms | 旧版入口后的观察只有入口；之后发现链接，但子操作后采集被预算拒绝，回执 unknown。新版入口后的观察已经含新链接，入口和链接均 succeeded |
| 仅 aria-live 占位 | 40 / 0 / 830 ms | 38 / 1 / 829 ms | 同上，新增控件记录保留 live-placeholder 信号 |
| 已有子控件执行后再添子项 | 40 / 0 / 811 ms | 38 / 1 / 903 ms | 新版已有子控件与新链接均 succeeded；旧控件仍在 DOM 中但已 disabled，不重复执行 |
| 永久 pending + 独立链接 | 29 / 0 / 729 ms | 34 / 3 / 946 ms | 两版均执行入口和独立链接；新版额外保留内容 unknown、入口 unready 和 required/unresolved 的 interaction_unstable 义务 |

新版四个场景都无预算拒绝；旧版前三个各有 3 次调用在预算边界被拒绝。前三个新版均只有一次入口／已有子项派发、一次迟到链接派发，有独立页面 link 事件和服务端 destination 请求。外部报价计时器一直变化，child-added 事件的 ticks 大于零。永久 pending 的相关等待为 224 ms，在既定 240 ms 观察窗口内结束；不会把没有看到子项解释为空或穷尽。

这是回执完整性和采集时机改善，不是总体吞吐或提速结论。新旧已完成 capture 数前三项均为 5（旧版另有被拒绝的采集），耗时没有一致降低。mixed 只证明“旧项保留且 disabled”的具体情形；仍 enabled 的已完成目标在新条件下是否该重测，属于另一开发线。四个测试任务本身仍保留范围／未知义务，没有宣称整个站点覆盖完成。

原始结果：[比较汇总](evidence/comparison.json.gz)及 `evidence/{before,after}-{delayed,live,mixed,never}.json.gz`，包含完整观察、SDK 尝试、插件事件、站点事件和账本。

## 冻结后的验证

| 检查 | 结果 |
| --- | --- |
| 新增针对性场景 | 17/17，通过；包含真实插件三种延迟、永久 pending、同 nav 内独立变化、相关 href／option／mode／record／IDREF 变化、弹层遮挡、引用缺失／歧义、采集上限和 progress |
| 相关回归六个文件 | 95/95，通过；含新增 17、navigation 11、native navigation 9、live content 33、region live content 7、discovery scans 18 |
| 类型检查 | 根目录和 core 均通过 |
| 原有 251 项回归 | 207 通过、44 失败；逐个完整测试名对比基线，新增失败 0、消失失败 0；11 个原测试文件均未修改 |
| 原本地验收，离线答复重放 | 29.783 秒、30 次真实浏览器操作，41/41 有限义务，协议分支无缺失；实际进程重启并续跑 15 个原 pending item；严格原子目标回看链 1 条通过；无重复已完成条件尝试 |

原本地验收用原 `local-loop-worker.ts`／launcher 动态生成临时副本，仅把 `providersFromEnv()` 换为历史成功运行的五条答复，跨进程保存重放游标；原覆盖协议、240 秒／80 次操作预算、重启控制和 `local-loop-audit.ts` 不变。审计器 SHA256：`6f1d6cf2e56306e166c3ed87988a04ddda52fb0158fc772a7a58940bf15fe367`。五次离线答复分别是 JEV task-intent 1、JEV control-classification 2、LLM initial-plan 1、LLM classification-clarification 1；联网模型调用为 0。答复中的模型名、usage/cost 属于原记录的历史元数据，不是本轮模型调用或新费用。这证明已有语义答复下的执行／持久化兼容性，不证明新模型判断质量。

原本地实际结果、独立审计、完整覆盖账本、时间线、首次／重启任务和源文件清单已归档为 `evidence/original-local-*`。此版本没有另跑第二次 fresh-data 本地确认；不能把独立审计进程描述成第二次浏览器运行。也没有以本地结果替代 OKX 严格验收。

所有最终归档与原文件 SHA256 见 [evidence/index.json](evidence/index.json)。本地闭合 SQLite 保留在 `.data/readiness-original-local-1`，其路径／hash 也在索引中。开发过程的日志与结果保留在自己的 `.data/async-readiness-*`、`.data/readiness-focused-initial.log`、`.data/readiness-focused-3.log`，并归档为 `evidence/development-*`；其中的失败没有被改写成通过。离线答复来源 `id-binding-local-1/explorer.sqlite` 的只读 SHA256 为 `ab819ef085f35940e08acf534e10efd5ac66354af8812d130dbb021459040660`。

## Crawljax 对应与保留限制

核对的本地源码为 `/Users/xietian/Experiments/crawljax-okx-20261018/upstream`。

| 上游机制 | TS 对应 | 没有照搬的部分 |
| --- | --- | --- |
| `Crawler.java:1150,1169` fireEventAndWait 后调用 WaitConditionChecker | 原动作后 capture 内先观察相关内容，再向已有候选管线提供结果 | 不照搬固定事件 sleep |
| `WaitCondition.java:65` 顺序检验配置条件；空条件立即成功 | 根据采集到的语义信号判断 pending/unknown，沿用既有 deadline | 不声称上游自带通用异步完成检测 |
| `Crawler.java:1380,1416,1450` inspectNewDom 后提取候选；clone 另有 rediscovery | 最终完整观察含迟到控件，已有 SDK／插件候选刷新直接消费 | 不改状态身份、clone 去重或路径恢复 |

当前 collector 仍在已有 `executionBoundary.programNavigation` 模式启用，披露子范围限定于导航区域。没有可识别信号的异步 JavaScript、没有披露语义的任意区域、canvas／shadow 依赖、业务完成与未知条件组合不因此变成已知。live/status 静态说明可能被保守保留为 unknown；不能靠删除该义务换取完成。`observed` 只表示本次有信号的内容转变已取得，不证明未来不会再出现控件。整合后需验证真实页面效果，尤其是已经有 ready 子控件时仍重复选入口的问题。

## 复现

使用 Node 24.22.0 和锁定依赖。在本工作目录运行，输出目录应为新的目录：

```sh
pnpm typecheck
pnpm exec vitest run tests/async-content-readiness.test.ts tests/navigation-readiness.test.ts tests/native-navigation-capture.test.ts tests/live-content.test.ts tests/region-live-content.test.ts tests/discovery-scans.test.ts
node --import tsx --conditions=development scripts/async-readiness-fixture.ts delayed .data/readiness-new-delayed
node --import tsx --conditions=development scripts/async-readiness-fixture.ts live .data/readiness-new-live
node --import tsx --conditions=development scripts/async-readiness-fixture.ts mixed .data/readiness-new-mixed
node --import tsx --conditions=development scripts/async-readiness-fixture.ts never .data/readiness-new-never
node docs/experiments/async-region-readiness-2026-10-18/run-original-offline.mjs .data/readiness-new-original-local
```

旧版比较应在 `git archive 82ba9c7` 的独立目录安装锁定依赖，复制同一 fixture HTML、`async-readiness-fixture.ts` 和 `readiness-budget.ts`，仅应用 `baseline-meter-only.patch` 后运行相同四个命令。不要从开发线借用会指向新版 workspace 包的 node_modules。原 251 项回归的精确文件列表和逐个失败名称见 `evidence/original-251-comparison.json.gz`。
