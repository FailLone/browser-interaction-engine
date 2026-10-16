# Run 3：继续运行的收益与重复候选

run `0bd214c6-67a5-4838-b4b0-a642c738c0b5` 使用 `3885c581` 所指版本（完整提交见 JSON）。结论：审阅等待与新来源保留确已生效；历史计划和失败债未丢失。三次旧操作仍因条件无法建立而重新执行，不能计为已证明的新语义覆盖。

## 关键数字

| 项目 | 只读核对结果 |
| --- | --- |
| 原计划 occurrence | 22/22 保留，原顺序不变 |
| 最终计划 | 25 = 原 22 + 新 3 |
| 本轮新建成功 occurrence | 3：announced click、checkbox true、checkbox false |
| 历史未解决转成功 | 0 |
| 已成功 occurrence 的证据刷新 | 9，独立于新增计数 |
| 计划状态 | succeeded 11→14，unresolved 10→10，pending 1→1 |
| 本轮动作 | 3 次探索成功 + 2 次恢复内部动作成功 |
| 语义覆盖 | 未证明；3 次探索均 unkeyed，condition candidates=0 |
| 模型请求 | JEV 6/6 返回，LLM 0，无剩余 pending |
| 会话/轮次 | 原 session、round 复用，rounds 始终为 1 |

原始 `coverage-review.json` 正确区分 3 个新增 occurrence 与 9 个 `refreshedPlanEvidence`，并保留 `planProgressIsSemanticCoverageProof=false`。不把 occurrence 增长、证据更新、SDK 动作成功混作覆盖增长。

## 审阅等待的实际效果

generic `Don’t show for 7 days` 目标仍是 `div :1552`，不是同名 `checkbox :1554`。分类 decision `fca912fc…` 于 21:17:32 将其判为 interaction；probe decision `fe5ba76f-d921-4946-99a3-17e73a03013a` 于 21:17:49 返回 interface hover/focus 均 null、external 均 false，以 `evidence_missing` 应用。

四个旧 review-only 行 `d6890f2b…`（classification）、`f6c2567c…`（operation basis）、`19a0689d…`（identity）、`92336800…`（probe）新增并保留 `reviewRecoveryWait`，均绑定本轮 observation `0e316e4c-e428-4222-9d11-47d2073f41a8`、上述 probe 决策以及同一个完整材料 key。它们仍为 unresolved、`dispatchScope=false`，scope.kind 缺省。原始旧 observation 也保留在 evidence 中。

其中 d689/f6c/923 在 21:17:59–21:18:00 有明确的 `obligation.route_unavailable / unchanged_unresolved_review` 记录，`retainedInPlan=true / coverageGranted=false`。四个 wait 用最终持久 task 对当时恢复调度 observation `256bd0f8…` 做纯函数复核，全部有效。这里区分“四个已持久 wait”与“三条明确 defer 事件”，不将二者混算。

当前实现只对[没有 operation kind/value 的审阅义务创建等待](/Users/xietian/.codex/worktrees/exploration-layered-refactor/browser-interaction-engine/packages/explorer-plugin/src/review-recovery.ts:50)，并在[恢复调度中暂缓有效 wait](/Users/xietian/.codex/worktrees/exploration-layered-refactor/browser-interaction-engine/packages/explorer-plugin/src/runtime.ts:631)。本轮没有任何 checkbox 行获得 wait，true/false 两次 check 均正常成功。两次 check 发生在 wait 建立之前；真实运行证明没有误挂 checkbox wait，尚不构成“建立 wait 后又派发 checkbox”的独立运行实验。

这次恢复选择的是仍 pending 的根范围义务 `bf26248e…`，source 为本轮 `0e316e4c…`、checkpoint `3ff97103…`，不再选择旧 generic d689 来源。随后恢复仍返回 UNVERIFIED；等待修复并不等于弹层恢复成功，也不表示根范围已穷尽。该调用 21.09 秒，内部两个动作，无新增成功探索跟随；恢复链原因由独立诊断负责。

## 三次重复为何仍存在

在独享副本上调用原 SDK 精确只读 `operationCorrespondence` 方法，对 run 1→run 3、run 2→run 3 各三对，共六对复核：

- 六对均 `equivalent=false / operation_conditions_unavailable`，没有授权或正向覆盖证据；旧、新两侧 operation sample 均 undefined。
- checkbox 身份仍为 `113b2388-297a-4701-89ad-6ac3b54deeae`，announced 仍为 `a8508c62-0c72-44aa-8fde-7c0a794a6982`，目标本身没有 pending hypothesis。
- 新页面仍保留隐藏 `Open sub-menu` 两项（`:1469`、`:1475`），pending hypotheses 分别 `8d1e5125…`、`94e82682…`。两者去掉 hypothesis 限制仅作诊断时，semantic binding 仍相同，同页碰撞数均 2，均在 modal 外。不能忽略它们来建立条件。
- 三次新动作仍 `reentry=false`、无 `repetitionSource`。重连清除当前实例的 tried cache，SDK 无法正向复用后，现有调度再次生成 fresh 候选；原同 scope/key 行均成功，于是追加三个 occurrence。相同的 unverified 调度 key 不等于完整条件证明。

[core 新分支](/Users/xietian/.codex/worktrees/exploration-layered-refactor/browser-interaction-engine/packages/core/src/engine.ts:257) 现在准确区分 unavailable 与 changed；这次收益是拒绝原因更准确，未放宽覆盖判断。重复仍是条件证据不足下的调度问题，不是本轮发现身份或历史丢失。

## 债与读取边界

原 `4781b6c8…`（Wallet）和 `d15b189c…`（generic）的 routeRetries 对象逐字段不变；新增 `a6bb9c66…` 根范围恢复债，attempts=1、outcome=unverified。旧失败没有被新来源覆盖或清零。前后 pendingDispatch、unverifiedRecoveries、unverifiedNavigations 均缺省；副本中全部 14 个 attempt 没有 unknown/executing。因此本轮不能宣称验证过实际 unknown 阻断场景。

完整冻结目录复制到独享 `/tmp/okx-run3-coverage-l5gsozr_/owned-copy`。SDK 查询绕过引擎构造器，不启动恢复、驱动、浏览器或模型；纯 wait 验证也只读保留材料。**1865 个原冻结文件、副本文件与原冻结 manifest 的 SHA256 全部一致**，无原库/冻结库写入，无产品代码变更。原始 raw 文件未改。详细事件、决策、六组 proof、occurrence、selector 字段和源码/输入哈希见 [continuation-diagnosis.json](/Users/xietian/.codex/worktrees/exploration-layered-refactor/browser-interaction-engine/docs/experiments/storage-tiering-2026-10-17/evidence/real-okx-3/continuation-diagnosis.json)。
