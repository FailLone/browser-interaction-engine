# v3 采样政策与存储集成交接

基于第一阶段提交 `366012568c24e8c5e720552eba801a7fc82b166e`。本工作树仍使用旧 array ledger；没有修改主 dev 的 storage、schema、事务或工作树。以下接口对照只读检查了主 dev 提交 `2d87131` 的 `fragment-records.ts` / `fragment-session.ts`。后续事务修复由主 dev 合并。

## 必须一起集成的变化

1. `guarded-host-fragments/v3` 是匹配/调度政策升级，不能仅切换 adapter 的版本字符串。局部结构类仍可用于索引；**类成员关系不再直接授权共享访问次数**。
2. 投影候选新增可选 `context: string`，内容为完整 canonical 外部模式/祖先证据。每个新 v3 候选都会输出它。context 必须参与 occurrence/revision、完整碰撞校验、find、历史动作查找和导出；不参加局部 correspondence class key。存储可用 material 引用压缩，必须保留完整可还原字节。旧记录保持字段缺省，不能伪造为一个已验证上下文。
3. 实际访问事件新增可选 `effect: string`。本 array 适配器采用既有 lossless `encodeFragmentMaterial`；内容是 `browserFragmentObservedEffect` 的完整 material，内部带 `fragment-observed-effect/v1`。主 dev 可独立存成 material 引用，但传入 sampler 前应采用统一、完整字节表示，不能混用 raw/encoded/id，也不能只比较 digest。
4. runtime 的成功回执路径把对应的原 before/after Observation 传入 `recordFragmentOutcome`。ID/session 必须与真实回执一致。关键观测缺口或截断不提供 effect。不能从模型判断、after 页面存在或旧 access count 推造 effect。
5. `decideFragmentSampling(candidateId, context, origins)` 是纯政策函数，可直接移植。输入仅为目标自己的真实事件，以及目标可直接对应的、未撤销来源候选的真实事件。每个 origin 是 `{id,candidateId,context,effect?}`。历史有向缺边/单边撤销不能由 class membership、递归 SQL walk 或传递闭包补齐；继承的 equivalent/duplicate 计数永远不是新 origin。

## 原 counts/origins 不能继续直接消费

`2d87131` 的 `FragmentSession.counts()` / `origins()` 经 `directClassQuery` 或递归 `accessQuery` 汇总来源。v3 中必须先筛出上述直接来源，再运行 sampler，才能得到普通调度需要的 sampled/influence。`classId` 只加速局部精确对应候选查询；不能把 A→B、B→C 变成缺失的 A→C 采样依据。

全新、同政策、无历史例外的精确类可以隐式表示经过相同完整 key 核验的直接局部对应，避免保存 O(n²) clique；但仍须对**每个目标**按自己的 context、直接事件和撤销计算采样许可。历史显式图、缺边和单边撤销保留原语义。禁止用一个 class-level sampled 布尔值代替。

决策表：

| 情况 | status | 普通重复动作剪枝 |
|---|---|---|
| 无直接来源 | fresh | 否 |
| 目标自身有真实回执 | direct | 是，只表示已经采样 |
| 可达真实来源出现不同已观测 effect | observed-effect-conflict | 否，重新开放间接复用工作 |
| 来源 context 与目标相同 | same-context | 是，仍仅是 observed-context-only 假设 |
| 新 context，少于两个不同 context 的一致实际 effect | context-recheck-required | 否，保留一次正常探索机会 |
| 两个不同 context 真实执行且 effect 完全相同 | context-sample | 是，显式 unverified-external-context 假设 |

任何记录都带 `coverageGranted:false`。两个一致的结果不证明任意 JS 依赖独立。`recheckBudget:1` 表示在首个样本之外，再用一个真实新上下文样本验证采样假设；没有后台/周期性强制探针。未知 effect 不扩大许可，仍受原普通动作与重试预算约束。后续必要恢复或其它实际执行若产生冲突，重新计算会撤销所有受影响的间接采样；目标自己真实执行过的 direct 记录保留。

## 持久化与缓存

- 外部 context、effect、origin IDs、直接/间接来源、单边撤销和原事件要能冷读；不要只持久化 derived sampled 位。
- event/revocation/root epoch 变化使 decision、influence、state ordering 和 frontier 缓存失效。冲突检查应读取所有合格已知 effect；不能截断到首 128 个后宣称无冲突。分页只用于审计展示。
- 原 task header、事件、pending child、恢复义务与新 fragment delta 的原子提交遵循主 dev 正在修复的事务。此次不更改事务边界或旧 schema。
- runtime 的 `fragment.frontier.samplingChecks` 记录需复验/冲突原因及真实 origin IDs，显示最多 128 条并报告 omitted 数。`fragment.access_recorded.sampling.conflictAttemptIds` 可说明实际回执发现的冲突。完整依据仍在 durable events/materials。
- v1/v2 ledger 保留原 policy、IDs、原始事件、mappings、revocations 和 pending，所有派生剪枝消费关闭。物理存储迁移不等于政策迁移。若要启用 v3，需新政策命名空间及从原观测重新投影；旧 receipt 只能按实际 before/after 重新连接来源，禁止改字符串继承旧派生事实。

## 集成门槛

复用本提交的真实 frozen pair、直接来源/缺边/撤销用例、跨上下文真实浏览器用例及旧政策消费门禁。新存储适配还需独立验证 context/effect 的完整导入导出、碰撞比较、重启一致、两 writer/失败 flush 的原子性，以及不因访问查询分页漏掉冲突。

最后真实 OKX strict reentry 与冻结代码独立复验仍由主 dev 在统一存储版本执行。本阶段没有启动新 OKX 会话，本地结果不能替代该最终验收。
