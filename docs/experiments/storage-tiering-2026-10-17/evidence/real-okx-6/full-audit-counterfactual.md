# Run 6 full audit fixed-input counterfactual

原版完整 `auditRemainingScopes` 新增 **174** 行；当前工作版先规范化旧调度标识后，完整同方法新增 **47** 行。两边处理同一 **204** 个待处理动作，保留全部 **206** 个当前动作。该结果证明本次输入减少重复登记，**不证明性能或存储改善**：当前最终任务 JSON 比原版大 **493,296 B**。

## 输入与隔离

- 基线是完整独立 Git archive `f6d7b9e2b427b5edf1fad359ecf8cc5a3df8ffcf`，所有 `@interaction` workspace 依赖指向该 archive；仅复用已安装的外部依赖。
- 两版从同一原始 `task-before`（543 行）分别 clone。当前版额外运行实际启动规范化路径，再调用完整实际审计方法。没有只调用去重 helper 来代替运行时方法。
- 当前观察 `c11abe9e-e2a4-44f2-bf53-64ebf22a1dd2`，使用原 `scope.audit` 的 204 个 pending action ID、204 个 availability facts、revision 及 obligations；identities 的 localId 由当前不可变 controls 精确回连。
- 两边 completed 集都为空：原 event 的 pending candidates 已被真实运行的 completed gate 过滤。未在 pending 的 2 个动作仍保留在完整 actions 集，但没有重建它们为什么不 pending。
- **这是固定输入反事实，不是精确真实运行重放。** task-before 的旧 round stack/entryPath（含 announced 路径）完整保留；没有假设它等于 SOURCE_REACHED 后 c11 的精确 preaudit task。基线仍精确复现 173 region + 1 pointer 新行。
- 使用记录事件/保存调用的纯内存 sink，无 SDK/SQLite store/BrowserEngine/provider 构造，不打开任何原始或冻结数据库；browser/provider/network 调用全部为 0。
- 全部 package 源码及输入 SHA-256 在运行前后核对不变；完整清单见 JSON。当前 runtime SHA-256：`1f5fa731a7c92f3c25a2d6f8cafb7b3e283694850165ead43035d3dc6cd573c7`。

## 新行与原历史

| 指标 | f6 原版 | 当前版 |
|---|---:|---:|
| 新行 | 174 | 47 |
| region_review_required | 173 | 45 |
| pointer_intercepted | 1 | 1 |
| operation_not_executed | 0 | 1 |
| 最终计划行 | 717 | 590 |

47 行中，44 行不存在旧完整相同 scope；1h 与 24h 虽有相同 scope，但旧行是直接成功 receipt，不能把尚未验证的新来源塞进旧成功状态；Trade 同理另建当前 `operation_not_executed`。因此 helper 所见 130 个相同 scope/hint 不能直接推断完整运行时只生 44 行。

全部旧 543 行保留；逐行验证 status、attempts、原始 key/policy、required/dispatch、scope、prerequisites、completion、resolvedBy/reviewResolvedBy/coverageResolvedBy 不变；原 evidence 均仍存在。rounds（含 tried）、scheduling 和 routeRetries 完全不变。原未测来源没有因此成为成功或覆盖。

当前有 421 个旧行附加 normalization audit，128 个旧行追加最新机械阻挡及当前来源；另 17 个规范化旧行只追加来源，8 个未规范化旧行追加来源，其余 276 个旧行仅增加 normalization。v3 相同只说明可共享调度工作，不能证明跨源 operationCorrespondence。opaque owner 的业务绑定若没有捕获字段仍无法由此证明相同。

## 成本：逻辑 JSON 与读取次数

| JSON 字节 | f6 原版 | 当前版 |
|---|---:|---:|
| 原始任务 | 812,690 | 812,690 |
| 规范化后任务 | 812,690 | 1,376,038 |
| 最终任务 | 1,029,843 | 1,523,139 |
| 计划 JSON 增量 | 217,153 | 710,449 |
| 新增行 JSON | 214,346 | 58,312 |
| normalization audit 总计 | 0 | 591,402 |
| 记录事件 JSON | 108,240 | 412,824 |

这些是 UTF-8 `JSON.stringify` 逻辑字节，不是数据库物理页、压缩后任务 chunk 或 WAL。旧 source/action/provenance 审计元数据的成本明显大于本次少生行所节省的 JSON。

| host 调用 | 原版审计 | 当前启动规范化 | 当前审计 |
|---|---:|---:|---:|
| observation | 4 | 61 | 277 |
| actions | 0 | 60 | 1 |
| list | 0 | 1 | 0 |

当前审计的 277 个 observation 调用中，3 个为旧 stack 来源；274 个来自记录 normalization/availability/scope.audit 事件时读取当前观察。当前 actions 的新增来源读取已由同步 reader 收敛至 1 次，但事件读取没有复用该 reader。启动规范化另读 60 个 source observation/actions，并记录 1 次事件。

一次混合运行耗时保存在 JSON：原版 audit 约 133 ms，当前 normalization 约 6,168 ms、audit 约 4,728 ms。该次与 root 测试并行，内存 sink、读取已解码对象，不包含 SQLite 解码/浏览器/模型网络，**不能作为严格性能基准或真实运行提速结论**。源码层面重复 hash 校验和事件读取成本应先解决，再独占窗口比较。

## 下一步边界

- 保留来源/原 key/attempt/unknown/route debt，不通过丢弃审计或移除旧失败记录换取少行。
- 可以优化同一同步审计内已验证 effective-key 的重复计算，以及已有 current observation 的事件记录路径；必须在来源追加后失效，不可把长期 mutable cache 当 proof。
- 元数据应另评估压缩/紧凑表示的实际 SQLite 成本，不能仅因少生 127 行宣称存储下降。
- 若 `wasTried` 用调度 alias 阻止再次执行，仍须明确保留新来源未验证状态，不能把未追加来源视为覆盖；这是独立正确性边界。

复核入口：`full-audit-counterfactual.ts`、`full-audit-counterfactual.json`、`full-audit-attribution.json`；Git archive 准备使用 `docs/experiments/pending-delta-2026-10-17/evidence/prepare-baseline.py`。
