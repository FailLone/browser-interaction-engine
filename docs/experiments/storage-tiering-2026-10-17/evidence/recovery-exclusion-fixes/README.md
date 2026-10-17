# 恢复候选误排除：两个独立补丁

在 `551a6b9` 选择周期优化上修复，不回退存储版本、SDK view、来源投影小表或有界缓存。产品最终固定 `63c57e5b435864cf4948afe385b50e479e849a67`，工作区及分支仍是 `exploration-layered-refactor` / `codex/exploration-layered-refactor`。

## 补丁与各自结论

1. `a77bdd6`：旧 negative review wait 只有在**最新历史材料**仍匹配时才能继续挡住候选。SDK 新增显式历史 `recoveryReviewMaterial` 及 view 的惰性读口，插件核对 action/review/materialKey；缺材料、读失败或对应不唯一只撤回负面等待，不放宽恢复、执行、覆盖或 unknown 门禁。插件材料缓存最多 8 项；只有受 view 版本保护的材料跨 yield 复用。
2. `63c57e5`：当前同名/同实例控件只提供对应线索，排除历史来源还需唯一对应、分类条件及非局部 UI 条件一致。当前 B 的禁用/策略拒绝不能排除历史 A；等价的近期来源只能跳过本来源，不能终止整个 item 的旧来源扫描。投影归当前 selection 所有，历史键用 WeakMap，不额外强持有来源图。

原来的真实无候选结果不能据此宣称正确：[离线诊断](../recovery-selection-exclusion-diagnostic/README.md)证明缓存命中没有串错，但原谓词本身使用了不足以排除的证据。72 次实际在场排除中，66 次没有相同分类条件的证明；本样本没有实际触发 policy 排除，policy 缺陷由受控反例证明。4 个旧 wait 在旧实现中未核对材料；不能据诊断宣称它们实际已失效。

## 有限验证与每次复验理由

| 检查 | 结果 | 证据及限制 |
| --- | --- | --- |
| 首次 10 个反例/正例 | 7 失败、3 通过 | [red.log](red.log)。wait 的 2 个反例复现；current-source 的 5 个失败后来发现被夹具中无法映射的独立 unknown 债遮挡，**不单独作为产品因果证明**。 |
| 修复后集中检查 | 98 项中 93 通过、5 失败 | [green.log](green.log)。唯一失败文件是上述 current-source 夹具；产品未因此改门禁。 |
| 既有 review 合同 | 16 通过、2 跳过 | [review-contract.log](review-contract.log)。显式筛选纯离线用例，跳过两个真实浏览器用例。 |
| 修正夹具的旧产品对照 | 5 失败、3 通过 | [corrected-baseline-red.log](corrected-baseline-red.log)、[元数据](corrected-baseline-red.json)。固定 `551a6b9` 独立归档；补齐独立 unknown 来源及成员映射，不删旧债；每个负例先验证移除当前对应线索后的合法来源可被选择，再验证旧谓词错误排除。 |
| 同一修正夹具的新产品复验 | 8 全部通过 | [fixture-repair-green.log](fixture-repair-green.log)。仅重跑受夹具修正影响的文件；原产品未改变。夹具 SHA 与旧产品对照相同，最后修改时间早于两个测试进程开始。 |
| 类型检查 | 根/core 最终通过 | 首次 [types.log](types.log) 仅夹具 blocker 缺少 evidence；补齐后只复验根 [types-repair.log](types-repair.log)。core 首次 [core-types.log](core-types.log) 通过，未重跑。 |

最终覆盖 114 个不同的定向用例，分上述检查点通过，不能描述为首次全绿。保留全部失败记录。修复后的运行量上界、容量溢出不漏候选、取消/版本失效、最终验证与旧债保护沿用并通过 20 个 selection cancellation 用例；本轮没有重跑旧长基线、扩大预算或运行真实网页。

`counterexample-baseline.py` 只复制源码和一个夹具，不读取任务库或启动浏览器。旧产品对照的 fixture/runtime 哈希、退出和临时目录清理均已确认。测试本身不赋予任何真实恢复成功、新覆盖或穷尽结论。

## 冻结输入复验及剩余边界

修复后的同输入唯一复验见 [独立报告](../recovery-exclusion-fixes-profile/README.md)。它读取自有 engine 副本，原任务只在内存 paused→running；若有候选，实际调用其纯 revalidate，仍不派发浏览器恢复。新选择可能提前返回，因此不同扫描处理量不能被包装成纯算法提速比例。

另一个待证合同是：缺少 portable target 条件是否也应阻断严格 checkpoint 恢复。诊断中 37 个 checkpoint 有 tryable 策略提示，其中 812 个被缺目标条件排除的实际组合涉及 287 个 item；这不是实际到达证明。既有测试有意保守处理未知非局部条件，且 routeConditionReader 仍有独立门禁；本轮没有简单删除该门，也没有将这些待测项改成功或从计划移除。

真实恢复成功率、实际新覆盖，以及该严格恢复合同仍需分开验证。本轮收尾结论仅限于：修复已经证实的误排除，保留已有性能结构和旧债边界，并核验冻结输入上实际选择结果。
