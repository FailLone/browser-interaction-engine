# 恢复候选局部索引：原协议复验

固定源码 `cbd5b878329f8d3e454e8fd5110d0e2da4f749a7` 的 16 个场景、80 次试验已完成，8 条原协议命令全部 exit 0。与 `run6-factory-protocols` 的 `900edf7d5c60c3ddcf9265538758033ccecc5832` 按场景及重复序号比较，原行为投影 **80/80 一致，0 差异**。原摘要器对本轮与基线各做 348 项完整性检查，全部通过；基线摘要重建、聚合和逐场景行为也全部相同。

运行前后 HEAD 均为 `cbd5b878329f8d3e454e8fd5110d0e2da4f749a7`，`packages/apps/scripts/tests` 下 463 个源码文件的 SHA-256 逐项相同，归档时产品及测试工作区无修改。四个原协议脚本、fixture 哈希和测量契约与基线一致。摘要器未修改，SHA-256 为 `d3218b0bdaf619aa57c119fededcfd4420fed5a0d56ed1458a65d1bfff09cf8c`。运行器仅更换固定提交、基线及独立输出目录；oracle、场景和每场景 5 次重复数未改变。

| 协议 | 试验 | 实际判据 |
| --- | ---: | --- |
| 操作条件 | 25 | 五类声明分支由 fixture 事件确认，假覆盖 0；价格场景每次 100 tick 的计划/待测数量无增长；非局部依赖仍单独执行 |
| 接续 | 15 | lostPending、incorrectlySettled、重复叶节点执行、不必要重入和无进展重复恢复均为 0；冷重启必要重入 15；unknown 重启 5 次均保留原 unknown，重启后新会话、attempt、恢复、JEV、LLM 均为 0 |
| 输入身份 | 10 | 40/40 对应检查符合预期，30 次实际输入成功，包含同名不同 owner |
| 恢复 | 30 | 四个正例场景共 20 次报告、物理到达及后续分支一致；偏离目标 5 次仍失败；注入 unknown 5 次即使物理到达，也不宣告成功或派发后续分支；假到达声明 0 |

unknown 接续场景保留未执行 Branch B，是预期安全结果，不能声称全部覆盖。结论依赖原 fixture oracle、SDK 派发与持久接续信息，不只依赖队列清空或进程退出码。

比较范围沿用原摘要器：排除时间、随机 ID、临时端口、不透明哈希、被动价格值、完整 proof 文本以及原始 plan/event 文本；保留状态/原因、输入值、分支事件、unknown 身份延续及阻挡、重入、预算和全部 tick 数量。原始 JSON 全部保留。本报告证明原协议行为投影一致，**不声称原始 plan/event 逐字一致**，也不证明真实站点穷尽。

CPU 基准正式释放后才启动本轮协议。仅使用四个原脚本自己建立的本地 fixture server、headless browser 和临时库，无真实 provider、真实浏览器、OKX 任务库或 main 构建操作。原脚本完成 close/临时目录清理路径，8 个子进程及 runner 正常退出。根线程可能并行执行类型验证；本轮时间仅保留作追溯，不用于性能或提速结论。

`runner.py` 为复现入口（输出目录必须尚不存在）；`commands.json` 记录原始命令及退出码。编号日志与 `runner.log` 保留完整输出。`analysis-commands.json` 记录摘要与逐次比较命令/退出码，结果见 `validation.json`、`comparison.json`、`trial-comparison.json`。源码快照见 `source-before.json`/`source-after.json`；本目录产物 SHA 见 `files.json`。未修改产品、测试、原始历史证据，未提交。
