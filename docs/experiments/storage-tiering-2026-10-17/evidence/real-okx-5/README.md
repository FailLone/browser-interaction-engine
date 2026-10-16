# 第五窗：旧审阅检查点抢在本轮来源返回之前

本窗源码与 main 均为 `de88210e0b50d6c851569c2de1bcb254f3ff430b`，任务 `6c56a979-34f0-4599-a5b7-9461c357144d`、session `412937f3-c4f5-4799-b86c-74adf480f329`、原 round 接续，未创建替代任务。运行 `d8d00f33-79ae-4ebd-a8ec-9fc31b5c6fda` 于 2026-10-16 22:50:41–22:52:25 UTC 结束。仅使用本实验自有浏览器与数据库，原测试资源未操作。

## 实际结果

- 实际探索操作 3 次，均 succeeded：checkbox true、checkbox false、announced link。JEV 6 次全部返回，LLM 0；没有 unknown、executing 或未结算 provider。
- 3 次操作均为 `target_conditions_unavailable`，新增 operation-condition candidates 为 0；不能称新增 3 个语义分支。新增成功 occurrence 为 3，旧成功证据刷新 15，历史未解决项转成功为 0。
- 计划 539→543：pending 181、unresolved 335 均未变，succeeded 23→26，新增 untested 1。未测事项保留，清单没有耗尽。
- 一次严格 `reachCheckpoint`，耗时 5,990.252 ms，结果 UNREACHABLE，原因 `Checkpoint path contains actions without replay permission`，没有执行恢复动作。22:52:20.148 UTC 触发自动停止，22:52:21.672 完成暂停结算，22:52:25.343 标记关闭；没有使用信号强退。
- 本窗没有调用 `returnToObservedSource`；不能据此评价该 SDK 接口本轮成功率，也不能因未再次选中 Wallet 就证明上一修复的真实效果。
- 活动耗时记录 500,836→597,128 ms，历史中断的不确定尾段仍保留，累计耗时不是精确总量。独立进展审计期限尚未到达，恢复失败先触发停止。

原始 [summary](summary.json)、[metrics](metrics.jsonl)、[coverage-review](coverage-review.json)、[精简汇总](window-assessment.json)分别保留执行结果、时序与覆盖边界，不改写失败状态。

## 原因与修复边界

调度选择了旧的 `USD` generic 控件 `classification_unresolved` 项 `92e78cad-25e8-495e-a317-6194ec309298`。它没有 operation kind、没有实际 attempt，也不是页面授权；五个来源均来自第四窗。选中检查点 `4391fdff-f488-498d-ab11-dddfe27f6b2e` 的源为 `d0b567f7-791f-49b5-9a0d-80a6cd81ed35`，属于上一浏览器，路径含不可重放的历史返回操作。

本轮离开兑换页时保留了新检查点 `36360018-2a62-475d-80a5-b8d375c0b9e9`，来源 `fe3ed5c7-d5dd-4c76-9628-870ddb441ee9`。它有当前浏览器仍存在的 GET 历史锚点，可供已接受的纯 URL 根义务使用；它不能未经控件对应核验就替换旧 USD 审阅来源。现有排序把具体控件义务置于页面根之前，调度在找到旧严格路线时即返回，因而没有评估这条本轮来源路线。

SDK 拒绝不可重放路径是正确行为。`edd32f9e34a67ea482eedde9b3b64a6212647600` 修复调度：旧审阅事项缺少当前原生锚点时，先评估同 URL 的已接受页面来源返回；全部原有上下文、原生位置、未知结果与预算约束通过才选用，否则回退原严格候选。具体操作及仍有当前锚点的审阅路线维持原优先级。没有给路径补发 replay 权限，没有把 SOURCE_REACHED 计为审阅完成或覆盖，不清除旧失败债。页面返回候选已有 native eligibility 约束，因此取消冗余的全量预读排序，按原顺序逐个核验，首个合法候选不变。

10 文件 149 项相关测试通过；补齐新测试夹具的必需类型字段后，最终 18 项和 root/core 类型检查通过，先前类型失败日志保留，见[源码、命令及日志](review-source-priority/verification.json)。独立[冻结材料验收](source-priority-validation.md)在完整 542 行计划上证明新版选本轮 `fe3…/3636…`；所有计划、旧 retry 债逐 JSON 相同，4 条旧路线语义保留，已有页面路线只按原规则刷新两个来源锚点。独立静态审阅无阻断。

同一页面候选资格实验中，host observation 调用 21→2、actions 20→1，唯一读取源 19→1；完整计划对照仍是 observation 24→25、actions 24→24，唯一源均 19。前者证明页面路径免去无条件全量预读，后者说明整个调度仍有旧事项核查成本，不能称整体提速。反事实没有启动浏览器、provider 或网络，也不是实际恢复成功证明。

`edd32f9` 的隔离 archive [编译验收](../run5-fixes-compiled/summary.json)通过 build、发布类型、窄公共契约、编译后 API/UI 交互；472 份源码前后不变，603 份产物有摘要。UI 截图[单独复核](../run5-fixes-compiled/visual-review.json)，原生成 summary 不改写。显式 mock fixture 只验证发布产物可用，不代表真实 OKX 已恢复或穷尽。固定版本 80 次原协议另行归档；新真实窗口尚待接续。

## 冻结与存储

确认自有 runner 已退出、PID 不存在且 WAL/SHM 均不存在后复制。3,055 个文件共 87,573,777 B；源复制前后、冻结副本逐文件 SHA 与长度全部相同，4 个 SQLite 文件完整性检查通过。完整 [冻结清单](frozen-snapshot.json)保留；诊断仅对不可变只读库或专属完整副本执行。

关闭时 summary 的总量为 87,550,944 B，包含 engine 61,214,720 B、plugin 4,665,344 B、证据 manifest 1,916,819 B、blob 10,262,276 B、运行材料与日志 9,491,785 B。冻结字节比关闭采样多 22,833 B，来自随后落盘的汇总和控制材料。

[逐项增长报告](storage-growth.md)对账总增 14,065,765 B，其中新历史动作查询索引 1,150,976 B、本轮审计导出 4,117,047 B。10 次新观察的逻辑 33,682,744 B 对应观察行及新共享包 680,037 B，旧共享对象和观察字节保持不变。主要新业务 payload 是 1,880 条候选 action 与 246 新/311 更新的 identity。插件净页增长 40,960 B 使用了旧空闲页，不能把它当作真实 payload 仅增加这么多。混合观察时间区间未展示更短的中位数，页面样本也不同；没有纯投影/保存计时，不能做整轮性能因果结论。
