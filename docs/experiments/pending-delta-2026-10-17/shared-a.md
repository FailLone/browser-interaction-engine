# 共享标识下 A 漏测：作用域投影修复

本轮基线是 `7cf3918d4e4da12346b1a091f0d2ddfbcdb65b35`，分支为 `codex/exploration-layered-refactor`。受控对照已修复共享标识场景中 A 的漏测；问题发生在插件构造任务范围时，SDK 已经捕获并区分两个控件。没有改动控件身份判定、SDK 覆盖对应或 unknown 阻断规则。

工作区：`/Users/xietian/.codex/worktrees/exploration-layered-refactor/browser-interaction-engine`。测试只使用新建的临时 HTTP fixture、浏览器和数据库。基线产品在独立归档副本运行；最终提交号由主报告记录。当前实现及相同反例测试的 SHA256 见 `evidence/shared-a/summary.json`。

## 根因与调用链

1. `collectIdentityContexts` 已捕获 Owner A、Owner B。SDK 给两个 Run 不同的 controlId，`actionAvailability` 两者都可执行，已有 `browserOperationKey` 包含 owner/binding，因而操作条件也不同。
2. 插件原 `scopeFor` 只保留 URL、region、label、role、stableKey、kind/value；本例二者都是 `stableKey=id:shared`、`label=Run`，不同 owner 被丢掉。
3. `ExplorerPlugin.step` 按 `digest(scopeFor(...))` 统计唯一候选。两个动作都被排除为 `ambiguous_scope_match`，前 4 步没有执行任一分支。
4. 原协议随后移除 A 并重建 B。此时只有一个匹配 scope，B 才执行。故旧结果 A 缺失不是发现时序预算不够，也不是把 B 的成功冒充为 A 的成功，而是插件遗漏可用的 SDK 语义，制造了本来可区分的调度歧义。

对应实现：

- [适配器原有对应提示及新增绑定摘要](/Users/xietian/.codex/worktrees/exploration-layered-refactor/browser-interaction-engine/packages/adapter-playwright/src/exploration.ts:9)
- [插件作用域构建与匹配](/Users/xietian/.codex/worktrees/exploration-layered-refactor/browser-interaction-engine/packages/explorer-plugin/src/policy.ts:10)
- [派生历史覆盖仍由 SDK 批量核验](/Users/xietian/.codex/worktrees/exploration-layered-refactor/browser-interaction-engine/packages/explorer-plugin/src/completion-evidence.ts:29)
- [旧列表作用域的版本化缓存](/Users/xietian/.codex/worktrees/exploration-layered-refactor/browser-interaction-engine/packages/explorer-plugin/src/scope-migration.ts:42)

## 改动与边界

适配器抽出 `browserOperationKey` 已使用的目标绑定投影，导出 `browserControlBindingKey`。插件 Scope 新增可选 `targetBinding` 摘要。原 stableKey 编码、操作条件 key、身份与覆盖契约保持原义。摘要来源只有捕获的语义 owner/binding、去除 instanceId 的 form binding、record/template/slot；不加入 DOM 顺序、节点实例、兄弟数量或当前输入值。

新派生范围可区分相同 label/stableKey 的不同 owner。两个控件连 owner/binding 都一样时仍然冲突，不通过序号强行选择。摘要只用于范围约束，不能授权身份对应、重放、历史成功或本轮执行。

旧用户 scope 不含该字段，仍按原字段作子集匹配；旧广义排除也保持广义。新范围可以只排除 A，同时允许 B。旧派生成功记录即使不含字段，也仍将真实 attempt 提交给 SDK 核验；新字段本身不被当作覆盖成功。

旧列表键迁移的事实缓存升为 v2，新增绑定字段。v1 重新读取留存事实后建立缓存，避免旧缓存缺字段阻止迁移。没有回写旧观察或改写成功历史。主线程另外将路径推导的语义比较同步加入 targetBinding。

## 相同协议对照

`scripts/verify-exploration-conditions.ts` 未修改，脚本 SHA256：`4c977f147d123ea1adc7c3496cce927ae5be7603fff317b5700578b2732d8693`。同一 shared-id-rebuild 场景各跑 5 次；真实 onclick HTTP 日志是覆盖 oracle。

| 指标 | 基线 | 修复后 |
| --- | --- | --- |
| A、B 都执行的轮次 | 0/5 | 5/5 |
| 初始 4 步真实点击 | 每轮 0 | 每轮 A、B 各 1 |
| 全程真实点击 | 每轮仅 B 1 次 | 每轮 A、B 各 1 次 |
| 无理由重复点击 | 0 | 0 |
| 错误覆盖声明 | 0 | 0 |
| JEV / LLM 调用 | 0 / 0 | 0 / 0 |
| 最终计划条目 | 每轮 6 | 每轮 7 |
| 最终待测条目 | 每轮 5 | 每轮 3 |

计划条目增加是原来合并的范围得以分别记录，并非靠删掉待测范围换取成功。fixture 的禁用 Later、未执行输入等范围仍保留，队列没有被强制清空。后测与其他受控测试并发运行，不据此声称墙钟性能提升。

原始证据：`evidence/baseline/conditions.json`、`evidence/shared-a/protocol-after.json`、`evidence/shared-a/summary.json`。主报告的最终完整 80 次协议对照覆盖其余机制，避免只用本场景判断整体回归。

## 反例与兼容测试

[新增真实浏览器测试](/Users/xietian/.codex/worktrees/exploration-layered-refactor/browser-interaction-engine/tests/explorer-shared-target-scope.test.ts:20) 的同一文件在基线 **6/9 通过，3/9 失败**，修复后 **9/9 通过**。失败的 3 项分别是同时可用 A/B 没有执行、无法只排除 A、A 范围仍会匹配剩余 B；原有 SDK 对未知、上下文变化和错误覆盖的拒绝原本就通过，不能把它们说成本轮新增收益。

验收覆盖同时可用目标、A 消失后 B 重建、同 owner 的真实歧义、冷会话重建、owner 改变、声明上下文改变、unknown 源记录、旧权限和旧覆盖记录。真实点击由页面独立数组记录；覆盖核验测试不额外点击当前会话。

相关测试结果：首组 4 文件 53 项、较广兼容组 5 文件 120 项、最终组 3 文件 22 项、完整 explorer-plugin 与迁移缓存组 2 文件 101 项全部通过。各组有重叠，不能相加作为不同测试数量。原始日志与 JSON 在 `evidence/shared-a/`。缓存组还验证 v1 事实缓存失效、v2 复用和不以缓存迁移赋予成功。

这证明了该已知漏测的根因和修复方向，不证明真实 OKX 穷尽，也不解决观察本身没有任何可区分语义的重复控件。
