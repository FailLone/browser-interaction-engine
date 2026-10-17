"""Render the second report without changing the first comparison."""
from pathlib import Path
import json
out=Path(__file__).resolve().parent
first=json.loads((out/'full-audit-counterfactual.json').read_text())
r=json.loads((out/'full-audit-counterfactual-compact.json').read_text())
b=r['results']['baseline'];c=r['results']['current'];old=first['results']['current']
assert r['inputs']==first['inputs']
lines=['# Run 6 full audit — compact normalization follow-up','',
'完全相同输入的第二轮对照仍为原版新增 **174** 行、当前版新增 **47** 行。全部 204 个原 pending 动作仍参与审计。来源、历史结果、尝试、原始 key/policy、前置与恢复债的完整性断言全部通过。','',
'此次只读反事实沿用第一轮限制：同一原始 task-before、全 206 actions、原审计的 204 pending candidates/facts 与 obligations；并非重建精确 c11 preaudit route。纯内存记录 sink，没有 SDK/数据库/浏览器/provider/network 调用。','',
'## 变化','',
'- 审核只存原 ref 的三元组字符串及去重 v2 aliases；source observation 与 action 仍由保留的 immutable source/attempt.before 重建并逐一核验。原 ref 删除/替换、scope 变化、unknown/executing、非唯一候选仍使审核失效。',
'- v2 与 v3 编码相同的行不再保存多余审核；325 行实际需要规范化（第一版 421 行）。',
'- 每个来源观察只构建一次完整 scope 索引并 memo v2/v3 action key，source record LRU 仍有 8 项上限；原生 SHA-256 使用与 core 完全相同的 canonical 序列化。',
'- root 的事件路径传入已知 observation ID，避免每个事件重读当前大观察；审计也不再把 wasTried 预算当作覆盖，改为核对同来源成功 receipt。因此此对照不隔离单一元数据优化。','',
'## 结果与代价','',
'| 指标 | 原 f6 | 第一版 working | 紧凑版 working |','|---|---:|---:|---:|',
f"| 新计划行 | {b['newRows']} | {old['newRows']} | {c['newRows']} |",
f"| 最终任务 JSON B | {b['bytes']['finalTask']:,} | {old['bytes']['finalTask']:,} | {c['bytes']['finalTask']:,} |",
f"| 计划 JSON 增量 B | {b['bytes']['planIncrement']:,} | {old['bytes']['planIncrement']:,} | {c['bytes']['planIncrement']:,} |",
f"| 审核元数据 B | 0 | {old['bytes']['normalizationAuditTotal']:,} | {c['bytes']['normalizationAuditTotal']:,} |",
f"| 事件 JSON B | {b['bytes']['emittedEvents']:,} | {old['bytes']['emittedEvents']:,} | {c['bytes']['emittedEvents']:,} |",
f"| 启动规范化 observation/actions/list | 0/0/0 | 61/60/1 | 61/60/1 |",
f"| 审计 observation/actions/list | 4/0/0 | 277/1/0 | 3/1/1 |",'',
'紧凑版任务仍比原版多 **159,954 B**；不能称本次迁移即时节省了物理存储。325 个旧行一次性审核会增加 metadata，以后追加相同调度工作来源通常比新增整行短，但尚未用多帧实际 SQLite 库量化该长期交换。上述数字是 UTF-8 JSON 逻辑字节，不是 DB/WAL/压缩 chunk 字节。','',
'一次混合耗时（非性能基准）：','',
'| 阶段 ms | 原 f6（同第二轮） | 第一版 | 紧凑版 |','|---|---:|---:|---:|',
f"| 启动规范化 | 0 | {old['mixedElapsedMsNotBenchmark']['normalization']:.1f} | {c['mixedElapsedMsNotBenchmark']['normalization']:.1f} |",
f"| 完整审计 | {b['mixedElapsedMsNotBenchmark']['audit']:.1f} | {old['mixedElapsedMsNotBenchmark']['audit']:.1f} | {c['mixedElapsedMsNotBenchmark']['audit']:.1f} |",'',
'当前的源索引与事件改动消除了明显放大，但审计仍慢于原版。每次 gap 查全 plan 会反复校验完整审核的 canonical/hash，尚有可测成本。以上单次混合结果不含 SQLite 解码、页面 capture、模型网络，也不用于宣称真实整轮提速。','',
'## 可复核性','',
'- 第一轮 `full-audit-counterfactual.{json,md}` 完整保留。',
'- 第二轮输入 SHA 与第一轮逐字段相等；全 package 源码前后 SHA 相同。',
'- `full-audit-counterfactual-compact.json` 保存所有输入、读次数、逐行变化、完整源码 SHA 及限制。',
'- `full-audit-compact-source.json` 保存相对独立 f6 archive 的全部变更 product 源内容和 SHA，可重建该次 working 源码。',
'- 复核脚本 `full-audit-counterfactual-compact.ts`；archive 准备仍使用 `docs/experiments/pending-delta-2026-10-17/evidence/prepare-baseline.py`。',
'- 专项 `explorer-operation-scheduling-key.test.ts` 30/30；新增断言覆盖被显式选中的 v2 split child 必须实际归一化且 bound=v3、完整 scope 非唯一拒绝、紧凑审核篡改、native/core hash 等价、无需审核的相同编码。','']
(out/'full-audit-counterfactual-compact.md').write_text('\n'.join(lines))
