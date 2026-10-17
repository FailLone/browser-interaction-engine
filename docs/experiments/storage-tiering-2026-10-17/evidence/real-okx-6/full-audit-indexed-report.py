"""Render two input paths independently; never compare bytes across different input paths."""
from pathlib import Path
import json
out=Path(__file__).resolve().parent
r=json.loads((out/'full-audit-counterfactual-indexed.json').read_text())
old=r['originalPathResults'];fresh=r['results'];b=fresh['baseline'];c=fresh['current']
assert old['baseline']['inputTaskSha256']==old['current']['inputTaskSha256']
assert b['inputTaskSha256']==c['inputTaskSha256']
lines=['# Run 6 full audit — indexed, two independently matched path inputs','',
'第三轮保留两个明确输入。旧 task-before 的 announced 路径不能与旧空路径义务跨 reason 聚合：基线新增 **174**，当前新增 **175**。将两版 round.entryPath/position 都替换成真实 seq2952 的恢复落点后，基线仍新增 **174**，当前新增 **47**。这不是为了得到更少行而放宽路径；不同前置仍隔离。','',
'## 路径的直接材料','',
'- `recovery.position_reconciled` seq2952 明确记录 c11 的 `path: []`；reason=recovery_moved_browser，checkpointVerified=false。',
'- 紧接 seq2955 的真实审计所新增 174 个 unresolved 行全部 `prerequisites: []`。',
'- 最终保留的 c11 frame 也为 `path: []`。最终 round.entryPath 已因随后 Trade 变成 Trade，不能把最终 round 值当 c11 preaudit 输入。',
'- 两版使用同一个 task-before。第二情形**仅**按 seq2952 改当前 round.entryPath 与 position；其他 plan、round.tried、历史债均保留。真实审计前已有的本轮 3 个成功探索及其他运行期改动没有完整重建，因此仍是固定输入反事实，而非完整运行重放。','',
'## 完整方法结果','',
'| 同组比较 | 原 f6 新行 | 当前新行 | 原最终 task JSON B | 当前最终 task JSON B |','|---|---:|---:|---:|---:|',
f"| 原 task-before announced 路径 | {old['baseline']['newRows']} | {old['current']['newRows']} | {old['baseline']['bytes']['finalTask']:,} | {old['current']['bytes']['finalTask']:,} |",
f"| seq2952 恢复后空路径 | {b['newRows']} | {c['newRows']} | {b['bytes']['finalTask']:,} | {c['bytes']['finalTask']:,} |",'',
'两组各自的 baseline/current 输入 task SHA 完全一致。全部 206 actions 保留，原审计 204 pending candidates/facts 均处理，无漏掉的 pending。所有原 543 行的 status、attempt、原始 key/policy、scope、required/dispatch、prerequisites、completion、既有结果证明完全不变；旧 evidence 保留；round.tried 与 route/scheduling 债不变。','',
'空路径组的 47 行仍为 45 region_review_required、1 pointer_intercepted、1 operation_not_executed。44 没有旧完整相同 scope，另 1h/24h/Trade 不能把尚未验证的新来源塞在旧直接成功 receipt 后，因此保留新未测。','',
'## 同步索引与代价','',
'- 一个审计建立一次 exact(reason,scope,effective condition) 及 availability(scope,effective condition,prerequisites) 索引。每个旧审核仍完整验证；gap 来源追加/normalization 后刷新该 item，新增行也立即入索引。索引不跨 await 或独立审计调用。',
'- availability 原有状态、attempt/proof/unknown/authority 等全部守卫继续在候选桶上执行，plan 原顺序不变。',
'- 同观察唯一候选按完整 actions 计算，不能因另一候选不在 pending 就错误折叠。',
'- 原任务读数/字节及详细逐行输出保存在 JSON。以下时间仅为一次纯内存混合运行，不是独占或整轮性能基准：','',
'| 空路径组 | 原 f6 | 当前 |','|---|---:|---:|',
f"| 启动规范化 ms | 0 | {c['mixedElapsedMsNotBenchmark']['normalization']:.1f} |",
f"| 完整审计 ms | {b['mixedElapsedMsNotBenchmark']['audit']:.1f} | {c['mixedElapsedMsNotBenchmark']['audit']:.1f} |",
f"| 启动 observation/actions/list | 0/0/0 | 61/60/1 |",
f"| 审计 observation/actions/list | 4/0/0 | 3/1/1 |",
f"| 计划 JSON 增量 B | {b['bytes']['planIncrement']:,} | {c['bytes']['planIncrement']:,} |",
f"| 新增行 JSON B | {b['bytes']['addedRows']:,} | {c['bytes']['addedRows']:,} |",
f"| 审核元数据 B | 0 | {c['bytes']['normalizationAuditTotal']:,} |",
f"| 事件 JSON B | {b['bytes']['emittedEvents']:,} | {c['bytes']['emittedEvents']:,} |",'',
'当前空路径组最终任务 JSON 仍净增 **200,975 B**。这是一次性 325 个旧行规范化及来源审计成本；没有声称物理 DB/WAL 变小。与第二轮相比路径、相同前置门和审计实现均已变化，不能直接把两轮时间差完全归因于索引。完整源快照允许后续用同输入单独控制变量。','',
'## 验证与材料','',
'- 3 个相关文件 57/57 项通过：新索引 6 项、规范化 30 项、availability 21 项。覆盖不同 reason/path、失效 alias 后索引更新、新行追加后重复 gap、独立调用不复用旧索引、完整 actions 非 pending 重名候选。',
'- root TypeScript `tsc --noEmit` 通过，日志 `/tmp/okx-run6-audit-gap-index-typecheck.log`；`git diff --check` 通过。',
'- `full-audit-counterfactual-indexed.{ts,json}` 为复核脚本/完整结果；`full-audit-indexed-source.json` 保存相对 f6 archive 的全部变更 product 源内容和 SHA。运行期间所有 package SHA 与输入 hash 均不变。',
'- `operation-scheduling-source-freeze.json` 保存本 agent 拥有的源码/测试 SHA。root 仍会在其他产品部分处理独立 semantic 回归，故本报告不声称整个最终产品已通过。',
'- 原两轮结果、源码成本及限制都保留；SDK/浏览器/provider/network 调用 0，没有打开原始/冻结数据库。','']
(out/'full-audit-counterfactual-indexed.md').write_text('\n'.join(lines))
