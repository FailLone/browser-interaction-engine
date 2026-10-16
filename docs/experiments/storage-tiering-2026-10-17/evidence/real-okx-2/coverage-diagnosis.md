# Run 2：历史操作重复候选、条件依赖与计划来源

本次三个动作保留了旧目标身份和成功证据；SDK 拒绝复用的原因是**旧、新两侧都无法建立操作条件样本**。这不是已证实的身份丢失，也不是已经证明的三项新语义覆盖。三次动作均以普通探索派发（`reentry=false`、无 `repetitionSource`），因此也不能据结果把它们追认为必要重入。

## 读取边界与可复核性

运行 `e926ae98-5c1a-4d6b-8cea-9b232fd47877`，产品版本 `cdb8a67a9f7646d71823ef4153c027bc3cf660d9`。原始证据是冻结目录 `/Users/xietian/.codex/worktrees/exploration-layered-refactor/browser-interaction-engine/.data/okx-storage-acceptance-20261017-v1-frozen-2`；完整独享副本位于 `/tmp/okx-run2-coverage-a8s84t8c/owned-copy`。

冻结库仅用 `mode=ro&immutable=1` 查看。SDK 解码和精确 `operationCorrespondence` 查询只在独享副本上进行；未调用引擎构造器、恢复、驱动、浏览器或模型。查询使用原引擎只读方法及纯适配器。全部相关产品源码与运行版本一致；未改产品文件。详细输入、查询脚本及源码 SHA256 见 [coverage-diagnosis.json](/Users/xietian/.codex/worktrees/exploration-layered-refactor/browser-interaction-engine/docs/experiments/storage-tiering-2026-10-17/evidence/real-okx-2/coverage-diagnosis.json)。

| 数据库 | 冻结原始、冻结复核、独享副本均一致的 SHA256 |
| --- | --- |
| `engine/engine.sqlite` | `aaf40b60d88dbe8d0a07a01f1acfc495d31e962e7596f3e0365fde717f6b53e3` |
| `plugin/explorer.sqlite` | `4856895cc4ab9b4a50c3002908428bcd3b6b8772c90975854b25dcb222e7dbf9` |

两个空协调锁库也保持原 SHA256；无 WAL/SHM 输入。数据库和大体积解码副本不纳入仓库。

## 三次操作的事实链

| 操作 | 旧 attempt | 新 attempt | 目标身份 |
| --- | --- | --- | --- |
| checkbox `true` | `2a820db4-4a56-4862-900d-8f882c9bd91e` | `183ccbdf-cdef-4eb1-bf97-bfec0e4dc58b` | 两侧均 `113b2388-297a-4701-89ad-6ac3b54deeae` |
| checkbox `false` | `98e8dbcb-fc34-437a-9e0e-a986760fb9b7` | `e7718bc9-81d4-4a21-aa44-e26c4f07bc6a` | 两侧均同上 |
| `announced` click | `492c5f9c-ca38-4621-bd3b-69f0350aeaed` | `55fc9752-861f-4a3a-b90d-f9247b33f3e5` | 两侧均 `a8508c62-0c72-44aa-8fde-7c0a794a6982` |

checkbox 的 `stableKey=id:_r_1_` 未变；announced 的上下文对应标识及原生链接目的地未变。三个目标本身都没有待裁决 hypothesis。旧、新页面实例不同，但持久 action 与 attempt 内 action 一致。日志里的 `sha256:` scope key 是 [decisionScope](/Users/xietian/.codex/worktrees/exploration-layered-refactor/browser-interaction-engine/packages/explorer-plugin/src/policy.ts:29) 的日志编码，不能当成身份变化。

三个精确 SDK 查询均为 `equivalent=false / operation_conditions_changed`，授权字段均 false、证据为空。两侧 `controlCase(portable=true)`、`operationSample`、`browserBranchConditions` 和 `browserTargetConditions` 均为 undefined；没有 critical gap，context 为 `{}`。当前 [core 拒绝分支](/Users/xietian/.codex/worktrees/exploration-layered-refactor/browser-interaction-engine/packages/core/src/engine.ts:257) 将“样本不可建立”和“已知样本不同”共用同一 reason，所以该 reason 本身不能证明条件发生变化。

## 两个隐藏依赖：身份审阅仍不足以解除歧义

三个新动作来源页，以及核对的旧 checkbox 来源页，均有两项隐藏 `Open sub-menu` selector。完整字段在 JSON 的 `selectors` 中；省略字段以 null 明示。两者均为：

- `tag=i`、`role=button`、`name=label=Open sub-menu`、`constraints.type=i`、`expanded=false`、`visible=false`。
- `stableKey`、`identityContext`、`formOwner`、`structuralItem`、`identityScope`、`readiness` 均缺省。
- 同页 localId 后缀分别为 `:1469`、`:1475`，各有独立 pending hypothesis；两者均在当前 dialog 的九个 overlay controlIds 之外。

仅为诊断忽略 hypothesis 限制，按生产 binding 投影计算，两者都得到 `{"name":"Open sub-menu","role":"button","tag":"i","type":"i"}`，**每项同页碰撞数都是 2**。因此不是“已有唯一 binding 只差一次 identity review”：即使当前身份被明确判为 independent，绑定本身仍重复。

[browserBranchConditions v2](/Users/xietian/.codex/worktrees/exploration-layered-refactor/browser-interaction-engine/packages/adapter-playwright/src/branch-conditions.ts:81) 包含全部已捕获 selector；没有单独独立性契约时，结构距离和隐藏状态不证明行为独立。[binding](/Users/xietian/.codex/worktrees/exploration-layered-refactor/browser-interaction-engine/packages/adapter-playwright/src/branch-conditions.ts:32) 对 hypothesis 拒绝，之后同页重复 binding 也拒绝。故本例的保守拒绝有确定证据，不能删除隐藏非局部依赖来让复用通过。

SDK 存在[带 observation/revision 守卫的 resolveIdentity](/Users/xietian/.codex/worktrees/exploration-layered-refactor/browser-interaction-engine/packages/core/src/engine.ts:931)，可提交身份审阅并重新采集；它没有“条件依赖自动补全”的承诺。插件 [reviewNext relevant](/Users/xietian/.codex/worktrees/exploration-layered-refactor/browser-interaction-engine/packages/explorer-plugin/src/reviews.ts:67) 先排除 active boundary 外的控件，[身份审阅循环](/Users/xietian/.codex/worktrees/exploration-layered-refactor/browser-interaction-engine/packages/explorer-plugin/src/reviews.ts:211) 只处理 relevantIds。当前没有由“操作条件不可建立”反向提供依赖审阅材料的路径。

历史 source observation 不因后来的身份审阅而重写；当前 branch sampler 直接读取历史 control 的 hypothesis 字段。**即使未来修好当前 binding，也不能把旧 source undefined 后验当作 known。**

## 为什么追加三个同 scope/key 的计划

原 session、round 复用，所有 19 个历史 occurrence 均保留，原 route retry 债保留。20:44:43.787 的 `round.reattached` 明示 `businessStateRestored=false / attemptCacheReset=true / unknownOutcomesRetained=true`。对应[重连分支](/Users/xietian/.codex/worktrees/exploration-layered-refactor/browser-interaction-engine/packages/explorer-plugin/src/runtime.ts:478) 在文档实例改变时清 `round.tried`，不清历史计划。

[completedOperations](/Users/xietian/.codex/worktrees/exploration-layered-refactor/browser-interaction-engine/packages/explorer-plugin/src/completion-evidence.ts:9) 保留旧 `resolvedBy` 和所有历史成功 attempt 作为候选；只有 SDK 正向 proof 才标完成。这三项 proof 未通过，[freshAction](/Users/xietian/.codex/worktrees/exploration-layered-refactor/browser-interaction-engine/packages/explorer-plugin/src/runtime.ts:917) 因此继续视为 fresh，且不是已经消耗重入额度的候选。随后[计划追加分支](/Users/xietian/.codex/worktrees/exploration-layered-refactor/browser-interaction-engine/packages/explorer-plugin/src/runtime.ts:730) 在相同 scope/condition 的旧行均已结算时追加新的 occurrence。

新增业务 ID 为 `ebb831a1…`、`1a6f3848…`、`172740a0…`，分别对应 announced / true / false；它们与相应旧行的 scope、operationConditionKey 相同。这里相等的是带 `sourceConditions.status=unverified` 的[调度 hint](/Users/xietian/.codex/worktrees/exploration-layered-refactor/browser-interaction-engine/packages/adapter-playwright/src/exploration.ts:77)，不是可替代 SDK 的完整条件证明。

因此本轮观察到的是“跨实例重新验证又追加计划”的调度行为；不能由三次成功推出三项独立语义覆盖，也不能由标签重复推出 SDK 正向覆盖遗失。可进一步改善的是依赖缺证的可解释性、审阅入口和有界重新验证策略。

## 统计校正与审阅边界

原产物 `newlyResolved=9` 包含：3 个本轮新建成功 occurrence，0 个历史未解决转成功，6 个原本已成功 occurrence 仅更新 `resolvedBy`。[recordOutcome](/Users/xietian/.codex/worktrees/exploration-layered-refactor/browser-interaction-engine/packages/explorer-plugin/src/runtime.ts:393) 保留旧 attempt 并刷新匹配行的证据，因此更新 `resolvedBy` 本身不是新增进展。计划状态从 `8 succeeded / 10 unresolved / 1 pending` 变为 `11 / 10 / 1`。

root 已以 `4161b38` 将证据刷新单列 `refreshedPlanEvidence`，保留 occurrence 顺序和同业务 ID 的独立 occurrence，并显式设置 `planProgressIsSemanticCoverageProof=false`。离线校正见 [plan-progress-correction.json](/Users/xietian/.codex/worktrees/exploration-layered-refactor/browser-interaction-engine/docs/experiments/storage-tiering-2026-10-17/evidence/real-okx-2/plan-progress-correction.json)。对该两文件改动独立只读复审未发现阻塞问题；未重复运行浏览器或模型。

另将 generic `Don’t show for 7 days` 的新实例审阅链交给生命周期审阅者：`68d03d78…` 在 20:45:13 分类为 interaction 并 applied；`3f546fab…` 在 20:45:29 对同目标给出 probe `interface_hover/focus=null`、`external=false`，以 evidence_missing 应用。旧 classification_unresolved 行仍只持有旧 observation。此链是审阅义务与材料是否耗尽的问题，不应误写成“从未审阅”或通过放宽到达验证修复。

建议的最小方向是保持 SDK 负向证明：将“条件未知、依赖身份待裁决、binding 冲突”等诊断及来源控件显式传给插件；允许必要的依赖审阅，但遇到本例双 binding 冲突仍保留待新证据；对相同缺证材料的重复验证单独记账并约束，必要重入继续使用现有独立契约。以上是设计建议，未实施，也不保证现有证据能建立新的唯一绑定。本轮最终无 unknown attempt，因此只证明此轮没有未知债，不能作为实际 unknown 阻断测试。
