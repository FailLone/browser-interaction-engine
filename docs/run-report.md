# V0.1 实际运行报告

生成时间：2026-10-14T15:48:17.247Z。运行于 Node v24.21.0，本地 React 测试站 + Chromium；无外部网站或模型服务。

此文件由 `pnpm report` 生成，所有计数来自持久化记录。

- 会话：`406dc44a-6867-415b-97e6-f337c4009b71`
- 已发现：7 个状态、12 次访问、10 条迁移、98 项待办记录。
- 执行：{"succeeded":10}；动作预算 10/10。
- 待办分布：{"needs_revalidation":82,"executed":1,"pending":11,"blocked":4}。
- 结果未知动作：0。身份待裁决：2。
- 结束原因：`BUDGET_EXHAUSTED`。
- 检查点结果：`REACHED_VERIFIED`，4 次恢复动作。
- 已保存 12 张截图；采集缺口 0 条。

## 实际动作

| # | 目的 | 操作 | 结果 | 变化数 |
| --- | --- | --- | --- | --- |
| 1 | external | click · Order type  | succeeded | 3 |
| 2 | external | click · Market  | succeeded | 5 |
| 3 | external | fill · Amount 2 | succeeded | 1 |
| 4 | external | fill · Amount 3 | succeeded | 1 |
| 5 | recovery | navigate · Reopen session entry http://127.0.0.1:5174 | succeeded | 15 |
| 6 | recovery | click · Order type  | succeeded | 3 |
| 7 | recovery | click · Market  | succeeded | 5 |
| 8 | recovery | fill · Amount 2 | succeeded | 1 |
| 9 | external | click · Duplicate controls  | succeeded | 3 |
| 10 | exploration | select · Trading pair ETH/USDT | succeeded | 5 |

## 受阻、未知与未完成范围

- needs_revalidation: business_context_changed：82 项。
- pending: 待选择：11 项。
- blocked: excluded_by_rule：2 项。
- blocked: identity_ambiguous：2 项。

这不是全站覆盖率。未发现的事件处理器、未声明的业务事实、未覆盖的控件组合和浏览器能力仍属于未知范围。

## 流程累计影响

- Interaction: Order type：closed，2 次操作，2 项累计差异，父区域 `form:order-form`。
- Interaction: Order type：closed，2 次操作，2 项累计差异，父区域 `form:order-form`。
- Interaction: Duplicate controls：open，2 次操作，0 项累计差异，父区域 `generic:Test controls`。

## 证据

- [02381017-4e75-4437-a305-7c658bc19765](run-evidence/02381017-4e75-4437-a305-7c658bc19765.png)
- [afdd2ff5-1679-4e7a-8206-ca11f25805f7](run-evidence/afdd2ff5-1679-4e7a-8206-ca11f25805f7.png)
- [33b71e91-244e-4ff5-94ad-1e2e853928e3](run-evidence/33b71e91-244e-4ff5-94ad-1e2e853928e3.png)
- [dab659dc-8dcf-4614-af52-03eb92c17ff9](run-evidence/dab659dc-8dcf-4614-af52-03eb92c17ff9.png)
- [622fc81b-0427-451e-951e-da22175d2093](run-evidence/622fc81b-0427-451e-951e-da22175d2093.png)
- [2787312f-1b04-46f5-b609-6e0b2543c540](run-evidence/2787312f-1b04-46f5-b609-6e0b2543c540.png)
- [1b4596f5-fc97-4612-aa02-1f2523024795](run-evidence/1b4596f5-fc97-4612-aa02-1f2523024795.png)
- [85c31aa9-0633-4d42-bf42-b1c9afd15590](run-evidence/85c31aa9-0633-4d42-bf42-b1c9afd15590.png)
- [34a57ec3-90f8-4640-a06b-b48e37824589](run-evidence/34a57ec3-90f8-4640-a06b-b48e37824589.png)
- [e4b56d35-0b94-4204-83db-fe235106f80b](run-evidence/e4b56d35-0b94-4204-83db-fe235106f80b.png)
- [72d8bba3-ba0b-462a-9651-bbeaba77fcd9](run-evidence/72d8bba3-ba0b-462a-9651-bbeaba77fcd9.png)
- [2a46dd99-c85e-45d8-bd26-d9607918244c](run-evidence/2a46dd99-c85e-45d8-bd26-d9607918244c.png)

机器可读结果：[run-report.json](run-report.json)。报告包含动作、图、待办、歧义、范围和恢复结果。原 SQLite 数据保存在 `.data/report-*/`，报告与复制的 PNG 可独立阅读。
