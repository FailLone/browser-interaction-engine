# 选择周期：唯一冻结输入集成

固定产品 `551a6b9020b919862434346d276a21fe3d1f4ac1`。只运行一次，进程上限 240 秒；没有旧版重跑、预热、补样本或真实网页操作。输入引用已关闭 run12，使用独占临时 engine 库副本，只将 task.status 在内存从 paused 改为 running。

**结论：这个固定输入的恢复候选选择在 8.526 秒内完成；重复的事实构建明显减少。返回无候选，不能据此宣称实际恢复成功、新覆盖或第 3 项完结。**

## 耗时与实际处理量

完整 worker 进程 9.857 秒，正常退出 0。阶段数据来自 [report.json](result/report.json)，原始调用边界在 [worker.jsonl](result/worker.jsonl)。

| 阶段 / 工作 | 耗时 | 实际处理量 |
| --- | ---: | --- |
| 输入验证 | 118.603 ms | 原输入哈希及 1241 行计划等前提 |
| 浏览器入口拒绝门 / 模块导入 | 219.414 / 353.233 ms | 仅独立 worker 内的 Playwright 启动和连接入口 |
| SQLite / Engine 构造 | 3.620 / 139.111 ms | 临时副本，构造累计 2 次 SQL 修改 |
| 当前 observation / actions / availability | 33.812 / 14.334 / 230.850 ms | 各 1 次外层准备读取 |
| **scheduledRecovery** | **8526.227 ms** | 完成一次选择，返回 undefined |
| ↳ SDK view 建立 | 214.579 ms | 取得 1 次，内建完整 availability 1 次 |
| ↳ 完整来源材料 | 2934.274 ms | 91 次 / 58 不同来源 / 33 次重复，返回 19118 个 action 行次 |
| ↳ 轻量锚点 | 612.409 ms | 35 次 / 35 不同来源 / 0 重复 |
| ↳ checkpoint 策略评估 | 2086.577 ms | 1 次，1 个 checkpoint |
| ↳ 显式 view 新鲜性检查 | 161.210 ms | 1506 次，无失效错误 |
| ↳ checkpoint 清单 | 0.262 ms | 1 次，57 行 |
| 完整输出核验 / 序列化 | 18.745 / 24.792 ms | 完整 task、事件、旧债及 selection 一份 |
| plugin / engine 关闭 | 0.071 / 0.866 ms | view 已关闭 1 次，数据库句柄已关闭 |

缩进项属于 scheduledRecovery，不能再与它相加。view 方法内部的版本检查、SDK 组合读取和原始 SQL 访问未另行计数，不是零；19118 是返回行次，不是唯一动作或实际执行量。InspectionCoordinator 的初始 sweep 和每秒计时器保留，后台成本未独立归因。query_only 后 SQL 修改为 0。

同一冻结输入的 [前次新版检查](../recovery-candidate-bounded/README.md) 在 240 秒仍未完成：selection 中完整 availability 已执行 544 次、完整来源构建完成 2772 次、锚点 857 次。本次完整 availability 为调用者准备 1 次 + view 建立 1 次，选择循环不再逐批重建；完整来源 91 次、锚点 35 次。两个旧样本没有完整终态，计量方式也不同，因此不报告精确加速比例、统计显著性或真实输入完整 A/B 语义等价。

序列化前 RSS 为 1,243,463,680 B，进程记录峰值 maxRSS 为 1,271,168 KiB；本次不支持内存下降结论。8 项是完整来源缓存上限，不是进程所有存活对象上限。持久化格式没有改变，磁盘占用改善也未被此实验验证。

## 完整输出和保留范围

主线程独立核验结果保存在 [verification.json](result/verification.json)：

- 完整 task 仅顶层 `status` 与 `scheduling` 改变；1241 行计划、预算、usage、rounds/cursor 逐字段保留。
- 8 条旧路线债完整保留，unknown/失败历史没有通过本次扫描被释放。
- deferred 从 1149 行到 1173 行，55 行新增或更新（24 新增、31 更新）；55 条有序事件均与其对应，均保留待测项且不给覆盖。原因分别为 source_target_unverified 18、retained_checkpoint_unavailable 14、current_review_occurrence_present 22、checkpoint_no_known_path 1。
- selected=null；callback 为 `not_selected`，没有调用最终 recovery revalidate，不能记作通过。正向候选、最终验证与变化阻断仅有[受控检查证据](../recovery-selection-epoch/README.md)。
- 零恢复派发、零浏览器到达、零本轮实际操作和新覆盖；这不是页面无路可达或穷尽证明。

完整语义只保存一份 gzip，位置及逻辑/压缩哈希见 [execution.json](result/execution.json) 的 semanticArtifact；没有重复保存原库或原 task 为新输入。

## 隔离与复核

[runner.py](runner.py) 复用已审阅的历史归档、指纹及终止 helper，固定产品源码独立归档。[worker.ts](worker.ts) 只包装外层 host 和返回 view；没有覆写 SDK、adapter、store 读取函数或原型。view 不可用时直接失败，不退测旧路径。Playwright 启动/连接入口在 worker 内拒绝；host 仅允许列明的查询方法。

父进程确认 worker PID 7664 正常退出后才删除自己的临时目录，主线程再次确认 PID 与目录均不存在。原冻结输入、工具、归档源码哈希一致；固定产品与已测文件哈希一致，语义压缩包哈希和全部保留字段通过独立核对。未连接原冻结库、未修改其他工作区、未操作原测试浏览器或服务。未合入 main，也未追加验收窗口。

本轮停止在这个检查点。仍缺真实成功到达后的新覆盖证据；有效候选很多、频繁写入导致整轮失效、投影容量超限时的实际成本也不能从此样本外推。下一步若继续优化，应由剩余阶段数据决定，不用重复完整长跑来搜索问题。
