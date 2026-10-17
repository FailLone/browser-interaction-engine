# 第七窗修复：原协议复验准备

当前仅准备，**未运行**。最终固定提交已绑定 `e06f057ecc1fd43feaa8cfa42d14c65e9750a08e`，CPU 窗口仍等待 root 通知；不能把本目录当成测试通过证据。

运行入口 `/tmp/bie-run-run7-fixes-protocols.py`（同内容归档为 `runner.py`）要求显式传入 root 提供的完整 SHA 和 `--cpu-released`。执行前拒绝不同 HEAD、产品/脚本/测试脏树、源目录未跟踪文件以及已存在的运行结果。原四脚本按既有八命令运行：16 场景 × 5 次，共 80 trial。仅输出目录和声明 revision 更新；禁止触碰历史结果和真实资源。

基线要求是 `106a1cdfddfe3e73cab9e01b28ba4dd8439653e2`，其对应已归档的 `run7-selection-protocols` 实际执行版本为 `cbd5b878329f8d3e454e8fd5110d0e2da4f749a7`。已用 git diff 确认两个提交在 packages/apps/scripts/tests 下无差异。基线名称和实际 revision 均保留，不重新标注旧结果。

`summarize.py` 与基线逐字相同，SHA-256 为 `d3218b0bdaf619aa57c119fededcfd4420fed5a0d56ed1458a65d1bfff09cf8c`，仍执行原 348 项完整性与实际 oracle 检查。`compare-trials.py` 只更新基线目录/标签，原 behavior 投影及完整差异函数未改。保留所有逐 trial 差异；不强求计数或所有投影与旧版相等，也不会预先把任何差异归为可见性修复而忽略。嵌套恢复、A/B 身份与输入、unknown 跨重启守卫仍由原标准判定。

若原协议退出失败，保留原日志与部分结果并停止；若摘要完整性拒绝，保留其退出码并仍尝试生成完整 trial 差异。计数变化需要人工逐场景说明，不能修改 oracle。运行耗时不用于性能结论。只使用原脚本自建的本地 fixture server、headless browser 和临时库，无真实 provider、用户浏览器、真实站点或 OKX 任务库。

本次准备只做 Python AST 静态语法解析、源码/历史脚本哈希核对和新目录文件写入，未运行 runner、摘要器、fixture、浏览器或构建。执行后将追加 commands、source-before/source-after、原始 JSON、分析日志及最终结论。
