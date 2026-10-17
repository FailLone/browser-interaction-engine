# 当前独占边界出口的调度优先级

2026-10-17 的唯一一次专项运行通过 16/16。命令、退出码 0、两份源码的运行前后 SHA256 见 `result.json`。`test-output.txt` 是从已有工具返回抄录的测试可见输出，不是当时重定向保存的逐字节 stdout；整理本目录没有重跑测试。

修正只在现有 `local` 候选已经通过 availability、唯一性、freshness 和 scope 筛选，且没有 inPlace 工作时生效：最末 overlay 与 boundary 必须同 key；有控件的出口须属于其 controlIds 或 exitControlIds；无控件出口仅消费既有 Escape 或 reviewed dismissal 语义。满足条件的当前出口先于 remote 选择，历史 localSelections 不重置。下一次观察重新构建候选，继续原有公平调度。非成员的 declared exit 仍沿用原策略。

专项覆盖计数达到 4 且存在 remote、下一观察恢复普通公平性、非活动/缺失/错配边界、非成员、blocked、nonexit、重复、已尝试、用户排除、两类无控件退出、inPlace 和历史 unknown 门禁。测试保留真实候选筛选与 run 入口 unknown 检查，替换与本结论无关的审阅、账本投影和远程路径发现，并在 obligation.selected 事件处中止，禁止 host 执行。未构造浏览器或 SDK engine，未打开数据库或启动服务。

结论限于“符合守卫的当前局部出口不会被历史公平计数挤掉”。第二帧由 fixture 提供，未证明真实退出或恢复到达；没有授予覆盖、重放权限或 unknown 成功状态。输出耗时只是该次测试记录，没有性能基准或性能提升结论。本补丁也不将 run9 的历史调度推测升级为已捕获事实。
