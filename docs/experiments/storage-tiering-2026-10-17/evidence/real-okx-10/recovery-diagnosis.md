# Run 10：已在场审阅项仍回退旧来源

本次只读诊断对应 `4f868d68494dd59853f2a6d03afb5d80e695e532`；未修改产品、运行测试、启动浏览器/服务、重新执行 SDK audit 或提交。唯一结论：**审阅项在一个有证据关联的近期来源上已经通过现有 occurrence 连续性条件，但 `scheduledRecovery` 只跳过该 checkpoint，仍可选中同项的更旧来源。** SDK 对最终旧来源的拒绝正确；本诊断没有证明任何替代路径能恢复旧画面。

## 既有证据与有限读取

- Run：`717bba24-03b5-487f-a96a-b60ef8cd9972`，导出位于 `.data/okx-storage-acceptance-20261017-v3/runs/<run>/`。复用 `metrics.jsonl`、`task-before.json`、`task-after.json`、`coverage-review.json` 及本目录 `receipt-audit.json`，不复制整套输入。
- `task-before.json` SHA256：`d8fcd76cee8bc39e90761c4a20da91a9624270b51a250b5a0714d507ff11c752`；`task-after.json`：`09875e1a2cb77d74221c7530b84ea6f466e5149bd0fceeb3cb5d0b8bab16f581`。
- 仅打开已结算独享副本 `/private/var/folders/s9/dy_jbdrs3fn1qzt_gnsy4tgw0000gn/T/bie-run10-receipt-audit-j3_8w95r/engine/engine.sqlite`，SQLite URI `mode=ro&immutable=1`。读取下列四份 observation 和前三份对应 checkpoint；未穷举状态图/历史 checkpoint。结构块、pack、重建 observation 均校验长度与 SHA256。一次字段展示错误后修正读取表达式；不是验收重跑。
- 主 DB 前后均为 127401984 bytes，SHA256 `a1dfbc1534374ecab30888d4119a5221fa0ad34d8225bdfabb59cc8e20d24cc4`；WAL/SHM 前后均不存在。连接已关闭，副本保留并释放。
- 仅对保留对象调用纯 `controlScopeMatcher`、`currentHistoryAnchor` 和 `BrowserEngine.prototype.transitionForObservations`，没有构造 Engine、Store、host，也没有执行 SDK batch。下述分支判定是代码与保留事实的投影；运行日志没有逐候选 reason 事件。

## 实际来源与触发链

待测项 `a244066d-3c7a-41c2-a430-5a579f67f3ba` 为 `classification_unresolved`，scope 含精确 URL、页面 region、generic role、`id:headerContainer` 和收起菜单时完整名称。前后均 `unresolved`，没有 attempts。

| 观察 | header 实例 | 与当前连续性 | 当前历史锚点 |
| --- | --- | --- | --- |
| 旧来源 `e6b34ad6-8e3f-4ec1-a126-e525899b75d3` | `cb5c7267-b2f8-4686-ab5c-6b90256c5d53:642` | 跨 instanceScope，无 retained target | false |
| Close 后来源 `d85c8536-8efe-4b97-9d47-9482d53f6f4d` | `b9eeda45-e0a5-4f52-b950-76f98659d314:643` | 与当前同一唯一实例 | true |
| Trade 后当前 `fb945d9c-9b51-4a7c-a1ed-2e966944ffc1` | 同上 `:643` | visible/enabled 均 true | — |
| 失败后 `5b1dbdbe-28db-4e98-bb36-7fab92bf5333` | 同上 `:643` | 菜单仍展开 | — |

四份观察都没有 critical gaps、没有 boundaries，context 为 `{}`。近期来源的精确 scope 匹配唯一 header；它及当前的 instanceId 计数均为 1。Trade 展开后 header 名称包含菜单文本，因此当前精确旧 scope 匹配为 0；这不妨碍 SDK 的同实例 occurrence 连续性，但不能推出分类/操作等价。

近期来源已加入该 item 的 evidence，且存在 checkpoint `166bc972-73c0-44e3-afaa-b57785417abb`。`runtime.ts:771–776` 按 evidence/本浏览器历史锚点优先处理它；`runtime.ts:790` 的 source 可见/边界检查通过。纯 transition 给 `verified=true`、`documentChanged=false`、retained target `:643`，所以 **`runtime.ts:809` 必然得到 `current_review_occurrence_present`**，并 `continue` 下一个候选。

旧来源仍精确匹配 item，但无当前 retained target、无当前精确 scope 匹配。最终日志 sequence 10103/10104 记录选择旧 checkpoint `fab896e5-dae5-45e7-a62f-fd5755eae2b3`，route `7630d1f6555cb1a9903a8dc9eacbab276d400f7bc579adc32f2d991645bd6164`。其 route debt 在 task-before 不存在，task-after 正确保留一次 unreachable 和失败终点条件；这不是忽略该 route 已有失败债的重试。

`reach` 返回 `Checkpoint path contains actions without replay permission`、attemptIds `[]`。不能仅据此在调度端把整条 checkpoint 预判为无路，因为 SDK 还允许当前验证、边界退出、合法 native return、状态图路径、局部恢复。此次 defect 是已在场 item 的候选循环继续回退，不是已证合法恢复路径被漏用。

既有 audit 的 4 条 document condition 覆盖属于 checkbox true/false、Close、Trade。它们保留正确，不自动完成 header 分类审阅；本诊断没有增加覆盖。

## 最小补丁建议与可证伪结论

仅把 `current_review_occurrence_present` 从候选级跳过改为 **item 级 defer**，结束该 item 的 checkpoint 循环，再选择其他工作。保留 item/evidence/历史 debt，不复用分类结果，不标记到达或完成；`source_review_target_not_available` 等其他拒绝仍继续搜索来源。无需新增“非许可 path 即无路”的调度预检。

单一可证伪结论：**当一个有证据关联、通过现有 source 门槛的来源已通过现有唯一 occurrence 连续性证明当前可见启用实例在场，调度不应再为同一 review item 回退旧 strict checkpoint。** 一个针对性用例保留近期/旧来源两候选，近期同实例因菜单展开而名称变化；期望无该项恢复派发、item 仍未解决、证据和债不变。移除连续性或令实例隐藏的对照应仍允许寻找其他合法来源，不能无条件 break。

边界限制：现有此分支只显式检查 source 的活动边界成员；current 检查为 visible/enabled，没有额外成员门。真实反例两侧都无 boundaries，因此本结论不扩大到有活动边界遮挡的场景。没有测试补丁、执行反事实调度或开启下一真实窗口。
