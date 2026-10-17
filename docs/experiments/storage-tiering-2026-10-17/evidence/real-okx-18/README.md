# Run18：局部目标恢复通过，全局恢复超时未结算

测试提交：`9fed86cc9bf03ae03f5e9b1b3b7db88ac9231762`，分支 `codex/exploration-layered-refactor`。工作区：`/Users/xietian/.codex/worktrees/exploration-layered-refactor/browser-interaction-engine`。开始时无已跟踪文件的未提交修改；三个既有未跟踪项保留。本轮只新增验收材料，没有修改产品代码。

**结论：此前失败的局部 Close → Trade → USD 目标到达链路已在真实 OKX 通过。整窗验收仍未通过：全局恢复已执行，但未在共同的 240 秒预算内返回。** 不延长预算、不自动重跑。

## 协议与隔离

沿用 [run17 脚本](../real-okx-17/run.mts) 和同一份 [历史目标与路径](../real-okx-17/source-plan.json)，`requireSourceEquivalent=true`。先完成局部恢复，再真实导航至 OKX 首页，随后恢复原历史目标。所有浏览器启动、设置和恢复共用一个时钟；首失败即停。

仅补充截止门禁，见 [protocol.json](protocol.json)。历史引擎材料来自已结束的 v8；只复制可变引擎文件，6907 个不可变证据 blob 共享文件链接，原材料内容前后哈希一致。没有复制或打开插件任务库，没有连接已有浏览器、启动或停止用户服务。新浏览器由本轮 SDK 独立创建。

## 功能结果

| 项目 | 真实结果 | 耗时与处理量 |
|---|---|---|
| 初始设置 | USD 目标确被初始 dialog 遮挡 | 54.999 秒；2 次捕获 |
| 局部退出 | Close 成功；退出初始边界；同文档且未导航 | attempt 7.637 秒，含动作后捕获与处理 |
| 局部历史重入 | Trade 成功；无入口重放或跨页动作 | attempt 8.893 秒，含动作后捕获与处理 |
| 局部最终到达 | `CURRENT_REVIEWABLE`、来源条件 `equivalent`、目标现场校验通过 | 局部 API 共 73.885 秒；2 次目标 preflight 合计 2.109 秒 |
| 全局场景设置 | 导航至 OKX 首页，历史与当前 browserSessionId 都存在且不同 | 18.193 秒 |
| 全局入口重放 | 首页 Close 后，确实执行 `recovery-entry` 和 driver `reopen`；入口动作成功 | 入口 attempt 6.938 秒，其中 reopen 调用 1.029 秒 |
| 入口后的历史动作 | 两次 checkbox 操作均有 succeeded 事件 | attempt 分别 6.083、6.058 秒；不能仅凭同名判定重复 |
| 全局最终到达 | **无返回、无目标 preflight、无最终 SDK 结算** | 全局调用从约 147.3 秒开始，在剩余约 92 秒内未完成 |

局部的 [local-recovery.json](local-recovery.json) 是完整已返回的 SDK 结果；全局只有 [timeline.jsonl](timeline.jsonl) 的已发生事件。没有伪造缺失的 `outcome.json` 或 `global-recovery.json`。

Trade 的 `recoverySegment.outcome=unverified` 原样保留：严格 canonical 中间匹配没有成立，最终目标到达由独立的来源条件和现场检查成立。不能把它改记 matched，不能把此次目标恢复当作严格 checkpoint 相等，也没有执行恢复后的新业务动作或授予新覆盖。

## 预算与性能：没有获得加速结论

[launch.json](launch.json) 记录外部监督进程在 **240.004 秒**请求终止，**242.080 秒**以 `-9` 结束，后两秒属于终止宽限。没有 235 秒 deadline 事件和正常 close 回执，不能声称内部软停止已执行。最后一条事件在 235.585 秒；同步工作或微任务阻塞是可能解释，具体原因尚未证明。结束后进程列表未发现本次 runner 或 Playwright Chromium 进程；不把进程退出等同于 SDK 正常关闭。

[audit.json](audit.json) 将已完成的驱动调用与外层阶段分开：

- 局部 API 73.885 秒，驱动调用合计 20.744 秒，剩余 **53.141 秒（约 72%）**在所测驱动调用之外。不是把 API、attempt 和驱动耗时相加。
- 初始化 54.999 秒，其中已测驱动调用 11.299 秒；其余 43.700 秒还包含 SDK 处理与设置阶段的对应核验。
- 多个 `observation.created` 事件后到下一个驱动动作出现约 13–17 秒间隔。入口第一次捕获后到 reattached 约 25.9 秒。这是优先排查信号，不是 CPU 栈证明。
- 合计 **11 次捕获、26 个已完成驱动调用、6 个成功动作事件、1 次恢复入口重开、0 次模型调用、0 项新覆盖授权**。全局成功动作不计作目标恢复成功；两次 checkbox 的值未包含在时间线摘要里，不能按同名认定无理由重试。

静态检查发现可核查的热点候选：`packages/browser/src/index.ts:773` 的 `afterCapture` 多次取得动作并构建/核验不同审阅材料；`packages/core/src/engine.ts:1612` 到达校验逐候选调用单项对应；`packages/adapter-playwright/src/branch-conditions.ts:94` portable 条件可重新构造结构 reader。这些调用确实存在，但本次计时没有分离其贡献，不能直接认定哪个函数造成 53 秒。

下一步应对保留材料做一次有界离线剖析，定位观察后处理、动作材料、模式引用和到达核验各自的调用次数与耗时，再决定共享事实缓存的范围及失效条件。应保持对应唯一性、模式变化、实时 preflight 和 unknown 门禁；不能靠跳过合法候选获得速度，也不应先扩大线上预算。

run17 局部失败只用了 23.811 秒，run18 局部完整成功用了 73.885 秒；工作量和结果不同，**不得作为相同工作量的性能前后对照**。此次可以证明局部恢复功能进展，不能证明性能收益、全局恢复成功或页面穷尽。

## 独立核验与保存边界

`acceptance_metrics_review` 只读核验了局部初始/最终文档、两次动作、退出 transition、现场校验和全局事件，确认“局部通过、全局已触发但未结算、整窗不通过”。未运行第二次验收或打开数据库。A/B 和 unknown 跨重启沿用上一补丁的回归证据，本次真实目标恢复没有重新测试这两项。

原 v8 的 7263 个引擎文件、179287032 字节前后哈希一致；任务库未复制或打开。新 v18 是被强制中断的独立工作副本，保留原 SQLite/WAL 证据，没有重新打开 SDK 或把它改记完成。
