# 已在场审阅项不回退旧来源

本补丁只证明一个结论：**当前没有活动边界，且较新来源已经通过 retained 对应找到当前可见、enabled 的审阅控件时，暂缓整个 item，不能继续用该 item 的较旧检查点恢复。** 循环后的既有 `deferObligation` 保留 `current_review_occurrence_present` 原因，再继续其他待测项。

基线为 `4f868d68494dd59853f2a6d03afb5d80e695e532`。产品只修改 `packages/explorer-plugin/src/runtime.ts` 的一行：该 present 分支在无活动边界时 `break`，有活动边界仍沿用 `continue`。其他候选拒绝、恢复、覆盖、身份和 unknown 契约均未修改。

验证顺序和记录：

- `red-test.log` / `red-validation.json`：未修改产品，只运行新增反例，确实失败。较新来源具有精确 scope 目标并与当前唯一实例 retained 对应；当前 region 不同，因此不能直接精确匹配旧 scope。旧实现仍选择 `review` 的旧 `source`，而不是另一个 `genuinely-missing` 项。
- 随后增加有活动边界的同场景对照，防止把可能被弹层遮挡的背景控件当成可审阅依据。
- `green-test.log` / `green-validation.json`：产品一行修复后，整个 `explorer-review-source-visibility.test.ts` 只运行一次，17/17 通过，即原 15 例和新场景的两个边界分支。隐藏来源的合法回退、当前目标不存在时的原有选路仍通过。新例确认 plan、item/task 状态、待决 hypothesis 和既有 unknown 重试账本不变；不执行恢复或操作。
- 两轮源码哈希分别记录于 `red-source.json` 和 `green-source.json`，失败记录未覆盖。

仅使用内存 fixture；没有浏览器、服务、持久任务库或实验数据库访问，没有发布、全协议或性能重跑。尚未证明真实 OKX 下一窗能够恢复或产出新覆盖；当前存在活动边界时的更精确审阅可用性仍沿用旧行为。本补丁没有结案审阅、身份、覆盖或 unknown，也没有验证跨重启的新行为。
