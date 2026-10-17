# 固定 OKX 局部／全局回放及实际续测通过

验收产品：`0bcfdcef891736f270ccdfa0f5785e0a9115c4d5`，分支 `codex/exploration-layered-refactor`。在独立浏览器和冻结 v8 引擎副本上，一次共用 240 秒窗口用时 **201.022 秒**，正常关闭。原测试浏览器、服务和任务库未操作，原始 engine 文件逐字节不变，验收进程组无残留。没有模型调用。

## 实际结果

| 阶段 | 耗时 | 结果 |
| --- | ---: | --- |
| 局部恢复 API | 42.414 秒 | Close 同文档退出 → 记录中的 Trade → 原 USD 来源等价、当前目标可交互；0 entry／跨页 |
| 局部续测及核验 | 12.791 秒 | 唯一对应历史 USD 金额输入框，经 SDK interface guard 填入 `2`，持久回执、观测值和 live 值一致 |
| 全局场景准备 | 11.863 秒 | 独立浏览器真实导航至主页，捕获当前事实 |
| 全局恢复 API | 91.768 秒 | Close → 新浏览器会话 entry → 历史 check(true)、check(false)、Close、Trade → 原来源等价且 live 目标有效 |
| 全局续测及核验 | 13.307 秒 | 新会话中同一历史输入目标唯一对应，经 SDK guard 填入 `3`，持久回执、观测值和 live 值一致 |

局部到达 live 检查两次合计 1.337 秒；全局到达 live 检查两次合计 1.360 秒，均已包含在恢复 API 时间内。全局的 6 个成功回执包含 1 次 entry 和 4 步历史重放；两个同名复选框操作分别输入 true 和 false，不能只凭标签计为无理由重复。

全局 setup 的 browserSessionId 为 `540a5871-19c8-4771-8377-026ac35ea5c7`，恢复后为 `9009a93f-f30f-4f59-8eb7-d378256ed5e3`。实际 `reopen` 返回，且独立的新会话标识核验通过。所有结果验证都使用真实当前观测；没有改写历史来源、身份、权限或图边。

两次续测前均无相同输入历史，执行后 clean、unknown 0、无关键采集缺口。**未测仅相对于冻结 v8 及本窗保留历史**；独立 run19 已执行过输入 2，这不是跨全部实验首次执行或新业务语义分支的证明。

## 超时修复与剩余成本

唯一产品补丁针对 `capture → interventions.sync → frontier → reconcileCoverage` 中不可能匹配成功证据的候选，先做必要字段排除，再保留原完整匹配与 receipt fallback；没有放宽到达或执行验证。[离线配对](../global-recovery-cost/README.md)保留相同输出，材料构建 14.405→5.966 秒；真实路径在本窗完成，之前 run18 在同样 240 秒总预算中尚未到达全局目标。新窗增加了实际续测，因此不能把两窗直接换算成整体提速百分比。

全局恢复 API 91.768 秒中，已测 driver 调用合计 31.540 秒，余下 60.228 秒包含 SDK／存储／历史材料核验等，未进一步拆分，不能全归因于某个函数。仍存在成本优化空间；此次固定交付完成后没有为取得更好时间重复跑。

## 验收契约与边界

[run19](../real-okx-19/README.md)原协议误将未来覆盖复用资格作为实际续测成功门，停止在局部续测之后。原结果维持 `not_accepted`。本窗在启动前修订协议：完整保留唯一对应、执行约束、live 检查，增加精确持久回执绑定、完整结果与 clean/no-unknown 条件；覆盖复用另列。两位独立只读审查者确认该区分符合固定目标。

两次 `operationReceiptCondition` 均为 `actualSuccess=true`、`conditionVerified=false / identity_pending`。**本次没有交付可复用的新条件覆盖**，没有把拒绝改成成功；这项后续问题不应被当前路径通过掩盖。历史段严格结果仍记 `unverified`，最终独立来源／目标到达证明通过，不等于完整检查点指纹相等。

此结果只证明本次两条固定路径实际可用。未测任意网页的恢复成功率、完整页面穷尽、插件自动调度、任意快照还原或无登录信息的新用户初始化。新浏览器会话沿用该测试的存储状态契约。

唯一原始证据见 [outcome.json](outcome.json)、[局部恢复](local-recovery.json)、[全局恢复](global-recovery.json)、[局部续测](local-continuation.json)、[全局续测](global-continuation.json)、[阶段核对](audit.json)和 [timeline.jsonl](timeline.jsonl)。API／driver／回执／到达检查时间存在嵌套，不可直接相加。
