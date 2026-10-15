# 文字与背景同色规则验收 · 2026-10-15

分支：`codex/text-background-visibility-rule`。上一个图片规则分支已快进合并至 main（`f25c501`），再从 main 开始本次开发。规则范围见 [规则说明](../../TEXT-BACKGROUND-RULE.md)。

从构建后的调试服务 `http://127.0.0.1:4186/` 创建会话，目标为测试站 `http://127.0.0.1:4174/text-background.html?mode=traversal`，启用本插件自动检测和持久证据，使用正常 DFS。

- 会话 `1e210961-86fc-4b76-8a73-72dee528e724`：4 个动作、6 条采集、6 条自动结果，全部完成。
- 探索以 `known_frontier_exhausted` 结束；这不代表检查全部通过。
- 初始白底白字产生 1 条 warning；重复观察仍为 warning。同一文字原位改为黑色后，产生 `TEXT_BACKGROUND_RESTORED`，issue ID 不变。
- 打开原生弹层后检测到同色标签；关闭后保留历史告警，没有误认为颜色已恢复。
- 历史重放与原自动报告一致，动作数保持 4。检查没有添加滚动、点击或要求探索等待。
- 构建后的调试页显示 5 个插件，并展示同色 warning，未记录脚本异常。预览初始报告有 2 条通过、22 条不适用；隐藏的对照样例不参与遍历。1 条“未判定”包含这条 warning，并非另一条问题。

[精简结果](acceptance.json) 保存每条采集的颜色样本、结果和 issue ID。完整结果和界面截图位于本地 `work/text-background-demo/`；服务继续使用 `work/image-aspect-ratio-demo/data`，保留之前的图片规则会话。

验证已执行：

- `pnpm typecheck`、`pnpm build` 通过。
- `node scripts/smoke-text-background.mjs` 通过：编译包、真实 HTTP paint 字段投影、显式要求产生 error、普通 DFS、弹层检查、原位恢复、重放一致且无额外动作。
- 最后 8 个测试文件共 93 项通过：text-background、text-background-integration、rules、rule-observation-status、rule-evidence-dependencies、rule-automation、evidence-query、text-truncation。
- 此前 8 个文件共 39 项通过，包含本规则、要求接口、插件、插件界面、缺陷界面、图片规则及其集成测试；其中本规则的两个文件与最终回归重叠。没有运行全仓库测试。

首版只证明受支持的纯色 sRGB 模型中，标签填充色是否与背景一致；不提供最低对比度或完整视觉可读性结论。严格 error 和允许同色的例外使用宿主明确提供的绑定要求验证；测试页面属性不授予要求，agent 提案接口不自动执行。
