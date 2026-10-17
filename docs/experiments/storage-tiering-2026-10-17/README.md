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

## 真实 OKX 第三窗：页面位置与旧画面恢复的契约分离

main 与实验源码均为 `3885c581`。同一任务、session、round 于 2026-10-16 21:16:47–21:18:24 UTC 接续，22 项历史 occurrence 全部保留，最终 25 项；原有两条失败路线债逐字段不变。3 次探索仍为 checkbox true/false 和 announced click，不能证明新增语义覆盖；新增成功 occurrence 为 3，历史未解决转成功为 0，旧成功证据刷新为 9。JEV 6 次返回、LLM 0，无剩余 provider、unknown 或 executing。详见 [接续诊断](evidence/real-okx-3/continuation-diagnosis.md)。

上一轮的审阅修复在真实运行中生效：四个 generic review-only 项有持久等待，三个有明确的 unchanged_unresolved_review 延后事件；checkbox 没有被错误加入等待。新的恢复选中原始纯 URL 根范围，不再选旧 generic 项。它却被发送到严格 checkpoint API：一次原生 history 已回到同浏览器的原 GET 条目，观察稳定、无关键缺口，但旧弹层和 checkbox 已消失。严格恢复继续重开入口并尝试旧 checkbox，候选数为 0，最终 21,088.805 ms 后 UNVERIFIED。该失败自动触发停止，完成结算与关闭。不能把原生动作成功解释为 checkpoint 恢复成功，也不能忽略多余重开造成的开销。见 [完整因果链](evidence/real-okx-3/recovery-diagnosis.md)。

新增窄 SDK 接口 `returnToObservedSource` 复用既有原生 history 返回与动作账本，最多执行一次返回，不重放、不重置、不启动替代浏览器。它验证浏览器实例、唯一原生条目、GET、URL、声明上下文、规则、稳定性与证据完整性；SOURCE_REACHED 只证明页面位置，明确保留 checkpointVerified/sourceStateRestored/currentExecution/executionAuthorized 四个 false。observed-ui 未评估效果 ID 继续保留。旧 checkpoint 与具体目标到达接口保持严格语义。

插件仅为已授权、无前置路径的纯 URL 待测项使用此接口；区域、控件、操作与审阅义务不适用。路线与严格恢复的失败债分开记录，旧债不清除；任何未释放 unknown 债仍全局阻断。动态价格、DOM/捕获 ID 不产生新位置返回预算；无原生锚点、当前不稳定或有活动弹层时延后。到达后清空未经验证的旧路径，从当前事实重新检查可执行操作；到达本身不结算覆盖。

公共 plugin.start 本地回归证明：离开弹层后，返回到弹层已消失的同一原生条目，随后真实执行新出现的 Remaining 控件；仅一个 history 恢复动作，没有 entry 重开或旧弹层重放。若返回后持久结果变为 unknown，插件撤销成功、保留债，重开任务后在 observe/createSession/恢复之前阻断。SDK/native/target/core 专项 42/42，最终插件及 SDK 联合回归 7 文件 101/101，root/core 类型检查通过；两组有重叠，不相加。包含严格接口伪返回 SOURCE_REACHED 的拒绝测试和 100 tick 不续预算测试。见 [验证记录](evidence/source-return-fix/verification.json)。这些仍是受控证据，需再次接续真实页面。

第三窗已关闭冻结 1,865 个文件、45,928,970 B，全部 SHA 与源前后相同，两库完整性检查通过。冻结副本只读，分析使用独享副本；原测试浏览器和任务数据库未操作。关闭时 engine 35,340,288 B、plugin 1,589,248 B，共享证据/日志占用另列在原始 summary。真实穷尽仍未完成，任务库与全量读取的正负性能结论继续沿用前述基准，不能由本次恢复修复推导新的速度或压缩率。

`ba7f38e` 已重跑相同 80 次协议：16 个场景逐 trial 行为与 `70b8cb4` 差异为 0，348 项完整性检查通过，源码前后不变、脚本与 fixture 摘要及测量契约相同。正向到达 20/20、嵌套冷重启 5/5（必要重入 15，重复叶子及无理由重入 0）、unknown 跨重启 5/5（之后 session/action/recovery/JEV/LLM 均 0）、A/B 对应 40/40、100 tick 计划与待测增长 0。原协议使用具体目标到达 API；新增来源位置接口的收益由前述新专项验证，不能用旧协议无回归冒充新 API 的真实成功率。见 [完整汇总](evidence/source-return-protocols/summary.json)及[逐场景对照](evidence/source-return-protocols/comparison.json)。

## 第四窗：来源返回后确实续测，旧失败落点仍触发冗余恢复

源码与 main 均为 `868e8b47afd31782161deba4f8bd7a14e0349430`，autonomous `4857ad5` 已是 main 祖先。独立任务 `6c56a979…` 的第四窗运行 `5f350d86…` 从 2026-10-16 21:39:01 至 21:42:56 UTC；原 round/session 和 25 个旧 plan occurrence 保留。原始材料见 [summary](evidence/real-okx-4/summary.json)、[metrics](evidence/real-okx-4/metrics.jsonl)和[冻结清单](evidence/real-okx-4/frozen-snapshot.json)。

- 纯 URL 来源返回使用一次原生 history，11,985.45 ms 得到 `SOURCE_REACHED`，11 个核验通过；未入口重放。`checkpointVerified/sourceStateRestored/currentExecution/executionAuthorized` 仍全为 false。随后实际执行 scroll、Trade、1h、24h，证明该样本可以继续交互；不是只有一个成功状态码。
- 第二次选择历史 Wallet 审阅项，严格 checkpoint 恢复仍为 `UNVERIFIED`，18,521.40 ms；入口 navigate 成功不等于 Wallet 弹层恢复。验收工具自动暂停、等待动作/provider 结算、关闭自有浏览器，进程正常 exit 2、signal=null，无 unknown/executing 遗留。
- 本窗 7 次 exploration 成功、2 次 recovery 动作，JEV 27/27（provider 累计 17,181.32 ms），LLM 0。7 次 exploration 均缺稳定的 operation-condition key，不能直接当作 7 个新覆盖分支；成功 occurrence 新增 9 与旧成功证据刷新 12 分开报告。
- 最终 plan 539 项：335 unresolved、181 pending、23 succeeded；原 25 项未丢失。增长 514 项不等于新发现 514 个独立操作，语义角色与重复问题另行检查。队列未空，穷尽未完成。
- 关闭后总占用 73,501,625 B，其中 engine 52,715,520 B、plugin 4,624,384 B、证据 blob 9,123,658 B，WAL/SHM 均为 0。随后冻结 2,709 文件、73,508,012 B，源前后与副本全 SHA 一致，四个 SQLite 完整性检查通过。首次中断留下的累计时长不确定性仍保留，未改称精确总耗时。

这次只能证明一个真实来源返回样本成功并继续了当前页面操作，不能由单次 11.99 s 推导一般恢复成功率或相对严格恢复的速度提升；两种接口契约不同。

### 失败落点预算修复与验收

[真实诊断](evidence/real-okx-4/recovery-diagnosis.md)确认 Wallet 旧失败后的条件 `613636…` 与本轮返回、滚动和周期切换后的条件完全相同，价格和新观察 ID 没有生成新条件。缺口是 ledger 只消费原入场条件 `a1a0…`，未记录失败落点，调度把已失败落点当作 `new_condition`。

本轮修复把有完整证据的失败落点记为负调度依据，独立于 attempts 和覆盖；每条路线至多保存 16 个落点，满后保留债务而非淘汰旧条件重开预算。SDK 验证的续行仍只给一次机会，新的相关条件/可验证路径仍可重新判断，unknown 继续优先阻断。仅有页面不稳定或缺失条件时不固化负证据；交互稳定的回放目标缺失需要独立 `INTERACTION_STABLE` 证据。

[真实冻结材料验收](evidence/real-okx-4/failure-condition-validation.md)实际调用 `scheduledRecovery`：旧 Wallet 重复恢复被阻断，原 attempts=1、scope、plan/status 均不变；重复迁移幂等。对纯不稳定失败的反例仍允许候选，无浏览器或网络调用。12 项新增测试及相关联合 74 项通过，修复后整树类型检查通过；完整协议复验另列，不能替代下一次真实接续。

### 按观察读取动作与身份压缩的取舍

SDK 当前动作查询新增可选按 observation 读取接口；SQLite 用带保守回退的索引，只解码当前或不能安全投影的行。第三方存储可回退原 list/filter；完整覆盖审计仍保留全部历史动作。不是缓存，也不改变身份、覆盖或许可。[离线同帧对照](evidence/action-observation-query/report.md)的 8 API × 2 次完整结果 16/16 一致，当前动作解码从 11,450 降至 207，单次读约 41–44→12 ms；checkpoint review 约 804–811→605–616 ms。整体义务投影仍约 2.2 s，不能宣称整轮等比例提速。索引首次诊断构建约 41.9 ms、新增 946,176 B。

[六进程交替写入对照](evidence/action-observation-query/write-comparison.json)显示代价：每 1,536 条实际 action 的批量插入中位 29.83→59.86 ms（2.01×，增加约 19.6 μs/条），原 JSON 重写 29.60→68.60 ms（2.32×，增加约 25.4 μs/条）。初始索引构建 42.81–44.15 ms，全部批次与最终解码摘要相等，六份副本完整性通过。上述是批量事务与热文件缓存测量，不是逐条提交、冷启动或真实采集总耗时；索引以额外空间和写入成本换取反复读取当前动作的收益。

身份行逐条 gzip 的[九进程对照](evidence/identity-codec-feasibility/README.md)给出负面结论：1 KiB 门槛整理后省 5,595,136 B，但热 list 慢 2.74 倍、get 慢 2.06 倍、旧行重写慢 3.22 倍，峰值 RSS 增约 68 MiB；32 KiB 门槛只省 77,824 B。因此不向身份热路径推广。全部解码/审计摘要相等及原始负样本保留，后续结构共享须解决引用根与热更新成本，不能只追求压缩率。

### 投影重复计算、未能证明的进展和撤回的去重原型

进一步优化 `projectObligations` 的同步读取：每个观察一次生成动作 scope，按请求字段组合索引候选，并在本次读取内复用每个 action 的条件计算。索引保留匹配顺序、重复候选、缺省/显式 undefined/null 的差异；最多保留 32 种查询字段组合，历史观察继续受原 8 文档上界约束。SDK 对应核验和全部许可检查不变，索引在这次调用结束后丢弃。

[完整旧/新对照](evidence/projection-action-index/comparison.json)使用三个真实冻结帧、539 项相同 plan，各交替三次，完整 projection/events 9/9 相等，事件/SQL 写次数和原输入摘要不变、浏览器启动 0。投影中位耗时分别为 1,920→1,001 ms、2,146→1,214 ms、2,086→1,131 ms（约减少 43%–48%）。这是有限热读取诊断，不是整轮或冷启动基准。新增差分测试遍历 256 种 scope 字段组合及重复、空 ID、输入类型和上下文变化；相关 33 项测试和类型检查通过。

[unkeyed 诊断](evidence/real-okx-4/unkeyed-progress-diagnosis.md)证实 7 次操作目标均可执行且身份匹配，但 6 个来源存在隐藏 selector 身份未决/绑定碰撞，另一次 selector 仅具实例身份，无法建立 portable branch conditions。SDK 拒绝有实际证据依据；裸调度键不能替代覆盖或恢复证明。旧工具的任一 unkeyed 成功会持续推迟无进展/重复路线判断；本窗仅约 230 s，未达 600 s，不能说第四窗已经发生阈值漏停。

验收工具增加原因和精确来源记录，以及独立有界的 `progress_evidence_unavailable_window`。从本窗最早仍未解释的成功起计 `stallMs`；历史 unkeyed 在重启后获得一个完整窗口，不计停机。后来的成功和重复事件不续期；期限到达只要求复核并正常结算，不把操作改记失败，也不声称无新覆盖或穷尽。成功被 SDK 重分类为 unknown/executing 后仍由原未知结果保护阻断。46 项离线专项及独立静态审阅通过，完整联合验证另列。

### 第四窗修复的冻结版本复验

最终产品源码为 `e7edfe24bd1cbab34e2568b6c42661f11377d194`。按观察读取、失败落点预算、同步投影索引和验收工具共同通过 [14 文件 / 184 项相关回归](evidence/run4-fixes-verification/verification.json)，根项目与 core 类型检查通过；该组有重叠专项，不能与前述测试数量相加。

冻结版本重新执行 [80 次原协议](evidence/run4-fixes-protocols/summary.json)，16 个场景的行为与 `70b8cb4` 基线逐项相等，当前 [348 项完整性核对](evidence/run4-fixes-protocols/validation.json)全通过。四类正向恢复仍为 20/20，嵌套冷重启 5/5（15 次必要重入，重复叶动作与无理由重入为 0），A/B 对应 40/40、实际输入 30 次；unknown 跨重启 5/5，之后没有新会话、动作、恢复或 JEV/LLM 请求。动态价格 100 次变化未增加待测项，非局部依赖分支仍全部执行。源码、fixture 与协议哈希保持一致。这些受控协议保留行为，不证明真实 OKX 穷尽或整轮提速。

完整套件在相同冻结源码上运行 181 个文件，1,898/1,903 项通过；460 份源码前后哈希相等。五项失败来自四个仍断言旧返回接口的测试，以及构造 schema 1 时未删除未来索引的夹具。原返回测试在较早 `a551168` 的隔离 archive 中同样失败。修订保留旧宿主全部断言，并增加新来源返回的正负测试；旧库夹具保留原内容一致性断言并检查索引重建。随后 7 文件 / 97 项联合回归与整树类型检查通过，产品源码没有变化；没有再次重跑全套，不能称此前完整运行全绿。完整原因及原始日志见[返回契约与旧库复验](evidence/return-scope-contract/README.md)。

最终测试提交 `b6c4420` 的[隔离编译验收](evidence/run4-fixes-compiled/summary.json)全部通过：build、发布类型、来源返回的窄结果类型、可选按观察读取及旧后端回退、编译后 API 和 Explorer UI 实际交互。471 个源码文件前后哈希相等，所有 workspace 模块指向自有 archive，603 个构建产物留有摘要；fixture 使用显式 mock provider，两个实际目标动作完成。[截图复核](evidence/run4-fixes-compiled/visual-review.json)单独记录在生成摘要之后，隔离目录已清理。`b6c4420` 已快进合入 main，包含 autonomous `4857ad5`，原工作区未变，见[合并核对](evidence/main-merge-run4-fixes.json)。真实第五窗另行接续，编译与 fixture 结果不代表真实穷尽。

[计划增长诊断](evidence/real-okx-4/plan-growth-diagnosis.md)确认 180 组未尝试操作有 observed_in_scope / operation_not_executed 双行，另 3 组被同一实际 attempt 一起完成；447 个新增行来自首次无遮挡完整页面。不能把全部增长都解释为动态价格或重复。曾实现仅同帧、唯一动作的窄去重原型，但真实两帧复算中首帧 3→2 行，下一帧缺少对应证明仍需独立缺口，最终净节省 0，因此已撤回产品补丁。原型、通过测试和反面结果均归档；旧双行及所有未测/attempt/unknown 证据未删除。后续应明确一个义务怎样保留多个尚未证明等价的来源，再设计审计状态，不能用相同 hash 强行合并。

## 第五窗：旧审阅路线抢先，页面候选仍有全量预读

main/source=`de88210` 的第五窗在同一 task/session/round 接续，实际探索 3 次，JEV 6、LLM 0，无 unknown/在途/provider 遗留；3 次仍因来源条件缺失而没有新语义覆盖证明。计划 539→543，原 pending 181、unresolved 335 均保留。严格恢复旧 USD 分类审阅检查点耗时 5,990.252 ms，路径含不可重放操作，UNREACHABLE 后自动停止，恢复动作 0。SDK 拒绝正确；问题是调度在旧审阅路线处提前返回，没有评估本轮同 URL 的有效 GET 历史入口。见[本窗事实与冻结清单](evidence/real-okx-5/README.md)。

`edd32f9` 仅在旧审阅缺少当前原生锚点时，优先评估同 URL 已接受页面返回，全部原门禁通过才采用；否则保留严格候选。具体操作和当前 native 审阅优先级不变。页面返回候选改为惰性核验，避免冗余全量排序读取。149 项相关测试通过；夹具类型字段补齐后最终新增 18 项及类型检查通过。完整冻结计划反事实选到本轮 `fe3…/3636…`，计划与旧 retry 债相同，4 条旧路线保留语义。页面单独调度的 observation/actions 读取 21/20→2/1；完整计划仍为 24/24→25/24，不能称整体调用下降。见[独立复核](evidence/real-okx-5/source-priority-validation.md)。

固定 `edd32f9` 重跑相同 [80 次协议](evidence/run5-fixes-protocols/summary.json)，16 个场景逐 trial 行为与 `70b8cb4` 相等，[348 项完整性核对](evidence/run5-fixes-protocols/validation.json)通过，源码、fixture、脚本及测量契约保持不变。正向到达 20/20、嵌套冷重启 5/5（必要重入 15、重复叶子/无理由重入 0）、A/B 对应 40/40及实际输入 30、unknown 跨重启 5/5（后续新 session/action/recovery/JEV/LLM 均 0）、100 tick 待测增长 0。隔离编译、发布类型和编译后 API/UI 实际交互也通过，472 份源码前后不变，截图单独复核。旧全套 1,898/1,903 的记录仍保留，本次未重跑全套，也尚未用新版本证明真实恢复成功。

存储总增 14,065,765 B，其中审计导出 4,117,047 B、新动作查询索引 1,150,976 B。10 次新观察的逻辑 33,682,744 B 以新增观察行/共享包 680,037 B 保存；旧共享材料没有变化。主要新增业务 payload 是候选 action 和 identity，插件较小的文件增长部分来自旧空闲页复用。没有独立的投影/保存计时，不能据两个不同页面窗口宣称整体提速。完整分项、负面时间指标和可复算脚本见[只读增长报告](evidence/real-okx-5/storage-growth.md)。真实穷尽仍未完成。

`823f981`（产品 `edd32f9` 及全部第五窗证据）已[快进合入 main](evidence/main-merge-run5-fixes.json)，autonomous `4857ad5` 仍为祖先。原工作区分支、HEAD 与未提交状态不变，没有安装依赖、构建 main 或操作原测试资源。第六窗将使用同一独立任务接续，不以本次 fixture 和冻结反事实代替真实恢复证明。


## 第六窗：来源返回成功，多来源义务与审阅重复的修复

第六窗在 main/source=`f6d7b9e` 接续，同一 task/session/round 保留。一次原生 history 返回在 15,539.687 ms 后通过 11 项验证，返回 `SOURCE_REACHED`，随后 Trade 实际执行成功；旧 USD 路线债和四个恢复/授权 false 字段保持。实际探索 4 次、恢复操作 1 次，JEV 26、LLM 0，没有 unknown、在途动作或 provider。所有实际操作仍缺 target conditions，不能计作 4 个新增可复用语义分支。计划 543→721，因新增 174 个 unresolved 触发实验操作者正常停止、结算、冻结；不是自动恢复失败。关闭采样累计占用 110,464,114 B，冻结 3,651 文件、110,489,030 B，前后/副本摘要一致、4 个 SQLite 完整性检查通过。详见[真实记录及停止原因](evidence/real-okx-6/README.md)。

诊断区分了 DOM owner 实例变化造成的调度 key 分裂、同范围机械阻挡理由变化，以及真正新 scope；174 项不能全部称重复。旧区域判断没有显式 reuse 策略，因此 SDK 可复用候选为 0，不能事后补授权。新增调度归一化仅去除已验证结构记录的文档实例部分，保留原 key 和审计；机械原因聚合要求相同完整前置路径。派生义务结案逐来源验证成功 receipt 或 SDK 操作对应，unknown、未知来源和新来源保留，不再以相同调度 key 结算覆盖。固定真实材料、依据已记录返回事件重建空入口路径的对照中，204 个 pending action 全保留，新增行 174→47。不同旧 announced 路径的反例为 174→175，独立保留。

新鲜 interface-only 区域判断可显式 opt-in 到 SDK 已有的条件复用；源/目标唯一性、完整结构/上下文、撤回链仍验证。仅原生 HTML disabled readiness 不使区域分组重复审阅，执行 enabled 校验保持，aria-disabled、data-owner、非原生 disabled 仍失效。历史覆盖另增加窄审阅澄清：核验实际成功动作所用原判断、三端完整条件/属性、同文档唯一实例、规则、时序、撤回状态，仅澄清旧 risk/basis；非局部条件比较继续执行，目标到达/重放不使用此投影。

同输入成本仍有负面结果：首轮紧凑迁移后任务 JSON 净增 200,975 B，不能据行数减少声称磁盘缩小。同步审计索引及动作 memo 将该审计的历史观察读取降至 3 次，但一次混合负载计时 106.6→388.7 ms，另有启动规范化 280.8 ms；这些不是可靠性能基准，也没有整轮提速证明。全部三轮原型及反例见[完整成本对照](evidence/real-okx-6/full-audit-counterfactual-indexed.md)。

修复提交 `125a10c` 的独立编译先发现 UI 间接导入 Node 原生 hash，Vite 打包失败；485 个输入前后不变、未运行后续烟测，失败完整保留在[编译诊断](evidence/run6-fixes-compiled/failure-diagnosis.json)。修复与最终验收后追加，不覆盖原始失败。真实穷尽仍未完成。

`125a10c` 已完成相同 [80 次恢复与接续协议](evidence/run6-fixes-protocols/README.md)：8 条命令成功、348/348 完整性检查通过，459 个源文件前后不变。对 `70b8cb4` 和 run5 均为 40 次详细行为相同、40 次不同，原“不完全相同”结果保留。差异为待测/计划行及审阅次数，嵌套冷重启每次 JEV 6→5（合计 30→25）；未知价格待测 5→6 更保守。实际动作/分支、误覆盖、必要重入、恢复成功/失败和 unknown 阻断的原 oracle 保持，A/B 40/40 对应、30 次实际输入，100 tick 无增长。续跑原始计划可解释双行聚合；条件协议没有完整计划，不能由计数独立证明所有来源安全。全套及 UI 修复之后的验收另列，协议不测真实站点性能或穷尽。

UI 依赖回归在 `d103747` 修复：将浏览器所需纯函数提取到独立模块，保留服务端原生 hash 和旧导出。13 个函数体逐字相同，42 项专项及完整 11 项 UI 历史交互、root/core 类型检查通过。原全套运行与提取的约 57 ms 编辑窗口重叠，不能改称固定最终源码全绿；冻结的 80 协议在编辑前已经结束，不受影响。新提交的[隔离构建验收](evidence/run6-ui-fixes-compiled/summary.json)五阶段全部通过（build、发布类型、公开契约、API、Explorer 实际 UI）；487 个输入哈希不变、623 个编译文件有摘要，所有工作区引用指向独立 archive。两次本地目标实际执行、mock JEV/LLM 各 1 次，界面仍明确整页穷尽未证明；代理及主线程均实际查看了截图，临时目录已清理。原失败和重验分别归档。

最终全量运行记录为 **191 文件、2,098/2,100 通过**，两项失败的实际 pageerror 均为修复前浏览器访问 `node:crypto.createHash`。原失败未改写；UI 修复后上述 42 项专项、11 项完整 UI history 及隔离编译已通过，root/core 类型检查均通过。全套期间四个路径发生纯函数提取与新测试变化，前 459 份源码逐 Git blob 对应 `125a10c`，后 461 份对应 `d103747`；不能称固定版本全套全绿，也没有再次整套重跑。完整边界及日志见[全量结果说明](evidence/run6-final-validation/README.md)。


安静串行对照发现首次成本回归，因此暂缓合并/真实第七窗。两个完整独立 archive、固定全部来源/前置、AB/BA交替各5进程的[首轮结果](evidence/real-okx-6/audit-serial/report.md)中，新版 audit 中位为旧版2.868倍，含首次 normalization 为5.312倍；任务JSON仍净增200,975 B。不是数据库或整轮性能测量。随后各3个进程承接原task/events，对同一静态快照连续审计，旧版第1/2/3次中位124.110/101.760/101.072 ms，新版363.279/50.404/45.861 ms，startup仅首次298.894 ms；后两次均新gap0、taskJSON不增。这个受限steady结果约快50%–55%，不能推广到页面变化后的下一帧。

独立CPU profile确认首次新增来源的主要热点：gap内反复创建SourceRecord，将同一当前页206个actions的scope映射重建114次（静态可核对23,484次投影）；这一调用链占该profile三次audit合计时间的约70.27%。`900edf7` 将缓存限定于一次同步audit/outcome的factory，不跨await/审阅/观察复用，逐item证据重验、顺序和事件保持。

最终[固定材料对照](evidence/real-okx-6/audit-factory/report.md)由d103747与900edf7完整独立归档各3个串行进程组成，共18次审计；只将新增计划UUID按追加次序映射，7组完整任务和累计事件比较全部一致，旧来源、前置、尝试、路线债与原候选均保留。首次audit中位366.680→62.658ms，减少82.9%；含初始化中位减少45.4%。初始化301.187→300.185ms，第2/3审49.633→50.593ms、46.223→46.790ms，没有进一步收益。两版首审均增加47行，后两次不增加，最终任务均1,174,260 B；原先净增200,975 B没有消失。只测内存材料上的同步计算，不是SQL、压缩、浏览器恢复或真实接续验收，也不能外推整体RSS下降。

[专项与归档](evidence/real-okx-6/normalization-factory-validation/README.md)包含69/69测试、根类型检查及先前fixture类型错误；新增outcome对照保留完整task/events和冻结原事实，独立静态审阅无阻断。跨来源SDK对应和撤销review后的下一次outcome没有新增集成试验；既有只读链经静态核对未变。缓存仅同步存活，但除了8个派生SourceRecord，还有原reader缓存和按session保存的完整attempt账本，不能称整个调用只持有8份材料或固定字节。该计算修复的阶段性交付不缩小完整目标；任务库压缩/全量读取、结构共享和历史分层仍需真实验收，当前继续最终协议与隔离编译，随后合并及真实第七窗。

最终产品 `900edf7` 的[原80次协议复验](evidence/run6-factory-protocols/README.md)完成：8条执行命令退出0，462份源码前后不变；与125a10c逐trial的行为投影80/80相同，原摘要器348/348完整性检查通过，假覆盖/假到达为0，unknown负例仍阻断。这里是协议行为投影一致，不声称原始浏览器记录逐字相同。[完整独立archive的构建验收](evidence/run6-factory-compiled/summary.json)五阶段全部通过，488输入哈希不变、623编译文件有摘要、28个workspace链接指向archive自身；两次实际本地fixture操作成功、显式mock JEV/LLM各1，代理和主线程实际查看截图，界面仍保留整页穷尽未证明。没有重跑2100项全套；上一轮原全套失败和版本重叠边界仍保留。两项验证并行，耗时不用作提速证据。

产品900edf7连同上述记录已通过d3e1973快进[合入main](evidence/main-merge-run6-fixes.json)，包含autonomous4857ad5；原工作区6e11128、分支和未提交状态全部不变，main未执行安装或构建。完整目标仍未完成，接下来以同一独立任务/会话接续第七窗，检查新观察与真实恢复成本，不重置旧覆盖、失败债或预算使用。

第七窗已终止并[全量冻结](evidence/real-okx-7/README.md)。后续 `855a3a4`/`875ce50` 的[组合读取对照](evidence/real-okx-7/source-material-isolation/README.md)在完整输出字节相同的三对进程中把候选筛选中位从35.896降至25.305秒（−29.51%）；初版复制成本的负样本也保留。`e06f057` [拒绝隐藏审阅来源](evidence/real-okx-7/recovery-diagnosis.md)，[冻结行为对照](evidence/real-okx-7/review-source-counterfactual/README.md)不再选择这类候选，但没有可验证替代路线，全部803计划与6个路线债保留。[80次原协议](evidence/run7-fixes-protocols/README.md)的行为投影和348项完整性检查保持，最终专项及证据边界见[验证记录](evidence/run7-fixes-validation/README.md)。

本轮[热写对照](evidence/task-store-hot-write/report.md)省去未变化记录解码与小冷包JSON传输；run7两种常见CAS减少约13.5%/15.8%，但历史夹具changed-round CAS慢12.67%，写事务体增加约0.52–0.75毫秒。没有新布局、压缩或完整读取收益。进一步任务库压缩/全量读取仍在后续计划，当前优先解决恢复路线与真实非局部绑定缺证；没有启动真实第八窗、合并main或宣称穷尽。
