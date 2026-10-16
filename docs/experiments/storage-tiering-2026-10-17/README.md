# 结构共享、任务压缩与读取对照

初次存储实现：`70b8cb4`；验收脚本修复：`2ff9e4b`、`9daa3af`；中断结算：`a657220`；大型 state 压缩：`91af435`。初次基线：`5696125ea3da0909d2daadfa150fa7ad8e94687e`，state 追加对照基线为 `6630dfa`。开发工作区为 `/Users/xietian/.codex/worktrees/exploration-layered-refactor/browser-interaction-engine`，分支 `codex/exploration-layered-refactor`，本轮开始时无未提交差异。原有测试浏览器、服务、任务库及其他工作区没有用于本轮验证。

当前结论是：存储分层的方向有证据支持，收益集中在重复观察与历史任务；不能声称所有写入、读取和内存指标都改善。这次没有修改状态等价、操作对应或覆盖授权规则；共享的是不可变字节，压缩不能代替页面恢复验证。

## 实际变更

- SQLite schema 3：完整 Observation 的控件、区域和嵌套子树按内容寻址，合包压缩；每个观察保留独立、有序、带完整摘要的重建清单。小值和不适合共享的内容使用原始 JSON 或整值 gzip。
- 观察缓存按总变更数、其他连接版本和 schema 版本失效；内容缓存不跨外层事务复用。连续低共享时跳过四帧结构分析，再周期探测；只保留有界、无授权效力的编码提示。新稳定布局可以重新进入共享。
- ExplorerStore schema 4：活动计划和当前轮次保持独立访问；终态计划与旧轮次使用有界 Zstandard 字典块。记录 occurrence、顺序、CAS 版本、A/B 源证据、unknown、预算及任务原义均保留。大任务头单独压缩并保留查询投影。
- `taskState()` 在一次完整组装中同时返回任务和编辑引用；活动查询使用部分索引。SQL 语句缓存限制为 128 项、256 KiB。
- 证据容量核对使用有界增量计数投影，保护关系仍重新读取。批量删除每次只扫描剩余文件清单一次；SQLite OS 锁协调文件发布、读取和回收，避免另一实例删掉尚未发布清单的块。
- 显式维护验证所有保留根，再回收孤立对象、重打包混合包。维护不按年龄删除 Observation 根，不清除 unknown，不自动解除模型证据 pin，也不在热写中扫描所有历史块。

## 任务库对照

同一脚本分别运行完整隔离基线和冻结实现；36 个独立进程，每个条件三次交替。所有输入、最终任务及维护后内容摘要跨版本一致。以下耗时为各进程稳态中位数的中位数，单位 ms。

| 计划行数／任务头 | 活动行 | 完整 task() | taskState() 改善 | CAS 热写 | 关闭后数据库 |
| --- | ---: | ---: | ---: | ---: | ---: |
| 1,000／小 | 10 | 2.974 → 2.642 | 25.0% | 0.107 → 0.099 | 950,272 → 372,736 B |
| 1,000／大 | 10 | 3.575 → 3.270 | 21.0% | 0.479 → 0.610 | 1,417,216 → 376,832 B |
| 5,000／小 | 10 | 14.722 → 12.969 | 26.5% | 0.105 → 0.102 | 4,542,464 → 1,474,560 B |
| 5,000／大 | 10 | 17.245 → 16.008 | 23.7% | 1.910 → 2.510 | 6,938,624 → 1,507,328 B |

历史任务完整读取快 7.2%–11.9%，带引用的任务加载快约 21%–27%，关闭后数据库减少 60.8%–78.3%。这不能推广到全活跃任务：1,000／5,000 行全活跃样本完整读取慢约 8%，关闭后 DB 分别增加 3.0%／0.6%。首次保存约慢 1.7–2.1 倍，部分首次读取也变慢；历史样本进程 RSS 高水位增加约 35–75 MiB。RSS 包含整个进程的分配，不能当成单次读取的净内存占用，更不能声称节省内存。

大任务头的 CAS 慢约 27.5%–31.4%，因为依然要序列化整个 header，再执行压缩。WAL 也不能忽略：1,000 行小头历史样本热写后 DB+WAL+SHM 为 2,532,192 → 2,877,536 B，虽关闭后 DB 变小，运行中这个采样点反而增加。5,000 行大头对应为 8,861,248 → 4,803,288 B。两边均采用相同 1,000 页自动 checkpoint、初始截断和最终关闭，原始记录保留每阶段文件大小。

维护测试先在两边删除相同一半 occurrence，核对完整任务、版本和引用保持一致。新版 24–117 ms 包含完整校验、重打包、引用回收和 VACUUM；基线 2.8–13.7 ms 仅执行 VACUUM，不能把它们视为同样的工作量。活动与冷记录索引均留有实际查询计划。

证据：[汇总](evidence/task-storage/summary.json)、[基准脚本](../../../scripts/benchmark-explorer-packed-store.ts)。

## 观察共享对照

完整隔离的基线 archive，三次交替对照。真实形状样本来自仓库 fixture 的独立 headless 浏览器捕获，14 个控件、4 个区域，单帧 70,163 B；随后保留该形状、改变帧标识及时间生成 36 帧。它不是 36 次真实 OKX 操作。大合成样本另外覆盖控件变化、插入与重排、全量 churn、高熵文本、小观察和非观察实体。

| 36 帧场景 | 关闭后数据库 | 写入耗时 | 热读取耗时 | 重开后读取 |
| --- | ---: | ---: | ---: | ---: |
| 捕获的 fixture 形状 | 339,968 → 143,360 B | 35.34 → 34.99 ms | 25.13 → 21.55 ms | 22.15 → 22.10 ms |
| 大合成观察，仅一个控件变化 | 634,880 → 352,256 B | 124.39 → 177.23 ms | 81.52 → 90.87 ms | 84.91 → 102.52 ms |
| 所有控件持续变化 | 782,336 → 905,216 B | 126.58 → 171.77 ms | 84.57 → 86.08 ms | 84.61 → 87.62 ms |
| 高熵文本 | 5,206,016 → 5,226,496 B | 149.75 → 167.02 ms | 42.88 → 43.84 ms | 42.50 → 43.51 ms |

共享有分析和引用管理成本；有限退避降低了全量变化时的成本，但没有消除写入回归。3,600 个非 Observation 实体仍走轻量读写路径，写入 128.51 → 130.81 ms，读取接近持平。小数据库增加的表和索引也占空间。已有 gzip 历史不会在启动时自动转换为共享对象。

证据：[全部输入摘要、源码摘要与逐次数据](evidence/observation-sharing.json)、[基准](../../../tests/storage-observation-sharing.benchmark.ts)、[捕获脚本](../../../tests/storage-observation-sharing.capture.ts)。

另以独立 fixture 浏览器进行 10 次真正连续的 SDK 采集，包括三次实际输入变化。14 个控件的 localId、instanceId、identityId 在各帧均稳定；稳定帧的 22 个引用中复用 21 个，对象字节复用率为 98.94%。每帧新增对象来自变化的 evidence artifact 路径。输入变化会改变两个控件及 canonical，当帧选择整值 gzip，下一稳定帧重新使用共享。最终 7 帧共享、3 帧 gzip，37 个对象、8 个包；manifest 与 pack payload 合计 55,384 B，原 Observation JSON 合计 701,852 B；完整 SDK 库含 251 个实体，关闭后 634,880 B。10/10 观察重开后精确一致。这是完整性与真实结构复用验证，没有基线计时，不能作为速度或整个数据库的压缩比例。见 [连续采集记录](evidence/live-fixture/verification.json)。

## 文件证据与保留层

同一 64 份捕获、保留 8 份的输入，三个交替独立进程对照：

| 操作 | 基线 → 实现 |
| --- | ---: |
| 写入 64 份 | 109.81 → 126.67 ms |
| 读取并逐字节核验 64 份 | 78.91 → 98.49 ms |
| 删除 56 份 | 130.23 → 9.77 ms |

跨实例锁增加单次文件操作成本；批量回收减少约 92.5% 删除耗时。证据字节未变化，仅多一个协调文件，所有存活捕获重开后精确一致。测试还直接计数：删除 8／10 份捕获后，仅读取 2 份剩余清单一次。

保留层在 100 和 1,000 份历史观察后的热写均为 5 次 get、0 次 list。无增量通知的第三方后端保留保守扫描。缓存不包含 pin 权限，跨连接变化、回滚、直接 SQL 和容量上限均有测试。

发布／GC 同一回归用例在基线失败，明确出现 `CORRUPT_EVIDENCE` 缺块；新实现通过。跨进程持锁者被 SIGKILL 后，后续写入可继续且字节一致。损坏清单或缺失引用会阻止孤立块删除。此锁只协调文件操作；业务元数据依然要求单个引擎写者，不能宣称多进程 pin 与异步删除原子化。

证据：[批量回收基准](evidence/evidence-store/summary.json)、[基线缺块反例](evidence/evidence-publication-baseline-red.log)、[57 项保留与文件证据专项](evidence/evidence-retention-targeted.log)。

## 验证与交付状态

- 产品、基准、测试和验收脚本已提交到 `70b8cb4`。
- 任务存储 50 项、观察与相关接口 77 项专项通过；根线程保留／文件证据联测 57 项通过。它们有重叠，不能相加当成独立测试总数。
- 完整测试首次运行 171 个文件、1,727 项测试通过；唯一失败是新验收脚本裸导入根包未声明的 `better-sqlite3`，使 `okx-storage-acceptance.test.ts` 无法加载。保留失败原始日志，修复后的脚本专项结果另列，不能把首次完整运行写成全绿。运行期间 430 个源码文件保持不变；启动时 HEAD 尚为 `5696125`，逐文件摘要已确认实际测试源码与提交 `70b8cb4` 完全一致。见 [完整结果](evidence/full-suite/suite-result.json)及[提交对应](evidence/full-suite/source-commit-verification.json)。
- `2ff9e4b` 只修改验收脚本及其测试：改从声明依赖的 workspace 包解析 SQLite；操作候选 key 包含目标，首次／重启采用相同分类；后续变 unknown 会撤销成功统计，结算按最终 attempt 真值重建；实时 executing 与未知分开；计划结算按 occurrence 比较。日志失败不阻断清理，provider 取消有界等待并披露仍在途请求。19/19 离线专项、根项目与 core 类型检查、真实脚本 `--help` 均通过。见 [专项结果](evidence/harness-final/summary.json)。
- 原来的 80 次协议对照全部执行，源码前后摘要一致：四类正向目标到达 20/20，局部退出偏离与 unknown 均拒绝虚报成功；A/B 输入对应 40/40，价格 100 次跳动的计划及待测增长均为 0。冷重启嵌套分支 5/5，必要重入 15 次、重复叶子执行及无理由重入为 0；unknown 跨重启保留 5/5，重启后没有新会话、动作、恢复或模型请求。续跑协议 JEV 45 次、LLM 0 次。排除计时与版本字段后，行为汇总与上一版 `7ec9665` 完全一致。该对照与完整测试并行，耗时不用于速度结论。见 [80 次汇总](evidence/protocols/summary.json)及[逐字段对照](evidence/protocol-comparison.json)。
- 独立 archive 的完整构建、公开类型检查、编译后 API 和 Explorer UI 烟测通过；截图已查看。见 [编译验证](evidence/compiled/summary.json)。
- main 已快进到 `6630dfa`，确认包含 autonomous-exploration `4857ad5`，见 [合并核对](evidence/main-merge.json)。首轮真实实验已执行，下面单独列出异常；离线 helper 测试和 fixture 烟测不能替代真实页面结果。

后续真实验收必须分别核对恢复返回状态、实际目标操作、历史等价覆盖、新执行、必要重入候选及无进展重试；监测 JEV/LLM、待测范围、数据库/WAL/证据总字节。未知执行、证据损坏、provider 错误或循环触发时暂停并保留原原因，修复后重新验证。任何队列清空、预算耗尽或 `completed` 状态都不能独立证明真实页面穷尽。

验收窗口的 provider／新 session 调用数在入口限制；动作及时间是停止阈值，已开始的整次恢复仍等待结算，超量单列。现有取消契约不能靠临时抛错变成无污染的动作边界中断。操作 key 仍是调度提示，同名共享标识仍可能冲突；没有可靠 key 的成功操作单独披露并暂停无进展启发式，不用它们证明穷尽。

## 真实 OKX 首轮：异常保留，尚未完成

使用与 main 相同的 `6630dfa`，独立目录 `.data/okx-storage-acceptance-20261017-v1`、新 headless 会话和任务库。事件记录到 24 次 JEV 与 1 次 LLM 返回；3 次探索操作和 2 次恢复操作完成。尚未建立真实页面的旧版对照，不能用这些数值宣称提速。

首个恢复服务于弹层内尚未完成操作风险审阅的 `Go to OKX Wallet`，不是已点击的 `announced` 链接。Wallet 的风险及 probe 审阅在导航前已经尝试，缺少可绑定上下文，正确保持 unresolved；没有证据表明导航抢走了应当先做的审阅。具体 click 义务因 `source_target_unverified` 被拒后，无操作类型的风险审阅义务走严格 `reachCheckpoint`。后退及入口重开后，截图证实整个提示弹层未出现，约 17.6 s 后返回 `UNVERIFIED / replay_target_not_unique_or_missing`。回放首个 checkbox 的匹配数是 0；后退观察已经稳定，弹层仍缺失，不能靠放宽稳定性解决。当前没有已观察到却遗漏的确定返弹层路径，也没有依据立即放宽 SDK 到达语义。

只读核对中，5 个 SDK attempts 全部 succeeded（3 探索、2 恢复），没有 unknown/executing；没有 pendingDispatch、unverifiedRecoveries 或 unverifiedNavigations。19 项计划仍有 8 succeeded、10 unresolved、1 pending；Wallet 缺口未被改记成功。失败 route 已保留 `attempts=1 / outcome=unverified`、来源证据和失败原因，证明失败路线及待测范围未丢失，不能据此声称页面穷尽。

人工停止向本轮唯一持有 runner 锁的进程发送 SIGINT；记录出现 `stop.requested`，进程随后以 130 退出，没有 `stop.settled` 或最终 summary。Playwright 的默认 SIGINT 处理会关闭浏览器后主动退出 130，与本轮现象一致；无浏览器的 Node／tsx 子进程对照均能完成异步结算，因此不能归因于 tsx，改为直接 Node 也不能单独消除此风险。脚本新增恢复非成功返回时立即停止，以及带 owner/task/run 校验的 `--request-stop` 控制文件入口，等待在途工作与结算，避免主动发浏览器进程信号。

本轮不能算正常暂停。留下了 task paused、round running、activeSince 未清、累计时长 0 和一条 returned 未应用决策；现有 running-only 启动整理会漏掉这种半暂停状态，直接恢复可能计入停机时间或耗用新的轮次。正在通过通用生命周期修复解决，不能清字段、扩预算或改成功掩盖问题。原库已通过只读 SQLite backup（包含 WAL）及证据文件复制[冻结快照](evidence/real-okx-1/frozen-snapshot.json)，保留[中断记录](evidence/real-okx-1/interruption-summary.json)、完整增量日志和[前后截图](evidence/real-okx-1/screenshot-export.json)。

原库只读检查中，14/14 Observation 精确解码及 SHA 校验通过，1,325 个共享对象、80 个包无缺块、跨会话或孤立对象。稳定同 document 帧可复用 831–836 个对象；导航后的实例变化会触发 gzip 和有界退避。payload 中 state 约 7.94 MB（47.3%）、identity 3.50 MB（20.9%）、action 2.33 MB（13.9%）；Observation 行 1.064 MB，加共享包 0.287 MB。运行遗留的主库及 WAL 不能直接解释为逻辑泄漏；后续优化需依据这些真实占用重新排序。

## 中断结算修复

`a657220` 将启动整理扩展到 running 及有未结算痕迹的 paused/stopped 任务，原子更新原 round occurrence、作废尚未应用的请求/回答并保留审计事件。不改变 pendingDispatch、unknown、unverified navigation/recovery、route 失败债、计划 occurrence 或已消耗的动作/模型用量。正常暂停先保存意图再取消；保存失败也执行取消，但该失败调用不承诺已经 waitIdle。

中断时长只计至最后可信持久活动，未知尾段以 `durationUncertainty` 保留上下界；停机不计作活动，重复重启不重复加时。这里的累计任务时长是下界，不能宣称严格覆盖进程中断前的所有 wall time。当前实验窗口另行计时。为兼容旧压缩头，启动仍逐个解码压缩头以找隐藏 activeSince；不会展开 plan/history。两个部分索引首次创建会扫描历史，后续只取未结算轮次和决策。

84/84 相关测试及根项目/core 类型检查通过，包括暂停写入失败、旧压缩头、事务回滚、未知债、重复重启、停机时间超过预算后实际 start 复用原轮次。真实冻结副本补计 **103,661 ms**、仅将一条 returned 决策改为 stale；19 项计划与原 round occurrence 均保留，第二次重启完全幂等。原冻结文件哈希未变，没有启动浏览器或 provider。见 [专项与源码摘要](evidence/restart-settlement/verification.json)、[真实副本复验](evidence/restart-settlement/frozen-reopen.json)。这不能替代后续真实网页接续。

## 大型 state 压缩追加对照

`91af435` 使用 schema 4：大于等于 32 KiB 且净节省至少 12.5% 的 state 保存为单行 gzip level 3，绑定 SQL kind/id/session、全文 SHA-256 与字节数。小值及不适合压缩的内容保留原文，state 仍允许同 owner 更新。没有新增状态缓存、共享对象或 GC 根，也没有改变状态归并或覆盖语义。旧 plain/gzip/structural 内容可读；真实 `6630dfa` binary 确认拒绝新 schema。

启动只升级 schema，不重写旧 state。显式 `compressStates({sessionId?,cursor?,limit?})` 用游标和原子批次逐条读取/压缩/验证，避免一次保留一批大型原文。压缩释放的是 SQLite 内部空间，显式 compact 才归还文件空间。

同一份真实 OKX 快照，5 轮交替、20 个独立进程；旧版为完整 `6630dfa` archive。最终源码摘要前后相同，26 类实体及 14 个 Observation 的解码摘要全部一致。以下为中位数，不含 capture、浏览器恢复或模型网络：

| 实际 SQLite 工作 | 旧版 | 新版 |
| --- | ---: | ---: |
| 完整引擎库，双方整理后 | 21,159,936 B | 13,643,776 B |
| 全部 state 热 list | 19.414 ms | 20.103 ms |
| 重开首次 list（未清 OS 缓存） | 20.395 ms | 21.613 ms |
| 9 次同值 state 更新 | 32.921 ms | 55.639 ms |
| 新库插入 9 条 state | 47.324 ms | 59.574 ms |
| 仅这 9 条 state 的关闭后新库 | 8,019,968 B | 503,808 B |

完整库减少约 35.5%，热读取约慢 3.5%，9 次更新约慢 69%。单次额外写入开销约 2.52 ms，不能据此声称整个真实探索提速。9 行历史迁移耗时 120.735 ms，迁移期间 WAL 暂增至 502,672 B。完整 worker 峰值 RSS 911.9→941.6 MB，包括启动、迁移及全库校验；post-GC heap 24.989→25.019 MB，ArrayBuffers 一致。保留所有内存数据与限制，不把峰值差当成独立 codec 或缓存成本。

最终 91 项存储相关测试与类型检查通过；只在临时副本中测试迁移、compact 和旧 binary 拒绝，未使用原测试浏览器或任务库。见 [实现、冻结文件清单与验证](evidence/state-codec-feasibility/implementation.json)、[最终逐进程记录](evidence/state-codec-feasibility/sqlite-2026-10-16T20-35-55-336Z.json)。

追加提交 `91af435` 已重跑相同 80 次协议，源码前后不变；脚本、fixture 与测量参数相同。16 个场景逐 trial 行为与 `70b8cb4` 差异为 0：正向到达 20/20，嵌套冷重启 5/5、必要重入 15、重复叶子与无理由重入 0；unknown 跨重启 5/5，之后没有新 session、动作、恢复或模型调用；实际 A/B/C 输入 30 次、对应检查 40/40；100 tick 的计划/pending 增长仍为 0。新版 348/348 完整性检查通过。该结果证明原受控收益保持，不能证明真实 OKX 穷尽或提速。见 [完整汇总](evidence/restart-state-protocols/summary.json)、[跨版本比较](evidence/restart-state-protocols/comparison.json)与[测试源码到提交对应](evidence/followup-source-verification.json)。

## 真实 OKX 第二窗：接续与停止有效，新增覆盖尚未证明

追加修复已快进合入 main=`cdb8a67`，包含 autonomous=`4857ad5`；实验工作区使用相同源码，见 [合并记录](evidence/main-merge-followup.json)。恢复前只对本实验自己的 engine 库执行大型 state 迁移及整理，4,125 个实体的精确解码摘要全部不变，关闭后主库为 13,643,776 B；未打开或修改 plugin 任务库。原始第一窗冻结副本保持不变。见 [维护记录](evidence/real-okx-1/state-maintenance.json)。

第二窗 `e926ae98-5c1a-4d6b-8cea-9b232fd47877` 于 2026-10-16 20:44:31–20:45:51 UTC 运行。原 task、session、round 复用，轮数仍为 1，19 个历史计划及旧 route 重试债保留。第二窗新增 3 次探索操作（checkbox true、false、announced click）、1 次 entry recovery；JEV 6 次返回、LLM 0。累计 actions 5→9，记录的活动耗时 103,661→180,302 ms；第一窗中断尾段仍明确标记不确定，没有把停机时间算成已知活动时间。

恢复返回 UNVERIFIED，耗时 11,752.757 ms；最后检查为 observation-completeness=unknown。该负向结果于 20:45:48.582 自动触发停止，20:45:49.417 已结算；20:45:50.426 读取人工请求时任务已经 paused，不能把正常收尾归功于后到的人工请求。最终没有 unknown、在途动作或未结算 provider，activeSince/pauseRequestedAt 均清除，summary 与 finished 控制记录齐全。见 [原始汇总](evidence/real-okx-2/summary.json)、[完整事件](evidence/real-okx-2/metrics.jsonl)。这是真实页面上的生命周期验证，仍不是恢复成功。

本窗发现一个确定的验收计数缺陷：原报告的 newlyResolvedPlanOccurrences=9 中，6 个 occurrence 在窗前已经 succeeded，只是 resolvedBy 换成了本窗执行证据。现将其单列为 refreshedPlanEvidence；只有从未成功到成功、或新出现的成功 occurrence 才计新增解决。以冻结产物离线重算为 **3 个新增 occurrence、0 个历史未解决项转成功、6 个证据刷新**；新增 occurrence 本身也不是新语义覆盖证明。28 项专项与完整类型检查通过，原始报告不改写，修正另存于 [计数修正](evidence/real-okx-2/plan-progress-correction.json)。

三次探索与历史操作相同是重复候选，不能仅凭 label 或 operationKey 判为覆盖遗失。只读核对表明目标 identity 沿用，但来源中隐藏菜单选择器仍有待裁决对应，source conditions 未建立；SDK 拒绝等价有实际证据。必须继续检查审阅依赖与恢复路径，不能通过忽略非局部隐藏条件来制造覆盖复用。第二窗关闭后 engine 23,449,600 B、plugin 1,171,456 B、证据及日志合计约 5.75 MB，总计 30,368,331 B；详细增长归因见下段。

`e34ba3e` 补上诊断区分：条件无法建立返回 `operation_conditions_unavailable` / `target_conditions_unavailable`，已知样本不同仍为 `*_conditions_changed`。两者都保持拒绝等价，未扩大执行或恢复权限。34 项相关回归通过；对真实冻结库的三组对应查询复验，仅 reason 改变，全部事实与授权字段不变，见 [精确复验](evidence/real-okx-2/condition-diagnostics-recheck.json)。两个隐藏 selector 的 binding 本身也冲突，不能靠一次身份审阅就解决；完整因果链见 [覆盖诊断](evidence/real-okx-2/coverage-diagnosis.md)。

增长归因已在独立副本完成：新增 2,899 个实体，identity/action payload 增长约 4.02 MB、事件约 0.974 MB。原 9 个 state 和 14 个 Observation 全部未变；总计 17 个 state 均压缩为 gzip、payload 仅 808,305 B。2,506 个共享对象全部有引用，稳定帧复用 836/837 个对象（约 99.57% 字节）；25 个 Observation、50 个证据根和 1,130 个 blob 全部校验通过。副本整理仅回收 720,896 B，不能消除大部分新增历史占用。action 的 preconditions/basis 约有 1.74 MB 精确重复内容，可研究结构共享；它只是逻辑字节潜力，尚无实际读写性能证明。见 [逐项归因](evidence/real-okx-2/storage-growth.json)、[结论与边界](evidence/real-okx-2/storage-growth-assessment.json)，后续已记入 ROADMAP。

本窗已冻结 1,199 个文件、30,375,198 B，SQLite 完整性检查通过；与 summary 的字节差来自之后落盘的汇总及控制记录。冻结前确认 runner 已退出且 WAL/SHM 均不存在，再逐文件复制、前后校验 SHA；分析只读冻结副本或独立临时副本，见 [冻结清单](evidence/real-okx-2/frozen-snapshot.json)。真实页面持续探索与穷尽验收仍未完成。

## 审阅恢复调度修复

`a0e07f4` 修复第二窗中审阅义务沿用旧浏览器来源的问题。旧、新目标必须通过 SDK 分类条件投影匹配，且没有同名歧义、截断、未知上下文、身份待决或后台边界问题，插件才保留当前来源。当前浏览器仍持有的 GET 历史条目优先用于路线选择；它只改变候选顺序，派发和到达仍由 SDK 验证，旧路线失败债不清除。

对于 interface-only 模式下明确经过 purpose/probe 审阅、仍无法得到可用操作的目标，插件持久记录“同一份缺证材料等待新事实”。这只抑制为该审阅项反复恢复页面，保留 unresolved、原 attempts 和覆盖状态。材料、规则、声明上下文、任务含义或浏览器变化、来源丢失、出现可执行操作时重新开放；机械暂停/启动 revision 变化本身不算新事实。未知执行、待提交动作和未验证恢复不能被该等待解除。observed-ui 的程序 probe 不在本次扩展范围内。

新增回归包括公共 plugin.start 的本地完整链：弱 generic 审阅仍缺证后离页，旧审阅继续待测，而目的页的新操作实际执行。真实 SDK 历史返回但目标已经消失的反例仍不报告 REACHED。4 文件 34 项专项、另外 9 文件 118 项相关回归和类型检查通过；冻结 OKX 材料在独享副本重验，generic 等待、6 个同名 checkbox 条目均不受影响，原路线债及冻结文件 SHA 不变，浏览器启动与 provider 调用均为 0。见 [源码与验证记录](evidence/review-recovery-fix/verification.json)、[冻结材料复验](evidence/review-recovery-fix/frozen-check.json)。这些证据尚不能证明真实网页恢复成功率上升。

修复版本 `a0e07f4` 再次运行相同 80 次协议，源码前后不变、脚本/fixture/参数一致，348 项完整性检查通过。16 场景逐 trial 行为与原 `70b8cb4` 基线差异为 0，包含 20/20 正向到达、5/5 嵌套冷重启（必要重入 15、重复叶子和无理由重入 0）、5/5 unknown 跨重启阻断、30 次实际 A/B/C 输入和 40/40 对应检查，以及 100 tick 待测清单增长为 0。见 [对照](evidence/review-recovery-protocols/comparison.json)和[完整汇总](evidence/review-recovery-protocols/summary.json)。运行期间另有相关测试，因此耗时仅作原始记录，不用于性能比较；本轮未重新运行完整 suite。
