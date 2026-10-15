# 独立上游 LLM 有限范围验收报告（只读复核修订版）

修订结论：**本轮功能交互样本全部成功，但严格契约验收不成立。** 原报告只盘点了 8 个语义控件，未把筛选浮层中项目实际发现的全部节点与 frontier、identity、区域复核状态逐项对齐，因此“范围内残留为零”的结论证据不足。原始报告和摘要分别保存在 `REPORT.original.zh-CN.md` 与 `summary.original.json`。

功能层结果保持不变：会话 `cc6fc11c-978a-41e6-a91b-5d7dff184e18` 有 49 次实际 ActionAttempt，49 次成功，0 次失败；24h change 的 12 个有限选项和 Market cap 的 5 个有限选项均实际选择成功。`Min=1`、`Max=1000`、Reset、Apply、重进持久化和显式关闭也均有成功动作与观察证据。Apply 只证明操作成功、浮层关闭及值在重进时保留，不能证明对所有可见行情类别统一过滤。

严格验收失败点来自最终重进浮层观察 `fd4fe26c-3675-48eb-b9ce-5031ad20bba2`。该观察的 `dialog:okd-transition-slide` 列出 20 个 controlId，而原 scope inventory 仅列 8 个语义控件。20 个节点中，6 个没有动作，是 dialog、焦点哨兵和 select 容器／popup 等结构节点；其余 14 个带动作或被项目暴露为动作节点。

其中只有 8 个节点形成最终 frontier case。它们的状态是：1 个实际 close 为 `executed`；1 个可访问性 Close 因边界已经退出而为 `superseded`；Min、Max 和两个 combobox 共 4 个为 `deferred / region_review_required`；Reset、Apply 共 2 个为 `blocked / operation_requires_review`。两个 combobox 的这组最终 frontier case 还明确记录 `identityResolved=false`。这些是范围内原始残留，不能因同类动作在较早观察中成功而自动视为零。

另外 6 个被观察暴露为动作节点，却没有对应的最终 frontier case：两个 `Select` textbox（localId `:7808`、`:7819`）具有 fill 动作，但 DOM 和观察均显示 `readonly=true`、`tabindex=-1`；四个 `role=none` wrapper（`:7791`、`:7798`、`:7806`、`:7817`）具有 tentative click 动作。现存证据没有逐项把这些节点裁决为语义重复、内部实现或应排除项，因此也不能在只读复核中把它们宣称为已解决。

identity 数据中，最终浮层的 20 个 identity record 在关闭后均为 `removed`。`removed` 表示节点生命周期结束，不等价于身份歧义已经解决。尤其最终 frontier 仍把两个 combobox 标为 `identityResolved=false`，所以原报告的“两个 combobox 已消歧”只能描述较早操作上下文，不能支持最终零残留断言。

区域方面，原操作过程确实提交过浮层区域复核，但最终 frontier 对 Min、Max 和两个 combobox 重新给出 `region_review_required`。这说明现存最终状态没有维持可用于零残留验收的区域闭合。全局 completion audit 的 blocked 不能直接等同于范围内 blocked；同样，也不能在没有逐项映射时把全局残留全部判定为范围外。本修订结论只使用上述明确落在浮层 controlIds 内的映射。

时间口径也作修正：`session.elapsedMs=399797` 是引擎累计活动时间，约 6 分 40 秒；会话 `createdAt=08:40:34.973Z`，停止请求为 `08:53:31.947Z`，实际墙钟跨度约 12 分 57 秒。两者均低于 45 分钟预算，但不能混为同一口径。动作数 49 低于 300 次预算。

调用层统计不变：停止前自动账本有 168 个 HTTP 请求、49 个 execute 请求。一次 `409 INVALID_REGION_REVIEW` 是动作派发前的程序阻断，没有创建 ActionAttempt；另有两次 curl 本地 URL 错误和一次 jq 本地格式化错误，也不是动作失败。

冻结核查仍成立：HEAD 为 `a512747e30b24a009b193db8798b0225f103b9cd`，tracked 工作树干净，`freeze.json` 的 514 个 tracked 文件 SHA-256 全部一致。会话保持 stopped，本次复核没有恢复浏览器、没有提交新审阅，也没有修改程序、配置或依赖。
