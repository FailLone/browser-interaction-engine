# 第二阶段：局部对应与可撤销采样

2026-10-18，独立分支 `codex/fraggen-matching`，第一阶段提交 `366012568c24e8c5e720552eba801a7fc82b166e` 之上。未修改主 dev 工作树、存储代码、活动数据库或浏览器；未启动新 OKX 会话、agent、goal 或自动化。

**已完成本阶段独立交付：冻结 OKX 的 59 节点公共菜单可以建立局部对应；真实本地浏览器中，3 次重复菜单机会实际只执行 2 次，独有动作继续执行，结果分歧使间接复用重新开放，新子入口获得真实回执。** 这不是已完成主 dev 的统一存储集成或最终真实 OKX 验收。

## 政策改变

投影升级为 `guarded-host-fragments/v3`。严格 key 继续包含完整局部结构与隐藏后代、目的地、操作种类/参数、record、显式声明 context、authority、规则版本、目标属性及局部/已关联模式。关联范围包括完整片段、目标祖先、同原生 form、已支持组件和捕获到的双向 IDREF 链；关联引用缺失或歧义仍拒绝。重复根、竞争候选、未就绪、原身份假设和截断限制继续生效。

未证实相关的全局模式及祖先属性完整保存在独立 `context` 材料中，进入 occurrence/revision，但不再要求其与局部操作 key 一致。它们没有被删除，也没有被宣称为已证明无关。review、执行授权、定位、到达验证和成功/覆盖语义未放宽。

采样是单独的、可撤销的决策：

- 一个真实样本遇到新外部 context 时，标记 `context-recheck-required`，该动作仍进入普通探索。
- 两个不同 context 的真实成功回执，且完整已观测 effect 相同后，允许第三个 context 以 `unverified-external-context` 假设复用样本。额外验证预算为 1；没有周期性探针或第二套执行模式。
- effect 是实际前后观测中的 URL、可见控件和文本变化，不是功能成功。关键缺口/截断不给 effect；未知结果不能批准跨上下文复用。动态内容噪声可能保守地撤销复用。
- 后续真实结果分歧立即重新开放受影响的间接样本；direct 回执不删除。新隐藏子节点改变完整局部材料，也会重新开放入口。
- 只从直接相连且未撤销的候选读取真实 origin events。A→B 的继承计数不能再沿 B→C 出借；缺边和单边撤销不被传递闭包补齐。所有决策 `coverageGranted:false`，原 pending 和恢复义务保留。

## 冻结真实材料

沿用第一阶段全部 27 份原观测、4,231 个动作，未修改输入。全量 JSON SHA-256 为 `4829d76f444728b62704839c815307c944c5c11dd859190391afd25c41e11253`；closed 副本数据库仍为 `1b3061c076aef9a7c588a82e2868841fd24fdb787512d47f8e6d23c6119878cd`。提交内六份完整 capture 及 manifest 沿用第一阶段文件。

使用提交 `3660125` 的原 v2 投影与当前 v3 逐一处理同一材料，未实例化数据库或浏览器：

| 计数 | v2 | v3 |
|---|---:|---:|
| 可投影动作 | 1,376 | 1,701 |
| 唯一 URL/revision 片段 | 157 | 240 |
| 跨 URL 的局部候选对应 | 0 | 846 |
| 关联引用不完整拒绝 | 0 | 13 |
| 相关模式不稳定拒绝 | 269 | 16 |

其余第一拒绝原因保存在 `evidence/full-comparison.json`。唯一片段增加也包含 context 被保留而导致的 occurrence 区分；不是新增页面或覆盖。846 是无存储容量限制的离线候选对应数，不是 dispatch、采样批准或成功数。

真实索引 0/4 的转换页与文章页，目标为“交易”button：两侧 59 节点 structure、完整 owner、path、operation、guard 相同；严格关联模式均为 4 项，外部证据不同且可完整还原。v2 的 27/11 项全局模式差异曾阻止对应。现在局部对应成立，首次跨 context 仍要求真实复验。`frozen-pair.json` 中 `example-origin` 明确只是说明决策的人工输入，**不是 OKX 真实执行回执**。

真实重复观测 10/11 由 v2 的 104 对降为 103 对：新增关联图检查拒绝了“搜索公告”控件的缺失引用，原因 `related_reference_incomplete`。没有为了提高数量删除该约束。实际相关 tab 值、目的地、record、参数改变仍失配。变更全局外部模式会改变 context，局部对应仍可保留。

## 真实本地验证与重启

`tests/fragment-sampling.test.ts` 使用全新 localhost 服务、独立浏览器会话与临时 SQLite，预先固定 60 秒 / 40 命令；启动、切换关闭、执行及最终关闭均计入。最终记录为 16 个命令，约 3.6 秒，完整观测、回执、ledger 和进程校验见 `evidence/browser-proof.json.gz`，可读摘要见 `browser-summary.json`。

1. A 的菜单普通执行；B 外部选择器不同，要求复验并真实执行；两次 effect 一致。
2. C 的菜单标记 `context-sample`，没有执行该重复动作；C 独有链接实际执行成功。三次菜单机会对应两份实际菜单回执。
3. D 的菜单仍可通过独立 SDK 授权执行路径实际执行，结果不同；C 的间接采样立即变为 `observed-effect-conflict`，不再剪枝。该步骤用于注入真实结果证据，不声称 D 是自动选择的恢复路径。
4. N 增加一个初始隐藏的子链接，入口材料变化使采样失效；菜单和 New child 均获得独立真实回执。
5. 把冲突前后两个 ledger 分别写入真实 ExplorerStore，关闭，再由新 Node 进程打开独立 SQLite 读回。完整 ledger 摘要、事件 IDs 和采样决策一致。JSON 冷读同样一致。

这是按采样决策驱动的实际 SDK 浏览器场景，不是自动运行的全站基准或新 OKX 测试。另行通过已有真实完整插件测试，证明共享菜单剪枝、独有入口执行、必要恢复入口实际重入及原 child 独立真实回执仍成立。实际进程正常退出/dispatch 后崩溃测试也通过，原 pending IDs 保留，未知执行不生成 success/access。

## 最终检查

- 76 个不同针对性测试通过：22 个匹配政策测试、6 个新增采样测试、36 个 mode structure 测试、6 个遍历核心测试、4 个真实浏览器测试、2 个真实进程恢复测试。
- 最初 75 项整组通过后，补全共享组件成员的关联引用闭包并新增负例；受影响 34 项重新通过，未改动的 42 项结果保留。两项项目 typecheck 最终通过。
- 失败记录保留：初始本地场景未关闭前一个会话；旧 v2 数量和全局模式断言未随明确政策改变；新增测试一处临时语法错误。分别修复后验证通过，没有把失败日志改写为成功。
- product/test/evidence 摘要在 `evidence/manifest.json`；第一阶段报告和证据保持不变。

## 存储交接与限制

详见 [STORAGE-HANDOFF.md](STORAGE-HANDOFF.md)。主 dev 的 class 可以继续作为**局部精确对应索引**，但 counts/origins 必须调用新 sampler；不能按 class 直接授予跨 context 剪枝，也不能用递归图传播继承计数。需要持久化 context/effect 和原始 provenance，处理冲突/撤销时使派生缓存失效。v1/v2 旧政策保持原字节和 IDs，关闭旧派生消费，不能直接改为 v3。

此工作树仍有原 array ledger 容量限制，只对新增 context/event 的容量核算作相应保守处理；主 dev 负责新存储的容量、原子提交和集成。没有全库回归、新真实 OKX strict reentry、冻结代码独立 OKX 复验或吞吐提升结论；这些统一验收仍由主 dev 执行。

## 复现

使用 Node 24 与锁定依赖，在本工作树运行：

```sh
pnpm exec vitest run tests/fragment-sampling.test.ts tests/fragment-matching-policy.test.ts tests/mode-structure.test.ts tests/fragment-traversal.test.ts tests/fragment-traversal-browser.test.ts tests/fragment-restart.test.ts
pnpm typecheck
node --conditions=development --import tsx docs/experiments/fraggen-sampling-2026-10-18/diagnose.ts
node --conditions=development --import tsx docs/experiments/fraggen-sampling-2026-10-18/diagnose.ts .data/fraggen-matching/captured.json.gz docs/experiments/fraggen-sampling-2026-10-18/evidence/full-comparison.json
```

第一个诊断默认只用提交内六份完整 capture；最后一个使用本机第一阶段冻结全量文件。诊断直接比较 v2/v3，测试会把新运行证据写入本工作树 `.data/fraggen-sampling`；提交内 evidence 为此次冻结结果，不由测试覆盖。
