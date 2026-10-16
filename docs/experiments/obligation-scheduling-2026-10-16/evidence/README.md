# 原始证据索引

本目录保留基线、开发中的失败及最终验证，文件名中的 initial / second / third / intermediate 不表示最终验收。路径、临时端口、UUID 和时间戳保持原样。完整协议比较以报告所列冻结版本为准。

| 内容 | 文件 |
| --- | --- |
| 两次受控稳定性红测 | `observation-stability-window-baseline-controlled-red.json`、`observation-stability-window-baseline-repeat-red.json` |
| 稳定性最终 8 文件 | `stability-final.json`、`stability-typecheck-final.log` |
| 第一阶段恢复对照 | `recovery-base-1..5.json` 对 `recovery-stability-1..5.json` |
| 阶段1源码一致性 | `baseline-source-audit.json`、`stability-measurement-manifest.json` |
| 调度11例基线与初版通过 | `scheduler-integration-before-final.json`、`scheduler-integration-fixed-initial.json` |
| 安全9例基线和冻结版 | `scheduler-safety-baseline-nine.json`、`scheduler-safety-fixed-nine-final.json` |
| 初版报价债务回归 | `scheduler-safety-initial-quote-regression.json`、`scheduler-safety-initial-obstructed-quote-regression.json` |
| 同控件A/B源条件债务反例 | `scheduler-same-control-source-debt.json`、`scheduler-same-control-source-debt-fixed.json`、`same-control-source-debt.json` |
| 源条件正式测试 | `scheduler-source-condition-formal.json`、`scheduler-source-condition-formal.sha256` |
| 开发首轮及局部修复 | `scheduler-existing-first.json`、`scheduler-regressions-second.json`、`scheduler-regressions-third.json` |
| 完整受影响回归 | `scheduler-regression-final-selection.json`、`scheduler-regression-final.json` |
| 调度冻结源码 | `scheduler-frozen-manifest.json`、`scheduler-final-start-hashes.json` |
| 调度原协议基线/修复版 | `conditions-scheduler-{base,fixed}.json`、`continuation-scheduler-{base,fixed}.json`、`input-identity-scheduler-{base,fixed}.json` |
| 调度恢复验证 | 基线复用 `recovery-stability-1..5.json`，修复版 `recovery-scheduler-fixed-1..5.json` |
| 导出和运行一致性 | `scheduler-base-source-audit.json`、`scheduler-base-protocol-manifest.json`、`scheduler-fixed-protocol-manifest.json` |
| 编译与冒烟 | `scheduler-typecheck-final.log`、`scheduler-build-final.log`、`scheduler-build-smoke-result.json`、`scheduler-explorer-smoke-result.json` |

每个 Vitest JSON 应阅读 `numFailedTests` 和具体断言，协议脚本应阅读真实事件、unknown、未测项和错误状态；进程退出0或队列为空都不等于网页探索完成。最终59文件已包含冻结11例、9例、纯调度7例和来源条件2例；各独立定向结果不再累加到648项总数。首次640/644及其协议结果保留在 `scheduler-3ee95f1/`。`scheduler-final-comparison-original.md` 保留分析时原文，发布版仅调整结束时态、相对定位和范围说明。
