# FRAGGEN 匹配专项：冻结真实材料、最小修复与集成边界

日期：2026-10-18（Asia/Shanghai）。独立工作树：`/Users/xietian/.codex/worktrees/fraggen-matching/browser-interaction-engine`。起点 `9eac9eea68b60e1e398b0ef35ea15a9ecb22c592`，其产品基线为 `574a7ea`。未修改主 dev 工作树、活动数据库或浏览器。未启动新 OKX 会话，也未新增 agent、goal 或自动化。

**结论：真实零跨页映射不是单一容量问题。修复了导航标签的临时实例身份造成的投影拒绝，以及不可用重复根造成的错误唯一性判断。冻结真实输入上的投影候选 649→1376；跨 URL 映射仍为 0。** 不把投影增加、同页重复材料相等或人工重建实验当作真实覆盖收益。

## 输入与复现可信度

- 原运行：主 dev `.data/broader-ui/fragment-compressed-broad-1`，已结束，27 次 fragment.frontier 对应观测、4,231 个动作候选。只复制 closed `engine.sqlite`，通过 SQLite `immutable=1` 查询副本；不创建任何 Store。
- 原数据库 SHA-256：`1b3061c076aef9a7c588a82e2868841fd24fdb787512d47f8e6d23c6119878cd`，提取前后相同。共享 pack、object、layout 和重建实体逐层校验长度和 SHA-256。
- 全量冻结 JSON 输入 SHA-256：`4829d76f444728b62704839c815307c944c5c11dd859190391afd25c41e11253`。文件保留在本工作树 `.data/fraggen-matching/captured.json.gz`，closed 副本同目录。JSON 是原存储解码后的值；冻结文件的序列化字节也有独立摘要。
- 提交的六份完整原始观测（索引 0、4、10、11、14、18）位于 `tests/fixtures/fraggen-matching/okx-public-captures.json.gz`，1.17 MB；未删模式、owner、控件或上下文来制造成功。其摘要和来源在同目录 manifest.json。
- `evidence/baseline-fragment-projection.ts` 是基线文件副本，仅重定位两个相对 import；其 review mode reader 默认路径没有更改。新旧投影以相同输入、相同 authority 运行。`full-comparison.json` 记录当前产品逐文件摘要和完整统计，`subset-comparison.json` 可仅用提交内材料重现。

## 拒绝分布（互斥的首个拒绝原因）

| 阶段 | 原政策 | 新政策 |
|---|---:|---:|
| 可投影候选 | 649 | 1376 |
| 无完整可用片段 | 881 | 881 |
| 目标未就绪 | 1315 | 1315 |
| 身份假设未解决 | 155 | 155 |
| IDREF 未解析/不在片段 | 43 | 43 |
| 模式绑定到临时实例 | 867 | 0 |
| 模式未稳定 | 129 | 269 |
| 模式缺 record key | 85 | 85 |
| 目标无 record key | 44 | 44 |
| 原生 form owner | 8 | 8 |
| 非片段动作（退出/历史等） | 55 | 55 |
| 合计 | 4231 | 4231 |

旧诊断把 7 个 IDREF 拒绝记入 selector_instance_bound；按产品真实先后顺序，正确值为 43/867，而不是 36/874。867 中 727 恢复投影，其余 140 在之后的选择器上遇到真实 unstable，仍然拒绝。没有删除该后续约束。

881 个缺片段是历史捕获已经缺少完整材料；原记录未保存采集器的具体拒绝码，无法再精确区分 256 节点上限、全局 2048 节点/196608 字节预算、32 根上限、canvas/iframe/shadow 等原因。这里只报告可观测的“无完整片段”，不把缺材料说成已证明独立。未出现的 critical gap/context unknown/目标截断等拒绝不虚构数量，另由负例验证。

## 登记后为什么仍为零

以 URL/revision 去重、暂不施加存储容量限制后，原投影有 115 个唯一片段；真实 ledger 接纳 114 个，说明容量拒绝与对应失败是两层不同的问题。原记录第 9 号输入可投影 99 个候选，实际登记 51 个；其余 48 个无法登记不是匹配成功。

原政策唯一片段之间：

| 比较阶段 | 同 URL 片段对 | 跨 URL 片段对 |
|---|---:|---:|
| 局部有序结构不同 | 3601 | 2616 |
| 结构相同、owner 不同 | 99 | 92 |
| 结构与 owner 完全相同 | 101 | 46 |
| 其内 path/operation 相同、guard 不同的候选对 | 499 | 92 |

最后 591 个 guard 不同的候选对，差异全部在 `modes`。owner 差异字段统计允许重叠：content 191 次、owner 48 次；没有把变化的隐藏目的地、内容或 owner 当成同一片段。新政策接纳更多真实材料，但有效全局模式仍不同，所以独立片段间及跨 URL 新映射依然为零。相同 URL/revision 的重复观测会引用已有候选，并不新增 mapping 边。

### 一组真实公共菜单，逐字段

`evidence/public-menu-pair.json`：转换页 `be257fd1-…` 与文章页 `c760e8d6-…` 的“交易”原生 button。

- documentId、localId、regionId 不同；它们用于连接各自的捕获材料，未作为 portable guard。
- 两侧都是 59 节点片段；structure SHA-256 相同：`54ed572aa381b1a3fb69eefc60b97052423ca3ab8fa7c699e8d58a5ab10db8b0`。
- owner（含完整隐藏后代内容、authority、ruleVersion、context）相同；候选相对 path 和 click operation 相同。
- tag、role、name、目标 attributes、semantic scope binding、constraints、runtime events、references、options、readOnly 全相同；均无 record 字段。
- 唯一 guard 差异为 modes：27 项 vs 11 项。转换页还包含图表周期、FAQ disclosure、提示 checkbox；结构模式引用的祖先属性也可能不同。

**局部结构具备对应，但现有材料不足以批准访问传播。** 原版 Fragment.getEquivalentCandidate 的相对 skeleton XPath 不检查上述业务条件；SOURCE-FACTS/VALIDATION 已实际证明它会把 `/buy` 访问传给 `/sell`。因此此次没有照搬这一弱条件，也没有仅因其它模式位于页面正文就删除它们。任意事件处理器可能读取外部选择器或祖先 attributes，局部 DOM 相似不等于依赖独立。

### 可修复的真实失败

文章页展开现货后，`c52d843f-…` 中 USDT tab 的 stableKey 含 `record-instance` 和文档实例 token。旧 mode reader 只允许导航 disclosure button 通过唯一目的地关系取得结构模式引用，拒绝同一完整导航 owner 下的 tab；所有依赖该模式的候选同时失去投影。

新政策仅对 fragment 调度启用同一程序证明：named navigation ancestor、完整且唯一的 owner、完整 IDREF、每个祖先导航 li 的唯一直接 HTTP(S) 链接目的地、完整竞争行、明确 aria-selected、无 unkeyed/业务嵌套 record、无同构竞争节点。保留 query、fragment、target、所有模式值和所有外部模式。临时实例只作为捕获内连接，不作为模式相等条件；原 control identityScope 仍为 instance，review/arrival/replay 的默认 reader 不变。

真实观测 10/11（同文档重复采集）以前各 0，现在各 104 个候选，可逐一对应；它们在 ledger 中是相同材料的重用，不应报为新的跨页 mapping。原实际 dispatch 7–11 的输入现在可投影，未伪造任何新 dispatch 或 access event，详见 `actual-dispatch-projections.json`。另有明确标记的 metamorphic 实验：仅替换原始 document/instance token 并更换 URL，104 个候选保持对应；这不是新一次 OKX 实际导航。

## 实现与政策边界

1. `mode-structure.ts` 增加可选 purpose，默认 review 路径保持不变。fragment 路径使用 `selector-fragment-reference/v1`；仅新增上述严格 navigation tab 证明。没有删除 ID、模式、完整属性、文本 guard、record、隐藏目标或 context。祖先 attributes 也保留；没有引入“位于 nav 外即无关”的规则。
2. `fragment-projection.ts` 政策升级为 `guarded-host-fragments/v2`，复用一个观测内的 mode reader。返回的片段/候选结构不变；新增可选第 4 参数 Map 提供首个拒绝原因。
3. 根唯一性改为精确 `(structure,owner)`，不再将候选集放入唯一性签名。候选暂不可用的同材料竞争根也必须拒绝，避免 readiness 变化制造身份。
4. `fragment-traversal.ts` 所有消费入口拒绝旧政策的派生剪枝/排序，包括 obligation、历史 action、frontier evidence、state order、候选选择和新增 access。旧原始片段、IDs、events、mappings、revocations、pending 原样保留。旧 ledger 暂停匹配优化，候选继续原探索流程；不把旧 ledger 的 policy 字符串直接改为 v2。

这是一项有意匹配政策升级，**不是存储物理迁移**。没有改存储 codec/records/schema 或任务事务。主 dev 集成时，adapter 两文件可直接取用；fragment-traversal 的入口校验需要合并到其新存储视图的对应消费入口。纯存储迁移必须继续保留旧 policy；若要让旧任务享受 v2，需要显式从保留的原始观测重新投影，再按原 receipt 建来源引用，不得把 v1 派生结果认定为 v2 事实。

新关系仍由精确 key `(policy,structure,owner,path,operation,guard)` 决定，每个 fragment 内候选唯一且根通过唯一性检查。因此在同政策的 eligible 集合内仍可使用 exact class membership。没有改 mapFragmentCandidates 的一对一规则，没有引入 union-find、传递闭包补边或单边撤销恢复。历史任意关系/缺边/撤销仍按主 dev 设计保留显式图与 provenance。

## 已运行验证

最终针对性组合：69/69，通过真实独立本地浏览器和真实进程退出/崩溃重启。

- 21 个新政策/真实材料测试：原失败、同页真实重复、仅实例重建、实际模式切换、外部 selector、祖先属性、参数、record、目的地、隐藏子目标、缺失/截断、重复根、重复目的地/节点、缺链接依据、非导航 owner，以及旧政策所有消费入口失效。
- 36 个既有 mode structure 测试通过，覆盖旧默认 review/operation 条件不变、导航歧义、不同目的地、不同 record、缺依据等。
- 6 个纯遍历核心测试通过，包含 `/buy` 与 `/sell`、模式/参数/record/context、不唯一候选、访问事件幂等、片段级 factor。
- 4 个本地真实浏览器测试通过：跨文档公共菜单剪枝、独有目的地实际执行、必要入口实际重入、原 child 独立实际回执；两个外部模式实际分别执行；超限片段未映射但原生动作继续。
- 2 个真实进程重启测试通过：正常退出和 dispatch 后崩溃均保留原 pending IDs；未知动作没有合成 access/success。
- 两项项目 typecheck 通过。加入 legacy stale-frontier 选择断言后，新政策 21 项单独再跑通过。

最初测试中两项断言错误地要求改变其它片段的 href 后所有片段均失配，已改为只要求受影响片段失配，并确认独立未变化片段仍可复用。另一项重复根测试揭示上述真实唯一性缺陷，已修复。首轮浏览器环境失败是 Node 25 编译的 better-sqlite3 无法由 Node 24 加载；本工作树修复依赖后通过。主 dev 依赖二进制仅被只读复制，inode 独立，未改其代码或安装。失败日志与最终日志均留存，不把环境失败算产品通过。

## 可执行复现

在本工作树使用 Node 24（本次为 24.22.0）及锁定依赖：

```sh
pnpm install --frozen-lockfile
pnpm exec vitest run tests/fragment-matching-policy.test.ts tests/mode-structure.test.ts tests/fragment-traversal.test.ts tests/fragment-traversal-browser.test.ts tests/fragment-restart.test.ts
pnpm typecheck
node --conditions=development --import tsx docs/experiments/fraggen-matching-2026-10-18/diagnose.ts
```

全量冻结材料在本机已有；全量诊断命令：

```sh
node --conditions=development --import tsx docs/experiments/fraggen-matching-2026-10-18/diagnose.ts .data/fraggen-matching/captured.json.gz docs/experiments/fraggen-matching-2026-10-18/evidence/full-comparison.json
```

需要从原 closed 运行再提取时，运行 `python3 docs/experiments/fraggen-matching-2026-10-18/extract.py <completed-run-dir> <new-empty-output-dir>`。会拒绝现存输出目录和仍存在 WAL 的原库，所有 SQL 只读 immutable 副本。

## 仍未验证/未解决

没有证明真实跨页剪枝收益、没有新 OKX strict reentry 成功、没有全库 251 回归或新的端到端耗时结论。主 dev 负责新共享存储后的统一验收。旧采集在 spot 页的业务 record/mode 未就绪和完整片段缺失仍存在。

要进一步让当前转换页/文章页公共菜单跨页传播，需要程序可核查的依赖范围契约或更完整采集证据，能具体证明哪些外部模式/ancestor attributes不影响该操作。现有公开页面材料没有这份证明；普通候选继续探索，不因未知对应阻塞整页，也不转入逐控件模型许可。
