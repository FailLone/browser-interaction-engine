# 缺少目标条件时的严格检查点恢复候选

本补丁只绑定一个结论：缺少 portable target 条件不再自动排除具有明确 SDK 严格恢复候选的唯一来源操作；它不授予目标对应、执行或覆盖权限。

工作区为 `/Users/xietian/.codex/worktrees/exploration-layered-refactor/browser-interaction-engine`，分支为 `codex/exploration-layered-refactor`，起点 `9546daf395b7a69a9947eca8092b560516f66442`（前一产品 `63c57e5`）。开始时只有原有未跟踪的 `okx-launch-7.json`、`okx-launch-7.log` 和 `task-store-full-read/performance-checkpoint-5eca079/`，本轮均未修改或纳入提交。

## 已证实的问题及修复

插件 `scheduledRecovery → projectSourceItem` 原先要求所有操作来源都能生成 `browserTargetConditions`，早于严格 checkpoint / portable target 的模式选择。SDK core 的严格恢复有独立的 canonical、context、predicates 和到达验证，并不要求 portable target 条件。

反例包含 33 个已捕获、各有语义标识的隐藏模式控件，超过完整分支条件投影的 32 项上限。投影拒绝等价是正确的，但插件不应因此拒绝所有严格恢复。真实 core 的保留事实 API 在这个合成来源上返回 `tryable`，旧插件仍然不选候选。另一个独立的纯内存 Counter 状态机证明：没有 portable target 条件时，core 确实可严格恢复到谓词与 canonical 均相符的检查点。后者不是前一个合成页面的实际到达测试。

插件现在要求该新增通道同时满足：唯一来源操作及原 operation binding、现有来源/上下文/当前路线门禁、身份一致且无 blocker 的 SDK `tryable`、至少一个可尝试策略、所有授权字段为 false。缺接口、unknown、异常和不合格评估都不新发放候选。`targetActionIds` 为空，确保后续调用 `reachCheckpoint`；原目标执行与覆盖核验仍独立进行。

缺少来源条件不能隐藏原 conditioned/composite 债，也不能在恢复条件证明后绕过已经消费的无条件预算。有明确不同条件的 A/B 普通失败预算仍独立。普通失败按到达合同关联：严格 checkpoint 失败不消费另有合法路径的原生页面返回；unknown 跨合同阻断。最终派发前重新读来源、checkpoint、相关债务及正面 SDK 判断，不复用已关闭选择周期的许可。

## 有限验证

| 检查点 | 结果与证据 | 复验理由 |
| --- | --- | --- |
| 修改产品前的反例 | [red.json](red.json)：1 通过、1 失败 | 内存 core 严格恢复成功；同一测试文件的插件正面候选断言在旧实现失败。 |
| 初版修复相关组 | [targeted.json](targeted.json)：101/101 通过 | 新通道、旧候选、来源筛选、选择周期失效与容量边界。 |
| 独立静态审阅发现跨合同误拦 | [arrival-contract-red.json](arrival-contract-red.json)：1 失败、34 未运行 | 精确复用现有 `explorer-source-return-scheduling.test.ts` 的 mapped strict failure 用例，证明初版债务关联范围过大；不复制夹具。 |
| 初次类型检查 | [types.txt](types.txt)：3 个新夹具字段缺失 | 补齐 gap.code、unknown context.value、session.dirty；不放宽产品类型。 |
| 冻结后的最终定向组 | [final-targeted.json](final-targeted.json)：7 文件，137/137 通过 | 修正跨合同关联、补齐夹具并增加 epoch 关闭后的正面候选重新核验。共享调度逻辑变化，故重验相关组；未运行全套或长基线。 |
| 最终类型检查 | [final-types.txt](final-types.txt)：退出 0，无诊断 | 上述类型修正及最终产品变更。 |

[final-inputs.json](final-inputs.json) 绑定起点、产品文件和七个测试文件的 SHA-256，最终运行前后均一致。新增文件有 24 个用例；包括来源歧义、operation 条件变化、critical gap、unknown context、当前目标歧义、旧债序列化后保留、动态价格/捕获 ID 不续期、条件证明恢复后的旧预算、A/B 独立、最终事实/策略/债务变化阻断。旧债序列化测试不冒充真实进程重启；原真实跨重启实验没有重跑。

## 性能、存储与能力边界

保留已有 selection view、纯投影小表、合作式 yield、容量和失效规则。SDK 策略缓存仍最多 8 项，每次 yield 清空；最终正面核验强制重读。新增测试中，一个候选选择只查一次 SDK，最终复验另查一次；歧义等便宜前筛失败不查 SDK。既有 20 个 selection cancellation/capacity 用例继续通过。

未增加持久化格式、全量来源缓存或任务库数据迁移。相关路线扫描仍随候选数和路线数增长，每个候选还可能检查路线的最多 16 条条件记录；此前被错误挡住的候选现在会产生必要核验成本。因此不宣称性能不变或提速，也不把旧 240 秒/真实冻结输入数据重标为新版结果。

所有新验证只用自有内存数据和纯内存 driver；没有操作浏览器、启动/停止服务或访问原任务数据库。未运行发布构建、合并到 main、开启真实实验或调用 JEV/LLM。

第 1 项离线合同修复完成。仍需后续发布/API 兼容检查，以及独立、有界的真实恢复与新覆盖联合验证；SDK `tryable`、受控严格恢复成功、队列结果均不能证明 OKX 已恢复或探索穷尽。若真实合法来源仍因旧债关联误排除、未知结果被绕过、或新增候选核验引发不可接受的重复读取，应在现有选择周期方案上修正对应问题，不能退回旧优化版本或降低验证标准。
