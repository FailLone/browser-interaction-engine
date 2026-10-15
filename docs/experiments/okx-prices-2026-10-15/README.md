# OKX 行情页观察与 DFS 复测

2026-10-15（Asia/Shanghai），页面：https://www.okx.com/markets/prices 。使用独立、未登录的 Playwright Chromium，1440 × 900，完整证据采集；未复用用户远端运行环境。

## 复现结果

页面约有 280–335 个采集控件，没有触及 1,500 控件上限。逐状态模式确实会因行情刷新出现致命 `UNSTABLE` / `EVIDENCE_CAPTURE_CHANGED`。控件模式允许只读展示变化，但在分类切换时仍复现了一次采集竞态：快速采样已稳定，随后详细采集捕获了更新后的列表，原实现立即把观察判为不完整。

实际 DFS 只开放公开页面的分类标签（Markets、Crypto、All、Hot、Top、DeFi、Layer 1&2、Top gainers、Top losers）、Close 和滚动/Escape；其余动作通过测试 hook 排除。此范围不包含登录、收藏、交易、跳转币种详情等操作。预算为 20 次动作、120 秒执行计时，settleMs=200、observeTimeoutMs=2000。

| 运行 | 实际动作 | 结果 | 停止原因 |
| --- | --- | --- | --- |
| 首次复现 | 11 | 10 成功，Hot 点击后的观察不完整，动作记为 unknown | OBSERVATION_INCOMPLETE |
| 修改后复测 | 20 | 全部 succeeded，23 次观察均无致命缺口 | BUDGET_EXHAUSTED |

逐次动作、观察和配置见 [runs.json](runs.json)。第二轮通过 Hot、Top、DeFi、Layer 1&2、Top gainers 和 Top losers，不能据此宣称全站或所有已发现控件探索完成。两轮实时行情、网络与渲染时序不同；第二轮未触发 `EVIDENCE_CAPTURE_RETRIED`，其通过只能说明该轮流程可以推进，不能单独证明重采分支生效。

测试期间工作区另有并行的身份匹配修改，因此第一轮观察版本为 observable-v3，第二轮为 observable-v4。此处修复仅涉及观察重采和提示，不包含这些身份修改；准确验证重采分支依靠下面的确定性回归测试。[fix.patch](fix.patch) 单独提取本次修复，可在基线 main（722a8c7）上应用，未包含并行修改。

本次修复已从原工作目录撤出，单独放入从 main（722a8c7）创建的 `fix/okx-observation-stability` 分支及独立工作树。身份匹配任务的改动保留在原目录；main 没有新增提交。

## 修复与验证

详细采集发现影响当前探索模式的变化时，在原观察时限剩余时间内重新等待稳定并重采证据。不会重放触发动作。若持续变化或剩余时间不足，仍保留致命缺口和 unknown，避免把未知结果包装成成功。

界面直接显示关键错误代码，区分持续变化、控件截断、证据预算不足；逐状态/代表性模式提示实时页面可新建控件覆盖会话。非致命的交互稳定状态也明确显示。旧会话不会被自动切换模式。

新增确定性测试在第一次详细采集时更新输入值：控件和逐状态模式均重采到稳定结果，详细采集两次、动作只执行一次。另一项测试在每次详细采集时更新目标，确认观察有界结束、结果仍 unknown、动作仍只执行一次。

验证通过：

- 28 项测试：observation-lifecycle、control-exploration、action-evidence、boundary-regressions、exploration-ui。
- `pnpm typecheck`。
- `pnpm --filter @interaction/ui build`。

迁移到独立分支后，使用 Node.js 24.21.0 再次运行上述 28 项测试，全部通过（67.61 秒）；独立工作树的 `pnpm typecheck` 和完整 `pnpm build` 也通过。此轮验证不含身份匹配任务的代码。

远端更新前可先执行 `git apply --check fix.patch` 检查补丁兼容性，再应用、构建并重启。对这个实时行情入口使用新建的“控件覆盖”会话；旧的逐状态会话会继续按原契约要求完整状态稳定。

仍有独立限制：页面的列表文本会参与控件身份，价格刷新可能造成身份数量增长；未识别的自定义交互、不可重放路径以及 Canvas 内部也不在本次修复范围。完整本地诊断数据在 `work/okx-prices/` 和 `work/okx-prices-dfs/`，未提交大型观察文件。

迁移说明：后续开发分支 `fix/live-content-exploration` 基于 `codex/okx-exploration` 的 `119b99a`。原修复 `cd27730` 的观察重采样及等价回归已由基础分支 `559f349` 包含，保留基础分支实现；提示与实测材料迁入新分支。旧分支保留作为历史记录。

后续动态页面修复已再次基于 `codex/okx-exploration` 的 `bfb809a` 整合，见[通用实时内容验收](../live-content-2026-10-15/README.md)。原实测材料是历史记录，不代表最终版本的完整站点覆盖。
