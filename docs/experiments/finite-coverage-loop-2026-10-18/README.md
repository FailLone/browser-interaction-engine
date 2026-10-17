# 有限覆盖与完整循环验收交付

本地完整闭环及冻结代码复验均通过。OKX 公开页面已完成同预算评测，但未建立重入续测链；不能据此声称 OKX 已跑通或全站穷尽。机器汇总见 [FINAL.json](FINAL.json)。

## 代码与来源

工作分支 `codex/finite-coverage-loop`。原 refactor 的 HEAD 为 `5b05d3939919d16d8c52203f0f37f0c3dd5e774c`；其完整未提交工作态冻结在 `09449a4`，选取旧验收修复后的基线为 `0fc7f37`。交付前重新核对原工作区全部冻结文件哈希，未发生变化。

实现提交依次为 `328d029`（显式有限合同）、`cb11497`（目标实例、派发见证与分类稳定性）、`5f13fc4`（原始来源关联回执审计）、`d9e510b`（先保留分类来源证明再离开）。本地通过和复验的产品提交均为 `d9e510b`，480 个源码文件哈希一致且运行时源码差异为空。`fc01ad2` 只添加通过证据、Crawljax 对应表及 OKX 评测器，没有修改产品包。

`finite-ui-v1` 必须由调用方显式启用，旧会话不自动转换。它以目标、操作、输入样本、约束/选项、目标自身激活状态及声明上下文定义有限操作义务。其他选择器组合保留为单独账本，未知 JavaScript 依赖、自由输入空间和业务效果仍未证明。旧账本的 164 条未完成项完整保留，逐来源解释在 `legacy-164.json` 与 `legacy-condition-explanation.json`；没有改写历史完成状态。

具体规则与迁移限制见 [COVERAGE-CONTRACT.md](COVERAGE-CONTRACT.md)。源码依据、采用/不采用原因、TS 位置与正反例见 [CRAWLJAX-MAPPING.md](CRAWLJAX-MAPPING.md)，外部源码哈希见 `crawljax-source-evidence.json`。导航状态等价、控件对应和覆盖义务保持独立；图路径只提供恢复线索，当前目标仍要重新定位、验证并取得执行回执。已有通用弹窗适配保持不变，FRAGGEN 不在主线中。

## 完整验收结果

每轮上限均为 240 秒、80 次浏览器动作，包含真实进程重启、等待和最终独立审计。内部最多三轮，没有临时延长预算。测试页原样使用 `/?defects=off`，探索器没有接收 23 分支清单或固定路线；真实 JEV/LLM、ExplorerPlugin、SDK、Playwright 和 SQLite 全链运行。

| 轮次 | 结果 | 总耗时 | 动作 | 结论 |
| --- | --- | ---: | ---: | --- |
| 1 | FAIL | 219.919 秒 | 55 | 缺 BTC/USDT 分支，44 条剩余，6 次重复完成 |
| 2 | FAIL | 161.856 秒 | 34 | 缺三个关闭/复位分支，15 条剩余；分类刷新使三轮提前耗尽 |
| 3 | FAIL | 79.460 秒 | 35 | 分支、重入与重启成立；新增账本遗漏 9 条关联回执来源证明 |
| 4 | FAIL | 75.792 秒 | 44 | 全分支与操作义务成立；分类来源未结清，5 次重复完成，任务阻塞 |
| 5 | PASS | 47.799 秒 | 34 | 所有完整判据成立 |
| 6 独立复验 | PASS | 49.300 秒 | 34 | 同一冻结源码、全新数据目录，再次完整通过 |

失败轮次的原始结果均未改成通过。每轮目录保留协议、源码清单与差异、时间线、任务快照、审计和 SQLite/观察证据归档。

两次通过均为：23/23 独立 DOM 分支、37/37 有效操作义务记录、零剩余必需项、零非必要重复完成，插件实际状态 `completed`。37 是保留的义务记录数，不是宣称 37 个互相独立的业务状态。另有 20 种已观察条件组合，未声称穷尽其全部排列。

两条自然重入链分别是 Time in force 和 Market。审计保存选择时仍未完成的原 item、原发现来源、离开后的缺席、实际入口重放、SDK 当前目标对应、独立子操作回执及持久化完成。以首轮通过为例：

| 子目标 | 实际返回入口回执 | 子目标实际执行回执 |
| --- | --- | --- |
| Time in force | `d25fc5c1-45d6-447f-baed-6040a6f9f115` | `a9ac0b15-03cc-4e25-a13d-ab7b2de335fc` |
| Market | `dd069f6a-4371-462b-afb1-f064c6695f88` | `b4dffacd-ab83-4051-b6be-79fc097fe9d0` |

首轮进程 PID 为 28969→28992，复验为 29202→29218。每次都保留同一 task ID，重启前完成回执不变，重启后继续完成 15 条原有未完成项，并产生 31 个成功执行记录。完整来源与检查结果见 [首轮审计](evidence/run-5/audit.json) 和 [复验审计](evidence/run-6-confirmation/audit.json)。[覆盖账本](evidence/run-6-confirmation/coverage-ledger.json)分别列出有限义务、已观察组合、未知依赖、阻塞及恢复。

## OKX 的真实结果与边界

入口 `https://www.okx.com/zh-hans/convert/usd-to-btc` 正常加载。165.296 秒内计数 2 次动作：入口导航和关闭公开弹窗；无登录、交易、地区/身份声明或绕过。43 次 JEV、2 次 LLM 调用后，任务以 `capability_or_unknown_outcome` 阻塞；实际没有 unknown/failed 执行，直接能力阻塞为 `UNSUPPORTED_CANVAS`。严格重入链数量为零，180 条操作义务未完成。结果为“不成立”，不是外部访问受限，也不是成功。

证据定位出三个仍存在的实现限制：JEV 将请求识别为 targeted，但 LLM 初始计划改为带排除项的全页根范围；大页面的区域/分类审阅先消耗大量时间；未支持的 canvas 被保留为必需能力缺口，最终阻止完成。没有通过接受能力限制、删除义务、调大预算或手动走菜单来取得成功。[机器诊断](evidence/okx-1/diagnosis.json)列出原决策、阻塞分类及代码位置，[结果](evidence/okx-1/result.json)保留完整边界。Crawljax v3 A 的自定义投影在其独立实验中有三条成功链，不代表当前 TS 在 OKX 上已经获得同等结果。

## 验证与已知基线失败

针对有限合同、来源证明、身份及审阅的 63 条回归通过，类型检查通过。扩大回归共 251 条：206 通过，45 失败。随后在独立 `git archive 0fc7f37` 副本上运行两个失败测试套件，45 个失败名称完全一致，本次对照没有新增失败。不能将仓库全套测试称为全绿。机器对照见 `broad-regression-summary.json`；原输出与基线 JSON 已压缩归档。

负例覆盖 unknown/failed、缺派发见证、错实例/动作/时序、被撤销的审阅、缺条件见证、动态可操作内容变化、控件移除/替换、匿名兄弟增删及顺序变化。重入、弹窗遮挡、边界退出、批量对应与回执校验相关扩大回归均通过。

## 复现

需要 Node 24、pnpm 10、已安装的 Chromium，以及现有通用 JEV/LLM 配置。以下命令不打印密钥；每次使用新的输出目录。

```sh
cd /Users/xietian/.codex/worktrees/finite-coverage-loop/browser-interaction-engine
export PATH=/Users/xietian/.local/share/fnm/node-versions/v24.22.0/installation/bin:$PATH
pnpm install --frozen-lockfile
node --env-file=/Users/xietian/.codex/worktrees/autonomous-exploration/browser-interaction-engine/.env.explorer.local scripts/local-loop-acceptance.mjs .data/local-reproduction-1
```

独立复验把最后的目录改为 `.data/local-reproduction-2`，保持代码不变。SDK 账本接口为 `ExplorerPlugin.coverageLedger(taskId)` 或导出的 `coverageLedger(host, task)`。**不要**为了诊断而对运行中的数据目录另建 `ExplorerStore`，构造函数会执行恢复；先等待工作进程退出，或使用独立复制的目录。

仅验证已交付档案，无浏览器或模型调用：

```sh
python3 scripts/verify-finite-evidence.py
```

公开 OKX 有界评测：

```sh
node --env-file=/Users/xietian/.codex/worktrees/autonomous-exploration/browser-interaction-engine/.env.explorer.local scripts/finite-okx-acceptance.mjs .data/okx-reproduction-1
```

该评测保留 240 秒/80 动作外层上限，在 210 秒请求合作停止以预留最终持久化审计。安全守卫只拒绝越界动作，不替探索器选择路线或返回成功；当前评测没有触发守卫拒绝。结果依赖公开页面与模型服务当时状态，旧证据不保证未来仍会得到同样结果。
