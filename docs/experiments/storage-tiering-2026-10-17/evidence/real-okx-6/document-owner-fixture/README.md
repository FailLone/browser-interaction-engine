反例已由自有本地 fixture 实际复现，产品版本为 d103747ee78779b3f1df8223854600cd321e36ee。未改产品或 tests，未实现新证明契约。

| 本地变化 | 隐藏 li/i 同一 JS 对象 | 全部原始 selector 字段相等 | Run 全部原始 Control 字段相等 | Run 实际 UI / HTTP oracle 输出 |
| --- | --- | --- | --- | --- |
| 初始 A / record-A | 是 | 基准 | 基准 | `A|/record-A` |
| 只将 li `data-record` A → B | 是 | 是，未忽略任何字段 | 是 | `B|/record-A` |
| 再只将直系 a.href record-A → record-B | 是 | 是，未忽略任何字段 | 是 | `B|/record-B` |

每个状态都由 SDK 观察并执行同一 Run 原生 button；三次 attempt 均 succeeded，有真实 before/after 与 UI 分支输出。服务端同步 HTTP oracle 与页面记录一致。比较的是 SDK 捕获的两个隐藏 mode selector 的完整原始 Control 对象，不是挑选性摘要，也没有删除 identityId、hypothesisId、rect 或其它变化字段。两次比较的差异列表均为空。Run 的完整原始 Control 及 action 的 kind/value/risk/basis 也完全相同。

被反驳的 naive key 包含同 session、browserSessionId、documentId、instanceScope、URL、known context、ruleVersion，以及全部完整 selector 对象；两次改绑前后 key 相同。该 key 若用来证明 Run 覆盖对应，就会把 `A|/record-A` 的成功错误用于 B 分支。DOM 实例连续性并不能证明父级记录绑定连续性。控件只捕获 parentInstanceId，hidden 控件无 reviewReuseBinding、identityContext/structural record；自己的 reviewAttributes 为空，因此 li 的 data-record 改变不进入这些 selector。相邻 link 的 href 被完整页面采集到，但不属于 mode selector；只比较 selectors 会遗漏它。完整 HTML/观察并非整体相等，本报告也未声称整体相等。

原有 portable 契约没有该错误：两种变化之前/之后 browserBranchConditions 和 controlCase(portable=true) 都 unavailable，实际 operationCorrespondence 都返回 equivalent=false / operation_conditions_unavailable，且 replayAuthorized/currentExecution=false。这个实验反驳的是拟议的 naive 文档绑定，不是声称当前产品已经错误覆盖。两个 selector 仍各有 pending logical identity；不能为了采用反例以外的正例，删除其条件或放宽 nonlocal mode 检查。

材料入口：`fixture.html` 是唯一页面；`experiment.ts` 是独立实验，不属于产品或测试。`trial-2/results.json` 保存执行 receipt、实际 oracle 和对照；`comparisons.json` 保存完整 selector 比较与 naive key 摘要；`target-comparison.json` 是从原始 capture 直接抽出的 Run 完整字段比较。六个 capture JSON 包含完整 observation、actions、HTML 与 JS 对象连续性断言，六张 PNG 保存页面状态；`all-observations.json`、`all-attempts.json`、`events.json` 保存 SDK 原记录。`captured-evidence/` 导出 12 份原截图/details，全部与 retention 元数据的 SHA-256 + mediaType 一致，总计 435511 字节，无缺失。

首次运行 `trial-1/` 已复现同样结果，但实验导出器把 retention 实体 id 当 artifact key，导致其导出清单记录 missing。这是导出器错误，非保留证据损坏；首轮记录和当时代码完整保留。仅修独立导出器为实际 row.key 后，第二次同 fixture 完整重跑、12/12 导出成功；未修改页面、比较投影、oracle 或产品。两次命令退出均为 0，首轮导出缺口没有被伪装为取证成功。

两轮各自的 source-before/source-after 覆盖 461 个产品/脚本/测试文件且完全相同；source 仍 d103747。host.close 后 page.isClosed=true、server.listening=false，清理无异常，实验进程已结束，MemoryStore 随进程结束释放。没有读取/写入任何真实任务库、真实站点、provider 或用户浏览器。命令、脚本及全部产物 hash 见 commands.json/files.json。到此停止，未实施任何产品契约。
