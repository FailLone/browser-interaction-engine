# Run 5 恢复路径诊断与最小调度修复

诊断基线为 `de88210e0b50d6c851569c2de1bcb254f3ff430b`。原始运行、原库和冻结库均未修改。SDK 解码只针对完整的私有复制；本次实现验收使用离线夹具及既有本地测试，不启动真实 OKX 浏览器或 provider。

## 实际失败与许可链

运行 `d8d00f33-79ae-4ebd-a8ec-9fc31b5c6fda` 选择 `92e78cad-25e8-495e-a317-6194ec309298`。该事项是 `USD` generic 控件的 `classification_unresolved` 审阅义务：无 operation kind，`dispatchScope=false`，`attempts=[]`。其五个直接观察来源均来自第四窗，四个拥有检查点。

`orderedObligations` 将具体控件范围置于纯页面范围之前。`scheduledRecovery` 在该事项的旧来源中选出检查点 `4391fdff-f488-498d-ab11-dddfe27f6b2e`，来源观察 `d0b567f7-791f-49b5-9a0d-80a6cd81ed35`，而后立即返回。它不是页面根义务，也没有可传给具体目标恢复的 action ID，因此 `step` 调用严格的 `reachCheckpoint`。

这次返回 `UNREACHABLE`，理由为 `Checkpoint path contains actions without replay permission`，耗时 5,990.252 ms，`attemptIds=[]`。起点 `d4d54ab3-190f-42a1-9a72-430fca15c213` 与最终观察 `c9d2e5d3-fb0b-4a40-9398-2d810b340c80` 均处于 OKX Help 页面。恢复未派发动作；正常自动停止并完成结算。耗时包含恢复的观察和验证过程，不能解释成一次真实导航耗时。

插件路线的 `path=[]` 是义务调度路径，不等于核心检查点的重放路径。核心 `checkpointInternal` 从 visit 保存的路径共有七个成功 attempt：

| 顺序 | 操作 | replayable |
| --- | --- | --- |
| 1 | checkbox true | true |
| 2 | checkbox false | true |
| 3 | announced link | true |
| 4 | `90102e0e-7a04-4b24-9abf-38f4f48498a9`，Return to observed page / history | **false** |
| 5 | generic scroll | true |
| 6 | Trade | true |
| 7 | 1h | true |

第 4 步是第四窗成功的原生历史返回，证据规则 `browser-history-return/v1` 绑定旧 browserSession `6b71f627-bc46-4141-88a0-b0bbbca10eec` 的 entry 6 → 4。第五窗 browserSession 已是 `131fb35f-efc7-47cf-bb58-236a56f89a3d`，不能把旧 history 操作重新授权为通用重放。核心在没有声明 reset 时正确拒绝不可重放的检查点路径。其余三个 USD 来源检查点也包含同一不可重放 history；仅换成更早的 USD 检查点不能解决问题。

## 已存在的独立可达来源

第五窗保留了三个当前浏览器的兑换页检查点；最新是 `36360018-2a62-475d-80a5-b8d375c0b9e9`，观察 `fe3ed5c7-d5dd-4c76-9628-870ddb441ee9`。其原生 GET entry 仍在当前浏览器历史中，`currentHistoryAnchor` 与 `sourceReturnCondition` 均可建立，adapter 可生成 history 返回候选。

这些事实只说明存在可供 SDK 再验证的原生来源路线，不证明导航已经成功。该观察没有进入旧 USD 审阅事项的直接来源；当前同名 USD 控件缺少可用于该义务的完整分类对应证明，而且处于活动弹层背景。不能用标签、稳定 key 或页面相同来重绑旧审阅事项。

纯 URL 根义务 `bf26248e-e22f-4c69-80b0-1e4edfe65dca` 已获接受，能独立请求 `returnToObservedSource`。因此缺口在候选顺序：旧审阅候选提前返回，令当前可原生到达的页面根候选没有被评估；不在 SDK 路径许可契约。

## 修复范围

`runtime.ts` 暂存满足以下条件的严格审阅候选：没有 operation kind、理由属于 control review gap、其来源没有当前原生历史锚点、同 URL 存在已接受且尚未完成的纯页面义务。随后只检查对应页面候选；它通过原有 authority、context、native entry、unknown、route debt 和 retry gates 才替换选择。全部页面候选无效时，返回原严格候选。

具体 operation 与仍有当前原生锚点的 review 保持原优先级。没有重绑 USD 来源、修改 replay 权限、清除失败债、标记义务完成或授予覆盖。`SOURCE_REACHED` 仍只表示原生来源位置到达；实际派发和返回后的验证继续由现有 SDK 承担。

纯来源返回已逐候选要求 `sourceReturnCondition`，因此所有非当前 native anchor 原本都会被拒绝。去除该分支的提前全量 `prioritizeReviewAnchors` 排序，改为按原顺序惰性验证，首个合法候选与原稳定分组排序一致。严格 review 的原生锚点排序保留。存在较新的合法来源时不会先解码所有旧检查点；无合法候选时仍会继续检查余下来源，未引入人为截断。这里仅报告读取行为，不把调用数下降等同整轮速度提升。

unknown 边界：opaque 的历史 unknown route debt 会阻止页面 source-return 候选，但单凭这类 ledger 不宣称全部 legacy strict 路线都被全局阻断。SDK 的 unknown attempt、未验证恢复与 pending dispatch 仍经既有全局恢复门禁阻断实际派发。本次回归分别覆盖二者，未混用证据。

## 验证与限制

新增 18 项离线调度测试覆盖旧审阅 + 当前来源、无直接来源引用时的惰性读取、最新 POST 来源失效后继续找较早合法来源、全部来源无效时保留 strict、context/boundary/stability/浏览器差异、已消费及饱和预算、unknown page debt、具体操作和当前原生 review 的优先级，以及 plan、旧证据和尝试记录不变。

相关 10 个测试文件共 149 项通过。两次类型检查暴露新增测试夹具的必需字段缺失，已补全 Checkpoint、constraints 与 reviewBinding 字段并保留原失败日志；最终类型检查及受影响 18 项新测试重跑均通过，结果见 `review-source-priority/verification.json`。冻结真实材料的新旧调度反事实由独立审阅者记录，不能用离线选择成功代替修复后的真实返回成功。本次没有运行新的 OKX 验收窗口，没有宣称覆盖穷尽。

源输入、命令、退出码与日志归档于 `review-source-priority/`；原始运行 `metrics.jsonl`、`summary.json`、`task-before.json`、`task-after.json` 均保留。
