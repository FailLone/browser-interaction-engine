# Run 5 来源页面调度修复：冻结输入离线验收

本验收使用完整 frozen-5 私有副本上的 SDK 只读方法和内存任务，调用实际 `scheduledRecovery`，没有发起浏览器、history、provider 或网络操作。结果只证明调度选择与读取范围；不证明真实页面已返回，不授予覆盖、控件执行或严格检查点恢复。

基线固定为 `de88210e0b50d6c851569c2de1bcb254f3ff430b` 的 runtime 原文，导入路径仅改成绝对路径；所有直接相对 helper 与该 commit 的 SHA 一致。新 runtime 在运行时仍是上述 HEAD 的 dirty 文件，SHA-256 为 `c31377c8dee1b1e1c1f1c6a2049db27dba47b8dec2345d39aa43fab60f34dc76`，运行前后相同。没有以 HEAD 标签代替源码版本。

输入复原沿用 `plan-source-diagnosis`：从最终任务移除本次失败恢复才产生的 gap 与该次 route/retry，恢复 announced 后的选择游标，保留本轮成功动作、审阅来源/等待更新以及全部旧债。当前观察固定为 help 页 `d4d54ab3-190f-42a1-9a72-430fca15c213`。完整计划有 542 行；page-only 对照仅在内存保留 URL 授权行，仍保留全部旧 route/retry。所有 required 目标都位于其他 URL，因此当前页 availability 不影响远端候选。

| 实现与输入 | 选中项 / 来源 / checkpoint | observation 读取（唯一 ID） | actions 读取（唯一 ID） | checkpoint list | transition |
|---|---|---:|---:|---:|---:|
| de88210 full plan | 旧 USD review / d0b567f7 / 4391fdff | 24 (19) | 24 (19) | 1 | 7 |
| de88210 page-only qualification | URL 页面授权 / fe3ed5c7 / 36360018 | 21 (19) | 20 (19) | 1 | 0 |
| patched full plan | URL 页面授权 / fe3ed5c7 / 36360018 | 25 (19) | 24 (19) | 1 | 7 |
| patched page-only qualification | URL 页面授权 / fe3ed5c7 / 36360018 | 2 (1) | 1 (1) | 1 | 0 |

新版完整计划选中 `bf26248e-e22f-4c69-80b0-1e4edfe65dca`，来源 `fe3ed5c7-d5dd-4c76-9628-870ddb441ee9`，checkpoint `36360018-2a62-475d-80a5-b8d375c0b9e9`，`returnToSource=true`。旧 USD 待审项 `92e78cad-25e8-495e-a317-6194ec309298` 保留原内容。全部计划和旧 retry 债逐 JSON 比较不变；4 条既有 scheduling route 的非锚点字段全部不变，非选中 route 全字段不变。选中的既有来源返回 route 只把 observation/checkpoint 刷新为本轮合法来源；旧基线的 page-only 路径也进行相同刷新。新版没有提前绑定旧 USD 的 provisional route。

惰性验证使 page-only 对照由读取 19 个历史观察降为只读取本轮 fe3ed5c7。完整调度仍先核验旧 review，所以 observation 总调用从 24 到 25，actions 维持 24，唯一观察与 transition 数量不变。这里没有整体提速或固定读取上界的证据；许多无效候选或缺少 native 来源时仍可能扫描更多材料。所有数字为调用计数，不是时间基准。

静态复核未发现阻断：promotion 仅适用于已经通过原闸门的旧 review 候选，且要求同 URL、独立纯页面授权义务。页面返回继续逐项验证来源稳定性、上下文、native history、unknown 债、route 映射和 retry 条件；不改 review 的来源、不清旧债、不把页面位置当控件或严格检查点恢复。具体 operation 和当前 native review 的原选择顺序保留；页面候选失败时回到原 review。source-return 去掉 eager 排序后仍取原顺序中第一个通过全部 native 条件的候选。

原冻结 engine/plugin SQLite 与 task-before/task-after/summary 文件 SHA 前后相同；browser、provider、network、禁止 host 调用均为 0。完整 JSON 记录所有调用和唯一 ID；诊断脚本只写本目录的新证据和独享临时副本。未重复运行产品测试。

- 数据：`source-priority-validation.json`
- 脚本：`source-priority-validation.ts`
- 运行日志：`/tmp/okx-run5-source-priority-validation.log`
- 运行方式：Node 24，`--import tsx --conditions=development`；临时 material 丢失时先运行同目录 `plan-source-extract.py`。
