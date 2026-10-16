# 有界备用恢复、共享证据与增量任务存储

本轮目标是提高恢复成功率、减少存储占用和重复计算。在既有 core/SDK 与独立探索插件分工内改造，不替换浏览器框架，不把快照当成可还原的浏览器运行状态。

结果支持继续分层重构：备用路线让4个原本不能到达的受控场景都能到达并继续输入；内容定义分块在动态插入样本中减少72.4%的证据文件占用；候选筛选和空闲轮询明显减少计算。置信度限于受控契约与局部基准。完整任务读取变慢、初始任务库增大，真实OKX端到端收益尚未证实。

## 版本和隔离

- 工作区：`/Users/xietian/.codex/worktrees/exploration-layered-refactor/browser-interaction-engine`。
- 分支：`codex/exploration-layered-refactor`；开始版本 `075b3fc03c7b446795bf4f792c2495608d52bcdc`，开始时无未提交差异。
- 原项目工作区保持 `codex/single-selection-state-rule` / `6e111284ac3a6642844531dbc06bce462ca4293c`。
- 基线由 `git archive 075b3fc` 建立独立副本，workspace 包明确链接到归档源码；仅第三方依赖共享。基线324份源码前后哈希一致。
- 所有浏览器、网页端口、SQLite和证据文件均为本轮新建的临时测试资源。未操作正在测试的浏览器、任务数据库或现有服务。
- 最终被测代码提交：`95bc6db7cd2219a256cd03f29d5d58a45982b9f4`。恢复`27a7c2e`、证据分块`7b7155c`、任务/候选索引`fa70cad`，最后的`95bc6db`仅修复两份旧测试夹具的候选ID。
- 399份源码/脚本/测试/fixture文件与该提交逐一SHA-256对应。80次后测和全量回归之后，产品源码无变化；仅上述两个测试文件修正数据准备。原始清单、差异及提交映射见`evidence/product-freeze-before.json`、`product-freeze-after.json`和`final-validation.json`。
- 完成时只读核对：原项目仍为`6e111284`、base工作区仍为`4857ad57`，两者均无未提交差异；本分支生成的两个旧截图文件已还原，新的冒烟证据单独保存。

## 实现与证据边界

### 恢复路线

保留严格观察状态图和逐次到达验证。图搜索使用入队标记、队列游标和前驱表，避免反复复制完整路径与 `shift()`。一次恢复共用查询内图，真实执行后仍从浏览器当前观察重新选路、读取来源证明并重新检查执行约束。已知失败可以尝试另一条已记录路线；候选计划数受固定上限约束，session操作预算继续有效。

失败记录保留路线、原尝试、原因、实际观察及本次执行记录。路线提示不能授予重放许可；unknown不能因另一条路线或新会话可用而改成成功。不能找到备用路线时不借机无限重开起点。该改动不提供任意网页快照还原，也不证明实时网页的所有有效路线均能发现。

上限4是路线计划数，不是最多4个物理动作；长路线仍受原会话动作/时间预算约束。既有严格`reachCheckpoint`接口还有一个边界：若入场时画面已匹配，它可以返回`REACHED_VERIFIED`，而旧unknown仍保留；这个返回只表示可观察检查点一致，不表示旧执行结果已核实。插件和目标到达入口另外检查unknown，新备用回放结束也先检查unknown再验证到达。本轮没有将严格接口扩展为统一的执行结果确认接口。

### 证据分块

`FileEvidenceStore`原来已经有SHA-256内容寻址、16KiB独立块、文本gzip及v3清单。本轮使足够大且可压缩的文本按内容决定边界，插入少量文本后能重新对齐后续块。二进制、小文本、低压缩率文本沿用固定分块。

打包缓存最多2048份块描述；完整布局缓存最多16份、每份最多128个块描述。缓存没有观察内容、执行许可或身份判断；复用前检查文件存在，读取仍核对每块及完整证据的长度、SHA-256。清单存在但块缺失/损坏时抛出`CORRUPT_EVIDENCE`。整个逻辑清单不存在仍遵守原`undefined`契约，不能声称本层能区分从未存在和清单丢失。

新数据继续使用v3清单，旧读者能够按已有任意范围清单重建，不创建patch依赖链。Observation整体gzip和`decodeStoredEntity`未改；本次存储收益主要来自文件证据，不能声称所有观察已经实现结构共享。证据保留、pin和GC的权限边界未放宽。

### 任务记录与轮询

插件schema v2把任务头与有序plan/round记录分开，按变化记录写入。保留原公开Task API；相同ID的不同出现位置仍分别保存，不以控件相似或同名进行存储合并。兼容迁移在一个事务内完成，unknown、来源证据和次序保留；失败全部回滚。

头部、记录及同步版本同事务发布。同步版本在写入时产生，空闲轮询只读取版本，不再读取整个任务然后重新哈希。任务读取核对条目摘要和完整数量；缺行或内容损坏拒绝读取。重启时任务暂停、decision失效及事件也合并事务，避免部分失败后永远漏记失效事件。

原API允许原地修改任意嵌套字段，因此`save(task)`仍需序列化并检查全部条目。这是减少实际写入与轮询成本，不是所有计算都变为O(变化数)。完整任务读取和小任务保存的额外行处理/校验成本实测可更高；未以对象引用缓存冒险跳过变化。只访问任务的程序使用公开API；直接读取tasks.json的外部脚本需适配schema v2。没有在现有任务数据库运行迁移。

schema v2是向前迁移：旧二进制会拒绝读取新库，没有自动降级转换。上线前应保存旧库的一致性备份；回退旧代码须同时还原对应备份。迁移成功后的新任务进展不能靠回退二进制自动带回旧库。

### 覆盖候选索引

`completedOperations`在每次同步读取内建立kind/label证明索引、控件与区域索引，先缩小历史证明候选，再提交原SDK对应请求。原生记录链接允许派生标签变化的已有规则走单独候选桶；用户接受的字面范围仍严格匹配。保留所有成功A/B来源，原unknown不能提供覆盖。没有跨await缓存身份、操作等价或执行许可。

不同标签较多时避免当前操作×全部历史证明的全量比较；同名控件密集或原生链接放宽标签时，候选仍可能很多，不宣称所有网页达到线性复杂度。

## 存储与性能实测

均使用相同输入、Node24，保留原始JSON与输入摘要。是局部微基准，不是OKX端到端性能。部分开发回归同时进行，耗时可有竞争噪声；不报告可靠P95。重开store未清空操作系统页缓存，不能称为物理冷盘读取。

### 文件证据：每场景3次重复

| 工作负载 | 关闭后的总文件字节，旧→新 | 写入耗时中位数，旧→新 |
| --- | ---: | ---: |
| 动态价格与列表插入 | 891,607 → 246,133（−72.4%） | 291.1 → 171.1 ms |
| 相同JSON | 239,641 → 199,071（−16.9%） | 173.6 → 91.6 ms |
| 所有价格变化 | 1,100,075 → 1,009,297（−8.3%） | 321.9 → 280.8 ms |
| 高熵文本 | 相同 | 340.2 → 321.6 ms |
| 二进制 | 相同 | 184.6 → 180.1 ms |

动态插入场景DB均为69,632B；清单104,964→70,140B，blobs717,011→106,361B。活跃WAL/SHM也计入时总计1,097,831→452,357B。另记录文件系统分配块，避免只统计JSON长度。720次完整重建校验通过。最初实现曾出现相同JSON和高熵文本写入CPU退步，原始pilot保留；最终增加有界布局缓存和低压缩率回退。

数据：`evidence/evidence-chunking.json`、`evidence/evidence-chunking-summary.json`、`evidence/evidence-chunking-initial-pilot.json`。

### 任务：40次单项修改、500次空闲轮询、30次完整读取，各3轮

使用SQLite通常的1000页自动checkpoint；初始数据checkpoint后测量，关闭最终连接使WAL合并，未做VACUUM。保留含WAL/SHM和关闭后两种口径。

| 待测记录数 | 单次空闲轮询，旧→新 | 完整读取，旧→新 | 单次保存，旧→新 |
| --- | ---: | ---: | ---: |
| 100 | 0.0575 → 0.0235 ms | 0.174 → 0.330 ms | 0.211 → 0.318 ms |
| 1000 | 0.440 → 0.0236 ms | 1.777 → 2.819 ms | 1.614 → 2.292 ms |
| 5000 | 2.264 → 0.0243 ms | 8.898 → 14.241 ms | 12.808 → 11.654 ms |

1000记录下，40次修改后活跃文件总大小5,810,464→1,120,160B；关闭后的DB1,163,264→757,760B。但初始DB602,112→757,760B，行与索引增加了静态开销。5000记录保存的单次中位数略好，40次总耗时和CPU仍较高，不能只挑中位数宣称保存全面加速。pilot曾关闭自动checkpoint放大写入日志观察，该数据单独保留，不与默认策略混算。

该选择适合不断小步更新、持续轮询的任务；频繁读取全部历史而很少更新/轮询的负载可能退步。完整结果见`evidence/algorithm-storage-summary.json`与`evidence/task-store/`。

### 历史覆盖筛选：每组5次、重复3轮

| 当前操作/历史证明数 | 筛选耗时中位数，旧→新 |
| --- | ---: |
| 100/100 | 1.815 → 0.371 ms |
| 1000/1000 | 114.602 → 3.159 ms |
| 3000/3000 | 1009.050 → 9.004 ms |

输入、提交请求与完成集合摘要两版一致。host采用明确的确定性替身，仅测候选筛选算法；真实SDK对应正确性由原浏览器回归和A/B协议另外核验。纯图BFS微基准也单独记录，不把几毫秒路径搜索收益当成真实浏览器恢复总耗时收益。

## 验收与未解决范围

原四协议双方各完成80次：条件25、接续15、输入10、恢复30。两版恢复均使用同一`refactor`参数和目标到达接口，不能把目录名baseline误解为调用另一种恢复契约。四份协议脚本和所有fixture的SHA-256一致；后测333份源码前后哈希一致。原始后测JSON中的`revision=075b3fc`是工作区的base commit，不是优化版本的最终提交；准确实现由源码清单和最终提交映射确定。

| 原有能力 | 基线 → 本轮 |
| --- | --- |
| 既有恢复正例：实际到达且后续SDK输入成功 | 20/20 → 20/20 |
| 不可达/未知结果安全拒绝；虚假到达 | 10/10 → 10/10；0 → 0 |
| 非局部A/B都执行 | 5/5 → 5/5 |
| 控件对应正确；真实输入次数 | 40/40 → 40/40；30 → 30 |
| 100次报价更新增加计划/待测/重试额度 | 0 → 0 |
| unknown冷重启后保留并阻断 | 5/5 → 5/5；新会话/执行/恢复/模型调用均0 |
| 必要重入；无理由重入；重复叶执行 | 15 → 15；0 → 0；0 → 0 |
| 待测遗失；错误结清 | 0 → 0；0 → 0 |
| 接续协议总JEV/LLM调用 | 45/0 → 45/0 |
| 共享标识重建时缺失shared:A | 5/5 → 5/5，仍未解决 |

这些协议的语义指标没有回归，不等于所有场景成功。unknown阻断后的Branch B应当继续待测，不计作已覆盖。该协议没有测量重启后的observe次数。后测与全量回归并行，恢复耗时不能拿来宣称性能提升。完整对照见`evidence/after/comparison.json`和两版`summary.json`。

新增路线反例另外统计：旧入口失效但备用入口有效、严格checkpoint与目标到达、嵌套中间状态继续、重复旧证明、所有路线失效、unknown、预算与不可重放。恢复正例必须在真实浏览器执行后续SDK输入；拒绝例不计恢复成功。

同文件11项对照为3/11→11/11，其中6个正向到达案例0/6→6/6。旧版部分预算/上限用例失败是因为它在第一条路线失败后直接停止，不是旧版超出预算。安全例单列，不混入成功率分母。新增首步筛选会跳过当前已拒绝的旧证明，避免它们白白消耗四个计划；原图存在路径但首步均不可用时保持失败，不偷偷重开起点。严格恢复也核对当前操作的可重放声明，不能只相信历史声明。

另外同一独立runner测试简单/嵌套×target/strict四种组合，两版分别0/4→4/4实际到达且可继续SDK输入。新版填写42后，DOM值为42，页面独立input事件为[42]；恢复阶段输入目标的attempt数仍为0，填充是后续独立验收。嵌套菜单Open只执行一次。旧版在390–605ms后失败，新版在606–714ms后成功，这不是“恢复更快”的证据：新版多付出一次有效备用入口动作，换取成功到达。这些值有并发负载，只报告原值范围。

纯BFS使用相同邻接图、相同选中路线，7次中位数：4000边链8.71→0.64ms；38480边汇合图4.01→0.46ms。不包括建图、读取观察、SQLite或真实浏览器动作。详细结果和边界见[恢复子报告](recovery-routes.md)、`evidence/recovery-routes/`。

以下任一情况会推翻本轮接受结论：A/B误共享覆盖；原unknown在重启或改走路线后被洗成成功；失败后未测范围遗失；同条件无理由重复执行；重构后的证据无法精确重建；事务错误发布半份任务；性能收益依赖移除必要核验。

当前还没有真实OKX同预算多轮后测，没有长期证据生命周期/GC收敛证明，没有完整观察子树存储，没有可靠性加权全局路径优化。既有shared-id重建缺A在基线5/5复现，本次不以存储或候选索引优化宣称解决身份歧义。必要的页面重入仍可能存在。业务正确性与真实网页穷尽均不是上述微基准能证明的结论。

## 最终工程验证

| 检查 | 结果与口径 |
| --- | --- |
| 全量首轮 | 159文件、1567项：1549通过，18失败，0跳过；不能称为全绿 |
| 基线复现 | 原`075b3fc`中两个相关文件57项：39通过，完全相同的18项失败 |
| 失败原因及修复 | 测试夹具把已持久化action ID改到另一会话，触发`ID_CONFLICT`；为新候选分配新ID，保持全部原断言和产品归属保护不变 |
| 最终受影响复测 | 两文件57/57通过；只改测试夹具，没有再跑第二次完整套件，不把重叠39项重复计数 |
| 类型与构建 | `pnpm typecheck`、`pnpm build`退出码均0 |
| 编译产物 | 公开类型、API、Chromium执行、历史证据、静态UI与插件UI冒烟通过；插件确实执行Alpha/Beta两次 |

日志与结构化结果保留在`evidence/full-tests.*`、`baseline-fixture-failures*`、`final-fixture-regression.*`、`final-typecheck.log`、`final-build.log`、`final-built-smoke.*`、`final-explorer-smoke.*`。冒烟使用明确的替身provider（JEV一次、LLM一次），与接续协议45/0分开统计，不是在线模型调用。冒烟在新建临时目录运行，报告和截图复制后该目录已删除；没有覆盖原`docs/build-smoke.json`。

## 一手参考与采用边界

- [Playwright v1.58.0快照采集源码](https://github.com/microsoft/playwright/blob/v1.58.0/packages/playwright-core/src/server/trace/recorder/snapshotterInjected.ts)：未变化子树引用和缓存失效。本轮借鉴共享原则，未移植其DOM采集器，也未声称trace能恢复JS运行状态。
- [restic存储设计](https://restic.readthedocs.io/en/stable/100_references.html#backups-and-deduplication)：内容分块、不可变引用和发布次序。本轮自实现有界Gear式分块，没有复制restic的Rabin实现或照搬备份块大小。
- [Crawljax固定版本Crawler](https://github.com/crawljax/crawljax/blob/5771f6161c645c75f710a8cdc14e3c6898727e06/core/src/main/java/com/crawljax/core/Crawler.java)：实际到达与计划路线分开；未照搬清除不可达待测任务的行为。
- [FRAGGEN论文](https://arxiv.org/html/2110.14043)：局部比较及近似重复边界。本轮只按已有必要条件缩小候选，不使用视觉近似直接证明覆盖。
- [Cypress session](https://docs.cypress.io/api/commands/session)：初始化与验证分开，不把登录存储恢复解释为可交互页面还原。

没有复制、翻译或vendoring上游实现，没有新增自动化框架依赖。完整来源背景见`docs/exploration-refactor-sources.md`。

## 复核入口

| 改动 | 实现入口 | 独立核验 |
| --- | --- | --- |
| 真实位置重选备用路线 | `packages/core/src/engine.ts:1247`、`packages/core/src/navigation-path.ts:13` | `tests/recovery-route-alternatives.test.ts`；`evidence/alternative-input-runner.ts` |
| 内容定义分块及有界缓存 | `packages/storage-sqlite/src/evidence.ts:24`、`packages/storage-sqlite/src/evidence-chunks.ts:14` | `tests/storage-evidence-chunking.test.ts`；`scripts/benchmark-evidence-chunking.ts` |
| 原子任务迁移、逐行写入和版本轮询 | `packages/explorer-plugin/src/store.ts:13`、`:68`、`:124` | `tests/explorer-store-normalized.test.ts`；`scripts/benchmark-explorer-store.ts` |
| 同步调用内覆盖候选筛选 | `packages/explorer-plugin/src/completion-evidence.ts:21`、`packages/explorer-plugin/src/policy.ts:17` | 原覆盖/条件测试；`scripts/benchmark-completion-index.ts` |

复现微基准使用Node24和开发导出条件，例如：

```sh
pnpm exec tsx --conditions=development scripts/benchmark-evidence-chunking.ts
pnpm exec tsx --conditions=development scripts/benchmark-explorer-store.ts --count=1000 --iterations=40 --polls=500
pnpm exec tsx --conditions=development scripts/benchmark-completion-index.ts --count=1000 --iterations=5
pnpm exec tsx --conditions=development scripts/benchmark-navigation-path.ts
```

任务/候选基准的`--source-root`指向隔离的旧版本副本即可复核旧版；workspace包也必须链接该副本，不能误用当前源码。文件证据基准直接读取固定base commit的旧writer。两种模式都只建立自己的临时文件。四协议的精确参数、日志和退出码见`evidence/baseline/commands.json`与`evidence/after/commands.json`。计时采样和测试结果不能跨重叠批次相加。
