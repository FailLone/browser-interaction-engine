# Static capture budget checkpoint

The native v2 collector cannot retain the required roots within the existing 512-node / 128 KiB budget on either of these two conservatively mapped static HTML inputs. Both return `byte_budget`, `inventoryComplete: false`, and an empty retained graph. This is one structural capacity conclusion, not a recovery or performance conclusion.

The single completed checkpoint used collector commit `9e8f4553319b0e0ddee01a73a828ef8252aa6ba3`, with checkout at `211841e008634d0571cbad7513698484d19380f7`. The collector source hash matches that native commit. The first launch stopped at a harness preflight guard before database access, browser creation or collector execution. Its corrected guard accepts an empty WAL only when the main file matches the previously recorded settled hash; the reason is retained in `result.json`. No static collector case was repeated.

| Static input | Retained controls mapped | Detail instance paths verified | Required control roots retained complete | Result |
| --- | ---: | ---: | ---: | --- |
| First before / checkbox | 301 / 301 | 194 | 0 / 33 | `byte_budget`, also `missing_idref` |
| Before `1W` | 304 / 304 | 187 | 0 / 37 | `byte_budget` |

Every mapped control also passed its retained attribute binding check; neither frame used a fallback selector. The collector cleared its nodes/roots/closures after the byte limit was reached, so the reported final 1,922 / 2,084 bytes describe the refusal record, not a successful compressed graph or peak collected bytes. The first frame's missing reference is an additional static reason; this checkpoint does not diagnose its original runtime behavior.

The temporary main database, empty WAL, and SHM fingerprints are unchanged. All 294 referenced evidence files are unchanged. Each private context fulfilled exactly one in-memory document; CSP prevented page script/resource loading, and no other request reached the route. Both contexts and their headless browser were closed.

Inputs are the first before observation and the before observation for `1W`, referenced by `../real-okx-8/collection-diagnosis.json`. The original evidence is read directly and hash checked, without opening its database or copying HTML. Only the already exclusive, settled temporary audit database is opened read-only to decode those two complete observations. No SDK host/store or browser driver is constructed.

The script refuses execution without an explicit native commit whose collector matches the working file, and refuses to overwrite `result.json`. Execution creates its own headless Chromium process and two isolated contexts. It serves the saved HTML in memory once at its original URL; CSP blocks page scripts and resources, the route aborts every other request, and host resolution is disabled. No server, user browser, live task database, provider, or interaction is used.

The original control selector must uniquely match an element of the same tag. Retained review/purpose attributes must match. When a retained detail node is present, its element path and complete attributes must also match; a truncated field fails the mapping. Missing detail nodes require retained binding attributes. Duplicate element bindings, ambiguity, missing targets, or mismatches make that entire frame `unverifiable_input_mapping`; the collector is then not called. No fallback selector or inferred association is invented.

For a valid mapping, the original controls are passed unchanged and fixture elements receive their retained IDs only as measurement labels. New IDs use the same document-prefix shape, with a six-digit counter. The report keeps root completeness/reasons, graph counts and bytes, input/source hashes and read boundaries. It does not retain the generated graph, duplicate HTML, or copy prior evidence.

This is not interactive page restoration, the original live same-frame capture, or a coverage/dispatch witness. HTML defaults are not retained live form values. The separate timestamps and synthetic identity labels prevent backfilling old graphs or claiming real recovery success. It is also not a timing or memory benchmark.

The original HTML uses saved attribute defaults, not live native values. Fixture-generated node IDs also use a conservative six-digit suffix. Those differences can affect exact bytes: this checkpoint proves the bounded collector rejects these static inputs, not that the original live frame would consume precisely the same space. No graph was persisted or backfilled. Repeating with larger budgets or altered selectors is outside this checkpoint.

Recorded invocation (already completed; the script refuses to overwrite the retained result):

```sh
node --import tsx --conditions=development docs/experiments/storage-tiering-2026-10-17/evidence/native-capture-budget-checkpoint/checkpoint.mjs --execute --native-commit 9e8f4553319b0e0ddee01a73a828ef8252aa6ba3
```

## Aggregate byte cost diagnosis

`cost-diagnosis.mjs` performed one separately authorized diagnosis because the bounded result deliberately erased the graph and could not explain byte allocation. It verifies the SHA of the committed checkpoint template and native collector, then strictly matches three aggregate byte refusal sites in an in-memory copy. It bypasses those refusals only for cost inspection. The original 512-node / 64-reference / 16-depth limits and individual 128 KiB attribute/text/value truncation checks remain. Product code, the bounded script, and `result.json` are unchanged. The wrapper records source and transformation hashes in `cost-result.json`; every diagnostic result is explicitly ineligible as proof.

Both frames again passed the same control mappings. This diagnostic shows that reserving root metadata alone is insufficient for these static inputs in the current representation:

| Exact JSON component bytes | First before | Before `1W` |
| --- | ---: | ---: |
| Nodes | 189,975 | 186,080 |
| Closures | 135,749 | 140,093 |
| Control roots | 83,085 | 84,149 |
| Native-only roots | 215 | 415 |
| References | 5,198 | 4,676 |
| Selector/native inventories | 1,555 | 1,733 |
| Header and framing | 339 | 358 |
| Total | **416,116** | **417,504** |

The component accounting reconciles exactly with serialized JSON. Required captured records alone occupy 206,733 / 231,512 bytes as separate arrays; their nodes alone occupy 151,309 / 167,053 bytes. These subsets omit unrelated inventory entries and retain original reference indexes, so they are not valid complete graphs or lower bounds for another encoding. They still show why reserving metadata without reducing the current representation cannot make these inputs fit 131,072 bytes.

The closure records contain 2,328 / 2,471 repeated node-ID occurrences. Their `nodeIds` arrays alone consume 106,118 / 112,675 bytes. This supports investigating lossless local indexes and shared membership structures; it does not measure a proposed encoding's savings or authorize dropping dependencies.

Removing the aggregate byte refusal does not make the required dependencies complete. The first input has 29 / 33 complete required control roots; two fail missing IDREFs and two fail ancestor depth. The `1W` input has 33 / 37; one fails a missing IDREF, two fail ancestor depth, and one retained native field still fails `node_budget` / `target_not_captured`. Native-only roots are diagnostically complete (1 / 1 and 2 / 2). Missing references include `navColumnContainer` and, in the first input, `_r_0_`; these are structural facts of the static HTML, not conclusions about live application semantics. Both diagnostic graphs reach the unchanged 512-node ceiling.

The same temporary database/WAL/SHM and all 294 source evidence files remain byte-identical. No original task database or browser was opened, and no graph or HTML was retained. The private fixture browser was closed. This is one byte-allocation diagnostic, not a passing coverage result, a performance benchmark, or evidence of real recovery success.

Recorded diagnostic invocation (already completed, output cannot be overwritten):

```sh
node --import tsx --conditions=development docs/experiments/storage-tiering-2026-10-17/evidence/native-capture-budget-checkpoint/cost-diagnosis.mjs --execute --native-commit 9e8f4553319b0e0ddee01a73a828ef8252aa6ba3
```

## 下一检查点：仅设计与后续清单

**建议先设计类型化 ID 字典与固定 tuple 行的紧凑 v3，和根元数据预留／预算分配分开提交。v3 尚未实现，也未进行候选编码测量。** 本次成本数据支持减少重复表示，但不能证明某个编码必然装入 128 KiB。必要根的 `missing_idref`、`ancestor_depth`、`node_budget` 已经独立成立；压缩不能消除这些拒绝，也不因此启动下一轮页面验收。

| 方案 | 收益依据 | 改动与边界 |
| --- | --- | --- |
| 类型化 ID 字典、引用索引、固定行字段 | 针对已经量到的重复 ID、闭包成员与固定字段名；不解释或归并业务文字 | 固定 schema 可明确检查每个槽位。建议作为最小方案；是否足够仍未测量 |
| 通用字符串／对象键 intern | 可能进一步共享属性名、class、URL 等原始重复字符串 | 需要通用 JSON 类型标签、任意键还原、重复键检测、展开额度与顺序规则，范围更大；先不进入最小补丁 |

建议的最小契约如下，所有数值新增项均需在实施前固定问题定义和专项验收，不能视为已发布能力：

- **表示与语义分开。** v3 外层保留 `documentId`、`baseURI`、`inventoryComplete`、`complete`、`limits` 等共享头，紧凑内容声明对应 v2 的原始依赖语义。ID 字典只做字符串精确去重；节点、根、闭包、引用按固定类型的行存储，成员数组使用整数引用。属性、文本、原生值、resolved URL 和原因保留原值；缺失字段与空对象／空数组不同，合法 `__proto__` 属性也必须无损保留。
- **ID 字典不等于已捕获节点表。** root 的 local／instance／owner／closure ID，以及 parent、child、association、reference 中的 ID 都需要可保留原始字符串。一个已知 ID 可能没有完整节点，这是现有不完整证据的一部分，不能强行映射到别的节点或丢弃。越界、非整数、重复字典条目、非法槽位、重复对象键等编码损坏立即拒绝；“ID 存在但所需节点未捕获”继续由原有闭包验证拒绝，不能把两类情况混为一谈。
- **构建直接受限。** 128 KiB 在 v3 明确约束含字典、行、状态和原因的完整编码包；512 节点、64 引用和深度 16 保持。构建时直接维护紧凑条目和成员索引，分配前计费，并给临时集合、条目数量及遍历工作设硬上限。不能先解除原始对象上限、构建巨大图，再用 gzip 或最后截断补救。新增编码预算失败仍输出有界拒绝，不能隐去必要依赖。
- **解码也单独有界。** 先检查编码字节、表长、行宽、类型和引用，再分配解码对象；对还原后的字符串重复、成员和 JSON 展开量累计计费。额外 **1 MiB 展开上限仅为设计提议，尚未实现或验证**；还需固定字典／成员／根数量硬限。现有 v1/v2 的 128 KiB 原始图检查不得顺带放宽。
- **派发保留原始封装哈希。** 当前派发链只依赖完整库存标记和图哈希，可继续哈希 v3 编码封装，不必在每次派发时解码。编码必须确定；旧 witness 不能改哈希、补签或跨编码版本假定成功。升级后若旧 before 与新采集封装不同，应重新观察，而非伪造旧见证。
- **reader 查询内解码一次。** v3 经严格解码后成为 v2 语义视图，复用现有 owner／IDREF／native／closure 校验；字节检查针对已经验证的原始封装，不能把大于 128 KiB 的解码视图送进旧字节分支后再放松旧分支。利用现有查询内 WeakMap 缓存，不跨查询缓存可撤销授权。v1/v2 原 key 与结果保持是后续验收约束，尚未由 v3 实现证明；v1 缺失的原生库存也不得补齐。

建议后续按单一结论拆分：

1. **无损编解码契约。** 先固定 schema 和全部构建／解码边界；以有限的原始依赖对象验证精确还原、坏索引／重复键／展开炸弹拒绝，以及旧 v1/v2 key、结果与拒绝原因不变。只验证表示，不声称覆盖可用了。
2. **有界采集接入。** 让 collector 直接构建紧凑表示并按编码字节计费；保留采集范围、遍历顺序、节点／引用／深度和字段截断。专项结论只能是同样原始语义在新表示中的有界保留成本；尚无候选收益数字。
3. **根库存与预算分配。** 单独定义根元数据预留、分配顺序和预算耗尽后的库存契约，独立提交与验收。不能把有损裁剪称作编码优化，也不能通过无限原始构建后的后置分配规避资源上限。
4. **证据契约问题分别定义。** 对必要根的缺失 IDREF、祖先深度及节点超限各自确认原因与最小补丁；不得因网页可打开、字节更小或本地编码测试通过而删除拒绝。没有固定的小补丁问题定义前，不增加页面验收窗口。

这份清单只记录下一检查点；任务库压缩／全量读取优化、真实恢复成功率及页面覆盖结论仍由主线程的 goal／ROADMAP 和实验入口统一维护。
