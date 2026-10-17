# Factory 版本恢复、覆盖与接续协议复验

固定源码 `900edf7d5c60c3ddcf9265538758033ccecc5832` 的 16 个场景、80 次试验已完成；8 条原协议命令全部 exit 0。与 `run6-fixes-protocols` 的 `125a10ca6dbc78f8dd859a0e7a2917f83d67b55b` 按相同场景及重复序号逐次比较，原行为投影 **80/80 一致，0 差异**。原摘要器对本轮及基线各执行 348 项完整性检查，全部通过；基线摘要重建一致，聚合与逐场景比较也一致。

运行前后 HEAD 均为 `900edf7d5c60c3ddcf9265538758033ccecc5832`，`packages/apps/scripts/tests` 下 462 个源码文件的 SHA-256 逐项相同。四个原协议脚本、fixture 哈希和测量契约与基线一致。原摘要器未修改，SHA-256 为 `d3218b0bdaf619aa57c119fededcfd4420fed5a0d56ed1458a65d1bfff09cf8c`。运行器仅调整固定 revision 与独立输出目录，原 oracle 和各场景 5 次重复数不变。

| 协议 | 试验 | 保留的实际判据 |
| --- | ---: | --- |
| 操作条件 | 25 | 五类声明分支均由 fixture 事件确认；假覆盖 0；两类价格场景每次 100 tick 的计划及待测数量无增长；非局部依赖仍独立执行 |
| 接续 | 15 | lostPending、incorrectlySettled、重复叶节点执行、不必要重入及无进展重复恢复均为 0；冷重启必要重入 15；unknown 重启 5 次均保留原 unknown，重启后新会话、attempt、恢复、JEV、LLM 均为 0 |
| 输入身份 | 10 | 40/40 对应检查符合预期，30 次实际输入成功；包含同名不同 owner |
| 恢复 | 30 | 四个正例场景共 20 次报告、物理到达与后续分支三者一致；偏离目标 5 次保持失败；注入 unknown 5 次即使物理位置已到达仍拒绝成功和后续分支；假到达声明 0 |

unknown 接续场景保留未执行 Branch B 是预期安全结果，不能称为全部覆盖。以上判据依赖实际 fixture oracle、SDK 派发及持久接续信息，不以队列清空或退出码单独宣告成功。

比较范围沿用原摘要器：排除时间、随机 ID、临时端口、不透明哈希、被动价格值、完整 proof 文本，以及原始 plan/event 文本；保留状态/原因、输入值、分支事件、unknown 身份延续与阻挡、重入、预算和全部 tick 数量。原始 JSON 保留供复核。这里证明的是原协议行为投影一致，**不声称原始 plan/event 逐字一致**，也不证明真实站点穷尽。

本次只创建协议自己的本地 fixture server、headless browser 与临时库，无真实 provider、真实浏览器或 OKX 任务库访问。原脚本完成 close/临时目录清理路径，8 个子进程和 runner 均正常结束。并行另有隔离构建；时间只留作追溯，不用于性能或提速结论。

复现入口为本目录 `runner.py`（输出目录必须尚不存在），准确命令、退出码见 `commands.json`；原始输出为各编号日志与 `runner.log`。摘要/逐次比较命令及退出码见 `analysis-commands.json`，结果见 `validation.json`、`comparison.json`、`trial-comparison.json`。`source-before.json`/`source-after.json` 为逐文件源码快照；`files.json` 为本证据目录产物清单。未修改产品、测试或原始历史证据，未提交。
