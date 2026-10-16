Run 3 相对 frozen-2 的存储增长只读核对

结论：Observation 结构共享和 state 无损压缩仍有效。本轮增长主要转移到未编码的 identity、action 与审计事件。最值得先验证的是 identity 的完整行无损编码；暂不建议通过删除历史 identity、事件或 occurrence 来控制体积。

本报告比较 frozen-2（1,199 个文件）与 frozen-3（1,865 个文件），数据库均以 `mode=ro&immutable=1` 加 `query_only` 打开，未构造 SDK store/engine，未操作浏览器或 provider。所有 Observation、对象、pack、state 的压缩内容均校验原长度、SHA-256 和所属 ID/session。开始、分析后及报告生成前的全部文件哈希均与原冻结 manifest 相同，WAL/SHM 均不存在。原库没有被打开。完整数字、输入哈希、代码引用和私有分析脚本位置见 [storage-growth.json](/Users/xietian/.codex/worktrees/exploration-layered-refactor/browser-interaction-engine/docs/experiments/storage-tiering-2026-10-17/evidence/real-okx-3/storage-growth.json)。

**文件与载荷增长**（单位均为字节；数据库文件、SQL 载荷与解码后的逻辑内容分开计算）：

| 项目 | frozen-2 | frozen-3 | 增量 |
|---|---:|---:|---:|
| engine.sqlite 文件 | 23,449,600 | 35,340,288 | 11,890,688 |
| explorer.sqlite 文件 | 1,171,456 | 1,589,248 | 417,792 |
| 外置 evidence blobs | 4,037,992 | 6,265,470 | 2,227,478 |
| 外置 evidence metadata | 687,334 | 1,009,363 | 322,029 |
| 运行日志与导出结果 | 1,027,957 | 1,723,742 | 695,785 |
| 全部冻结文件 | 30,375,198 | 45,928,970 | 15,553,772 |

引擎 `entities` 的实际 JSON/BLOB 载荷增加 7,592,371；该表分配空间增加 9,506,816。`events` 表分配空间增加 1,425,408，共享 pack 表增加 327,680，其余增长来自对象表与索引。引擎 freelist 为 0；dbstat 单元格余隙由 3,217,416 增至 5,027,606。余隙不是已经可删除的数据，也不是可直接承诺的 VACUUM 收益。插件库增量主要来自事件和 decision，最终 task_items 只有 26 行；没有触发冷 chunk 打包，不属于本轮主成本。

| 引擎实体/事件载荷 | 数量变化 | 本轮载荷增长 |
|---|---:|---:|
| identity | 1,142 → 1,726 | 2,704,110 |
| action candidates | 4,789 → 7,083 | 2,069,271 |
| 审计事件 | 671 → 1,012 | 1,273,588 |
| frontier | 707 → 1,115 | 743,929 |
| exploration-group | 116 → 174 | 540,406 |
| Observation 行封套/压缩数据 | 25 → 37 | 745,929 |
| Observation shared pack 数据 | 151 → 222 packs | 258,453 |
| state 封套/压缩数据 | 17 → 25 | 399,353 |

identity 新增 584 行贡献 2,297,659，311 条旧行变化净增 406,451；没有删除旧行。2,294 条新增 action 全是按捕获保留的候选快照，旧 action 行无一变化，不能把候选数当成执行次数或语义覆盖增长。旧 671 条事件的 sequence、时间、类型与 JSON 全部不变。

**共享与压缩未失效。** 新增 12 条 Observation 的完整逻辑内容为 40,929,010，实际新增行载荷与 pack 数据合计 1,004,382（2.454%，不含 SQLite 行/对象/索引开销）。其中 8 条使用结构共享，4 条使用整值 gzip；新增结构引用 10,857 次，引用片段共 27,145,983。其中 1,231 次引用复用了 frozen-2 的 140 个已有对象，共 3,621,867 字节；只新增 1,181 个对象、4,132,424 字节唯一原文。37 条 Observation 全部重建校验通过；旧 25 条 Observation 与旧 2,506 个对象原文均未改变。最终 3,687 个对象全部有引用，孤儿对象与 pack 内未引用碎片均为 0。

最终结构共享所避免的重复片段原文为 68,501,551 字节，较 frozen-2 再增加 23,013,559；这是按引用次数计算的原文字节复用，不能当成文件压缩收益相加。作为独立体积试算，24 条结构共享 Observation 若逐条 gzip level 6，压缩数据约 3,848,654；当前这 24 条行封套/布局加所有 pack 数据合计 1,275,408。该反事实试算使用 Python zlib，与实际 Node codec 不保证压缩字节完全一致，只证明本批共享仍有明显体积收益。

state 当前是完整行 gzip，并非跨 state 的共享对象。25 行全部压缩；新增 8 行对应 7,414,578 字节逻辑内容，存储 399,353（5.386%）。12 条新增 Observation 使用这 8 个新 state，另有 4 次本轮内复用；没有新增 Observation 引用 frozen-2 的旧 state。旧 17 个 state 内容不变。不能把新 state 数直接归因于存储共享失败。编码定义见 [encodeStateJson](/Users/xietian/.codex/worktrees/exploration-layered-refactor/browser-interaction-engine/packages/storage-sqlite/src/entity-codec.ts:91)。

**精确重复内容与保留边界。** 下列数字比较原始 UTF-8 JSON 片段，不按标签、业务 ID 或近似语义归并；不同优化方案之间有重叠，不相加。

| 可复用的精确内容 | frozen-3 中重复字节 | 核对结果 |
|---|---:|---|
| identity.lastControl 与对应 Observation control | 4,335,134 | 1,726/1,726 全部逐字相同 |
| action.preconditions 内重复值 | 1,742,514 | 7,083 份值，只有 11 个不同字节串 |
| action.basis 内重复值 | 877,808 | 7,080 份值，336 个不同字节串 |
| frontier.action 与 action 行 | 831,835 | 1,115/1,115 精确匹配 |
| attempt.action 与 action 行 | 10,946 | 14/14 精确匹配 |
| action.completed 与 attempt 行 | 330,714 | 14/14 精确匹配 |
| observation.diff 与 attempt.diff | 313,235 | 14/14 精确匹配 |

identity 的 10,217 条 occurrence 全部能找到对应 Observation/localId，identityId 也一致，数组元素彼此没有逐字重复。它们是不同捕获的身份历史，不能按内容相近删减。`lastControl` 的复制来源可由 [identity 更新](/Users/xietian/.codex/worktrees/exploration-layered-refactor/browser-interaction-engine/packages/core/src/identity.ts:79)直接解释。当前 1,434 条 identity 标为 `not_observed`，仍保留最近控制材料和历史引用，不能当作垃圾。

虽然所有 `lastControl` 都可对应 Observation，只有 758 份（1,806,044 字节）恰好已是单个共享对象，其余 968 份不能直接用现有单一对象 ID 替换。更重要的是，当前 [共享对象 GC roots](/Users/xietian/.codex/worktrees/exploration-layered-refactor/browser-interaction-engine/packages/storage-sqlite/src/observation-store.ts:175)只扫描 Observation manifest。若未来 identity 直接引用对象，必须扩展根集合、session 删除与保留策略，校验 owner/hash，在事务中维护所有引用；不能认为“本次都有 Observation”便永久安全。读取时也不应为每条 identity 重建整份历史 Observation。

事件保留的是当时的判断。174 条 `exploration.group_detected` 中只有 16 条完整 JSON 仍等于当前 group 行；105 条事件的 members 已与当前 group 不同。不能把历史事件简单改成指向当前 mutable group 的引用。所有事件彼此完整 payload 仅有 84 字节重复，且对应不同事件 occurrence，仍须保留 sequence/type/time/session。事件体积优化应使用无损压缩或不可变快照共享；参见 [group detection 事件](/Users/xietian/.codex/worktrees/exploration-layered-refactor/browser-interaction-engine/packages/core/src/exploration-groups.ts:102)与 [完成及 diff 审计](/Users/xietian/.codex/worktrees/exploration-layered-refactor/browser-interaction-engine/packages/core/src/engine.ts:583)。

**下一项建议：先验证 identity 的自包含无损 codec。** [当前编码分派](/Users/xietian/.codex/worktrees/exploration-layered-refactor/browser-interaction-engine/packages/storage-sqlite/src/index.ts:88)只压缩 Observation/state，其余实体仍是原 JSON。对本次 1,726 条 identity 的完整 JSON 做 gzip level 3，8,317,156 字节变为 2,537,011；再加包含 format/version/codec、原长度、SHA-256、id/sessionId 的示例封套 441,985，总量 2,978,996，载荷试算节省 **5,338,160 字节（64.18%）**。全部逐条解压回原始字节一致。frozen-2 的同样试算节省 3,627,854，本轮增量可少约 1,710,306 字节。该 codec 不新增跨对象引用，完整保留 unknown/hypothesis、occurrence 顺序、上下文、原判断与审计材料，风险面小于直接引用历史 Observation。

这只是下一项最值得验证的方向，**不是已实现的性能收益**：[每次 capture 读取 identity 全量](/Users/xietian/.codex/worktrees/exploration-layered-refactor/browser-interaction-engine/packages/core/src/engine.ts:444)，随后仍会 [写回 identity ledger](/Users/xietian/.codex/worktrees/exploration-layered-refactor/browser-interaction-engine/packages/core/src/engine.ts:502)。必须用相同冻结数据比较首次/稳态 identity 全读、正常 capture 热写、未变化旧行重写成本、WAL 放大及内存；不能用文件变小掩盖解压/重复编码回归。可考虑按已验证内容跳过未变化行编码，但这次没有修改该语义。

action 是第二优先项：64 KiB 有界原文 pack 的纯体积试算为 6,316,082 → 696,832（97 packs），明显优于逐行 gzip 的 4,096,617；但这些数字未计行偏移、校验、ownership 索引和事务成本。需要保持每个 action ID/Observation/state/preconditions/basis/value/risk，不合并不同捕获或不同条件的操作。相较 identity 自包含 codec，其打包、变更、引用和单项读取契约需要更多实现与验证。

本次只新增报告；未执行迁移、压缩写回、清理、VACUUM 或浏览器/provider 工作。没有读写耗时基准，也不承诺实际 DB 回收值。冻结输入及报告 SHA-256 已单独记录，原始 raw 文件未改。
