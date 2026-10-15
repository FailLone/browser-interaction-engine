# 合并后独立上游验收：功能走通，严格闭合未成立

本轮修复后的真实页面操作已走通，但**不能宣称固定范围已经严格穷尽**。独立上游最初漏审范围内残留，父级复核后，上游只读复核并更正报告。原始报告保留，最终结论以本文件、`summary.json` 和修订报告为准。

## 代码与分工

- 开发分支：`fix/live-content-exploration`，独立 worktree，未在 main 开发。
- 合并另一任务的正式提交 `ea45a38`，合并点 `9cd7bd5`。运行时代码 `085c805`，冻结 HEAD `a512747e30b24a009b193db8798b0225f103b9cd`。
- 本轮通用修复：不把语义表格行的字段当成重复记录；嵌套弹层能够包含其实际滚动视口。保留先前的模态区域就绪判断及截图不修改输入节点的修复。没有按 OKX 控件、URL、文案或选择器定制运行时代码。
- 另一线程 `01a13bb0-5527-7482-9b9f-0eee09b674b8` 负责组件/补采与区域局部补审。其较新的 `3ff43af` 和 BTC/USD 转换页实测不在本次冻结基线中，本任务没有重复实现或操作它的会话。
- 最终冻结代码：[74 个测试文件 / 538 项通过](regression.log)；[类型检查](typecheck.log)、[构建](build.log)、[发布产物烟雾测试](smoke.log)通过。

## 实验约束

目标为 `https://www.okx.com/markets/prices`；固定范围为 Filters 入口、浮层和两个有限选项列表，以及必要的进入、退出与重入。连续输入使用代表值，不要求数值空间或组合穷尽。

新启动 `gpt-5.6-sol / low` 独立代理，仅通过项目公开接口决策和操作。没有提供历史操作序列；运行时主代理没有指导、改代码或代操作。会话 `cc6fc11c-978a-41e6-a91b-5d7dff184e18` 已停止，独立 HTTP 服务也已停止。冻结后的 514 个 tracked 文件哈希全部匹配。

完整约束见 [experiment-contract.json](experiment-contract.json)。预算为 300 次实际操作、45 分钟；本轮用了 49 次，实际墙钟约 12 分 57 秒。引擎 `elapsedMs=399797` 是另一个累计时间口径，不能作为墙钟时间。

## 已验证的效果

| 项目 | 原始证据结论 |
| --- | --- |
| 实际操作 | 49 次 execute 对应 49 次 ActionAttempt，全部 succeeded；包括一次必要的地区提示关闭 |
| 有限选项 | 12 个涨跌幅选项、5 个市值选项，逐项选择，后续观察的值与选项文案一致 |
| 下半部选项 | 5 次项目 scroll 成功，随后实际点击对应选项 |
| 连续输入 | Min=1、Max=1000，填入后的观察值一致 |
| Reset | 四个筛选值均从非空变为空 |
| Apply 与重入 | Apply 后浮层消失，重新进入后 Min=1、Max=1000 保留 |
| 显式关闭 | 最后一次关闭后浮层消失 |
| 调用错误 | 一次无效区域提交被 409 拒绝并由上游改正；不是实际操作失败，也没有产生 ActionAttempt |

没有再出现此前阻断流程的 STALE_OBSERVATION 或无法到达下半部选项问题。Apply 的证据仅覆盖界面效果与值保留：不能证明所有行情类别按价格统一过滤，代理观察到 DEX 行中仍存在低于下限的价格。

## 为什么仍不算严格穷尽

最终重入的浮层有 20 个发现节点，不能用 8 个语义控件清单替代全部节点审计。该观察对应 8 个 frontier 动作节点：1 个 executed、1 个 superseded、4 个 region_review_required、2 个 operation_requires_review；其中两个 combobox 的身份仍未决。

按全部 58 个观察的浮层及其子弹层取并集，再通过 identity occurrences 和 frontier.action.localId 映射，还有 14 个未确认控件组、22 个 pending 身份假设。历史动作案例分别为 31 succeeded、2 covered_equivalent、148 awaiting_decision、2 blocked、29 retired。**这些是历史案例/身份统计，不代表有 148 个不同选项没点过。** 两个 equivalent 案例均引用实际成功尝试，不能增加实际派发次数。

上游没有提交 classifyControls；在区域审阅的说明中把包装节点称作内部实现，也不等于完成逐项分类。重新进入后的用途、区域和身份也没有完成重新审阅或有依据的归并。关闭导致 identity 变为 removed，同样不等于已消除歧义。

这些事实足以否定“范围内残留为零”，但不足以把所有残留归因于新的引擎故障。尤其本轮没有尝试用现有分类、身份与区域接口完成这部分闭合。后续应先让上游完成剩余审阅，再用实际失败证据判断是否还有程序缺陷；区域局部补审沿用另一线程的实现，不在这里重复开发。

本轮证明的是：修复后的引擎允许独立上游在持续更新的真实页面上完成该功能流程。没有证明严格范围穷尽、整站穷尽、任意复杂页面穷尽或发现能力完整。

## 证据与复核

- [修订后的独立报告](upstream-report.zh-CN.md)；[最初报告，仅保留追溯](upstream-original-report.zh-CN.md)、[最初摘要](upstream-original-summary.json)。复制的报告保留代理原文，其 `REPORT.original.zh-CN.md`、`summary.original.json` 对应这里的两个 upstream-original 文件。
- [49 次尝试及前后字段](attempts.json)、[17 个选项值验证](finite-options.json)、[范围映射与残留](scope-audit.json)。
- [统计](summary.json)、[冻结复核](freeze-audit.json)、[源码哈希](source-hashes.json)。
- 全量观察和 HTTP 账本保存在本地忽略目录 `work/integrated-scoped-retest-2026-10-15/`；[原始证据哈希](raw-evidence-hashes.json)提供定位与校验。主代理请求从 171 开始，均为结束后的只读集合读取，不计入代理运行请求数。
- 运行 `python3 docs/experiments/integrated-scoped-acceptance-2026-10-15/verify.py` 校验本目录的计数、选项结果、重置/应用/重入/关闭效果、等价引用和范围残留。脚本仅审计保存的数据，不访问网站或改变结论。
