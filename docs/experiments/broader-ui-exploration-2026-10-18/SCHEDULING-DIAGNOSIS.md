# 调度源码对照与运行诊断

调查版本：Crawljax `a9e14583e85569f6a7775fa6391c13cf53b3fd6d`，本地只读目录 `/Users/xietian/Experiments/crawljax-okx-20261018/upstream`。本项目真实运行分别使用原 `source.json` 所列冻结版本；下文优先级行号以 broad-7 的 `6df32a8` 为准。当前未提交试验已保存到 `.data/broader-ui/scheduling-diagnosis/uncommitted-before-source-review.patch`，没有继续真实重跑。

**结论先行：零恢复不能单独证明退化。** broad-7 所有12次实际操作都 succeeded，选择时仍有11–44个记录在案的当前/重入候选，且确实继续到了新的交易对地址。因此“仍在合理深入”有证据支持。“所有返回都执行失败”没有证据，实际根本没有 recovery.selected。另一方面，重复导航片段中的低收益探查、配额重置及绕过通用调度器的规则确实需要收敛。不能为短窗口的三条续测链强制制造往返。

## 1. 上游实际调用链

| 问题 | 固定版本代码与实际行为 |
|---|---|
| 普通模式用哪个队列？ | `CrawlTaskConsumer.java:24,63–87` 实际注入 **UnfiredFragmentCandidates**，普通状态也使用它。`UnfiredCandidateActions` 的旧队列/priority enum 不是该 consumer 的实际执行链，不能拿它的注释当当前保证。普通分支由 `UnfiredFragmentCandidates.java:376–377` 进入 FIFO。 |
| 新页面是否继续深入？ | `Crawler.java:1215–1238` 每次动作后从 **stateMachine.currentState** 取下一个动作；新状态改变 currentState，随后就消费新状态候选。不是执行一个页面动作就回首页。`inspectNewDom:1409–1418` 新状态注册后提取候选，达到配置深度时不再提取。 |
| 无变化、克隆、近似重复？ | `inspectNewState:1371–1384` DOM 不变返回 false，已取出的动作不会因此重新放回。`StateMachine.java:95–116,144–156` 克隆连接已有顶点并切换过去；`Crawler.java:1441–1446` 恢复其保留候选后继续。普通循环在 **新状态且 hasNearDuplicate** 时结束（1234–1238），克隆本身不等于停止。默认 `StateVertexImpl.java:110–120` 按 stripped DOM 相等，URL不构成状态身份；不能用“新URL”代替“新状态”。 |
| 候选如何消费/保留？ | 普通 `UnfiredFragmentCandidates.java:611–627` 从当前状态列表移除第一个；列表耗尽才移除状态。跨入新状态不清空旧列表。`addActions:298–340` 将动作绑定状态并入队；`consumeTask:413–430` 领取状态任务；`taskDone:441–457` 把尚有候选的任务重新排队。当前深度循环未结束时，单浏览器旧任务可能还未获得轮次。没有固定局部动作配额。 |
| 普通 clickOnce 是成功覆盖吗？ | 不是。默认 true（`CrawlRules.java:45`），提取时即 `markChecked`（`CandidateElementExtractor.java:364–376`），源码 TODO 明确讨论尚未等实际 fire。不能照搬为我们的成功/覆盖证据。 |
| FRAGGEN 如何选动作？ | `Crawler.java:1258–1262` 按 HybridStateVertexImpl 分派；`FragGenStateVertexFactory.java:21–31` 创建该状态并加 FragmentationPlugin。`getBestAction:94–137` 跳过 direct access / 达最大 equivalent access 的候选，优先未探索候选，再比较 influence×duplicationFactor。`FragmentManager.java:399–453` 记录直接/重复/等价访问；`781–790` influence=1−0.5×duplicate−0.25×equivalent（direct 起点为0）。不是看标签相同就算做过。 |
| FRAGGEN 何时切状态？ | `UnfiredFragmentCandidates.java:148–245` 若当前最佳候选仍未探索，继续本状态；最佳只剩 explored 时才可能询问其他状态，afterBacktrack 对该询问有特殊处理。默认 skipExploredActions=true，最终还会清空已探索候选分支（224–230）。无候选或该函数返回 null，当前 crawlThroughActionsNew 循环结束，consumer 再领任务。 |
| FRAGGEN 如何选目标？ | `FragmentManager.java:656–741` 先限制到待执行状态，偏好有未探索动作、且无已探索近似重复的状态，然后比较候选 influence−回溯 hops，可选再加 nonSelectionAdvantage。`744–778` hops 使用从 onURLSet 到目标的平均最短路再加一次URL加载成本；不是严格的真实耗时最短路。`1286–1297` 更新未选择次数。默认 applyNonSelAdvantage=false、skipExploredActions=true、maxRepeat=2（`CrawlRules.java:52–62`）；FragGen factory 不自动开启等待加分。这里没有可证明的固定等待上界，持续新状态仍可延后旧状态。 |
| 恢复目标与路径？ | consumer 先选待办状态，`Crawler.execute:378–421` 调当前状态动作循环，再 reset/reachFromHome；此版本当前任务等于当前状态的分支后没有提前 return，不能把注释解释成省略 reset。`reachFromHome:430–538` 尝试图中最短路、失败后 reset，再尝试其他 onURL 起点；`InMemoryStateFlowGraph.java:283–287` 使用 Dijkstra。失败候选移入 unreachableCache（`UnfiredFragmentCandidates:504–515`），重新遇见状态可恢复（250–277）。 |
| 必要重放与普通探索重复？ | `followOld:575–613` 和 `followNew:616–869` 沿已保存事件路径回放，不通过普通候选消费。Hybrid 为回溯事件设置另一个ID（636–638），比较实际到达状态、失效边、必要时重算更短路径（733–867）。旧 followOld 的末端 currentState 很大程度按图切换（880–898），不能当成我们所需的原始控件独立对应证明；Hybrid 也允许若干近似状态，不能据此放宽我们的严格原待办链。 |

默认 StateVertexImpl.inThreshold 固定 false、getDist 返回−1（195–213），普通默认状态并没有有效的近似距离模型；普通循环中的近似分支主要取决于自定义状态实现。默认配置是 DefaultStateVertexFactory（`CrawljaxConfiguration.java:417–418`），crawlPriority=NORMAL、delayNearDuplicateCrawling=true、maxDepth=0；选择 Hybrid 才走 FRAGGEN 分支。普通模式不是由旧 `awaitNewTaskPriority` 的 RANDOM/SHALLOW_FIRST 枚举控制。另有实现细节值得谨慎：Hybrid 的 awaitNewTask 启发式分支直接返回状态（368–404），不经过普通 consumeTask 计数路径，而 consumer 总会 taskDone；因此不能从队列名字推出严格公平或计数正确性保证。

原生 hover 边界不变：`WebDriverBackedEmbeddedBrowser.java:341–342` 明确未实现。我们带可见事件证据的 hover 是扩展能力，不是已经由 Crawljax 证明有效的探索策略。

## 2. 冻结运行逐步对照

完整动作轨迹见 [SCHEDULING-TRACE.md](SCHEDULING-TRACE.md)。重建器为 `reconstruct-scheduling.mjs`，详细源观测/动作/原始揭示ID/历史位置/候选库存/优先事件保存在 `evidence/scheduling-trace.json.gz`。仅读取已关闭 audit-copy；原结果不改写。

| 运行 | 原判据：分支 / 严格链 | recovery.selected | 关键轨迹与解释 |
|---|---:|---:|---|
| baseline-3 | 2 / 1 | 2 | 71.4s离开入口到现货，99.0s真实历史返回；重开交易菜单后140.9s执行原闪兑子目标。目的页可执行区域不足，返回条件较早成立。 |
| broad-2 | 4 / 1 | 3 | 47.3s现货→56.7s返回→86.7s原闪兑子目标；93.9s再次返回，随后现货子菜单、USDT、Crypto、ETH/BTC。第二条原始子菜单链仍未获得原目标对应，不能用新同名点击替代。 |
| broad-3 | 4 / 1 | 3 | 类似 broad-2；有目的页机会事件，但页头受缺失引用依赖阻挡，可执行目的页工作仍少。其较多返回并不证明广泛探索更完整。 |
| broad-5 | 2 / 0 | 0 | 目的页导航真正可执行。convert→trade-convert→spot→trade-convert；同URL闪兑点击与回到已访问页面均出现。按新 document 重置机会使重复页面又获一批优先权；这是可识别的重复成本，而不是恢复执行失败。 |
| broad-7 | 1 / 0 | 0 | 提示选项/关闭→交易→两种hover→现货子菜单→BTC/USDT；目的页交易→两种hover→现货子菜单→ETH/USDT。12次动作均成功，仍有未试候选。不能仅据零恢复判定不合理深入。 |

broad-7 的关键选择：

- 22.7s 原入口第一次页头机会将 localSelections 从提示窗后的2重置为0；29.4s交易、41.3s anchor hover、52.7s parent-li hover、59.6s子菜单消耗这一批。79.9s虽计数达到4，scopedDeparture 仍选择未访问 BTC/USDT，并压后一个已记录的交易重入候选（`action.priority`）。
- 83.9s新目的页再次获机会。105.6/126.7/148.2/160.8s执行交易、anchor hover、li hover、子菜单。190.2s计数再次达到4，scopedDeparture 选择未访问 ETH/USDT。两次 departure 都使 scheduledRecovery 的前置条件不成立；这解释“没有选择恢复”，不等于该策略应当在此返回。
- 四个hover的即时独立DOM库存均未新增唯一可见 href。**同一页的两个hover是不同节点**（a/link 与 li/generic），有不同 localId/绑定；不是同一操作重复两次。跨页面的 anchor targetBinding 相同，但现有采样排序键包含 URL，priorSuccessfulSamples 又是0；li缺少可移植 targetBinding，重建实例也不共享采样提示。证据支持“重复片段中的探查收益弱”，不支持按同名合并覆盖，也不足证明没有任何其他UI效果。
- 目的页上的源入口 GET 历史条目仍存在：机械位置 returnable。但是局部操作后的新观测 stable=false 且不再带此前 navigationCapture；旧 sourceReturnCondition 因此不接受位置就绪。它是**潜在切换能力缺口**，不是 broad-7 零恢复的直接已执行失败。入口刚到目的页时可返回，后续准备/局部操作消耗了原完成证明。不得继承旧动作证明，需在真正需要切换时使用新鲜位置证据。
- broad-7 的原 branchCount=1 还存在保守计数边界：ETH/USDT 独立 after DOM 的 URL 已变且新增一个市场数据href，但保留 workspace fragment；检查器要求 `resolved href === after.url`，所以该导航未计入分支。原失败结论保留；不能把“只计到1”解释成只发生了一次新地址导航。

**竞争解释的结论：** A（合理深入）对 broad-7 的新子菜单、BTC和ETH地址成立，当前候选未耗尽，短窗口无返回可以是预期。B（无效延后）在 broad-5 的已访问URL循环和同URL导航上有直接证据；broad-7 暴露跨文档重复片段采样成本，但尚不能断言这些成本足以构成旧待办饥饿。需要在有限候选耗尽/只剩已消费探查的组合场景验证是否实际切换，不能以链数反推调度错误。

历史日志没有保存每次选择的完整过滤后候选排序及全部淘汰原因。记录的 candidateCount、被压后重入、实际动作、原始揭示和历史位置可核查；附录原始库存含未获授权/未通过当时前置检查的动作，**不能把它们全称为可执行候选**。下一次诊断须记录完整决策理由后才可作更强结论。

## 3. 本项目规则冲突及最早分歧

`runtime.ts@6df32a8:1315–1323` 新 URL/context（忽略fragment仅作排序）重置局部计数；此前 `7d61d20/360bd09:1315–1320` 按 document 重置。`1440–1468` 当前分支、采样、深度、离开成本排序后生成 scopedChoice；`1492` 只有没有五种优先选择、没有重入、且无局部候选或达到配额时才调用 scheduledRecovery。`1503` 的实际顺序是：

`boundaryExit → arrivedChoice → arrivedReentry → returnedReentry → scopedChoice（含scopedDeparture）→ selectObligation`。

通用 `obligation-scheduler.ts:46–54` 的“四步后远端优先”只在最后一个分支生效。scopedDeparture 达配额后仍可直接选择新目的地；随后目的地机会重置计数。因此它不是全局公平性保证。arrived* 和 returnedReentry 原本保护已选择的原目标接续，属于必要路径工作；它们不应与普通探索重复混为一类。

`freshAction/wasTried`（`runtime.ts@6df32a8:1788–1844`附近）依据操作条件和必要入口债务，避免精确重复及无新增子目标的入口重试。它不跨URL证明两个观察是同一操作。`programOperationSamplePriority` 用包括URL的scope（有targetBinding时只去掉stableKey）降权实际成功采样，且仅影响排序。它和“每新地址获得机会”叠加后，重复页头仍能像新工作排在前面；修正点应是候选消费/排序证据，而不是把已执行直接变成已覆盖。

最早可见分歧不在“回执失败”：broad-5 漏做提示选项使第一批计数少一步；页头依赖修正又使目的页候选真实可执行，旧的立即返回路径不再适用。broad-7 修回提示选项后，入口机会显式重置计数，第二次hover仍进入第一批。后面的新地址 departure 是同一规则的延续。

## 4. 一致的实现方向（先替换试验规则，不继续叠加）

1. **账本与调度分离。** 原 itemID、首次揭示、条件、未知义务不变。轻量状态/区域 agenda 只保存可执行候选及实际采样历史，不以新URL或新document自动生成新的优先权。借鉴上游按状态保留并消费候选；不引入完整FRAGGEN图像/片段系统。
2. **单个程序选择器。** 硬约束是活动modal内部工作与退出验证；已选恢复路线/原子目标形成显式 continuation。其余普通候选统一比较当前区域、未尝试证据、已采样/无新揭示成本、合法原生操作、返回路径成本。移除彼此绕过的机会重置、scopedDeparture和固定配额例外组合。必要入口重放走 continuation，不能被普通已消费过滤器误杀。
3. **继续还是切换由候选决定。** 仍有真正未试、可执行的新区域/目的地候选时允许深入；没有可执行新候选，或仅剩有明确证据的已采样重复/无效探查时，比较有原待办的可验证恢复路线。没有待办不强制返回；无限新增有用链接不承诺每N步返回。等待成本可作同等候选的排序提示，不能冒充严格公平保证。
4. **重复/近似只影响成本。** 对完全相同的可移植 targetBinding、操作、声明上下文与区域依据可复用采样提示；不同父子节点不能仅凭标签合并。近似状态只提供排序提示，实际恢复/对应/完成仍必须逐项验证。新文档同URL不是新探索额度，也不是旧UI已恢复。
5. **新鲜返回证据。** 真正达到切换条件时，验证当前 URL/document 的连续采样和原生GET历史位置，再交给既有返回/重入/原目标对应链。它只证明当前位置可以离开，不证明旧控件已返回。已经开始的该独立能力试验保留，但不作为“必须返回”的理由。
6. **组合回归先行。** 同一轮验证目的页新工作→当前有限候选耗尽/只剩重复→实际返回原待办→必要入口重放→原始后续目标完成；同时覆盖近似状态、新文档同URL、动态背景、无效hover、必要重放。另加持续新链接场景，验证不因计数达到4就提前回退。每次选择记录候选首次发现/实际尝试/新增揭示、排序依据、选中/延后理由与返回验证状态。

当前未提交的 `retainedOtherPage` 达配额返回优先试验不应直接纳入该方案；它会把“存在旧待办”误当作“当前应切换”。它已保存但未做下一轮真实验收。最新局部组合试验仍有2项失败，不能宣布方案已验证。

## 5. 验收与成本口径

原冻结240秒/80命令、范围、严格审计和全部失败记录保持。旧“3有效分支+3严格链跨2区域”继续作为**既有复合判据**报告，不能事后改成通过；它混合了广泛探索收益与恢复触发频率。若有限窗口中持续有新内容，链数要求会偏置探索顺序，不能单独评价是否尽可能穷尽网页。

建议下一阶段分别报告：①广泛探索的独立新增内容/区域、实际重复与无新增揭示比例、停滞、预算成本和未完成义务；②在策略达到切换条件的受控有限场景及真实可触发场景中，保留原严格ID/入口/SDK对应/后续操作/持久完成证明。新旧口径并列，任何正式协议调整需明确决定后再应用，不偷偷修改当前审计器或阈值。

broad-7：215.579s、13计数命令（含启动）/12实际动作；解码约48.954s self samples。关闭后 engineDB 33,124,352 + explorerDB 9,383,936 + 引擎证据9,332,008 = 51,840,296 bytes；导出/日志24,102,618、审计副本59,496,063另列。worker峰值1,270,352KiB≈1240.6MiB，不含浏览器。没有整体存储收益结论。

已开始的性能试验仅限4条/16MiB已验证JSON文本缓存，每次返回独立JSON.parse；未改持久化格式，保留owner/digest/原始写入/外部连接/回滚/TEMP遮蔽校验。小范围64项通过；它减少重复解码的可能性仍需真实对照，不能替代上述调度诊断与闭环验证。原窄链、最终相关回归及两次完整独立验收仍未完成。
