只读结论：可以研究一层显式、仅供成功操作覆盖对应使用的 document-bound 条件证明；不能直接放宽现有 portable 端口，也不能用“同一 WeakMap 节点”取代完整绑定证据。当前 run6 材料尚不足以宣布该新证明成立：隐藏 selector 的父级记录绑定存在实际采集缺口。产品/测试保持 d103747ee78779b3f1df8223854600cd321e36ee 冻结。

核对范围是源代码、既有 `selector-condition-diagnosis.json` 与其摘要；未运行 SDK、浏览器、provider、数据库、测试或负载。该诊断引用的七个产品文件 SHA 与当前树一致。精确数量是 c11 的 206/206 actions 不可建立 branch/target 条件；后面三帧各 214/214 不可建立，不是单帧 206/214。c11 有 26 selectors、2 pending identity、1 重复 binding；后面三帧各 28 selectors、3 instance-only。c11→f234 的 Trade expanded、成员集合与若干语义都变化，必须拒绝。f234→7d2→fd34 的完整已采集 selector 投影相同，只是候选输入，并非已有 SDK 对应证明。

当前调用链：`operationCorrespondence(s)`、`explorationTargetCorrespondences`、`repetitionAssessment` 共用 core `correspondenceReader`；其 sample 经 `operationSample` 调用 `adapter.correspondenceCase`，Playwright 实现固定 `controlCase(..., true)`。`reconcileCoverage` 也调用该端口，但有自己独立的成功样本索引。`browserBranchConditions(v2)` 包含所有已观察的 hidden、跨 form、跨 region modes，拒绝 unresolved/instance-only/nonunique portable binding、missing state、不稳定与超过 32 项。target/repetition 还比较 portable target conditions。此设计的严格拒绝目前符合已有契约，并不是应删掉 hidden modes 的实现错误。

最小 SDK 契约建议：保留 `correspondenceCase` 的 portable 含义，另加可选的 coverage-only 文档样本端口（名称可定为 `documentOperationCase`）。core 平台无关，只消费版本化 policy、opaque 条件 key、证据及作用域；浏览器适配器负责原生 document/instance 及完整 DOM 语义。仅 actual succeeded receipt 的 operation correspondence 与 reconcileCoverage 能选该模式，target/arrival/repetition/replay 从入口就不得调用。结果注明 document-bound policy，仍 identityAuthorized=false、replayAuthorized=false、currentExecution=false。没有成功 receipt，最多存在条件材料，不能给成功覆盖。

必须同时满足以下边界：

- 两端来源/动作归属正确，真实成功 attempt 有 before/after 且结果完整。session、browser session、documentId、instanceScope 均非空且一致，target 的实际 instanceId 在双方完整捕获中各唯一。相同 URL 或 resolved identity 不能替代其中任何项；新节点、重建文档、另一个浏览器均拒绝。
- URL、非空 ruleVersion、已知 declared context、操作 kind/value/risk/basis 与原 coverage gate 仍一致。未知业务 context、缺失 action basis、critical gap、目标/依赖未稳定、成员捕获不完整均拒绝。只读对应不修改身份、旧 attempt、计划或来源状态。
- 仍读取全部 observed selectors，包括 hidden/cross-form/cross-region；比较完整成员集合、唯一物理实例、selector state、语义属性、options、form/record/owner/IDREF 绑定及其完整性。不得截断到 32 项后继续，不得以 DOM 距离推断 independence。选择器的 pending logical identity 不等于其物理状态未知，但只有完整文档绑定证明可替代 portable identity；不把 hypothesis 改成 resolved。
- 保持不同 value 的 fill/select/check 分开。对于输入目标自己的起始状态是否沿用现有 destination-value 采样豁免，必须明确沿用原 operation-sample 契约；不能把这条豁免应用到其它 selector 或放宽未知 selector state。A→B→A 只可在完整已知条件回到 A 时复用 A 的实际样本，未观测组合不算覆盖。
- unknown/executing 不得被成功样本覆盖。现有 reconcileCoverage 会跳过自身有 attempts 以及 unknown/executing 的 frontier，operationSourceCompletion 也拒绝所引用 unknown；这些守卫不能减少。此外当前 correspondenceReader 只检查所给 source receipt，不自动检查 session 中另一个 unknown。若新文档模式要求任意未结算结果都阻断，需要显式检查其 session 的 unknown/executing（批内一次），不可误称端口已有此保证；既有 portable 行为另属原契约。

最重要的反例是同节点业务复用。保持隐藏 `<li><i role="button" aria-expanded="false" ...></i><a href="/A"></a></li>` 的 li/i WeakMap ID、label、expanded 全部不变，仅把 li 的 data-record 或直系 a.href 改为 B；Run 可以读取该 owner 绑定而进入 B 分支。现在 hidden i 没有 reviewReuseBinding，reviewBinding 只保存 parentInstanceId 与控件自身属性，identityContext 对 li 后代跳过 owner scope；若它没有结构 record，selector 投影可能完全不变。另一个 anchor 虽被采集，也不是 mode selector，不能假设会进入仅 selector 的比较。这正对应 run6 已发现的隐藏记录采集盲区。不能从“父节点还在”推断“父节点业务绑定还相同”。建议先补版本化且有明确完整性标记的 selector owner/record/IDREF 材料；材料缺失、被截断或规则不支持时保持 unavailable。即便补充已采集绑定，未观测 JS closure/服务器状态仍由 declared context 契约约束，不能声称任意业务等价。

实现上还需避免两个易漏点。第一，同一个 pair 应统一选 portable 或 document 模式，不能每端各自 `portable ?? document`：一端 pending 后变 resolved 会使同一有效文档证明错误混用 policy。可以先试 portable，再在明确允许的 actual-success 路径对双方构造同一种文档样本。第二，reconcileCoverage 目前按 resolved identity 建 target key；新的文档 key 必须自己包含 target instance 与完整文档作用域，否则同文档两个共享 identity 的 A/B 节点可能串证。其成功索引可最多保留两种明确模式；所有 memo 都按模式区分并只活一次同步查询。历史 review clarification 仍须先走原 review provenance/时序/三端绑定检查，不能用文档连续性替代审阅 proof。

建议最小验收矩阵（本次未执行）：同一文档两次采集、两个同名但唯一实例的隐藏 selectors、完整 owner 绑定且状态不变，实际成功样本可以覆盖同实例旧来源；同时验证 target/repetition 仍拒。负例至少包括：hidden remote mode A→B；增加/删除 selector；同实例 parent data-record/href/IDREF 改绑；节点替换但 stable key 相同；新文档 URL 相同；重复/缺失 instance；未知 aria-selected；上下文/规则改变或缺失；capture 截断/超 32；真实 unknown；同 action ID 不同 value；批量后撤销 review；未执行的 observed target。对 run6 只能先检查 26→28 明确拒绝，后两组 28→28 在 owner 材料不足时仍拒绝，不能将候选数据自称正例。

迁移可保持增量且不改历史库：可选端口使第三方适配器继续使用原 portable 行为；新 policy/version 通过保留快照只读计算，不改旧 scheduling key、normalization alias、route retry 债或旧 sourceConditions=unverified。旧快照缺新增完整性字段就拒绝新模式，不能借当前 live DOM 补旧证据。无需新增持久实体或索引；若补采集，则需要 adapter 规则/证据版本与新字段兼容说明。已持久化的旧 covered 记录不要批量重写；新证明只附在本次可审计的成功对应结果中。性能上是另一次完整 selector 投影与每查询 session/实例唯一性检查，应按 observation+mode 做同步局部 memo，再对真实固定输入测量，不能从本次只读审阅预测收益。
