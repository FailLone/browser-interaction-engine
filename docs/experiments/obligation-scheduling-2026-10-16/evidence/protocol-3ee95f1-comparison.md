# 290456d → 3ee95f1 阶段性原协议比较

这是冻结提交 3ee95f17bfc590b0b1c250cbeb1612fce2637e5e 的已有记录分析；产品仍可能修复，不是最终验收。未运行测试，未触碰仓库、浏览器、服务或任务数据库。

原协议合计 80 trial / 版本：恢复 30、条件 25、接续 15、输入身份 10。四脚本 SHA256 两边相同；3ee 清单 231 个源文件前后相同，8 个命令 exit 0。

## 冷重启嵌套菜单：减少审阅，没有减少点击

|指标，每轮|290|3ee|
|---|---:|---:|
|实际点击|9|9|
|必要重入|3|3|
|无理由重入|0|0|
|JEV 请求|8|6|
|其中 region-review|7|5|
|重启前 / 后 JEV|4 / 4|4 / 2|
|LLM 请求|0|0|
|SDK 恢复 API|0|1|
|三条实际叶分支|3/3|3/3|
|trial 耗时 median / max ms|3672 / 3813|3196 / 3320|
|重启后 phase median / max ms|2260 / 2362|1821 / 1833|

新版唯一 SDK 恢复为 reachExplorationTarget，5/5 TARGET_REACHED，3 个实际恢复动作（Close gate、Open menu、Open submenu）；checks 包含 unknown、context、target-ready。checkpointVerified 为 false：这里验证目标可继续操作，不声称任意历史快照完整恢复。恢复 API 耗时 median / max 为 559 / 573 ms；旧版没有此 API 调用，0 不能当作可比恢复延时。

旧版重启后顺序：Close gate → Outside → Open menu → Open submenu → Branch B，全 external。新版：Close gate → Open menu → Open submenu（recovery）→ Branch B → Outside（external）。两个版本都产出 Branch A、Branch B、Outside，各 5/5；都没有重复叶分支。

JEV 总请求少 25%，重启后少 50%。trial median 在本批次少 476 ms（约 13%），重启后 phase median 少 439 ms（约 19%）。模型为确定性桩，不能推出真实模型耗时、成本或生产网站同幅度提升；路线和必要点击没有减少。

## shared-id-rebuild：不能给多一项 pending 赋予未经验证的意义

|阶段|290 rows / pending|3ee rows / pending|
|---|---:|---:|
|initial|1 / 1|1 / 1|
|after-initial|3 / 3|6 / 6|
|A-removed-B-rebuilt-before-dispatch|3 / 3|6 / 6|
|A-removed-B-rebuilt-after-dispatch|6 / 4|6 / 5|
|same-B-rebuilt-again|6 / 4|6 / 5|

上述路径在五次重复完全一致。两边最终总行数都是 6，实际只点击 B 一次，A 没执行，falseCoverageChecks 都是 0。新版在 after-initial 就已生成 6 行；旧版此时是 3 行，B 执行后才变成 6 行。

原 JSON 不含逐项 plan，只含计数和当前 Run 控件的 coverageClaims；因此无法指出新增待测项的 itemId/scope，也无法证明 pending 4→5 是保留了旧未测项或避免误结清。当前 A 已消失，falseCoverageChecks=0 也不能替代 A 的历史行审计。更不能把 pending 增加理解成新的覆盖或无限累积。

首轮精确 JSON 行：
- 290 `/tmp/bie-stability-scheduler-evidence/conditions-scheduler-base.json`：
  - `results[1].phaseRecord[0]`（对象行 237，pending 值行 261）：initial。
  - `results[1].phaseRecord[1]`（对象行 264，pending 值行 288）：after-initial。
  - `results[1].phaseRecord[2]`（对象行 291，pending 值行 309）：A-removed-B-rebuilt-before-dispatch。
  - `results[1].phaseRecord[3]`（对象行 312，pending 值行 332）：A-removed-B-rebuilt-after-dispatch。
  - `results[1].phaseRecord[4]`（对象行 335，pending 值行 355）：same-B-rebuilt-again。
- 290 `/tmp/bie-stability-scheduler-evidence/continuation-scheduler-base.json`：`runs[0].metrics` 行 142；`runs[0].recoveries` 行 1522；`runs[0].modelCalls` 行 1523；前/后 phase modelRequests 行 186 / 635。
- 3ee `/tmp/bie-stability-scheduler-evidence/scheduler-3ee95f1/conditions-scheduler-fixed.json`：
  - `results[1].phaseRecord[0]`（对象行 237，pending 值行 261）：initial。
  - `results[1].phaseRecord[1]`（对象行 264，pending 值行 288）：after-initial。
  - `results[1].phaseRecord[2]`（对象行 291，pending 值行 309）：A-removed-B-rebuilt-before-dispatch。
  - `results[1].phaseRecord[3]`（对象行 312，pending 值行 332）：A-removed-B-rebuilt-after-dispatch。
  - `results[1].phaseRecord[4]`（对象行 335，pending 值行 355）：same-B-rebuilt-again。
- 3ee `/tmp/bie-stability-scheduler-evidence/scheduler-3ee95f1/continuation-scheduler-fixed.json`：`runs[0].metrics` 行 142；`runs[0].recoveries` 行 1428；`runs[0].modelCalls` 行 1466；前/后 phase modelRequests 行 186 / 635。

## 保留的能力与证据边界

- 恢复正例两边均 20/20 到达且 guarded branch 有真实事件；两个负例合计均 10/10 拒绝，false arrival 0。
- 非局部依赖 A/B 两边均每轮实际执行各一次、false coverage 0；这次比较说明先前收益保留。
- 输入身份对应两边均 40/40 正确（30 拒绝、10 接受），30/30 实际填入，A/B/C 事件各 10。
- 价格 known/unknown 两边均 100 ticks：state 1、retry key 1、click 1、recovery 0；初始发现后 plan 与 pending 增长都是 0。unknown 在这里指条件证据不足，并非执行结果 unknown。
- 接续 unknown 两边均 5/5 真正关闭/新建 host+plugin 后保持阻断；重启后新 session、attempt、recovery、模型请求皆 0。原脚本没计 observe 调用，不能单凭本数据声称 observe=0。SDK 原恢复脚本 unknown 是同会话案例。
- failed_recovery_restart 的恢复失败是注入 UNVERIFIED 桩，0 ms 不能作为浏览器恢复速度；unknown 案例 raw recoveryHostSuccess=1 是注入前宿主结果，不能当作已安全恢复。
- 待测行未测长期失效淘汰、内存/CPU/数据库体积、缓存命中、真实模型延时和真实 OKX 持续探索。

结构化数据与完整文件 SHA256：`/tmp/bie-stability-scheduler-evidence/protocol-3ee95f1-comparison.json`。
