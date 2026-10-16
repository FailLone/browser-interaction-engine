# 290456d → 7c88f01 原协议对照

仅报告已结束的 80 轮协议；不包含仍在运行的完整 59 文件回归，不据此宣布全部验收完成。

基线 `290456d63831477638b6aa7de3bee4a15e4c675c`；候选 `7c88f0161a47969b28aeddb7c5269d9ae683af30`。每版恢复 30、条件 25、接续 15、输入身份 10，合计 80 trial。每场景重复 5 次，四份验证脚本字节相同。

候选的协议与完整回归并发运行。下述耗时仅是本批观察值，不能证明提速，也没有隔离调度、浏览器等待、机器负载或缓存的耗时贡献。未运行新测试，未改仓库，未操作浏览器、服务或任务数据库。

## 结果与分母

|指标|290|7c88|解释|
|---|---:|---:|---|
|SDK 恢复正例：到达且实际 guarded branch 事件|20/20|20/20|静态嵌套、弹层重入、动态报价嵌套、已就绪目标|
|SDK 恢复负例：拒绝且不执行目标|10/10|10/10|局部退出偏离、执行结果 unknown；false arrival 都为 0|
|条件协议：实际声明叶分支|35/40|35/40|缺失均为 shared-id-rebuild 的 A，共 5 次|
|条件协议：误覆盖计数 / 重复点击|0 / 0|0 / 0|只检查当前 Run 控件，不能替代消失控件的账本审计|
|输入身份对应判断|40/40|40/40|30 次应拒绝、10 次应接受|
|输入真实执行|30/30|30/30|A、B、C 各 10 个输入事件|
|冷重启嵌套实际叶分支|15/15|15/15|每次 Branch A、Branch B、Outside 各一次|
|失败恢复后接续实际叶分支|10/10|10/10|UNVERIFIED 为注入桩；并非实浏览器失败恢复成功率|
|unknown 冷重启保留并阻断|5/5|5/5|真实关闭并新建 host + plugin；B 刻意不执行|
|接续命名旧待测行遗失 / 错结清|0/40 / 0/40|0/40 / 0/40|仅此协议输出的命名 priorPending 行|

接续合计实际叶分支 30/35，其中 5 个 missing B 来自必须阻断的 unknown 负例；不能把它们当作漏测失败，也不能把 15/15 valid 当作 15/15 完成探索。failed 场景最终仍 budget_exhausted，unknown 最终 blocked。

unknown 冷重启后，两个版本的新 session、attempt、recovery、模型调用均为 0；每轮原 unknown id/status 保留。原协议未记录 observe 调用次数，不能单凭这些 JSON 声称 observe=0。原 SDK 恢复脚本的 unknown 用例没有重启，只有 continuation 的对应 5 轮提供冷重启证据。raw recoveryHostSuccess=1 是注入 unknown 之前的宿主返回值，不能记作安全恢复成功。

## 嵌套恢复路线与模型请求

|每轮 cold_nested_restart|290|7c88|
|---|---:|---:|
|实际点击|9|9|
|必要重入 / 无理由重入|3 / 0|3 / 0|
|重复叶分支|0|0|
|JEV 请求|8|6|
|region-review / classification|7 / 1|5 / 1|
|重启前 / 后 JEV|4 / 4|4 / 2|
|LLM 请求|0|0|
|实际 SDK 恢复 API|0|1|
|trial elapsed median / max ms|3672.00 / 3813.00|3248.00 / 3421.00|
|重启后 phase median / max ms|2260.00 / 2362.00|1865.00 / 1938.00|
|SDK 恢复 API median / max ms|无调用，无可比样本|570.00 / 586.00|

旧版重启后：Close gate → Outside → Open menu → Open submenu → Branch B，全是 external。新版：Close gate → Open menu → Open submenu（recovery）→ Branch B → Outside（external）。

新版 reachExplorationTarget 5/5 返回 TARGET_REACHED，实际执行 3 个恢复动作，并通过 unknown、context、target-ready 检查；checkpointVerified=false。它证明目标可继续操作，不声称历史页面快照完全还原。每次仍有相同 3 个必要重入和 9 次实际点击。旧版无恢复 API，耗时字段 0 不能与新版 570 ms 直接比较。

确定性 JEV 桩每次减少 2 个 region-review 请求：总请求减少 25%，重启后减少 50%。这支持减少重复审阅和使用确定性恢复路径的方向，不能推导真实模型延时、费用或整体提速。15 次接续的 JEV 总数 55→45，LLM 均为 0；其他三个协议不调用模型。

## 待测范围与动态状态

|场景，每轮|290 最终 rows / pending|7c88 最终 rows / pending|实际执行|
|---|---:|---:|---|
|public-form-cycle|5 / 0|5 / 0|form:A, form:B|
|shared-id-rebuild|6 / 4|6 / 5|shared:B|
|price-known|5 / 3|5 / 3|price:run|
|price-unknown|7 / 5|7 / 5|price:run|
|nonlocal-dependency|8 / 4|8 / 4|nonlocal:A, nonlocal:B|

两种价格场景每轮都经历 100 ticks；两边均 state=1、retry key=1、click=1、recovery=0。初始发现之后，plan rows 和 pending rows 增长均为 0；known 维持 5/3、unknown 维持 7/5。这里 unknown 是模式条件证据不足，不能混为执行结果 unknown。

非局部依赖两边都实际执行 A/B，每轮各一次，误覆盖和重复点击为 0。此比较证明保留先前修复，不是新增覆盖。任意隐式 JavaScript 因果、自由文本依赖和全部组合仍不在证明范围。

shared-id-rebuild 五次均有同样轨迹：

|阶段|290 rows / pending|7c88 rows / pending|
|---|---:|---:|
|initial|1 / 1|1 / 1|
|after-initial|3 / 3|6 / 6|
|A-removed-B-rebuilt-before-dispatch|3 / 3|6 / 6|
|A-removed-B-rebuilt-after-dispatch|6 / 4|6 / 5|
|same-B-rebuilt-again|6 / 4|6 / 5|

最终总行数没有增加，都是 6；新版初始观察阶段更早建立到 6 行。实际仅 B 一次、A 缺失；B 再重建后不继续增长。但 JSON 只输出计数和当前控件 coverageClaims，没有逐项 plan 的 id/scope/status/lineage。pending 4→5 究竟是哪一行、是否保留旧未测项或避免误结清，仍未证实。不能把这项增加宣传成覆盖收益，也不能据此认定无限增长。

接续的 cold/failed/unknown 三场景，重启前后总行数分别始终 11/6/6；所计 pending 分别 5→0、4→2、4→4。命名旧待测 40 行没有遗失或错误结清；仍不能据此断言真实页面穷尽。

## SDK 恢复 API 耗时观察

|场景，各 5 次，median / max ms|290|7c88|
|---|---:|---:|
|nested_static|510.83 / 542.71|570.58 / 611.36|
|modal_reentry_changed_quote|714.37 / 724.92|721.42 / 811.73|
|ready_target_ticking_quote|188.61 / 205.74|204.61 / 205.61|
|nested_changed_quote|862.68 / 1002.24|906.62 / 985.54|
|local_inverse_diverges|389.13 / 389.71|370.62 / 387.48|
|unknown_outcome_injected|0.78 / 0.92|0.80 / 0.87|

计时包围恢复 API，不含随后测量用 DOM 核实和 guarded target dispatch。negative 的快速返回是拒绝开销，不是成功恢复。并发回归影响没有控制，不从此表得出快慢结论。

## 来源与定位

候选 manifest 231 个源文件 before==after，sourceUnchanged=true，8 个协议命令 exit 0。290 独立导出审计 200 个产品文件 allMatch=true；其恢复运行审计 200 个产品文件前后相同。导出审计与运行前后审计的统计范围不同，不能将 200 和 231 当作产品增量。

四个脚本哈希在两版记录中一致，且与当前只读检查的脚本字节相同：

|脚本|SHA256|
|---|---|
|verify-exploration-recovery.ts|`005a8e58223e70f95b27a2f3a4e45833ba61930cd0caca5ce85faf5ef11ee57f`|
|verify-exploration-continuation.ts|`7b193666d24f3d7b650667e6b5b640b27e2a281e2db5c45a8ed0e066dba7ff4f`|
|verify-exploration-conditions.ts|`4c977f147d123ea1adc7c3496cce927ae5be7603fff317b5700578b2732d8693`|
|verify-exploration-input-identity.ts|`7cfe18ff69e2fcdad84cda46b353d2c9d0c44c6ce6486ac36b75a322e52ab1e1`|

首轮精确 JSON 定位（均零起始数组下标）：

- 290 `/tmp/bie-stability-scheduler-evidence/conditions-scheduler-base.json`：`results[1].phaseRecord[1]` 对象行 264 / pending 行 288；`[3]` 对象行 312 / pending 行 332；`[4]` 对象行 335 / pending 行 355。
- 290 `/tmp/bie-stability-scheduler-evidence/continuation-scheduler-base.json`：`runs[0].metrics` 行 142；`recoveries` 行 1522；`modelCalls` 行 1523；前/后 phase modelRequests 行 186 / 635。
- 7c88 `/tmp/bie-stability-scheduler-evidence/conditions-scheduler-fixed.json`：`results[1].phaseRecord[1]` 对象行 264 / pending 行 288；`[3]` 对象行 312 / pending 行 332；`[4]` 对象行 335 / pending 行 355。
- 7c88 `/tmp/bie-stability-scheduler-evidence/continuation-scheduler-fixed.json`：`runs[0].metrics` 行 142；`recoveries` 行 1428；`modelCalls` 行 1466；前/后 phase modelRequests 行 186 / 635。

全部输入 JSON/manifest 的 SHA256、具体重复样本、证据字段与分母保存在 `/tmp/bie-stability-scheduler-evidence/scheduler-final-comparison.json`；生成前后核对输入文件未变。

尚缺：完整 59 文件回归结论、shared 逐项账本、observe 调用计量、真实模型成本/耗时、长期失效待测淘汰、CPU/内存/数据库体积与缓存指标、真实 OKX 长时探索。原协议部分使用外部驱动 DOM 与私有 step，不等于全部走自主调度。
