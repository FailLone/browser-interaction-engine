# 第 3 项发布产物检查：7c1bf9c

固定产品提交：`7c1bf9c25fbba0d2302db68e765e68bfffd61866`，来自 `codex/exploration-layered-refactor`。本目录是独立发布检查，不更改产品、不合并分支。未操作原测试浏览器、服务或任务数据库。

## 结果

| 检查 | 结果 | 证据 |
| --- | --- | --- |
| 完整发布构建：TypeScript SDK/server、包内产物、UI、test-site | 通过 | `build.log` |
| 现有发布声明消费检查：完整/当前 explorationSnapshot 的类型边界 | 通过 | `published-snapshot-types.log` |
| 新批量回执接口的发布声明消费检查 | 通过；结果没有变成 any，四个权限字段保持 false 字面量，非法入参与虚构权限被类型系统拒绝 | `compiled-smoke.mjs`、`compiled-receipt-api.log` |
| 编译后的 `operationReceiptConditions` 可用 | core 和 browser 上均存在；四份历史本地真实操作回执完整结果与固定 5eca 基线相等 | `compiled-smoke.json` |
| 旧判断不得被批量复用成授权 | 四个权限标志始终 false；缺失回执拒绝；下一次查询重新发现 unknown，保留 actualSuccess 但拒绝 conditionVerified | `compiled-smoke.json` |
| 隔离与纯读 | 28 条 workspace 依赖链接均在 archive 内；508 个输入源码文件不变；查询写入/事件/driver 调用均为 0 | `validation.json`、`source-manifest.json` |

新建 archive 路径记录于 `preparation.json`，只从指定提交导出完整产品、脚本、配置和测试；旧 docs 证据不复制。外部依赖借用已有安装，所有目标与 package.json 哈希均记录。Node 为 `v24.22.0`；构建产出 635 个文件，其路径、大小及 SHA-256 见 `artifact-manifest.json`。UI 和 test-site 均构建成功；本轮没有启动 UI 做渲染验收。

运行 `python3 runner.py` 会建立新的自有 archive 并串行执行三项检查；已有 `validation.json` 时拒绝覆盖。构建清理只发生在该 archive。原工作区产物没有用于 SDK 接口检查：运行时逐一确认 core、browser、memory、explorer-plugin 的包入口解析到 archive 自己的 `packages/*/dist/index.js`，未启用 development 条件。

## 证据边界

回执种子复用 `../receipt-condition-batch/fixture.json.gz`，四份回执原先由本地浏览器实际执行生成，本轮不再创建网页或浏览器。完整基线来自 `../receipt-condition-batch/baseline-fixed.json`。种子、参考结果和输出哈希都在本目录记录；四份结果 SHA-256 为 `7ca13d2156f8f25995ea409053cd926237647bfdf9ff65e8c30b4911d7ab04ad`。

unknown 负例只修改本轮 MemoryStore 中的自有种子副本；没有创建持久数据库。没有启动服务，没有重新运行浏览器 smoke、80 次协议或已通过的专项套件。本检查证明编译与发布接口保持约束，不能证明真实 OKX 恢复成功率、恢复耗时、页面穷尽或端到端性能。编译耗时只作为执行记录，不作性能比较。

`evidence-manifest.json` 记录本目录其余证据的 SHA-256。父线程可在合并或继续真实实验前独立复核这些记录。
