# Run 4 计划增长与同帧重复登记

输入为 frozen-4 的独享临时副本以及原始 `task-before.json`、`task-after.json`。未连接原库，未启动浏览器，网络、provider、执行调用均为 0。副本仅作 SDK 读取；写入限于临时插件库和本诊断产物。完整计数、样例、输入及源码 SHA 见 `plan-growth-diagnosis.json`；可复现脚本为同名 `.ts`。这不是性能基准。

结论：514 个新计划行包含首次完整发现的工作，也存在同一观察中“已发现待执行”和“尚未执行”重复登记。实验原型只阻止经过唯一当前动作确认的同帧双登记。真实两帧重算证明第一帧少 1 行，下一帧缺少对应证明时恢复独立缺口，最终净节省 **0 行**。该收益不足以支持每次 audit 新增完整动作 scope 索引和每 gap 的 plan 扫描，**产品原型已撤回**。不能据此宣称 run4 的 180 对历史行或最终增长已被消除。

## 数量与角色

| 项目 | 运行前 | 运行后 | 新增 |
| --- | ---: | ---: | ---: |
| 全部计划行 | 25 | 539 | 514 |
| pending | 1 | 181 | 180 |
| unresolved | 10 | 335 | 325 |
| succeeded | 14 | 23 | 9 |

514 个新行均为 `dispatchScope=false`；439 行带操作 kind，75 行为控件或其他审阅义务。主要新增 reason：`observed_in_scope` 186、`operation_not_executed` 184、`operation_basis_unconfirmed` 40、`classification_unresolved` 32、`region_review_required` 28。其余包括权限、可见性、拦截、身份、重新进入等缺口。不同审阅角色或阻断原因不能直接当成重复操作删除。

447 行首次来源为 `5f80a3df…`（首次完整显露的换币页面）；后续各来源新增 8、25、1、30、2、1 行。这是一轮从小量旧计划进入大量可见控件的发现过程，并非每步固定追加 514 行。

按精确 scope、操作 condition、condition policy、required、dispatchScope、prerequisites 分组，186 组同时含 `observed_in_scope` 与 `operation_not_executed`，合计对应 195 个 discovered 行和 186 个 gap 行。该分组只用于审计，**不证明跨观察的操作身份**。其中 180 组为无 attempt 的 pending discovered 与 unresolved gap，相关未尝试行均为本轮新增。

例：`1W` 的 discovered `9200acd8…` 与 gap `9e65f037…` 都未执行。另一方面，`Trade`、`1h`、`24h` 的两种记账行分别引用同一个真实成功 attempt；这些是一次执行更新两行，不是两次执行。另有同名 Trade 但不同 scope 的待测目标，不能按 label 合并。

最终持久化 projection 属于 `9ca9a659…`，只含 509 行：463 active、22 waiting、23 resolved、1 authority、0 aliases；最终 plan 已有 539 行。因此 335 unresolved / 181 pending 是最终行状态，不能与旧 projection 的 unresolvedGroups=485 直接混算，也不能据此认定 516 个互不相同的操作。

## 调用链与已撤回的最小原型

`runtime.step` 先按 scope + `keyFor` 查已有记录，并创建 reason=`observed_in_scope` 的 pending 操作。随后 `auditRemainingScopes` 将同帧可执行但未尝试的动作记为 `operation_not_executed`。旧 `gap` 只按 reason + scope + condition 寻找记录；reason 不同，因而立即再建 unresolved 行。

原型 `pending-operation.ts` 允许审计复用当前 discovered 行，前提全部满足：同 session、同 observation 的全部来源证据；完整当前 actions 集合中恰好一个精确 scope 动作；action 与 availability 属于该观察；操作、输入类型和值、scope、条件 policy/key、前置路径精确一致；非 dispatch 权限行；pending/unresolved；没有 attempt、执行/覆盖/审阅证明、条件迁移、条件拆分或恢复等待。多个候选行、同名 A/B、不同条件、旧观察、未知/失败历史均不合并。既有 `operation_not_executed` 行仍优先保留，旧双行不删除、不迁移、不计覆盖。

运行时唯一索引仅在同步审计中使用，scope 读取保留空 localId 的原始 `scopeFor` 行为。没有新增权限、执行或身份规则。

## 真实两帧离线验证与边界

聚焦根权限项 + 真实 `1W` discovered 项，实际调用新 runtime 的 `auditRemainingScopes`。输入为每帧真实 Observation、全部 ActionCandidate，以及历史 `scope.audit` 记录中的 executable 事实；completed 设为空，审阅缺口设为空，以隔离重复操作登记。该范围不是完整任务重放。

| 观察 | 禁用新合并逻辑的对照 | 新逻辑 | 说明 |
| --- | ---: | ---: | --- |
| `5f80a3df…` | 3 行 | 2 行 | 根 + 当前唯一 1W；不再生成第二操作行 |
| `c446073e…` | 3 行 | 3 行 | 新观察没有对应证明，保留独立 gap |

对照是在同一当前 runtime 中仅关闭新合并逻辑，不能冒充 868e8b47 独立二进制性能基线。实际旧运行行为另由未修改的原始 JSON 保留。审计没有改变根的历史 attempts，也没有新增成功、执行或覆盖。

`plan-growth-probe.json` 另外实际调用 SDK correspondence：真实 1W / 1h 的跨帧与同帧自对应均返回 `operation_conditions_unavailable`。`keyFor` 相等是调度提示，不能代替该证明。当前 step 也不会仅因旧 pending 行的 hash 相同就追加新的当前来源证据。因此该原型的收益仅限同帧记账；后帧仍可能需要另一行。

后续若要减少长期双行，应先明确“首次发现的待执行义务”和“当前审计缺口”是否可统一成同一种记录生命周期，或由 SDK 提供适用的对应证明，再验证多帧 step/audit/完成链。不能通过跨帧 hash 合并、覆盖 evidence、删除旧未知记录或把缺口标成功来取得数字收益。

## 验证与快照

原型专项覆盖同帧幂等、TaskWriter 往返、完整动作集合的 A/B 歧义、session/observation/availability owner、条件/输入/前置/角色差异、历史 attempt/unknown 保留及跨帧独立缺口；34/34 通过。之前 29 个原型测试加相关 lifecycle + retry 联测共 60/60 通过。最后增加的空 localId scope fallback 经真实离线重算；原型不进入最终产品。

本次离线运行的四文件组合 SHA 为 `24a3b1b7c09163e72c0e034493268f4b8bcc10e8a1751737fc73592ad8020421`；运行前后源码、冻结库和原始任务 JSON 的 SHA 全部一致。单文件 SHA 见 JSON。脚本首次断言误把根已有历史 attempt 当成新增 attempt；修正为根整行不变及新操作无 attempt 后通过，未修改任何原始输入。

原型 helper、34 项测试和 runtime 差异均以 `.txt` / `.patch` 归档到 `pending-operation-prototype/`，另保留实际通过日志与完整 runtime 前后快照。撤回仅移除本原型差异，root 的失败落点重试修复逐字保留。撤回后 runtime SHA 为 `9e7bfa509d9c4356641129ad759d4152af7aad22f19078f69043c91e6bdc1110`，与预期的原型前版本逐字一致；两个新增产品/测试文件已移除。撤回后 `tsc --noEmit` 通过。详见 `pending-operation-prototype/withdrawal.json`。若复现实验，应在独立 checkout 应用归档 patch，不能直接在已撤回的产品树重跑原型脚本。
