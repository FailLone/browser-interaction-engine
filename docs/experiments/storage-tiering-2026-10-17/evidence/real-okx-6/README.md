# 第六窗：来源返回成功，待测清单增长触发人工审查

运行源码与 main 为 `f6d7b9e2b427b5edf1fad359ecf8cc5a3df8ffcf`。继续同一自有任务 `6c56a979-34f0-4599-a5b7-9461c357144d`、session `412937f3-c4f5-4799-b86c-74adf480f329`、round 1。运行 `f581575e-64ad-4983-8627-462c51067509` 于 2026-10-16 23:11:18.895–23:14:15.703 UTC 正常退出；未操作原测试浏览器、服务或任务库。

## 已取得的证据

- 4 次实际探索成功：checkbox true、checkbox false、announced 链接，以及返回后 Trade。另有 1 次 SDK 恢复操作成功；实际探索和恢复分别计数。
- `returnToObservedSource` 选择已接受页面根 `bf26248e-e22f-4c69-80b0-1e4edfe65dca`，检查点 `21870b2d-b34b-4ad1-87a5-d80eb9df1199`、来源 `78c74558-7a19-46c7-8eb6-5d66da1a1fa6`。一次原生 history 操作后返回 `SOURCE_REACHED`，耗时 15,539.687 ms，11 项验证通过；随后真实 Trade 操作 succeeded。这证明第五窗调度修复在本窗成功到达可继续交互的页面来源。
- 恢复结果仍为 `checkpointVerified=false`、`sourceStateRestored=false`、`currentExecution=false`、`executionAuthorized=false`。它不是任意页面快照还原，也不证明旧控件义务已完成。跨两窗的两个来源返回成功样本不足以估计普遍恢复成功率。
- JEV 26/26 返回，LLM 0；provider 报告总耗时 17,122.676 ms、input 58,012 / output 1,197 tokens。无 unknown、executing 或未结算请求。21 次 JEV 用于区域审阅，另分类、身份、控件风险各 1，探测风险 2。
- 4 次实际操作都缺少可验证的 target conditions，新增 operation-condition candidates 为 0。只能记录实际成功执行，不能称新增 4 个可复用语义分支。历史未键控成功与耗时不确定尾段均保留。

## 为什么停止

计划 543→721，新增 4 条成功执行记录及 174 条 unresolved；pending 保持 181，unresolved 335→509，succeeded 26→30，untested 保持 1。174 条都首次出现在来源返回后的观察 `c11abe9e-e2a4-44f2-bf53-64ebf22a1dd2`，其中 173 为 `region_review_required`、1 为 `pointer_intercepted`。

为审查增长原因，23:14:08.289 UTC 请求自有 runner 正常停止；23:14:09.060 接受请求，最终结算为 paused / user_paused。这是实验操作者的审查停止，不是自动恢复失败，也不是用户要求暂停整个开发目标。没有信号强退。

逐行诊断区分：130 项有旧完整 scope，其中 14 项 scope 与调度 key 都相同但阻挡理由不同；另外 116 项仅调度 key 内部 structural-item 的 DOM owner 实例编号变化。另 44 项尚须分别判断动态内容与新成员，不能把 174 全称重复。所有这些 key 都只是调度提示，不能代替 SDK 的操作对应证明。

旧记录没有显式 region reuse 策略，所以现有 SDK 实际可复用候选为 0。20 次返回页区域审阅由 legacy interface-only 模式分 4 批提交；observed-ui 的程序批分区未启用。不能静默改变执行模式，也不能将旧无 opt-in 的审阅后验授权复用。

发现另一个完成边界：原 `recordOutcome` 对带调度 key 的派生项，可凭 key 相等与当前 scope 唯一直接标成功，未逐一核验旧来源。若要把不同阻挡理由统一为同一待执行事项，必须先补齐该完成契约，防止一次新控件执行覆盖未验证的旧来源。本窗停止时尚未应用后续修复。

## 存储与实验边界

关闭采样 110,464,114 B：engine 74,858,496，plugin 6,598,656，证据 manifests 2,362,245，blobs 12,174,588，运行日志与材料 14,470,129；WAL/SHM 为 0。这是累计磁盘总量，不是单次保存成本；没有同输入整轮提速结论。

确认 runner 结束、PID 不存在、无 WAL/SHM 后，冻结为 `okx-storage-acceptance-20261017-v1-frozen-6`。共 3,651 文件、110,489,030 B，源复制前后及副本逐文件摘要和长度相等，4 个 SQLite 完整性检查通过。冻结与关闭采样之差来自随后落盘的汇总和控制材料。

原始 `summary.json`、`metrics.jsonl`、`coverage-review.json`、前后任务 JSON、停止请求、运行状态及 `frozen-snapshot.json` 均保留。后续诊断使用不可变只读库或完整专属副本，不在冻结库上构造有写入副作用的 SDK store。清单未耗尽，真实页面没有被证明穷尽。

## 停止后的修复与同输入核验

修复仍以原始 `f6d7b9e` 为比较基线，旧失败记录、全部来源引用、实际 attempt、原始条件 key、重试额度和恢复债均保留。新增调度 key 仅去除已验证 structural-item 编码中的文档实例部分，不成为身份、覆盖或重放证明。机械阻挡理由变化只在完整 scope、条件、唯一目标和完整前置路径一致时沿用待测项；不同 A/B 入口分别保留。重试预算只限制派发，不能过滤新来源的待测记录。

派生项结案增加逐来源门槛：自己的精确成功 receipt 可证明自己的实际执行，其余来源必须由 SDK 对应证明。新来源不能塞进旧 succeeded 行；unknown/executing、不可核对的 receipt 和缺失来源继续阻断。为避免“先未知用途、后经审阅真实执行”永不结案，SDK 另验证实际成功动作使用的原审阅、两端完整绑定、同文档唯一实例、规则版本与时序；仅可澄清旧 risk/basis，原非局部条件比较继续执行，目标到达与重放接口不使用此投影。

区域审阅只对新鲜判断显式登记可复用条件，旧无 opt-in 的判断保持原状。SDK 校验源/目标唯一性、完整结构与上下文，撤回链保持生效。原生 HTML 控件的 disabled readiness 不再使区域分组重复审阅，动作本身仍由 enabled 校验阻止；aria-disabled、data-owner 和非原生元素的 disabled 属性仍视为证据变化。

固定输入对照保留三轮结果及负面结果。第一轮虽新增行 174→47，但审计 JSON 抵消收益且产生 274 次多余观察读取；已改为紧凑来源引用、原生等价哈希、每次同步审计的 scope/condition 索引，以及直接引用已知观察记录事件。第三轮依据真实 `recovery.position_reconciled` 的空路径、174 新行前置及新 frame 交叉核对重建入口路径：204 个待处理动作全部保留，新增行仍为 174→47；当前审计只读取 3 个旧观察/1 个当前 actions/1 次 attempts。旧 announced 路径输入独立保留，因不同前置不可合并，结果为 174→175。

当前空路径对照任务 JSON 仍净增 **200,975 B**（973,285→1,174,260 B）；这些是逻辑 UTF-8 字节，不是实际 SQLite/WAL 大小。混合测试时一次审计 106.6→388.7 ms，新增启动规范化约 280.8 ms，不能称整轮提速。少生重复行、减少观察解码有后续收益，但首轮审计成本仍需真实接续测量。详见 [带路径边界的完整对照](full-audit-counterfactual-indexed.md)、[区域回归与原失败](../region-reuse-validation/summary.json)、[生命周期独立审阅](lifecycle-integration-review.md)。

全量验收、合并与下一真实窗口另行记录；当前这些受控结果不改变本窗“尚未穷尽”的结论。


## 尚未实施的同文档覆盖层与实际反例

[选择器诊断](selector-condition-diagnosis.md)确认当前 portable 条件拒绝有依据：隐藏行继承 visibility:hidden 后，其直接链接被 `recordScopes` 当成独立子区域排除，父级绑定没有进入 selector。仅修采集也不能把 inferred record-link 升为跨文档身份。Trade 后两组观察虽然有相同 28 个实例/状态，只能作为同文档证明的潜在候选。

[独立审阅](document-bound-operation-review.md)和[本地实际反例](document-owner-fixture/README.md)进一步否定“同文档+实例+现有全部 selector 字段相等就可继承覆盖”：保持原 li/i 和 Run 节点，先改父 li.data-record，再改兄弟 a.href，SDK 中全部原 selector/Run 字段仍相等，但三次真实点击分别产出 `A|/record-A`、`B|/record-A`、`B|/record-B`。原 portable API 均正确拒绝；当前产品没有被这个实验发现错误覆盖。复验 461 个源码哈希不变，完整 capture、12/12 原证据和实际 oracle 归档，自有资源已关闭。

后续若增加 document-bound 层，必须先补版本化、完整且唯一的 owner/record/IDREF 绑定，再让成功操作对应和 frontier 读取统一的 coverage-only 证明；target arrival、repetition 和 replay 保持原 portable 契约。缺证、新文档、新节点、A/B 改绑和 unknown 继续拒绝。当前没有实施这项放宽，也没有将潜在同文档样本计为覆盖收益。
