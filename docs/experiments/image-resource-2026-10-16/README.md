# 图片资源加载规则验收 · 2026-10-16

已将文字同色分支 `9af5edf` 快进合并至 main，再创建 `codex/image-resource-state-rule`。规则范围和要求接口见 [规则说明](../../IMAGE-RESOURCE-RULE.md)。

构建后的调试服务 `http://127.0.0.1:4186/` 检查 `http://127.0.0.1:4174/image-resource.html?mode=traversal`，启用图片资源插件、正常 DFS 和持久证据。

- 会话 `1a4cb663-69a9-4ec9-b64e-2b35b5d2ef2f`：4 个动作、6 条采集、6 条自动检查，全部完成。
- 结束原因是 `known_frontier_exhausted`，不代表所有规则通过。
- 初始缺图得到 1 条原生加载失败 warning。对照样例在遍历模式隐藏，另外 13 个目标不适用；1 条未判定包含该 warning，并非第二个问题。
- 重试缺失 URL 仍失败，保持同一 issue ID 和 warning；不会因重复失败自动升级 error。
- 换上有效替代图后，新资源可用；原资源失败保留为历史，未输出原资源已恢复。打开弹层发现弹层缺图，关闭后保留其历史记录。
- 重放首条采集的报告与原自动结果一致，动作数仍为 4。
- 构建界面显示 6 个插件及当前失败说明，没有记录页面脚本异常。

[精简结果](acceptance.json) 保存逐采集的来源绑定、事件、告警和 issue ID。完整验收和截图在本地 `work/image-resource-demo/`。调试服务继续使用 `work/image-aspect-ratio-demo/data`，保留之前的图片和文字规则会话。

验证执行：

- `pnpm typecheck`、`pnpm build` 通过。
- `node scripts/smoke-image-resource.mjs` 通过：编译包、HTTP 元数据投影、明确要求产生 error、正常遍历、弹层检查、替代图单独记录、历史重放一致且无动作。
- 9 个测试文件共 72 项通过：image-resource、image-resource-integration、rule-requirements、rule-plugins、rule-plugins-ui、image-aspect-ratio、text-background、evidence-query、engine.e2e。
- 原资源重试恢复由受控响应测试证明：同一节点、声明和 URL，后续成功 load 解除原告警；页面本身的缺失 URL 没有被后台修改。另测加载中、懒加载、响应式来源、SVG、页面伪造事件、自动 fallback、节点/标签/作用范围变化和旧证据。没有运行全仓库测试。

首版不评判替代头像的实体正确性、布局、清晰度、CSS 背景图或业务必要性。默认输出 warning，明确绑定的宿主要求可以产生 error；规范和 agent 接口仅产生提案，没有自动执行器。
