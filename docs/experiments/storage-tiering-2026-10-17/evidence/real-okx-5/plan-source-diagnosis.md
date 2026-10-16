# Run 5 计划、来源锚点与恢复选择诊断

结论：本轮计划只增长 4 行；转换页的新 native 来源没有丢失。停止来自旧 `USD` 分类审阅义务先于 URL 页面义务被选中，继而要求恢复旧浏览器中的完整 checkpoint。固定 `de88210` 源码的离线反事实证明：本轮页面来源能通过现有调度闸门，选中 `fe3ed5c7…` / checkpoint `36360018…` 的窄 source-position return。该结论只证明调度候选可构造，没有执行 history 或证明实际到达。

## 增长与实际工作

| 行状态 | 运行前 | 运行后 |
| --- | ---: | ---: |
| 全部 | 539 | 543 |
| pending | 181 | 181 |
| unresolved | 335 | 335 |
| succeeded | 23 | 26 |
| untested | 0 | 1 |

新增 3 个 `observed_in_scope` 行分别执行 `check Don’t show for 7 days=true`、`check ...=false`、`click announced`，均有真实成功 attempt。另新增 1 个 help URL 下的 `checkpoint_unverified`，为 untested，不扩大转换页执行权限。本轮没有重演 run4 的 514 行发现增长。

每个新成功操作在运行前都已有 **5 个精确同 scope、同 operationConditionKey 的成功行**。`step` 在同提示下所有旧行均完成时允许登记新观察操作；SDK 对新来源缺少 operation conditions，因此无法据这些成功行证明当前覆盖。这里不能把历史成功直接等价成当前条件，也不能把 true/false 两个输入合并。

三个 unkeyed attempt：

| Attempt | 操作 | 来源 → 结果 |
| --- | --- | --- |
| `d316eb23…` | check=true | `6c7cf95b…` → `61a3d07b…` |
| `fd9f7104…` | check=false | `61a3d07b…` → `12544344…` |
| `a4fc543d…` | announced | `fe3ed5c7…` → help `d4d54ab3…` |

实际 SDK 纯函数对三者均返回 branch/target conditions unavailable。另在专属副本上调用公开 `operationCorrespondence`：本轮第一次 check=true 成功，与 check=false 之后 `fe3ed5c7…` 中同 localId/instance 的 check=true 候选比较，仍返回 `equivalent=false / operation_conditions_unavailable`。所以缺口确实延伸到同文档同实例，不能只归因于重启；也没有据此新增覆盖许可。

## 被选的不是 24h 操作

`92e78cad-25e8-495e-a317-6194ec309298` 是转换页 **USD generic 的 classification_unresolved 审阅义务**，无 kind/value、无 prerequisites、dispatchScope=false、无 attempt。它前后内容完全一致，来源仅有 run4 的五帧 `5f80 / c446 / f6c6 / d0 / 9ca`。

`d0b567f7…` 恰是前轮执行 1h 后、24h 前的观察；选用它不代表目标是 24h。该义务最新来源 `9ca…` 没有 checkpoint；候选从来源倒序建立后，最新实际 checkpoint 是 `d0…` 的 `4391fdff…`。该审阅没有具体可执行目标 action，故走严格 `reachCheckpoint`。

插件路线的 prerequisites/path 是空数组，SDK checkpoint 自己的历史 path 则含 7 个真实 attempt；两者不能混同。SDK 返回 `UNREACHABLE / Checkpoint path contains actions without replay permission`，attemptIds=[]。它没有执行恢复动作，也没有声称旧 USD 审阅完成。

## 本轮来源存在，USD 审阅来源没有被越界更新

本轮保留了三个转换页 checkpoint：`6c7cf95b…/0dbbeb85…`、`61a3d07b…/ffad0fcc…`、`fe3ed5c7…/36360018…`。当前 help 页的 history 包含同浏览器的 GET 转换页 entry id=4；最近 `fe3ed5c7…` 的 `currentHistoryAnchor` 与 `sourceReturnCondition` 都成立。

旧 `d0…` 的 browserSessionId 是 `6b71f627…`，本轮是 `131fb35f…`。虽然两个 history 恰好都有数字 entry=4 和同 URL，旧 history 不能借用新浏览器位置；旧五个来源的 native anchor 均为 false。

新转换页仍有 visible=true 的 USD generic，分类投影存在，但它处于地区限制 modal 的 **active boundary 之外**。`reviewRecoveryChanges` 要求目标在 active boundary 内才保留新的审阅锚点，因此没有给这个 USD 义务添加本轮来源是正确限制。此次另有 8 个 `review.source_retained` 事件更新了实际可核实的审阅来源，说明更新机制并未整体失效。不能为修复排序而把 modal 后的 USD 擅自视为可审阅/可执行。

## 固定基线的调度反事实

使用完整 frozen-5 的专属临时复制；SDK 只调用读取方法。plugin store 为内存，不写原库或复制库中的任务表。重建 pre-recovery task：保留三个真实成功与来源/等待更新，仅撤回最终一次失败恢复的新 route/retry 和事后 checkpoint gap，恢复最后 announced 的 cursor。原计划 542 行，required scopes 全在转换页，与当前 help URL 不同。

基线 runtime 从 `git show de88210` 写入临时模块，所有相对 import 只改定位路径；引用 helper 逐一与该提交 SHA 校验。工作区正在开发的新 runtime **没有用于这些基线结果**。首次直接加载工作区时检测到选择已变，断言停止；固定基线后重新通过，未使用首次结果。

| 内存计划变化 | 实际 scheduledRecovery 结果 |
| --- | --- |
| 原计划 | USD `92e78…` → 旧 `d0…/4391…`，returnToSource=false |
| 仅暂移 USD 审阅 | BTC generic `de16343f…` → 同旧 `d0…/4391…`，returnToSource=false |
| 只保留原 URL 页面义务，完整保留既有 routes/retries/unknown 债 | root → 本轮 `fe3ed5c7…/36360018…`，returnToSource=true |

原始 ordered 列表中 root 为第 513 项（index=512）。`orderedObligations` 将带 label/stableKey/kind 的具体义务排在 broad URL 项前；`scheduledRecovery` 返回第一个合格恢复。因此问题不是“USD 特例”或“页面返回无法通过闸门”，单删 USD 只会转向 BTC。最小方向应是在已有窄规则内比较当前可验证页面返回与旧审阅来源的成本，保留具体操作、当前 native 审阅和所有未知/重试债的原契约。

以上 page-only 反事实是明确标记的候选资格隔离，不能当作完整计划已实现新排序，也不能当作真实浏览器能成功返回。它没有改审阅来源、清债、调用 returnToObservedSource 或任何恢复方法。

## 证据与边界

`plan-source-diagnosis.json` 保留完整来源、候选、history、SDK 结果、事件及源码哈希；`plan-source-extraction.json` 保留输入 SHA 和解码校验计数。原始提取只用 immutable/query_only SQLite。SDK 构造只发生在完整专属复制，随后删除；browser/network/provider/禁用 host 调用均为 0。原始 JSON 与两库前后 SHA 未变，无产品/测试源码修改。

此报告不提出跨上下文覆盖放宽。另一个独立性能边界：真实 root 没有非 attempt 的直接 evidence，所以旧页面候选逻辑可能扫描全部 checkpoint；新增优先级若促使更早访问该路径，需要检查读取成本，不能由“有显式来源的合成 root”测试推断真实运行无额外读取。
