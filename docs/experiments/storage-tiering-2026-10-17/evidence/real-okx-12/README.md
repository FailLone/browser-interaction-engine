# 第十二窗：已结算，真实恢复门未通过

唯一新增理由：核验 `c3a7d1a5cf08de45900b28d3aa134fbf9c600768` 的候选契约能跳过 SDK 明确报告 `no_known_path` 的历史 strict 来源，而不丢失待测与旧债。候选判断不证明恢复、覆盖或整页穷尽。run11 保留事实上的八策略无路结果仅是开启本窗的依据，不能代替本窗当前事实。

本窗已于 `2026-10-17T06:36:45.280Z` 正常结算，run `bb1d2382-753b-43e4-849c-4ca04066b822`，source/main `7c0273d`，产品 `c3a7d1a`。launcher exit 0 只表示结算成功，不能视为验收通过。原始停止原因为主线程发现采样停滞后发出的 `operator_stop_request`；没有追加窗口。

已固定发布基线 `a5adfb6b2e7d1e01d5eff8f1e3f7a7c5520e6627`；允许其后仅文档工具提交，但实际 HEAD 必须等于本地 main，产品及 runner 继续通过原检查。

准备检查仅含 JavaScript 语法、Python AST 与 JSON/预算参数解析；没有导入或执行任何入口，没有创建数据副本、launch 记录或审计结果。

## 本窗结论与证据

- **新候选契约的真实效果尚未证实。** `checkpoint_no_known_path` item 事件为 0；这不是 SDK 调用或逐来源跳过次数。此前失败的 Trade 审阅项 `e5ecf883…` 实际由既有 `route_retry_condition_attempted` 暂缓。不能将旧失败债的效果归给新 API，也不能由零事件推断 API 从未调用。
- **恢复调用 0，到达及到达后覆盖门未通过。** 本窗发生 5 次实际成功操作：check true/false、Close、Trade、fill。唯一离线 SDK batch 核对为 **5/5 document 条件覆盖**，所有到达、重放、身份、当前执行授权均为 false。Close 的同文档边界退出已验证；它仍不是 checkpoint/target/source 到达。跨会话语义新增、必要重入和全页穷尽未获证明。
- **观察到响应性问题。** 相邻 metrics 输出最大间隔 **168.994 秒**；`06:35:36.228Z` 发出的自有停止请求到 `06:36:17.738Z` 才被处理，延迟 **41.510 秒**，结算延迟 **59.510 秒**。其间又开始了 1 次 fill，最终成功且取得 document 覆盖；不能省略这次停止后的动作。未强杀进程。
- **计划和旧债完整保留。** plan **1194→1241（+47）**，原 ID 与 scope/prerequisites/required/dispatchScope/condition 字段无缺失或变化，无重复 ID；新增 43 个 region review、2 个未执行操作、1 个 pointer intercepted、1 个 observed-in-scope。8 条旧路线债逐字段不变。470 个暂缓事件均保留 item、不授予覆盖，原因分别为 source_target_unverified 408、retained_checkpoint_unavailable 57、route_retry_condition_attempted 3、current_review_occurrence_present 2。增长不等于语义新增或收敛。
- **结算完整。** JEV 6、LLM 0；unknown、在途及 provider pending 均为 0，无 fatal/diagnosticFailure。原冻结 v4 字节校验未变。唯一 receipt 审计 query SQL/public writes/driver 均为 0，构造阶段两个 SQL change 分列记录，未改变原回执；副本关闭后字节不变且已删除。

完整提取仅保存在 [outcome.json](outcome.json)，回执结果仅在 [receipt-audit.json](receipt-audit.json)。原 exports/metrics 仅引用自有冻结 v5/run 目录及 [closed-evidence.json](closed-evidence.json)，不复制原始数据。采集器与 receipt 算法没有随本补丁改变，因此没有重复原 wire/graph 诊断；旧诊断明确仅支持其旧窗口。

一次 1 秒的自有进程 native 采样显示大量 JSON.parse，physical footprint 原值为 1.5G、峰值 1.7G。只压缩保存 [原始采样](owned-process-sample.txt.gz) 一份，哈希和尺寸在 [native-sample.json](native-sample.json)。这是定位线索，不是 JavaScript 函数级归因或性能 A/B 结论。

静态最可疑调用链为 `step → scheduledRecovery → prioritizeReviewAnchors → recoverySourceMaterial → SqliteStore → decodeStoredEntity`。排序临时数组持有全部 source，8 项缓存不能限制它；跨 item 可能重复淘汰读取，每批候选查询又读当前事实和 attempts。同步 pending×source 扫描不让出事件循环，会推迟同线程采样与停止轮询。该链与现象一致，但本窗没有函数调用计数，不能断言全部开销由新候选 API 引入。

下一补丁只解决“候选扫描可中断、停止后不继续派发”这一结论；再单独处理精简投影与共享读取的成本。先用冻结输入/受控大候选集合证明边界，不再开真实窗口逐项试错。性能、存储和行为结果继续分开。第 3 项尚未完结。

以下是本窗已执行工具的固定规则与操作说明，保留以便复核，**不是再次执行指令**。

## 固定输入与隔离

`window.json` 固定冻结 run11 的 v4 目录、关闭记录哈希、产品 commit、现有 runner 哈希及新 v5 目录。`window_files.py` 把 run9 已有文件复制/关闭规则直接参数化，供两个小入口复用；`launch.mjs` 直接调用已有 `scripts/okx-storage-acceptance.ts`。不再执行多层字符串替换，也不生成 JavaScript。

- 来源：`.data/okx-storage-acceptance-20261017-v4`，run `01958656-8614-4f9b-b571-a182b5cd8bbc`。
- 新工作目录：`.data/okx-storage-acceptance-20261017-v5`；必须不存在。
- 仅复制 engine/plugin 的运行必需材料。所有 SQLite、manifest 等可变文件独立复制；只有 `engine/evidence/blobs` 下 `.gz/.bin` 内容硬链。旧 runs、summary、active-run、stop/control 元数据和协调锁均不复制。新 owner 独立生成，保留同一 taskId。
- prepare 不打开任何数据库，不调整任务预算/用量。复制前后核对冻结来源的完整字节清单哈希；不迁移或重启 v4。
- launcher 只继承原先的 provider 白名单与代理变量，不读取或记录 provider 值之外的服务配置；凭据值不写证据。

沿用一次增量预算：1 轮、20 动作、80 模型请求、8 分钟，采样 30 秒、停滞窗口 5 分钟。保留所有现有停止门、在途结算和 overshoot 报告。strict 恢复失败仍按原门停止，不能改记成功。

## 主线程批准后的操作顺序

1. 记录 main 合并及核准 revision；确认产品在其祖先中。`prepare.py --prepare <verified-main-revision>` 创建唯一 v5 副本。此步骤会复制文件，当前尚未获准执行。
2. `launch.mjs --run <verified-main-revision>` 核对 HEAD/main、干净运行源码、runner 哈希与 preparation，一次调用已有协议。不能直接启动未准备的目录。
3. 等 launcher 和 owned active-run 都正式结算后，`close-and-copy.py --closed-copy` 冻结新结果、核对 run11 未变，创建唯一临时 DB-only 审计副本；不打开数据库。
4. 主线程单独授权一次既有 receipt batch 审计，使用实际 `closed-evidence.json`/`audit-copy.json` 输入。审计逻辑参照已冻结的 [run11 审计](../real-okx-11/receipt-audit.mjs) 及结果；此处不再叠加 wrapper，也不在实际 runId 未产生前伪造审计准备或成功结果。审计关闭后按所有权/指纹清理临时副本。

Python 入口建议使用 `python3 -B`，避免写入无关字节码。JavaScript 使用 `window.json` 的 Node 24 路径。所有命令都由主线程在上述授权检查点执行，本说明不是执行许可。

## 分开核对三个结论

1. **候选调度：** 既有 metrics 中的 `obligation.route_unavailable / checkpoint_no_known_path`、后续选择以及 task-before/after。确认相关 item 仍未完成，旧 ID/scope/prerequisites/required/dispatchScope/条件与旧 debt 保留，且无伪恢复 attempt/result。此事件是 item 级暂缓，不能冒充每个历史 checkpoint 的逐项统计；引用不足时报告未证实。
2. **实际到达：** 分列 strict checkpoint、目标操作到达、来源位置返回与边界退出结果；记录实际恢复动作数、耗时、失败/unknown。候选 `tryable` 或 `no_known_path` 均不计到达。
3. **到达后收益：** 一次现有 SDK receipt 审计统计随后真实执行的条件覆盖，区分历史覆盖、本轮执行及恢复动作。另报待测增长、必要重入证据、JEV/LLM 次数；没有对应证据就不报必要重入或跨会话新增覆盖。性能不做 A/B 结论。

本窗不重跑旧 audit、codec 或完整协议；不为下一旧项追加特例，不扩大预算。只保存新结果一次，引用 v4 冻结证据。到达与覆盖任一门未满足，应明确保留缺口。

复制规则参考固定原始工具：run9 `prepare.py` SHA256 `170ce16c2a020bdf215325b9e448fcaa07030ed38aaa3e8a616a6e2f6473d172`；run9 `close-and-copy.py` SHA256 `056ba491d577d5051e5fdda0a4c8c647788ad03a82859a90cdd3d5ac5bfb3626`。启动白名单/子进程协议参考 run8 launcher SHA256 `6cab3eedbcbd15da6a82238f8e99db42541b29d7c9c4b53cf677664273b84e3f`。没有复制历史实验数据或报告。
