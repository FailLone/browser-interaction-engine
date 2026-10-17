# 第七窗：严格恢复拒绝与独立的 unkeyed 条件问题

SDK 正确拒绝了不可重放的 checkpoint 全路径。插件另有一个确定的选路缺陷：把只包含隐藏审阅目标的旧快照，当成了能够继续审阅的恢复目的地。修正这个候选门可以避免本次无用的严格恢复，但本报告没有证明旧 checkpoint 已可恢复，也没有把本轮较早的 `SOURCE_REACHED` 算成 checkpoint 恢复成功。

## 一手事实与调用链

真实 run `e38c02f1-d0b9-4c8c-bb9d-474cb0c1db1e` 的原代码为 `069b65b47…`。初始只读诊断基于 HEAD `106a1cdfddfe3e73cab9e01b28ba4dd8439653e2`；下列代码行号引用随后单独固定的纯性能版本 `855a3a47b513305077ef160a8d4d5716fe1780f9`，仍未包含源可见性门。新测试和本诊断不修改产品代码。

1. 插件 `recovery.selected` 选择 item `35a22c35-fa78-47fb-8681-2ac3250539cd`，reason 为 `identity_unresolved`。scope 只有 USD URL、Main menu、Open sub-menu、button，没有操作 kind；required=true、dispatchScope=false、unresolved、attempts=[]、prerequisites=[]。
2. 该事项唯一直接来源是 `5f80a3df-8355-444a-8499-4a625cb89577`。`runtime.ts:707` 从该 evidence 找 checkpoint，所以选择 `b1e80845-ab4f-4c31-809d-ba37be180e92`。此源创建于 2026-10-16 21:41，属于旧 browserSession `6b71f627…`；本轮当前 browserSession 是 `d6188a00…`。`currentHistoryAnchor` 因浏览器会话不同为 false。
3. 旧来源中 scope 匹配两个控件 `:1491`、`:1497`，都是 `i / role=button / name=Open sub-menu`，`visible=false`、enabled=true，均有未解决 hypothesis，没有匹配 action。当前 `f6ad38c2…` 也只有两个隐藏的同名未解决控件 `:1492`、`:1498`。这里的同名匹配只说明需要审阅的范围，不能证明控件身份对应。
4. `runtime.ts:727` 用全部匹配 source.controls 构造 `previous`；`:735` 只检查集合非空，并未要求源中目标可见、位于源的活动边界内。由于当前匹配控件也隐藏，下一行“当前已有可见审阅对象”的抑制条件不触发。这是本次进入无用恢复的具体缺口。
5. 该 review 候选没有 targetActionIds，`runtime.ts:964–968` 走严格 `reachCheckpoint`。不是 `reachExplorationTarget`，也不是 `returnToObservedSource`。
6. checkpoint 的完整路径有四个已成功 attempt：两次 checkbox、announced，以及 `90102e0e-7a04-4b24-9abf-38f4f48498a9`。最后一步是 run4 的 `history / Return to observed page / browser-history-return`，明确 `replayable=false`。`core/engine.ts:1033–1043` 的 visitPath 保留这种历史返回步骤；它不是新的可任意重放 entry。
7. `core/engine.ts:1258–1388` 已依次尝试当前验证、边界退出/当前原生返回、记录路径和声明式局部恢复；最后 `:1411` 拒绝含不可重放 action 的 entry replay。原结果只有 `observable-state:fail`、attemptIds=[]，无 dirty action、无 reset。最后 100 条引擎事件没有该次 `checkpoint.path_selected` 或 `checkpoint.path_failed`。不能从这些事实反推已找到另一条可执行路径。
8. 结果 `1fee6dd0-865c-416c-b905-fd4db8621a44` 为 `UNREACHABLE / Checkpoint path contains actions without replay permission`，耗时 11.424 秒，最终观察 `f5d928b6…`。验收工具请求 `recovery_not_verified` 后正常 settle；未把 paused 改写成原始失败原因。

前一次恢复是不同契约：返回源页面只派发一个 history，结果 `SOURCE_REACHED`，耗时 14.761 秒，checkpointVerified/sourceStateRestored/currentExecution/executionAuthorized 均为 false。两次结果不能相互替代。

## 是否存在仍安全可用的替代

检查了同一 session 的 31 个 checkpoint。8 个属于当前 browserSession，native source entry 都是 USD GET entry 4，而失败前当前也已在 entry 4。`adapter-playwright/navigation.ts:52` 不生成返回同一当前 entry 的 history action；`:40–42` 的“源位置已到达”也不证明旧 UI 状态已恢复。纯 URL root 在当前同 URL 时不进入恢复候选，是正确行为。

其中确有三个本轮快照捕获了可见 Open sub-menu：

| checkpoint | observation | 来源状态 |
| --- | --- | --- |
| `b328194a…` | `63f3d18a…` | Trade 展开后；两个目标可见，均为 instance identity |
| `fb000566…` | `24f495c2…` | Spot 展开后；两个目标可见，但 observation.stable=false |
| `2e215879…` | `1ea431eb…` | 后续稳定快照；两个目标可见，仍为 instance identity |

这三个快照不是旧 item 的来源。不能靠相同 label 给旧 ambiguous scope 换源、解除旧债或宣称身份对应。第一个 checkpoint 路径已含本轮不可重放 history；后两个还含不可重放的 instance-only Spot 操作。已有原生 entry 锚点不能恢复展开状态。记录中没有证明从失败落点到这些完整状态的合法路径；本报告不把“先点击 Trade 看看”当作已经验证的替代路径。实际前置入口须由正常候选、权限、重复操作及到达验证契约处理。

因此最小修复应只纠正目的地事实：对 `controlReviewGapReasons` 且无 kind 的候选，要求至少一个 scope 匹配源控件可见，且在存在活动 boundary 时属于最内层对应 overlay 的 controlIds；否则保留事项并记录 `source_review_target_not_available`，不花费新的严格恢复尝试。缺 overlay 成员证据也应拒绝。可见但 disabled 的目标仍可有审阅材料；可见的重复 identity 仍可以是 identity review 的目的地，不应额外要求唯一性。此门不给执行/完成/跨来源身份授权。

“恢复后再打开入口使隐藏目标可见”需要显式前置入口或独立待测项；严格恢复到一个目标仍隐藏的 checkpoint 本身不提供这条步骤。该门也不能普遍跳过所有含不可重放 path 的 checkpoint：其当前验证、有效原生返回、记录路径仍可能合法成功。

## 7 次成功但 unkeyed 是独立问题

`recovery-diagnosis/unkeyed.ts` 只读私有提取的完整 before 观察与实际 attempt，调用未修改的 SDK branch/target 条件函数。7 个 attempt 都是真实 succeeded；七者 branch 和 target conditions 全部 unavailable。不是动作失败，也不是整个页面穷尽。

| 实际成功操作 | 纳入该 action 的 selector 数 | 条件缺口 |
| --- | ---: | --- |
| Don’t show true | 26 | 2 个隐藏 Open sub-menu，身份未解决且 binding 相同 |
| Don’t show false | 28 | 同上 |
| announced | 29 | 同上 |
| Trade | 26 | 同上 |
| Open Spot sub-menu | 28 | 3 个 instance-only selector |
| 1W | 30 | 5 个 instance-only selector，增加 USDT、Crypto |
| 1M | 28 | 2 个隐藏 Open sub-menu，身份未解决且 binding 相同 |

这些帧没有 critical gap、未知 context、selector 缺失状态或 selector unstable；数量均未超过 32 上限。`branch-conditions.ts:38–40,91–125` 有意保留隐藏及非局部 selector，并拒绝未解决、instance-only 或重复 binding。验收 `operationConditionAssessment` 依赖此完整条件，正确保留 unkeyed，而没有把成功次数冒充不同语义操作的覆盖。

这个缺口会持续限制跨来源覆盖对应和可证明的重复进入，因而值得后续单独修复；当前可见性门不解决它。安全方向是补齐实际拥有者/记录/控件关联的采集证据和确定性对应，或设计能完整约束这些依赖的更窄证明契约。不能直接忽略 hidden selector、只取同 region，或用同 document/instance 替代业务绑定。

反例已经在第六窗 `document-owner-fixture/` 实际复现：隐藏 li/i 的 JS 实例、所有完整捕获 selector 字段、document/context/rule 均保持相同，父 li 的 data-record 或同级直系 a.href 从 A 变成 B，实际 Run 的 UI/HTTP oracle 分支却改变。原 portable 契约正确拒绝。先补捕获才能讨论这种新证明，不能为了让七次成功获得 key 而放宽非局部依赖。即便补足部分隐藏记录，也不能预先保证 Spot/USDT/Crypto 的 instance-only 模式都因此变为可移植。

## 回归与取证边界

新增且独占 `tests/explorer-review-source-visibility.test.ts`，只用内存 ExplorerStore 和无派发 host。未加门的基线 15 项中 12 失败、3 通过，失败日志完整保留；root 实施源门后，同一文件 15/15 通过，exit 0。覆盖 hidden 五种 review reason、后台/外层 boundary/缺 overlay、可见重复 hypothesis、可见 disabled、合法后续来源、fresh source 可见性、旧 unknown 债、同 URL 不能代替展开，以及独立具体入口不受 review 门阻碍。它没有启动浏览器，也不是成功恢复的端到端证明。未运行全量套件；新增测试的最终整树类型验证由 root 整合。

数据来自对 frozen-7 全目录的完整私有 copy，首次及结束后核对原 4,511 文件 SHA 均全等，9 个归档 run 文件也与冻结材料相同。仅对 copy 使用 readonly + query_only 的 SQLite decoder，total_changes=0；未构造浏览器或 provider，未对原/冻结数据库调用 SDK/store 构造器。readonly SQLite 在私有 copy 新增了空 WAL 和 32 KiB SHM，初次“整个私有树完全相同”的断言因此失败；这些 sidecar、错误记录和哈希均保留，原 4,511 文件没有变化，冻结树也没有新增 sidecar。没有把读取副作用误报为原数据库变更或丢弃失败日志。

`extract.ts`、原日志、紧凑事实及原始 unkeyed 条件报告位于相邻 `recovery-diagnosis/`。首次提取的 tsx 模块格式错误也保留，没有将失败隐藏为取证成功。完整大帧留在私有目录，可从冻结副本按脚本重建。修后专项期间 4 个采样产品/测试源码哈希前后一致；测试文件最终 SHA-256 为 `f44627cc914f9a8e80323149d6b2ffdce06d5b3e1fdae968b9219c50b1c71caf`。哈希验证与命令记录见该目录 manifest 与 commands。实际选路修复的冻结完整材料对照由 root 独立归档，本报告没有用纯性能对照替代语义修复验证。
