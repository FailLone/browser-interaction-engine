# Run5 存储与现有耗时证据

冻结输入从 **73,508,012 B 增至 87,573,777 B，净增 14,065,765 B（19.13%）**。这不是三次实际操作直接写了 14 MB：本轮有 10 次观察、1,880 条新候选 action、246 个新 identity、311 个旧 identity 更新；另有一次性动作查询索引 1,150,976 B，以及本轮审计导出 4,117,047 B。观察共享和 state 压缩继续有效。

绑定 run `d8d00f33-79ae-4ebd-a8ec-9fc31b5c6fda`、源码 `de88210e0b50d6c851569c2de1bcb254f3ff430b`。所有大小都是字节；表中分项按所属层级解释，不能将 JSON/blob 子项再加到 SQLite 文件大小。

## 物理文件账目

| 类别 | frozen-4 | frozen-5 | 净增 B | 占总增量 |
|---|---:|---:|---:|---:|
| 引擎 SQLite | 52,715,520 | 61,214,720 | 8,499,200 | 60.42% |
| 插件 SQLite | 4,624,384 | 4,665,344 | 40,960 | 0.29% |
| 证据 blobs | 9,123,658 | 10,262,276 | 1,138,618 | 8.09% |
| 证据 manifests | 1,646,879 | 1,916,819 | 269,940 | 1.92% |
| 本轮审计导出 | 5,396,712 | 9,513,759 | 4,117,047 | 29.27% |
| 其他控制文件 | 859 | 859 | 0 | 0.00% |
| 合计 | 73,508,012 | 87,573,777 | 14,065,765 | 100% |

2709 → 3055 个文件；没有删除文件或 WAL/SHM。旧文件只有两个 SQLite 和等长的 active-run.json 改变，历史 runs 导出全部逐字节保留。本轮导出在仓库 evidence/real-okx-5 中还有 **4,117,047 B 的逐字节副本**，不在上述冻结目录总量中；整个 frozen-4/frozen-5 作为人为归档的目录级副本也不应合计成生产库增长。

## 引擎：候选动作、身份与索引主导增量

| entity kind | 行数变化 | JSON + compressed_json 净增 B |
|---|---:|---:|
| action | 11,450 → 13,330 | 1,758,013 |
| identity | 2,324 → 2,570 | 1,514,196 |
| observation | 59 → 69 | 421,397 |
| state | 37 → 43 | 296,642 |
| exploration-group | 253 → 279 | 245,355 |
| intervention-snapshot | 65 → 76 | 150,952 |
| frontier | 1,536 → 1,609 | 138,099 |
| attempt | 23 → 26 | 44,282 |

所有 1,880 条 action 都是本轮 10 个新观察的候选事实：转换页每次 210 条，共 8 次；文章页每次 100 条，共 2 次。它们与 3 个实际探索 attempt 是不同计数。旧 action 行未修改、未删除。新增 action 中 preconditions 字段 545,060 B、basis 244,596 B，其余是 ID、作用对象、状态引用及操作属性；这些事实保留对应观察和审计语义，不能按显示同名或仅执行过 3 次就删除。

identity JSON 增加 1,514,196 B，其中 246 新行 1,176,338 B，311 个旧行变更净增 337,858 B。字段净增主要是 occurrences 763,349 B、lastControl 576,057 B。occurrences 从 16,449 增至 19,177（+2728），正好对应 8×301 + 2×160 个捕获 control；所有旧 occurrence 前缀完整保留，没有删除 identity。

新 `entities_action_observation` 索引占 **281 页 / 1,150,976 B**，涵盖累计 13,330 条 action，属于对既有历史建立索引的成本。只读 EXPLAIN 确认为 `SEARCH ... entities_action_observation (session_id=? AND <expr>=?)`；NULL fallback 为 0。当前观察读取 210 或 100 条候选即可，不需把累计 13,330 条都解码。这里只确认访问计划与行数，不测延迟、也不把索引容量换算成性能收益。[索引与读取实现](/Users/xietian/.codex/worktrees/exploration-layered-refactor/browser-interaction-engine/packages/storage-sqlite/src/index.ts:57)

引擎还有 229 条新审计 event，JSON **706,923 B**。SQLite dbstat 对 +8,499,200 B 的精确分解为：记录及索引 payload +7,276,172 B、已分配页内部 unused +1,111,545 B、B-tree/页结构开销 +111,483 B；freelist 始终 0。这里的 unused 是页内空间，不是已测得可回收量；未执行 VACUUM。

## 观察与 state：压缩/共享未失效

10 个新 Observation 原始 JSON 共 **33,682,744 B**，新增观察行（envelope + compressed_json）仅 **421,397 B**，另加新共享 pack 数据 **258,640 B**，合计 **680,037 B（原始的 2.02%）**。该值不含 SQL 行/索引开销及独立截图/DOM 证据文件。

8 个为 structural-v2，2 个为自包含 gzip-v1；两种都是受支持的无损格式。gzip 两次恰好是本轮恢复后的转换页首帧及转到文章页首帧；后续同页帧使用共享编码。此模式与 [新内容退避/重新探测策略](/Users/xietian/.codex/worktrees/exploration-layered-refactor/browser-interaction-engine/packages/storage-sqlite/src/observation-store.ts:121) 相符，但没有记录当时分支计数，不能从格式倒推出完整的编码器决策过程。

共享表新增 1181 个对象、71 个 gzip pack。新观察共有 10,857 次对象引用，引用逻辑字节 27,147,012 B；其中 1231 次引用复用 frozen-4 的 140 个对象，共 3,621,867 B。剩余重复也在本轮不同观察间共享。全库 **0 孤儿对象、0 pack 内无引用逻辑范围**；旧 Observation 行、object 行、pack 字节均未变化。

state 新增 6 行，原始 5,472,476 B → envelope + gzip **296,642 B（5.42%）**，旧 state 行全部不变。10 次观察使用这 6 个新 state，4 次在本轮复用 state；本轮没有命中 frozen-4 的旧 state ID。这不影响观察结构共享的有效性。[state/observation codec](/Users/xietian/.codex/worktrees/exploration-layered-refactor/browser-interaction-engine/packages/storage-sqlite/src/entity-codec.ts:90)

## 插件：页复用掩盖了审计增长，当前遍历栈明显缩小

插件文件只增加 40,960 B，但 dbstat payload 实际增加 **321,636 B**。freelist 从 86 页减至 7 页，复用 **79 页 / 323,584 B**；已分配页 unused +38,931 B、B-tree 开销 +3977 B。算式为 321,636 + 38,931 + 3977 − 323,584 = 40,960。

- plan：539 → 543 行，JSON 605,162 → 619,480 B（+14,318）。
- round：仍为同一个 occurrence，JSON 352,024 → 34,585 B（−317,439）。主要是 stack 319,697 → 4068 B、7 → 3 帧；reviewed/tried 当前缓存也缩小。新 driver instance 的 [resume 分支](/Users/xietian/.codex/worktrees/exploration-layered-refactor/browser-interaction-engine/packages/explorer-plugin/src/runtime.ts:497) 重建当前遍历栈，历史 entryRoutes 仍为 27,326 B；这不是压缩收益或历史事实删除。旧 task-after 与本次 task-before 对象完全相同，旧审计导出仍保留原栈。
- task header：逻辑 167,428 → 158,061 B，zstd 19,867 → 17,550 B；两个压缩 hash/原始长度/owner/projection 校验均通过。
- decisions：64 → 70 行，JSON +103,001 B；events：2283 → 2597 行，JSON +495,128 B。旧 engine/plugin events 均逐字节不变。
- task_chunks 仍为 0；plan/round 都是热行，没有冷块收益可归功。全部 plain item content_hash 校验通过。

## 审计导出占 4.12 MB，属于独立的可复核副本

| 本轮导出 | 字节 |
|---|---:|
| task-before.json | 1,482,522 |
| task-after.json | 1,053,987 |
| coverage-review.json | 819,169 |
| metrics.jsonl | 696,859 |
| summary.json | 23,299 |
| plan-occurrences-after.json | 20,637 |
| plan-occurrences-before.json | 20,485 |
| cursors.json | 89 |

两份完整 task 快照和 coverage-review 合计 3,355,678 B；其中 task-before **与上轮 task-after 完全相同**，是显式重新导出的历史快照，不能当作新增业务事实。保留完整快照有审计价值，但其空间增长应与核心数据库分开报告。

metrics.jsonl 的 696,859 B 中，plugin.event 528,189 B、engine.event 73,894 B。核对源码 DB：290 个插件 event 完整复制了 480,741 B 的源 JSON，24 个 decision event 是有意精简；229 个 engine event 都仅是标识/状态元数据投影，不是完整 payload 重复。不得声称 metrics 又复制了全部 706,923 B 引擎事件内容。[导出投影](/Users/xietian/.codex/worktrees/exploration-layered-refactor/browser-interaction-engine/scripts/okx-storage-acceptance.ts:499)

这些副本和历史 SQL 记录有不同审计用途；本次没有做删除、改引用、归档重打包或回收试验。

## 现有时间证据：能量化粗阶段，不能拆出纯投影/保存成本

本轮窗口 **97,758ms**，3 个实际动作分别 4272/4256/4477ms（合计 13,005ms）。JEV 6 次返回合计约 **5487ms**，LLM 0；strict reachCheckpoint **5990.252ms**、attemptIds=[]、UNREACHABLE。恢复没有动作，但仍产生一次 recovery 观察。10 次观察构成为 3 action、5 inspection、2 recovery（含重连首帧）。这些区间存在包含/重叠，不能简单相加后把剩余都叫作存储成本。

源码时间位置：browser.capturedAt 在 DOM 稳定性/详细收集循环之后、history/screenshot/ARIA/证据保存之前；visit.at 在 driver 返回、身份匹配与初次 stateGrouping 之后；observation.created 在 discovery、最终 projection、观察/状态/身份/action/frontier 持久化事务尾部发出。因此下列区间只是混合阶段区间，不等于独立的 capture、projection 或 SQLite save 计时。[capture 位置](/Users/xietian/.codex/worktrees/exploration-layered-refactor/browser-interaction-engine/packages/adapter-playwright/src/browser.ts:624) · [核心处理顺序](/Users/xietian/.codex/worktrees/exploration-layered-refactor/browser-interaction-engine/packages/core/src/engine.ts:434)

| Observation 前缀 | cause | controls/actions | capturedAt→visit ms | visit→event ms | capturedAt→event ms |
|---|---|---:|---:|---:|---:|
| `c740ce30` | recovery | 301 / 210 | 481 | 915 | 1396 |
| `6c7cf95b` | inspection | 301 / 210 | 395 | 864 | 1259 |
| `61a3d07b` | action | 301 / 210 | 421 | 932 | 1353 |
| `12544344` | action | 301 / 210 | 402 | 944 | 1346 |
| `175cca62` | inspection | 301 / 210 | 415 | 619 | 1034 |
| `f75c31ce` | inspection | 301 / 210 | 412 | 699 | 1111 |
| `652ebf48` | inspection | 301 / 210 | 427 | 707 | 1134 |
| `fe3ed5c7` | inspection | 301 / 210 | 404 | 706 | 1110 |
| `d4d54ab3` | action | 160 / 100 | 351 | 677 | 1028 |
| `c9d2e5d3` | recovery | 160 / 100 | 319 | 576 | 895 |

run5 三组区间中位数分别 **408 / 706.5 / 1122.5ms**，总和 **4027 / 7639 / 11,666ms**。截图完成时间距 capturedAt 为 29–45ms，中位数 32.5ms。run4 的 22 次观察同口径中位数为 369.5 / 535.5 / 907ms；run5 没有在这些混合指标上展示更短的中位数，但动作/页面/稳定性样本不同，不能据此判定查询优化回归。相同三个开头动作 run4 为 3909/3732/4130ms，run5 为 4272/4256/4477ms，也只是两次真实环境样本。**本轮没有纯观测、投影、保存计时器，不能提供这些环节的可信独立耗时或优化因果结论。**

## 边界与后续优先级

目前最大新增业务 payload 是 action 和 identity；新索引占用是性能读取结构的成本，审计导出占用则是实验交付成本。先保持这三种账目分开，比以“每次实际操作总增长”判断存储退化更准确。观察共享无需回退。若继续存储优化，应针对不可变 action 内容的重复字段/审计副本组织单独验证，而不能删掉候选历史、未知债或身份 occurrence；先前 identity gzip 热读写成本的负面实验也不能因本轮体积继续增长而忽略。

只读方法：两个冻结目录均使用 SQLite URI `mode=ro&immutable=1`、query_only；未构造 SDK Store/Engine。新 Observation 解码校验完整 raw/layout/pack/object hash、大小与 owner，新 state 校验 gzip/owner，task header 用 Node zstd 解码核验。两份冻结清单 2709/3055 个文件在分析前后与 manifest 全量 SHA 一致，没有 WAL/SHM；未访问原活动库、服务、浏览器/provider/network，也未运行 benchmark。独享脚本和暂存数据保留于 `/tmp/okx-run5-growth-TmJbL9`，数据库不复制进报告。

冻结 engine SHA：run4 `3ce36c03015dff7482c7dcedf1fcee850e991f1b0b44a11e9cd6d09a3c693357`；run5 `f1b9a71350d65b0d7a3cc1e08c7123ee183ff76d9e2ec9b5627d04f12b503958`。插件、raw 证据、源码及诊断脚本 SHA、全部分表/逐行变化和逐观察时间点见同名 JSON。结论只限这次冻结增量。

## 分析脚本归档与复核

五个原始脚本已按字节归档在 [storage-growth-tools](storage-growth-tools/)，只含源码，不含数据库、解码结果或临时大素材。`storage-growth.json.analysisScripts` 的 `path` 保留当时执行位置；以相同 basename 对应归档文件，五个 SHA-256 均与该 JSON 中原记录一致。此次归档没有重跑分析。

依赖仅为 Python 3 标准库（SQLite 需支持 JSON1、dbstat）、Node.js 24 的 `node:zlib.zstdDecompressSync`、Git。无需 pnpm、SDK 实例或浏览器。原执行使用 Node v24.22.0，路径 `/Users/xietian/.local/share/fnm/node-versions/v24.22.0/installation/bin/node`。

必需输入是仓库内的两个完整冻结目录 `.data/okx-storage-acceptance-20261017-v1-frozen-4`、`-frozen-5`，对应 `evidence/real-okx-4`、`real-okx-5` 的原始 manifest/summary/metrics/task 文件，以及 Git 提交 `de88210e0b50d6c851569c2de1bcb254f3ff430b` 的源码。脚本不会连接原活动目录。

原脚本记录了绝对仓库路径 `/Users/xietian/.codex/worktrees/exploration-layered-refactor/browser-interaction-engine`，并以 `/tmp/okx-run5-growth-TmJbL9` 为工作目录；其中 `headers.mjs` 直接引用该临时目录。复核时先把归档源码复制到独享临时目录，再执行下列顺序。若路径不同，只在**临时副本**中机械替换这两个路径前缀；归档文件保持不变。不要直接在仓库的 tools 目录运行，以免把派生素材写进归档。迁移后的副本哈希与原始脚本不同，应另外记录；现有 JSON 的脚本哈希证明的是未修改归档。

| 顺序 | 脚本 | 输入与重建输出 |
|---:|---|---|
| 1 | [analyze.py](storage-growth-tools/analyze.py) | 验证两份冻结 manifest；immutable SQL 读取表/行与共享 codec，并读已有 metrics。生成 `analysis.json`、`plugin-header-4.json`、`plugin-header-5.json`。最后两份是由冻结 task 行重建的检查素材，不是外部依赖。 |
| 2 | [supplement.py](storage-growth-tools/supplement.py) | 读取上一步 `analysis.json` 和两份冻结库、raw 日志，生成 `supplement.json`、`headers.json`。`headers.json` 完全由冻结 task 压缩 header 重建。 |
| 3 | [headers.mjs](storage-growth-tools/headers.mjs) | 仅读取 `headers.json`；Node 原生 zstd 验证并解码，生成 `headers-decoded.json`。 |
| 4 | [index-and-integrity.py](storage-growth-tools/index-and-integrity.py) | immutable SQL 检查索引计划，读取 Git 源码并再次验证冻结文件 hash，生成 `index-and-integrity.json`。 |
| 5 | [report.py](storage-growth-tools/report.py) | 读取上述四份结果 JSON、原始证据及五个脚本，生成 `storage-growth.json/md`。此脚本会写报告文件；复核现有冻结报告时，应先将原始 real-okx-5 证据文件复制到独立输出目录，再把临时副本中的 `out` 指向该目录（报告脚本也从 `out` 收集 raw hashes），然后运行。 |

在已准备好的临时副本目录中，原执行顺序为：

```sh
python3 analyze.py
python3 supplement.py
/Users/xietian/.local/share/fnm/node-versions/v24.22.0/installation/bin/node headers.mjs
python3 index-and-integrity.py
python3 report.py
```

因此 `/tmp` 中所有 JSON 素材都可以从保留的 frozen/raw/Git 输入重新生成，不依赖曾经打开的浏览器、活动数据库或未归档采样。报告生成时间、当前源码 hash、临时路径以及 `repoRawFilesBytes`（当时 evidence 目录文件总量）会随复核环境变化；应对比冻结文件、行/字节计数和时间戳推导字段，不要求新报告逐字节等于原报告。`report.py` 只重建原事实报告，不包含本次后补的脚本归档说明。
