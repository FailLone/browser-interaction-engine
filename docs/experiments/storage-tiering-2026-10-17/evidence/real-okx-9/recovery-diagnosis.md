# Run 9 恢复失败：只读诊断

对应 commit：`8b9f6934988dd60cccbff74721d13003560317e2`。唯一结构化证据为本目录 `recovery-diagnosis.json`，复用已关闭 run 9 的导出及独享审计副本；未访问原任务库、构造 SDK host、启动浏览器或服务、执行测试。副本主文件、空 WAL 和 SHM 的读取前后指纹一致，所有句柄已关闭，副本保留供主线程后续使用。

## 结论

SDK 返回 `UNREACHABLE` 有依据；没有发现足以证明调度漏用了合法严格恢复路径的证据。建议下一补丁只解决一个调度结论：**已通过现有 SDK availability、scope、唯一性和本地候选门槛的活动独占弹层退出，应先完成退出，再重新观察和调度，不能仅因历史本地选择计数达到 4 而先进入远程恢复。** 这是待验证的改进，尚不能宣称已经修复 run 9。

不建议凭同名、同 stableKey 或 targetBinding 将旧 USD 审阅视为当前已对应，更不能结案旧任务或修改失败结果。

## 已确认事实

- 选中的 `92e78cad-25e8-495e-a317-6194ec309298` 是 `USD` generic 的 `classification_unresolved`，没有操作 kind，`dispatchScope=false`；恢复后仍为 unresolved。它不是允许使用 source-position arrival 的页面发现任务。
- source `e6b34ad6…` 的旧 scope 匹配一个控件。current `235a58e9…`、Close-before `0d1b8016…` 和 after `dfede8b5…` 均保留可见、启用的 USD generic，URL、名称、角色、stableKey 和 targetBinding 相同，但文档区域名由 `USD to BTC | Convert US Dollar to Bitcoin | OKX` 变为 `Buy Bitcoin & Crypto | Crypto Exchange, App & Wallet | OKX`。scope 精确匹配因此返回零个。另一个同名 USD button 隐藏且角色、区域不同，不能作为替代。
- source 与 current 的 browserSessionId、instanceScope 都不同；同实例保留关系不能使用。该项的 22 个观察引用对应 20 个保留检查点，全部没有当前原生历史锚点，全部记录了不可重放的路径步骤。这只覆盖该项直接关联的检查点，不是全导航图可达性的穷举证明。
- 选中检查点 `fab896e5…` 的 12 步路径包含不可重放的 `Return to observed page` 和 `Open Spot sub-menu`。SDK 实际执行一次 Close，关闭弹层后严格画面验证仍失败，继而以路径缺少重放许可返回 `UNREACHABLE`。它没有用新会话可用或 Close 成功替代检查点到达证明。
- source 的弹层列表为空。current 与 Close-before 的活动弹层为 `dialog:okd-dialog-window`、kind=`modal`、带 `aria-modal` 证据。Close `:729` 同时属于其 9 个 controlIds 和唯一 exitControlId；USD `:1943` 不在该弹层中。after 的弹层已消失。
- USD 的实际 SDK 分类投影在三份观察均可构建，均有完整 58 节点子树、零外部引用，归一化子树 hash 相同；但 source 与 current/after 的 **identityKey 和 conditionKey 都不相等**。现有投影将 region.label 纳入目标，祖先绑定 hash 也不同。因此并没有可直接使用的分类对应证明；未修改或伪造任何投影输入。
- `task-before.scheduling.localSelections=4`，等于源码公平调度阈值；run 9 选择远程恢复后计数变为 0。current 保留的 Close candidate 具备 native-button supported basis、interface risk、replayable=true、excluded=false、visible/enabled/identityResolved/targetResolved=true、空 precondition blockers。随后 SDK 在新捕获的 Close-before 对相同控件执行成功。

## 推测与边界

源码允许达到计数上限时，远程恢复优先于本地候选。这与本次现象相符。但导出中没有选择时的 local 数组或完整 availability snapshot，也没有 `action.validation` 事件，故不能把候选字段和稍后的成功执行当作“当时 Close 已通过全部本地门槛”的完整证明。

标题变化使旧 scope 对应失败是确定事实；它是否应被视为无关描述变化，是另一个 SDK 契约问题。当前投影拒绝对应，当前 USD 又位于活动弹层之外，不能通过跳过 region、改写分类 key 或只检查绑定键来绕过。动态输入值也存在差异（BTC 读数由 `0.00001226` 变为 `0.00001225`），本次没有拆解严格 canonical 失败的全部原因。

## 最小后续检查点

仅验证上述退出优先级：计数为 4 时，合法且属于活动独占弹层的本地 exit 先执行；退出后重建观察和调度。不可用、歧义、失效退出或 unknown 结果不得获得权限；没有独占边界时原有有限公平调度继续生效。A/B 和真实上下文变化仍保留独立待测范围，不授予旧审阅、覆盖或检查点成功。

本次不新增真实页面验收，不测性能，不把约 23.9 秒的失败恢复解释为改善。

源码定位：`packages/adapter-playwright/src/browser.ts:227`（标题生成文档区域名）；`packages/explorer-plugin/src/policy.ts:54`（scope 精确对应）；`packages/browser/src/index.ts:134`（实例连续性）；`packages/adapter-playwright/src/classification-correspondence.ts:39`（分类区域条件）；`packages/explorer-plugin/src/runtime.ts:809,966`（当前审阅抑制及恢复调度）；`packages/explorer-plugin/src/obligation-scheduler.ts:50`（公平选择）；`packages/explorer-plugin/src/source-return.ts:9`（原生位置返回范围）；`packages/core/src/engine.ts:1532`（不可重放路径拒绝）。
