# 真实行情页面验收：2026-10-15

**行情持续变化时可以继续操作，主要展示流程已实际验证；整页无人干预 DFS 尚未通过。** 本次不以页面打开、几个顶部菜单点击或单个 `succeeded` 状态作为业务验收。

入口为 <https://www.okx.com/markets/prices>。使用项目自己的 BrowserEngine、Playwright Chromium 和通用 `scripts/exploration-workbench.ts`，真实联网页面、1440×900、`controls` 模式、300 ms 采样窗口、10 s 观察上限。没有暂停行情、改写远端 DOM 或固定网络返回。所有动作经过引擎的当前观察、执行前验证和动作账本。

分支为 `fix/live-content-exploration`，基于另一任务的 `48ad958`，本轮修改前为 `32f720e`。生产修复及本地回归页面没有域名、币种、站点控件或 CSS 选择器特例。站点名称和操作目的仅出现在本次验收材料与当前实例的外部审阅记录中。

## 实际结果

| 验收项 | 实际检查 | 结果 |
| --- | --- | --- |
| 实时变化下继续操作 | 连续四次只读观察；动作数始终为 85；原文哈希和原始状态各有四种，交互投影只有一种；随后 Hot、All 两次操作成功 | 通过，见 [采样证据](passive-proof.json) |
| 七个行情分类 | Hot、Top、DeFi、Layer 1&2、Top gainers、Top losers、All；逐项验证 URL 和选中状态 | 通过 |
| 价格筛选界面 | 打开、填入 Min=10000 / Max=100000、Apply、重开核对值、Reset 核对空值、Apply 恢复列表 | 界面流程通过；不声称站点业务过滤完全正确，见下文 |
| 搜索 | BTC 得到一个原生 Details 链接；无匹配词得到空态及零个原生 Details；清空后恢复六个原生 Details | 通过，见 [匹配结果](screenshots/08-search-btc.png)、[空结果](screenshots/09-search-no-match.png) |
| 详情图表 | 点击实际观察到的 BTC Details 链接；关闭地区提示；依次切换 1h、1W、1M、24h | 四个按钮均执行成功，截图确认选中项、曲线及时间轴变化；不覆盖 Canvas 内部交互 |
| 详情返回 | 原生历史返回列表，关闭重新出现的地区提示，再验证根 URL、All 选中且无活动边界 | 页面返回成功；严格检查点结果保留 **UNVERIFIED** |
| 审阅辅助 DFS | 按引擎 DFS 顺序遍历，批准已验证的七个分类页面范围；继续检查菜单、分类与滚动 | 自动阶段至第 83 次操作，保留 `PAGE_RETURN_BLOCKED`；没有整页完成结论 |

两组正式会话共 **114 次成功操作、143 次观察、零个未知操作结果、零个致命采集缺口**。动作数量包含手动经引擎执行的验收操作、恢复和准备步骤，不等同于独立控件覆盖率。

| 会话 | 成功操作 | 构成 | 代码与证据边界 |
| --- | ---: | --- | --- |
| 主要流程 `b0ba5713-f6c2-4e81-8ab8-fd6ba6d63cd8` | 27 | external 26、recovery 1 | 已含最终记录边界修复；启动于页面返回后备修复之前；[动作及观察摘要](reviewed-flows.json) |
| DFS 与被动刷新 `99724219-548b-423a-a064-00cb07190e76` | 87 | exploration 76、recovery 3、external 8 | 含本轮全部生产修复；[动作及观察摘要](dfs-run.json) |

DFS 的第 83 次操作以前有四次 external 操作：初始地区提示关闭，以及三次按当前可见分类控件辅助返回。其余 79 次为引擎安排的探索或恢复。最终阻塞后，第 84、85 次用于返回采样入口，第 86、87 次证明采样后仍可切换分类。它们没有清除此前的页面范围阻塞或未覆盖待办。

四次只读采样发生于 12:36:26—12:36:35（Asia/Shanghai）。其中三次完整页面 `stable=false`，但均没有致命缺口，交互投影一致；另一次 `stable=true`。这证明实测没有依赖每次整页静止，不证明远端页面从未出现短暂稳定窗口。每 10 ms 永久更新、从不停止的情形另由本地 `live-content` 测试覆盖。

## 从实测修复的问题

1. **子面板污染父记录身份。** 初次实测在 12 次操作内反复打开同一菜单、切换子分类。菜单结果中的链接被算入父列表项的链接键，导致同一个入口获得新身份。链接和文字现在共用记录边界，排除独立子面板及隐藏后代。第一次修复后实测又发现 CSS 隐藏面板仍污染身份，补充该情形后复测。四个通用回归测试验证语义面板、浮动面板、CSS 隐藏、关闭重开、父项自身目标改变，以及有限 DFS 不再反复打开同一入口。
2. **只查最近来源条目，过早放弃返回。** 完成上述修复后，真实 DFS 在第 25 次操作遇到 SPA 覆盖最近来源历史条目。浏览器里仍有更早、已观察的同 URL / 同上下文 GET 条目。页面调度现在可用该条目，仍验证当前历史绑定及实际返回结果。最终实测三次页面返回成功，其中一次实际使用了不同于最近来源的历史观察（见 `dfs-run.json` 中 `navigationTargetId != targetId`）。两个通用回归用例分别验证可返回和声明上下文改变后拒绝返回。

这些修改不授予未知业务操作权限，不绕过 dirty、活动弹层、排除或证据完整性检查，不把 URL 返回当作严格状态恢复。

## 仍未通过的部分

- **整页自主 DFS。** 远端 SPA 随后会把所有已知来源页历史条目都覆盖。最终自动阶段停在 `/markets/favorite`，不存在可验证的原生来源返回路径，且目的页未批准继续。上层曾用当前可见控件辅助返回，也按已验证分类补充页面范围决策；因此本次不能称为无人干预成功。这是页面范围与返回路径能力的缺口，不能再用增加稳定等待时间解决。
- **业务筛选语义。** 筛选后原生列表保留 BTC，但截图中仍有不满足价格下限的 DEX 行。本次确认输入保存、应用、重置和列表变化，不把所有可见记录满足区间记为通过。参见[筛选结果](screenshots/04-filtered.png)。
- **严格恢复。** 详情返回的检查点账本仍为 `UNVERIFIED`，返回时出现地区提示；随后关闭提示只证明当前位置可继续。没有将该记录改写为 `RESTORED`。
- **Canvas 和其他未执行项。** Canvas 内部鼠标交互、任意自定义事件和未审阅操作保留原缺口。最终 frontier 有 blocked=1737、pending=328、deferred=124、executed=87、superseded=15；这是跨观察待办数量，不能当作独立控件数或覆盖率。具体原因见 `dfs-run.json` 的 `unexecutedReasons`。

工作台默认将离页链接及未知用途操作留作待审阅。主要流程用当前截图、DOM 操作依据、目标链接和节点实例进行用途审阅，记录见 [reviews.jsonl](reviews.jsonl)，重放权限默认关闭。DFS 的七个页面范围见 [reviewed-pages.json](reviewed-pages.json)。这些上层审阅并非生产引擎中的站点规则。

下一项需要解决的具体问题是：没有原生历史条目时，如何让上层基于当前证据声明一个可验证的返回操作，再验证返回页面范围并恢复遍历；不能凭文字猜 URL 或直接宣称状态恢复。

## 复核材料与复跑

- [逐项断言及观察引用](cases.json)、[测试与构建结果](validation.json)。
- 图表截图：[1h](screenshots/chart-1h.png)、[1W](screenshots/chart-1W.png)、[1M](screenshots/chart-1M.png)、[24h](screenshots/chart-24h.png)。
- [返回后的列表](screenshots/14-return-ready.png)、[被动采样首帧](screenshots/passive-sample-0.png)、[被动采样末帧](screenshots/passive-sample-3.png)。
- 完整本地原始 SQLite、DOM 证据、截图与调用记录分别保存在工作树的 `work/live-prices-flows/`、`work/live-prices-dfs-verified/`；本目录提交紧凑摘要和关键截图，未将巨量原始采集入库。早期复现保存在 `work/live-prices-acceptance/`、`work/live-prices-acceptance-fixed/`、`work/live-prices-acceptance-final/`。

```sh
pnpm exec tsx --conditions=development scripts/exploration-workbench.ts https://www.okx.com/markets/prices work/new-live-acceptance
pnpm test
pnpm typecheck
pnpm build
pnpm smoke:built
```

工作台输出本地 HTTP 地址。按 `/state` 的当前证据，通过 `/review` 审阅具体实例，再用 `/command` 操作或启动 DFS；遇到页面范围决策保留理由。站点布局、行情和可用功能会变化，本报告中的旧节点引用不能直接当作新运行的选择器或审阅权限。`summarize.py RUN_DIRECTORY OUTPUT_JSON` 可只读汇总保留的账本。
