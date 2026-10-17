# 恢复候选选择：统一结构与有限验证

本轮优先解决同一次候选扫描反复加载相同事实的算法结构。采用存储变更版本、SDK 选择读视图和插件选择周期三层合同；保留最终完整验证。分类查询内部的局部优化不在本轮范围内。

**状态：三层优化保留；后续离线审查发现原有筛选谓词存在误排除，已在其上修复至 `63c57e5`。初次 `551a6b9` 样本选择器 8.526 秒、来源 91 次，但其“无候选”不能视为正确性通过。诊断确认缓存没有串错，同时 72 次在场排除中 66 次缺相同条件证明。两个修复、有限复验及证据限制见[修复检查点](experiments/storage-tiering-2026-10-17/evidence/recovery-exclusion-fixes/README.md)，修复后冻结输入见[同输入报告](experiments/storage-tiering-2026-10-17/evidence/recovery-exclusion-fixes-profile/README.md)。不支持恢复成功率、第 3 项完成或穷尽结论。**

本文对应产品 `551a6b9020b919862434346d276a21fe3d1f4ac1`，父提交为 `04e6501d839977924b75214181e46fee3f858160`，工作区 `/Users/xietian/.codex/worktrees/exploration-layered-refactor/browser-interaction-engine`、分支 `codex/exploration-layered-refactor`。本轮最终源码及日志哈希见 [checkpoint.json](experiments/storage-tiering-2026-10-17/evidence/recovery-selection-epoch/checkpoint.json)，检查范围见 [检查点说明](experiments/storage-tiering-2026-10-17/evidence/recovery-selection-epoch/README.md)，真实保留材料的阶段/处理量见[唯一集成报告](experiments/storage-tiering-2026-10-17/evidence/recovery-selection-epoch-profile/README.md)；后述比较夹具修复不修改产品。旧轻量锚点产品为 `fe3cb7a70585de64c6638c6b43584bce141d969a`，不能代表本轮实现。

## 1. 已有能力与实际缺口

现有系统不是缺少恢复机制：

- SDK 已提供严格 checkpoint、目标到达和原生来源返回等不同到达合同；恢复结果、未知执行结果及覆盖证据分开记录。
- `checkpointRecoveryCandidates` 已提供有界、只读的策略候选评估。`tryable` 不授权执行，`no_known_path` 不等于不可达证明；未知结果和恢复债不能被新候选清除。
- 插件已有持久待测义务、顺序和公平性规则、route/retry 债、review fallback、当前控件在场判断；DFS 栈是路径提示，不是未完成工作的唯一来源。
- 扫描已能协作让出事件循环。取消、预算、任务 revision、当前事实变化及最终 async 返回边界已有检查。
- SDK 已有 `recoverySourceMaterial` 和只供排序使用的 `recoveryAnchorMaterial`。轻量读取保留覆写组合路径的回退，不给出身份、重放、到达或覆盖许可。
- 同步批次内已有最多 8 项历史材料缓存、来源索引和最多 8 个 checkpoint 候选评估；选中 recovery 有最终 `revalidate`。

本轮之前的缺口在于这些机制的组织方式：插件以 item 为外层反复扫描历史来源；每次 yield 都重新构建当前完整可执行性，并无条件丢弃已有来源材料、锚点和索引。输入未变时，正确性检查仍触发大量相同工作。轻量锚点减少了单次排序读取的内容，但没有改变整体访问次数。本轮对具备 SDK 选择视图资格的路径保留稳定事实，增加有界纯筛选表；不具备资格的路径仍执行原有保守刷新。

源码定位以基准提交为准，后续行号可能移动：

| 基准位置 | 改动前行为 | 本轮处理的结构问题 |
| --- | --- | --- |
| `packages/explorer-plugin/src/runtime.ts:719–739` | `resume` 每次重新读取 observation、availability、actions 并计算摘要 | 把 yield 等同于所有事实失效 |
| `runtime.ts:741–766` | 构建 pending 和 checkpoint 来源索引，随后继续遍历 | 这些派生结果也依赖事实版本；不能仅清缓存后继续旧 cursor |
| `runtime.ts:770–808` | `retained`、`anchors`、当前索引及负面候选在 yield 后全部清空 | 相同来源跨 item、跨批次重复构建 |
| `runtime.ts:847–974` | 按 item 扫描候选，执行来源可见性、对应、路线与旧债判断 | 来源事实的纯筛选可以按来源合并，最终选择顺序仍须保持 |
| `runtime.ts:834–844,1093–1107` | 当前事实与选中来源在提交调度结果前复核 | 保留此正确性边界，不用新视图代替 |
| `packages/browser/src/index.ts:124–163` | 完整来源材料含来源 actions、当前 observation 和 transition；锚点只投影必要字段 | SDK 应控制共享事实的有效期和适用资格 |

## 2. 已取得的证据及因果边界

原始材料只引用，不在此复制观察、任务或数据库。

| 检查点 | 已知事实 | 不能推出的结论 |
| --- | --- | --- |
| [轻量锚点行为检查](experiments/storage-tiering-2026-10-17/evidence/recovery-anchor-material/README.md) | 28/28 定向行为检查、根/core 类型检查通过；来源可见性、覆写回退、取消与最终验证保留 | 不证明真实页面恢复成功率或性能收益 |
| [旧基线首对记录](experiments/storage-tiering-2026-10-17/evidence/recovery-anchor-material/execution.json) | 基线 `8c5c0a1` worker 在 240 秒上限超时；候选没有启动；首次归档准备失败另行原样保留 | 没有阶段遥测，不能把整个 worker 时间算作 selector 时间；没有完整 A/B 结果 |
| [新版唯一有界检查](experiments/storage-tiering-2026-10-17/evidence/recovery-candidate-bounded/README.md) | 新版 `fe3cb7a` 也在 240 秒超时；约 1.130 秒已完成准备并进入恢复扫描；未进入候选返回、最终回调和完整结果核验 | 两个未完成样本、不同遥测条件，不支持加速比或完整选择语义等价结论 |
| [本轮首次定向检查](experiments/storage-tiering-2026-10-17/evidence/recovery-selection-epoch/behavior.log) | 55 项中 54 项通过；其中存储 17 项、SDK view 18 项全部通过，插件 20 项中 19 项通过。唯一失败是两个独立夹具随机 `taskId` 的事件比较 | 不能写成首次 55/55，也不表示真实选择链或恢复已完成 |
| [唯一夹具修复复验](experiments/storage-tiering-2026-10-17/evidence/recovery-selection-epoch/comparison-repair.log) | 事件比较仅归一化 `taskId`，并把旧路径读取次数断言收紧为精确 384；只重跑失败项，1 项通过、19 项跳过。调度、计划、旧债和其他事件字段/顺序比较保留 | 该修复不是产品修复，也不是额外完整测试轮次 |
| [本轮类型检查](experiments/storage-tiering-2026-10-17/evidence/recovery-selection-epoch/types.log) | 根/core 类型检查退出 0；先前启动命令语法错误发生在编译器运行前，修正启动方式未改产品 | 不替代编译发布或固定输入集成 |

新版原始 [worker.jsonl](experiments/storage-tiering-2026-10-17/evidence/recovery-candidate-bounded/worker.jsonl) 和派生报告显示：

- 当前 `actionAvailability` 复核完成 544 次，外层累计约 95.028 秒。
- 完整 `recoverySourceMaterial` 开始 2773 次、完成 2772 次，完成调用累计约 79.840 秒。
- 轻量 `recoveryAnchorMaterial` 完成 857 次，累计约 12.026 秒。
- 最后一次汇总已读取完整来源材料 2770 次，但只有 58 个不同来源；轻量材料涉及 35 个来源。
- 已暂缓 826 个不同 item，新增 route-unavailable 事件只有 38 条。计划行数、暂缓数和事件数都不能当作操作数或新覆盖。

这些数据与源码共同支持：重复的当前事实复核和跨 item 的材料构建是实际热点。外层耗时包含内部工作与遥测成本，不能再与内层 store 耗时相加；`get` 与 `require` 有嵌套，不能相加当物理 I/O。后台 InspectionCoordinator 的读取单列为 unattributed，不能全部归因于扫描恢复。

尚未完成的完整结果对照仍是证据缺口。分类内部某次历史解码的独立占比没有被本次数据证明，本轮不以该猜测另开局部优化。

本轮受控稳定用例中，32 个缺失操作 item 共享 12 个来源，完整来源读取从旧路径的 **384 次降至 12 次**；扩至 96 个 item、仍为 12 个来源时，新路径仍读 12 次。两种新路径规模的 availability 调用均为 2 次，即调用者输入一次、view 初始化一次；不是每个 yield 重建。该用例验证选择结果、调度、计划、旧债及有序事件保持一致（只归一化独立夹具的 `taskId`）。这证明了该类共享负面事实的算法收益，不是实际页面耗时基准，也不覆盖所有候选组合和缓存超量情况。

## 3. 统一结构

### 3.1 存储：`recordRevision` 只证明记录没有发生已知变化

已新增覆盖全部记录读取变化的 `recordRevision()` 失效信号，由具体存储提供。MemoryStore 使用实例标识及变更代数；SqliteStore 组合实例/代数、精确整数的 `total_changes`、`data_version`、main/TEMP schema version；RetainedPersistence 在绑定读取及底层版本方法未被替换时转发并隔离实例。它不是快照恢复能力，不是浏览器实时状态，不是身份或权限版本。

必须覆盖正常写入、动作/分类/审阅/session/checkpoint/未知结果与 continuation 等相关记录、跨连接修改、直接 SQL 修改、回滚和重新打开。无支持、变化来源无法覆盖、事务内稳定性不明确时，不得返回可复用证明。token 只对产生它的存储实例有效，不能跨进程、跨重启或跨存储实例沿用。

上述受控写入、事务、覆写、关闭及底层转发边界已有 17 项存储检查。SQLite 合同覆盖正常 DML/DDL；替换 SQL 函数或扩展、手工伪造 schema version、修改已打开数据库的底层文件不在该合同内，使用方须撤销版本支持。不能把一次版本比较称作跨连接原子快照。

现有 `entityChanges` 不能直接替代：基准 `packages/core/src/entity-changes.ts:4` 只跟踪 attempt、transition、observation、evidence-entry、evidence-retention；未覆盖全部选择依赖。`recordReadIsolation='detached'` 仅保证读结果不共享可变引用，也不是新鲜度证明。

以读取前后版本一致来接受一个同步读段；跨 yield 重新检查版本。不跨 yield 持有 SQLite 事务，不为保持视图而阻止写入或增加 WAL 长期保留。粗粒度失效可能因无关写入增加重启，先接受这个安全边界，不在本轮扩展精细依赖追踪器。

### 3.2 SDK：仅默认封闭读取路径可提供选择视图

SDK 已提供 `BrowserEngine.recoverySelectionView(sessionId,{observationId})`，由默认组合资格和存储版本共同决定是否返回 view；不支持时返回 `undefined`。插件不根据存在某个 token 猜测安全。接口包括：

- `current`：打开视图时取得一次完整的当前 observation、actions 和 availability，并绑定指定 session/current observation。
- `source(id)`：在读取前后验证版本，提供来源事实、actions 和必要 transition；SDK view 不缓存来源大材料，插件的完整来源缓存最多 8 项。
- `anchor(id)`：提供来源排序所需事实，不因此读取或保留整份操作材料。
- `reviewMaterial(id)`（`a77bdd6` 新增，可选）：按显式历史 observation ID 取得当前有效的审阅及操作事实。读取前后核验同一版本；只有存在旧 negative wait 时才需要，不给出恢复或执行许可。
- `assertCurrent()`：检查视图仍有效及默认组合资格仍成立。变化或无法证明时失败，不隐式换一套事实继续旧扫描。
- `close()`：永久失效，之后的读取与验证不能重新启用；成功、取消、异常都在插件 `finally` 关闭。它不擦除调用者已取得的对象，也不自行清除插件缓存。

view 仅持有初次 `current` 及读取闭包。来源、锚点、纯筛选材料的容量和生命周期由插件管理；调用者不能修改事实后继续把同一个版本当成其内容未变的证明。

默认封闭读取路径的资格必须在创建、复用和返回边界持续成立。只核对 observation/actions 这几个方法并不自动覆盖 availability 的完整依赖：后者还进入 prepared validation、分类/审阅、探索分组、未知结果、边界约束、session 策略等。覆写方法、继承扩展、hook 或外部可变策略不能被存储版本代表时，回退到原路径；读取过程中资格被撤销也必须失效。

版本稳定不能保证时间、文件证据或浏览器 live DOM 未变。预算、取消和任务状态仍由插件现查；SDK 实际执行与恢复入口仍执行原有派发前验证。视图只服务选择，不发放执行、身份、重放、到达或覆盖权限。

### 3.3 插件：一个选择周期，按来源合并纯筛选

当前实现保留原 item/candidate 循环，一个选择周期从当前事实和任务 revision 绑定开始，到本周期调度结果提交结束。它包含 pending/checkpoint 索引、循环位置、纯筛选小表和有界材料引用；尚未建立来源到 pending 的独立逆向索引。

1. 保留原 `orderedObligations`、授权/排除、pending 和 checkpoint 来源索引的语义。
2. 一个来源首次产生纯筛选拒绝后，`projectRelatedItems` 才惰性遍历整个 pending，用 evidence/作用域规则找相关 item，调用提取出的原谓词 `projectSourceItem`。不是预先建好逆向索引。结果按来源/item ID 保存 `skip/reason/stop`，全周期最多 65536 对；不保存完整 observation/actions/transition。预计算异常不会使无关 item 失败，版本未变时保留其正式候选路径再判断。
3. 锚点缓存最多 128 个来源（保守旧路径仍为 8），保留原稳定排序；超过容量可重新读取。来源预计算不能改变 item 优先级、checkpoint 顺序、page-first fallback、公平性或最后选中项。
4. 正式选择仍按原 item/candidate 顺序消费小表。命中的 skip 只复用本周期谓词的拒绝/暂缓原因；例如未知上下文仍是本来源未验证，不是确定无路。未缓存、缺材料、预计算异常或容量截断的组合均回到逐项读取和判断，不能当作 skip。部分来源表达到容量也不会删除后面的候选。`63c57e5` 修正旧谓词：当前 scope/retained 线索还需唯一对应、相同分类与非局部 UI 条件证明，才可排除该来源；等价的近期来源不再终止整个 item 的旧源回退。此修复明确改变不充分的排除语义，不能用缓存等价掩盖原谓词缺陷。
5. 进入必要的实际候选评估时，仍执行来源/当前对应、严格 checkpoint 与目标/来源合同选择、route condition、旧债、未知结果及策略检查。大材料通过 8 项有界缓存共享。
6. 稳定版本下 yield 检查取消、预算、任务 revision/status、任务调度/债对象及 SDK view 有效性，不再次计算全量 availability，不因 yield 自身清空来源/锚点/纯筛选缓存。checkpoint 策略评估另有 adapter/hook 依赖，不受 view 版本完整覆盖：仍最多 8 项，且每次 yield 清空。
7. 任何依赖变化都中止整个周期，释放视图。不能清缓存后沿用旧 pending、已跳过的候选和 cursor；下次选择从新事实重建。中止不是结案、到达失败或覆盖授予。
8. 周期结束时先验证任务、view 及原调度/债摘要，才提交本周期暂存的 scheduling、routeRetries 和有序事件；提交保持原 schedule 对象身份，使 `step` 跨 await 持有的引用仍能正确 reserve 和持久化。最终 async 返回后继续完整检查当前事实；选中 recovery/inspect 再完整重核来源、checkpoint、route/retry/unknown，然后才 reserve、记录实际尝试或派发。实际 reach/execute 继续验证，视图不会取代它们。

纯预筛选不写事件、延期或 route 债。view 路径把扫描产生的延期、路由绑定、历史失败条件保留及事件先暂存在周期内；失效/取消不发布这些负面判断。有效周期提交后仍保留原计划、未知债和操作状态，不能把选择结果当成执行或覆盖证据。保守旧路径保留原变更顺序。

custom hosts 或不合格存储整体使用原保守路径。不能先改变它们的读取顺序、调用次数和副作用，再声称只是缓存未命中。

## 4. 依赖与失效表

| 材料 | 依赖 | 稳定周期内可复用什么 | 变化后的处理 |
| --- | --- | --- | --- |
| pending / 来源关系 | 任务计划、授权/排除、alias、当前可执行性、checkpoint 清单 | ID、顺序；相关项按来源惰性遍历，小表最多 65536 对 | 结束周期并重建；旧 cursor 之前已跳过的工作也要重新纳入 |
| source / retained | 来源 observation、可变 actions、当前 observation、transition 规则 | 默认链证明下的事实及纯索引，完整材料最多 8 项 | 结束周期；历史页面不可变不代表 replayable/basis/权限不可变 |
| anchors | 来源及当前 navigation/context/gaps | 最多 128 个来源的排序材料；超量淘汰后可重读 | 失效后重新排序；不能拿旧排序拒绝候选 |
| negative review wait 材料 | 历史 observation 及最新 actions/review/surroundings、任务含义 | 材料最多 8 项；通过 view 的 reader 才跨 yield 复用 | 材料无法核验或 materialKey 改变则撤回等待；不释放 route/unknown 债 |
| 当前事实排除来源的证明 | 来源/当前完整分类、对应唯一性、非局部 UI 模式、活动 boundary | 当前标量索引与 WeakMap 来源投影；不额外强持有历史图 | legacy invalidate 重建；缺证保留候选进入后续恢复门禁 |
| routeCondition | 当前事实索引、来源、route 的成员/路径、作用域条件 | 纯映射与索引 | 不能只按 routeKey 复用；任务内 route/retry 债独立现查 |
| checkpoint 负面评估 | 当前及来源事实、actions、图、attempt、策略、旧债及 adapter/hook | 同步片段内最多 8 项；不属于 view 的跨 yield 复用证明 | 每次 yield 清空并按需重查；记录版本变化仍中止整个周期 |
| reviewFallback / 最终选中项 | 所有来源条件、到达合同、当前事实、旧债及 task 状态 | 候选标识；不是待执行许可 | 返回微任务边界后完整重核，不能绕过 local fallback 门禁 |

任务自身的调度变更不一定写入 engine 存储，因此 `recordRevision` 不能替代 task revision、取消、预算和 route debt 检查。反过来，task revision 不变也不能证明 SDK 记录没变。

## 5. 可检查的工作量边界

令 `P` 为 pending 数，`U` 为不同来源数，`E` 为来源与相关 item 的关系数，`B` 为 yield 次数，`V` 为正式候选、review wait、路线/失败端点等后续完整材料校验的读取需求，`F` 为最终必要重核读取需求。以下分项以无事实变化、单个完整周期为前提；不能把有界缓存表述为任意规模都成立的线性总耗时证明：

- 选择周期内初次完整 availability 构建为一次；最终重核单独计数。不能随着 `B` 增长再次全量构建。调用者的准备读取、实际派发及后台读取另列，不把它们混入或隐藏。
- 每个触发预筛选的来源至多建立一次小表，但实现会遍历整个 pending 并检查 evidence，关系发现成本有 `U × P` 项（另含 evidence 遍历），不是已有 `O(E)` 逆向索引。正式候选循环也仍按原顺序执行。
- 当相关投影可完整放入 65536 对、预筛选来源材料可取得且相应负面判断已缓存时，可按 `U + V + F` 核对来源加载上界。通过预筛选的真实候选、review wait、路线来源及最终重核仍可能需要独立读取，不能承诺所有页面只读 `U` 次。
- 超过 65536 对后，未缓存组合回到逐项判断；材料缺失或预计算异常也不获得负面缓存保证。此时来源重复读取可重新随 item/候选数增长，不能继续引用容量内的 `U + V + F` 上界。容量用例已验证截断后未缓存候选仍可被选中。
- 锚点至多保留 128 个来源；只有所需锚点落在容量内时才可按不同来源读取一次，超量重读另计。checkpoint assessments 不在此界内，每次 yield 后仍可能重新评估。
- 完整来源缓存至多 8 项、纯筛选至多 65536 对，不含页面正文、controls/actions 数组或完整 transition；锚点上限 128。当前材料、选中/fallback 必要引用与缓存峰值须分别审阅，不能把缓存条数冒称进程全部存活对象上界。禁止用全量返回材料总表换取表面耗时收益。
- 稳定 yield 的检查成本不随已读历史页面体积增长；变化时停止本周期，不自动无限重启。重启原因和次数须可见。
- 单次同步 SDK 调用仍无法被 cooperative yield 中途打断。上述结构减少重复次数，不承诺消除所有单次调用长尾。

区分 SDK API 调用、原始 record accessor 调用、不同来源数、同来源重复次数、预筛选关系数、`V/F/B`、失效次数及缓存峰值。唯一集成只无侵入地记录外层 host/view 调用、来源数与返回行量；内部 SQL、投影关系数和缓存实时峰值未测，不能记为零，也不为获得这些数字破坏 view 资格后冒称测量新路径。缓存容量有源码及受控检查支持。`get/require` 不合并算物理 I/O；嵌套耗时不累加为总耗时。

## 6. 必须关闭的风险

**风险一：版本证明不完整。** 现有 change feed、detached 声明、observation ID 或 actionCount 均不足以证明全部记录稳定。若任一正常相关写入、外部连接变化、回滚或重开能够保持可复用 token，不能启用新路径。

**风险二：SDK 覆盖资格不完整。** 若 view 声称默认链，却漏掉能改变结果的自定义方法、hook、外部策略或读取中途覆写，存储版本不变也会复用错误结果。资格不确定必须回退，不能为了性能数据扩大默认资格。

**风险三：改变扫描顺序或遗失负面范围。** 按来源预筛选只改变计算组织方式，不改变最终优先级和失败原因语义。变化后沿旧 cursor 继续、丢弃 unknown 组合、让 fallback 消失或直接认定空队列完成，均属于正确性失败。

**风险四：用内存换掉全部重复读取。** 8 项完整来源缓存之外的当前/候选必要引用仍须明确，不能在预筛选表、闭包、诊断或返回数组另留无界的全量页面。`close()` 使 view 失效，不等于擦除所有调用者引用；材料生命周期由插件负责。旧证据只引用，不能重复复制为新输入材料。

## 7. 六组关键反例及有限检查点

以下仍是本轮的有限合同清单。存储 17 项、SDK 18 项、插件 20 项已有上述分轮结果；这些受控检查不能替代固定输入集成，也不要求再逐组另开一套验收。本文不执行检查或不断追加相近场景。

| 组 | 关键反例 | 必须观察到的结果 |
| --- | --- | --- |
| 1 | 稳定版本、多 item 共享超过 8 个来源、跨多次 yield；小表满后的未缓存候选；成功周期的调度提交 | 与原算法在受控事实上的选择、顺序事件、延期及旧债一致；容量内读取减少，超量不漏候选；提交保留 schedule 对象身份 |
| 2 | 当前 observation ID 不变，修改 source action/replayable、分类或审阅记录；原先跳过的 checkpoint 新增合法路径 | view 失效，整个周期结束；下次重建不能漏掉旧 cursor 之前的候选 |
| 3 | 支持存储发生跨连接/直接写入、事务回滚、重新打开；不支持存储或资格撤销 | 不复用旧 token；事务内或无法证明稳定时保守回退；同值恢复不能绕过失效合同 |
| 4 | custom host、继承覆写、hook 或同 ID 投影变化，包括读取中途替换方法 | 不伪装默认封闭链；保留原组合行为及错误，不发放额外权限 |
| 5 | 扫描期间出现 unknown、边界失败、dirty/continuation 变化，或 task 内新增重试债；存在 page/review fallback | 不续用旧负面结论或许可；unknown 旧债不被消除；到达合同不降级；必要工作仍留在计划 |
| 6 | 周期内及最终 async 返回前后 stop、任务 revision、当前场景/边界或历史来源改变；最终选择可能转向 local fallback | 周期失效不提交暂存判断；返回后变化在 reserve、实际尝试记债/事件和派发前阻断；关闭 view；实际恢复和目标执行仍走原验证 |

检查点只分三步：

1. **实现及合同复核，产品已固定。** recordRevision、SDK 默认资格、view 生命周期和有界预筛选已实现并绑定 `551a6b9`；版本覆盖与 SDK 资格仍是必须持续成立的风险，不因定向通过而扩大合同。
2. **集中定向验证已完成这一检查点。** 首次 55 项为 54 通过、1 个随机 taskId 比较失败；只归一化该生成元数据后复验 1 通过、19 跳过；根/core 类型通过。保留首轮失败，不写成“一次全绿”，不机械重跑旧 28 项或追加全面套件。
3. **唯一集成已执行并停止。** 固定 `551a6b9`，使用已关闭 run12 的独占临时副本和原 task/budget/plan/cursor/债，只在内存 paused→running。选择 8.526 秒、进程 9.857 秒，view 取得/关闭各一次，原输入和完整计划/旧债不变。无候选，因此最终 revalidate 未调用，不记作通过，也不改输入制造正向候选。资源已关闭清理；没有重跑、延长或新增真实窗口。

该集成是保留事实上的完整选择调用，不是浏览器恢复的端到端成功证明。已有真实输入没有完整旧基线终态结果，因此不能虚构逐字段真实 A/B 等价；语义等价依靠受控用例。初次只证明该输入走完选择并保存完整无候选结果，没有覆盖正向最终回调；后续离线诊断已发现提前截断来源的误排除，不能再将该 null 作为筛选正确的证据。唯一报告记录选择与回调状态、任务/有序事件/旧债完整核验、工作量、阶段耗时与序列化前资源。

## 8. 完成与推翻条件

本轮结构优化检查点包括：版本与默认资格合同复核、有限反例及适用容量内工作量边界、唯一集成的完整选择结果、原始输入及源码绑定、资源关闭。初次无候选样本没有正向最终回调覆盖，且后续已发现原有谓词不充分；该缺陷及其修复证据须与缓存正确性分开。修复后回调结果以同输入报告为准，真实成功恢复与后续新覆盖仍是独立未通过的门。不能将读取次数和固定输入耗时改善写成第 3 项整体完结。

以下证据足以推翻本方案当前实现：存在未使版本失效的相关写入；custom 行为被静默绕过；稳定扫描仍随 yield 数重复全量 availability；预筛选改变顺序或漏掉新合法路径；unknown/旧债被释放；最终微任务边界绕过检查；或完整大材料超过有界数量。届时修正对应合同或组织方式，不以更大预算、扩大缓存、减少验证或清空任务队列掩盖问题。

本轮不承担分类内部优化、存储压缩格式迁移、新增恢复策略、登录态恢复、网页任意快照还原或穷尽证明。恢复成功率、新 UI 到达、新覆盖与实际重放成本仍需独立证据；本设计只处理持续探索中候选选择的重复工作及其安全边界。
