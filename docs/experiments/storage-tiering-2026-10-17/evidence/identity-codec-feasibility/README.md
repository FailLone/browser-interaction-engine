Identity 自包含压缩可行性与成本实验

结论：**不建议把逐行 gzip 直接接入当前 identity 热路径。** 1 KiB 门槛虽然减少整理后数据库 5,595,136 字节，但热 list 慢约 2.74 倍、未变化历史行重写慢约 3.22 倍。沿用 state 的 32 KiB 门槛仅压缩 2 行，空间收益不足以支撑推广。此前 storage-growth 报告中的体积机会成立，性能可行性没有通过本次验证。

使用 frozen-3 的完整独享副本，1,865 个文件与冻结 manifest 全部一致；只对副本 engine.sqlite 的 identity 行应用实验 codec。原 live 数据库、原任务库、浏览器与 provider 均未操作；完整源副本中的任务库也未打开。每个 variant 有 3 个独立 Node 24.22.0 进程，按 plain→32k→1k、1k→32k→plain、32k→plain→1k 交替执行。9 个进程均退出 0，测试脚本字节保持不变。原始全量副本与所有试验数据库保留在 `/tmp/identity-codec-feasibility-DJOXN0`，仓库只存脚本、日志、结果和哈希，不提交数据库。

**体积**：编码保留完整 JSON，使用 gzip level 3；压缩封套含 format/version/codec、UTF-8 原字节数、完整 SHA-256、id 和 sessionId。只有封套加 blob 至少节省 12.5% 才编码。解码校验 SQL kind/id/session_id、封套、byte count、完整哈希及内容 owner，不引用 Observation。明文基线也先做相同 VACUUM，排除原库已有余隙造成的虚假收益。

| frozen-3 原始 1,726 行 | plain | gzip3，32 KiB | gzip3，1 KiB |
|---|---:|---:|---:|
| 被压缩行数 | 0 | 2 | 1,726 |
| identity JSON+blob 字节 | 8,317,156 | 8,237,851 | 2,951,157 |
| 初始整理后 engine.sqlite | 34,156,544 | 34,078,720 | 28,561,408 |
| 比整理后 plain 节省 | — | 77,824（0.23%） | 5,595,136（16.38%） |

原冻结 DB 为 35,340,288 字节，plain 自身整理就释放 1,183,744；这部分没有算给 codec。写入实验后所有组均有 2,602 行（原 1,726 行保留，新增 876 个合成 identity），整理后分别为 38,572,032、38,375,424、30,515,200 字节。这组最终体积属于合成写入工作负载，不冒充真实 run4 存储收益。

**读写时间**：表中为三个独立进程的中位值；每个进程的热 get 为 5 批 × 3,452 次，热 list 为 5 批 × 3 次；写入各 3 批。完整分布、每轮配对比值及原始样本在 [summary.json](/Users/xietian/.codex/worktrees/exploration-layered-refactor/browser-interaction-engine/docs/experiments/storage-tiering-2026-10-17/evidence/identity-codec-feasibility/summary.json) 和逐 trial JSON 中。

| 操作 | plain | gzip3，32 KiB | gzip3，1 KiB | 1 KiB/plain |
|---|---:|---:|---:|---:|
| 新进程首次 list，ms | 26.20 | 26.82 | 55.40 | 2.11× |
| 热 get，μs/行 | 19.26 | 20.93 | 39.66 | 2.06× |
| 热 list 全部 1,726 行，ms | 17.73 | 19.69 | 48.64 | 2.74× |
| 追加 occurrence，μs/行 | 38.17 | 62.03 | 102.11 | 2.68× |
| 未变化历史行重写，μs/行 | 21.76 | 31.99 | 70.01 | 3.22× |
| 新 identity 插入，μs/行 | 53.35 | 72.34 | 82.28 | 1.54× |
| 测量段峰值 RSS，MiB | 315.84 | 326.05 | 383.94 | 1.22× |
| 最后 checkpoint+VACUUM+checkpoint，ms | 139.82 | 147.55 | 119.09 | 0.85× |

旧行更新使用当前 292 个 `present` identity，向每行追加一份已有 occurrence 的完整引用，保持所有原前缀；另测 1,434 个历史 identity 的原值重写，反映当前 capture 仍写回完整 identity ledger 的成本。插入使用 292 个真实 payload 模板生成固定新 UUID、单 occurrence 的合成记录。它们只验证实际 payload 形状和 codec 成本，不声明发生了新的身份识别或合法执行。两个旧行批次在本实验中分别提交，因此不能把时间相加称为真实 capture 耗时。

32 KiB 的旧行更新和历史重写也变慢。原型沿用 state 式实现，先 serialize/parse 校验 owner，再检查门槛；额外解析是其中一个成本来源。未来可减少不必要的解析或缓存，但本报告没有把未实现的优化当收益。1 KiB 的读回归还包含必要的解压、完整哈希与 owner 校验，不能靠省去校验让对照“通过”。

**无损与审计保留**：准备阶段三个版本的 1,726 行解码摘要完全相同；9 次最终 2,602 行解码摘要也相同：`7f1fb73946c0f9f54461778ae56c4db89313fec396c4bf4d4655848fa7d7e007`。逐行比较原 JSON 对象的序列化结果，所有原 occurrence 数组前缀都保留。所有非 identity 实体、事件、请求、Observation objects/packs、metadata/sequence 表内容摘要保持 `f24bae61875e31c4f0788f3545d77cab8d0540d3589e1dbf5869f7b40179fd61`。两种 codec 各通过 9 项损坏拒绝检查，包括错误 SQL id/session/kind、错误 SHA、过小/过大原长度、截断 blob、缺失 blob以及“哈希有效但解码 owner 错误”。没有通过删历史、删 unknown 或删审计记录换空间。

每次 VACUUM 前后都核验 TRUNCATE checkpoint 无 busy，整理后 WAL 为 0。写入结束、整理前 WAL 文件大小分别为 4,845,152、4,742,152、4,218,912 字节；这只是文件尺寸快照，不等于总写入量或 WAL 放大系数。SHM 仍打开时的大小也保留在逐 trial 结果中，不能算永久数据。

**适用范围**：root 在 lifecycle 计时结束后明确释放 CPU 窗口；本轮 19 秒内只顺序执行 9 个试验进程，root 保留编码与轻量读取。仍是共享 Mac，未锁 CPU、未清 OS 文件缓存，桌面与浏览器后台进程可能存在，只有每组 3 个独立进程。因此这些数据支持否决当前方案的可行性判断，不能当最终产品性能验收。首次 list 是新进程首次读取，不是冷盘读取。测试直接使用实际 JSON、SQLite 与生产形状的查询/owner/upsert SQL，没有调用 SDK 构造函数；共同的 SDK hook/变更通知不计入时间。显式 GC 在批次间且不计时。RSS 是工作负载及验证结束后、最终 DB 文件 SHA 读取前的原生进程高水位，包含 fixture/map；读阶段 RSS 另列。

后续若继续 identity 优化，应先用增量 identity 视图、避免未变化历史行重写或有界已验证缓存减少重复工作，再衡量冷数据编码。当前数据不支持直接落地逐行 gzip，也不支持放弃校验或引用保留。完整脚本、版本、原始日志与 source proof 已归档；未修改任何现有产品/测试源码。
