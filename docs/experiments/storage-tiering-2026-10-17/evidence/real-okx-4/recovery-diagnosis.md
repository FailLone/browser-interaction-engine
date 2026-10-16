# Run 4 严格恢复与重试条件诊断

本轮第二次恢复重复消费了一个已经失败过的落点条件。它没有因价格、标题或 `1h` / `24h` 选中状态变化获得新条件；问题在于旧 ledger 只记入场条件，未消费失败后的条件。SDK 返回 `UNVERIFIED` 符合严格检查点契约，不能用第一次 `SOURCE_REACHED` 或相同 URL 把它改判为成功。

## 输入和只读边界

- 运行：`5f350d86-b9dd-43e5-ac07-43a79a9e30f0`，任务：`6c56a979-34f0-4599-a5b7-9461c357144d`。
- 冻结数据：`.data/okx-storage-acceptance-20261017-v1-frozen-4`；原运行库未连接。
- 行为复算基线：`868e8b47afd31782161deba4f8bd7a14e0349430`。`recovery-diagnosis.json` 保存的四个产品文件 SHA256 已逐一与该 commit 核对。
- SDK 仅打开独享临时副本，浏览器启动被显式禁止；实际浏览器启动和 provider 调用均为 0。另用 `immutable=1&mode=ro` 查询冻结库中的事件元数据。两个冻结数据库的前后 SHA256 均不变。
- 后续诊断脚本增加基线源码断言；root 开始修复后，脚本在打开数据库副本前拒绝运行。没有把修复代码混入本报告的旧行为结论。
- 这是离线事实分析，不是性能基准，也没有验证真实页面上的新操作。完整数据见同目录 `recovery-diagnosis.json`；复现脚本为 `recovery-diagnosis.ts`，需要上述源码基线。

## 选中了什么

第二次 `recovery.selected` 是事件 2189，时间为 `2026-10-16T21:42:32.642Z`：

| 字段 | 值 |
| --- | --- |
| 待测项 | `93cb64e4-ff77-4bdd-85f2-bd5bc01007b6` |
| 内容 | `dialog` 中的 button，`Go to OKX Wallet` |
| 原因 | `operation_basis_unconfirmed` |
| 状态 | `unresolved`，`required=true`，`dispatchScope=false`，没有执行记录 |
| 历史来源 | `8e894178-1943-4a1f-b75d-1ce665aa01cc`，首轮原始对话框 |
| 当前观察 | `9ca9a659-c1af-47c6-af1c-40b77b5803a3` |
| 检查点 | `7d7c3b8d-5dc6-45dc-a77a-13f5b3eab8ec`，`path=[]` |
| route | `4781b6c8347fe7977def58b6636fb39c8f1c8f0d8582dd8e1123dce010069d29` |

它不是刚完成的周期按钮任务。源观察确实有一个可见、启用的 Wallet 原生按钮，click basis 是 `supported`，risk 为 `unknown`。因此 plan 的通用缺证原因不应解读成“浏览器没有识别出原生 click”。该 plan scope 没有 `kind`，是控件审阅待办，不能直接变成一次 click。

当前观察已稳定，但没有匹配 Wallet 的控件或 action，也没有同名控件。仅凭当前保存材料，不能直接执行该目标或完成其审阅。它必须继续保留为未测；如果以后重新出现目标，再依据当时的材料审阅和选择。

## 本轮经过与契约

| 事件 | 结果 |
| --- | --- |
| 1586 → 1652 | 纯 URL 页面任务执行来源返回；单次 history 操作得到 `SOURCE_REACHED` |
| 1924 | 选择 scroll，候选数 27 |
| 1948 | 选择 Trade，候选数 26 |
| 2019 | 选择 1h，候选数 20 |
| 2080 | 选择 24h，候选数 19 |
| 2189 → 2281 | 选择历史 Wallet 审阅项，严格恢复返回 `UNVERIFIED` |

来源返回确认页面位置，`checkpointVerified`、`sourceStateRestored`、`currentExecution`、`executionAuthorized` 均为 false。后续 scroll/Trade/周期操作使用新的观察。第二次选择发生在四次本地操作之后，与调度的有限本地批次相符；不能由此推断当时所有本地工作已经耗尽。表中候选数是对应 action.selected 时的值，不是严格恢复开始时的完整可执行候选数。

Wallet scope 不是仅 URL、无前置条件的 `dispatchScope=true` 页面授权，故窄来源返回接口不适用。该控件审阅 scope 又没有 `kind`，`scheduledRecovery` 没有生成 `targetActionIds`，最终走 `reachCheckpoint`，而不是 `reachExplorationTarget`。这是现有契约分支；把它改用页面位置成功会错误扩大含义。

严格恢复依次考虑当前状态、边界退出、已记录路径、声明的局部恢复及入口重放。最终只有一次 `recovery-entry` navigate：`6974dfc3-4178-4291-9fa7-32fd1f975b1a`，执行结果为 succeeded。新观察 `c4fae20b-a313-48bb-a1f6-22f793550193` 仍无 Wallet，对话框没有恢复；浏览器实例也已更换。检查结果只有 `observation-completeness=unknown`，因为完整观察不稳定，故 reason 为 `Entry replay verification: UNVERIFIED`。

最终观察有 `INTERACTION_STABLE`，且没有 critical gap，但这不等同于严格 checkpoint 的完整 canonical 相等。即使忽略整体稳定性，Wallet/对话框缺失及 canonical 不同仍不能证明恢复到原始检查点。因此本轮可修的是“是否应该再次尝试”，不是降低严格验证。

## 已确认的预算缺口

下列 Wallet route 条件复算结果相同：

`613636bec2298b894b26fcc0bd8d6988679dcdf22c7e3b5520c0378b2fac5bcb`

它覆盖旧失败落点 `cfc205c1…`，本轮来源返回落点 `214b3539…`，scroll/Trade/1h/24h 前后的采样，以及第二次恢复的入场 `9ca9a659…` 和失败落点 `c4fae20b…`。这一条件包含 URL、ruleVersion、known context、边界，以及目标 absent 的投影，不包含价格、页面标题、DOM id、选中周期或整体 stable 位。

旧 ledger 只有：

```text
conditions[a1a0eef5…] = {
  attempts: 1,
  outcome: unverified,
  reason: replay_target_not_unique_or_missing,
  evidence.observationId: cfc205c1…
}
```

`a1a0eef5…` 是首次尝试前 help 页面条件。与之并存的 `route.failure.conditionVersion` 已是 `613636…`，但没有被写入 retry ledger。离线对原始 task-before 复算：

```text
routeRetryEligibility(beforeLedger, WalletRoute, 613636…) =
{ allowed: true, reason: new_condition, attempts: 0 }
```

`updateObligations` 会把同失败条件投影成 waiting；`scheduledRecovery` 没有把相应失败结果纳入预算判断。因此相同失败落点被当作未尝试的新入场。这是确定的重试记账缺口。单纯排除所有 waiting/unreachable 则会误伤真正的新条件，不能作为修复。

旧 run 1 用的是 checkpoint `33702c36…`，其 path 含两个 checkbox 操作；run 4 改选原始 checkpoint `7d7c3b8d…`、path 为空。二者不能称为“同一检查点再次调用”，但它们映射到了同一个旧 Wallet route。单独生成或换选一个 checkpoint UUID，不证明存在新的可验证恢复路径。旧 `replay_target_not_unique_or_missing` 指路径回放未匹配，不能仅凭这个 reason 断言缺的是 Wallet；Wallet 缺失由保存的控件/action 列表另行证明。

## 最小修复及反例

建议把失败后的可验证条件保存为该次尝试的负调度证据，与原入场条件分开。它只阻止把既有失败落点当作新预算，不增加 attempts，不授予执行、身份、覆盖或状态恢复。旧数据补记必须核对 session、观察存在、reason、condition 重算，以及证据完整性。

旧落点 `cfc205c1…` 的整体 stable=false，但明确有 `INTERACTION_STABLE`，无 critical gap、无未知 context，另有回放目标缺失结果。可以针对这种有交互稳定证据的回放失败保留负条件；只有 `UNSTABLE` 或 reason 字符串本身不足以证明该条件。

必须保留以下行为：

1. A 入场失败落 B，重启后在 B 不自动多一次预算；同 attemptKey 的 reserve/result 不重复计数。
2. 只有不稳定或不完整证据的失败，不能额外把未尝试的失败落点固化成负条件。原始入场条件的 attempt 预算仍然已经消费：若从 B 入场又落回 B，并不会因纯 UNSTABLE 自动获得重试。
3. 目标、相关模式、已知 context 或可验证新路径变化允许重新判断；无关价格、标题、新 UUID 不构成新路径。
4. unknown/executing 债跨恢复契约继续阻断。SDK 精确续行证明优先于负条件，只给一次 allowance；verified progress 可以显式清旧条件。
5. 更新已尝试的入场条件时不能意外遗忘另一个旧失败落点，从而让一次 allowance 额外释放多个预算。
6. 缺失、跨 session、不匹配的 legacy evidence 不得凭空生成可信落点别名。实际 route 条件不可计算时，不能把入场 fallback 标成已验证的结果条件。
7. SOURCE/TARGET/strict 返回契约不匹配仍为 `UNVERIFIED`。目标未出现仍是未测，不能转换为覆盖或任务完成。

这里未验证修复代码的测试结果，也未运行浏览器。本报告确认旧行为、失败契约和修复边界，不宣称真实页面性能改善或整体探索目标完成。
