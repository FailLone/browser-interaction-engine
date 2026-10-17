# 第七窗修复：原 80 次协议复验

固定产品 `e06f057ecc1fd43feaa8cfa42d14c65e9750a08e`（有界来源读取优化与审阅源可见性门）的原 16 场景、80 次试验已完成。八条原命令全部 exit 0；原摘要器对本轮及基线各 **348/348** 项完整性检查全部通过。与 `run7-selection-protocols` 逐场景和重复序号比较，原行为投影 **80/80 相同，0 差异**，聚合及逐场景分布也相同。本轮没有需要解释的投影计数差异，也没有为了相等而调整 oracle。

基线要求为 `106a1cdfddfe3e73cab9e01b28ba4dd8439653e2`。其对应已归档协议实际运行于 `cbd5b878329f8d3e454e8fd5110d0e2da4f749a7`；两个提交在 packages/apps/scripts/tests 下无差异，已在 preparation.json 记录。旧协议文件和其实际 revision 原样保留，没有重标为 106a。

| 协议 | 次数 | 原始事件/守卫结论 |
| --- | ---: | --- |
| 操作条件 | 25 | 五类声明分支全部实际执行，假覆盖和遗漏均为 0；每次 100 个价格 tick 没有计划/待测增长；共享标识重建和非局部依赖仍执行各自分支 |
| 接续 | 15 | 丢失 pending、错误结算、重复叶节点、无理由重入及无进展重复恢复均为 0；冷嵌套接续必要重入合计 15 |
| 输入身份 | 10 | 40/40 对应判据符合预期，30 次实际 A/B/C 输入成功，含同名不同 owner |
| 恢复 | 30 | 四类正例共 20 次报告、物理到达及后续派发一致；5 次局部逆操作偏离仍失败；5 次注入 unknown 即使已物理到达仍不报成功、不继续派发 |

unknown 跨重启五次均保留注入的同一 unknown receipt，重启后新会话、attempt、恢复、JEV 和 LLM 均为 0。Branch B 保持未执行是负例所要求的阻挡，不能据此宣称全部覆盖。结果依据 fixture 的实际事件 oracle、SDK 派发、来源与持久接续证据，不只依据队列清空或退出码。

四个原协议脚本、fixture 哈希和测量契约与基线一致。原 summarize.py 字节不变，SHA-256 为 `d3218b0bdaf619aa57c119fededcfd4420fed5a0d56ed1458a65d1bfff09cf8c`；compare-trials.py 仅改基线目录/标签，原投影和完整差异函数未改。全部逐 trial 差异保存在 trial-comparison.json 中，即使发生计数差异也不会截断、过滤或自动归因为可见性修复。

比较范围沿用原摘要器：排除时间、随机 ID、临时端口、不透明哈希、被动价格值、完整 proof 文本及原始 plan/event 文本；保留状态、原因、输入、分支事件、unknown 身份保留/守卫、重入、预算和全部 tick 数量。原始八份 JSON 全部保留。因此这里证明的是原协议行为投影一致，不是原始 plan/event 逐字相同。可见性缺陷的实际分支变化由独立 visibility 专项和真实冻结材料反事实验证；这 80 个旧场景没有被改写去制造该分支，也不证明真实站点穷尽或旧 checkpoint 可恢复。

运行前后 HEAD 均为 e06，467 个源码文件 SHA-256 逐项相同；工作区产品、脚本和测试未修改。runner 只绑定固定提交并替换输出路径，未构建 main，未修改产品/测试或旧证据，未提交。

本轮在 root 的 source-material 基准和 task_storage 的冻结反事实均结束后启动，只运行原脚本自己创建的本地 fixture server、headless browser 和临时库，无真实 provider、用户浏览器、真实站点或 OKX 任务库。八个子进程及 runner 均正常退出，原脚本的 host/plugin/server close 与自有临时库清理路径正常完成。可能有其它工程验证并行，耗时仅保留作追溯，不作性能或提速结论。

复现入口 runner.py（`/tmp/bie-run-run7-fixes-protocols.py` 同内容）要求已绑定完整 SHA、明确 CPU 释放、干净产品树和未运行过的自有输出目录；不会覆盖本次结果。commands.json 保留八条原命令/退出码，runner.log 和编号日志保留原始输出；analysis-commands.json 保留原摘要器及 trial 比较命令/退出码，完整结果在 validation/comparison/trial-comparison/behavior JSON。source-before/source-after 为源码快照，files.json 为最终产物哈希。preparation.json、preparation-files.json 及 preparation-readme.md 保留运行前准备状态，后者内容对应准备清单中的旧 README.md 哈希。
