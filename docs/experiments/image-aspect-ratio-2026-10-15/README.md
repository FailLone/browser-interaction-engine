# 图片拉伸规则验收 · 2026-10-15

分支：`codex/image-aspect-ratio-rule`。范围和配置见 [规则说明](../../IMAGE-ASPECT-RATIO-RULE.md)。

从构建后的调试服务 `http://127.0.0.1:4186/` 创建会话，目标为测试站 `http://127.0.0.1:4174/image-aspect-ratio.html`，启用图片插件自动检测和持久证据，使用正常 DFS。没有为规则添加主动滚动、额外点击或等待恢复。

- 会话 `d44d0fa9-1923-4ccb-a072-b46c6ae59361`，6 个动作、8 条采集、8 条自动结果，插件全部完成。
- 探索以 `known_frontier_exhausted` 结束；这仅说明已知探索边界完成，不代表规则全部通过。
- 首次图片检查：4 条拉伸 warning，12 条比例正常，3 条不适用，4 条信息级缺证/范围限制。界面的 8 条未判定包含上述 4 条 warning，不应与 warning 数相加。
- 普通动作原位修复压扁图片后，报告 `IMAGE_ASPECT_RATIO_RESTORED`，保持原 issue ID。
- 打开弹层后，发现弹层内压扁图片；关闭弹层后保留历史记录，没有误称恢复。
- 调试页显示四个可选插件，正确显示图片标签，保存结果可选择查看。构建页面运行时未记录脚本异常。

[精简采集结果](acceptance.json) 保留每条任务的代码、级别、标签、状态、比例和 issue ID。完整采集/结果在本地 `work/image-aspect-ratio-demo/data`、`work/image-aspect-ratio-demo/acceptance.json`。

验证已执行：

- `pnpm typecheck`、`pnpm build` 均通过。
- `node scripts/smoke-image-aspect-ratio.mjs` 通过：编译包、真实 HTTP 图片字段投影、明确要求产生 error、普通 DFS、弹层检测、无额外动作、历史重放一致。
- 最终八个测试文件共 106 项通过：image-aspect-ratio、image-aspect-ratio-integration、rule-plugins-ui、rule-defects-ui、rule-automation-ui、clipped-control、text-truncation、observed-occlusion。
- 另外验证过 rules、rule-requirements、rule-plugins、rule-evidence-dependencies、rule-observation-status、rule-automation、evidence-query；没有运行全仓库测试。

默认预览使用无项目要求的 warning 路径。error 和允许变形的例外在规则测试及编译后 smoke 中用宿主提供的精确绑定要求验证，不从测试页面属性自动取得要求。SVG、3D 及资源内部变形等限制仍按规则说明保留。
