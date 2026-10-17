"""Add provider totals from archived raw decisions and render existing pure-projection diagnosis."""
import json,pathlib,collections
p=pathlib.Path(__file__).parent;r=json.loads((p/'plan-growth-diagnosis.json').read_text());m=json.loads(pathlib.Path(r['integrity']['material']).read_text());req={x['decisionId'] for x in m['events'] if x['type']=='decision.requested'}
stats=collections.defaultdict(lambda:{'count':0,'elapsedMs':0,'inputTokens':0,'outputTokens':0})
for d in m['decisions']:
 if d['id'] not in req:continue
 v=stats[d['purpose']];v['count']+=1;v['elapsedMs']+=d.get('elapsedMs',0);u=d.get('answer',{}).get('usage',{});v['inputTokens']+=u.get('input_tokens',0);v['outputTokens']+=u.get('output_tokens',0)
r['providerBreakdown']=dict(stats)
before={i['id']:i for i in m['before']['plan']};after={i['id']:i for i in m['after']['plan']}
r['historicalRetention']={'oldRows':len(before),'allStatusesUnchanged':all(i['status']==after[id]['status'] for id,i in before.items()),'allEvidenceRetained':all(all(e in after[id]['evidence'] for e in i['evidence']) for id,i in before.items()),'allAttemptsRetained':all(all(e in after[id]['attempts'] for e in i['attempts']) for id,i in before.items())};assert all(v for v in r['historicalRetention'].values())
(p/'plan-growth-diagnosis.json').write_text(json.dumps(r,ensure_ascii=False,indent=2)+'\n')
text='''# Run 6 计划增长诊断

基于 f6d7b9e 与完整 frozen-6 的 immutable/query_only 原始 SQLite、归档任务。已校验解码 85 个 Observation，含本轮之前 69 个；没有构造 SDK 写者、浏览器或 provider。每一新增项的来源动作、旧条目、字段差异及源码 SHA 见 JSON。

计划从 543 到 721：新增 4 个已成功操作，以及 174 个 unresolved。174 全来自返回页面后的同一观察 c11abe9e，其中 173 为 region_review_required，1 为 pointer_intercepted。不是新增 174 个未分类控件，也不是恢复失败。旧 543 行最终状态均保留；原 evidence/attempt 没有删除。

| 分组 | 数量 | 原材料支持的结论 |
|---|---:|---|
| 完整 scope 与旧 operation key 都相同 | 14 | 新 blocker reason 导致另建行；旧行主要为 observed_in_scope / operation_not_executed。不能据 key 当成功覆盖。 |
| 完整 scope 相同，key 改变 | 116 | 所有可重算旧来源的 key 投影仅 scope.stableKey 不同；差异来自 structural-item 中的 DOM owner 实例。 |
| 旧计划无相同完整 scope，但旧捕获已有 native reference | 16 | 旧计划未登记该完整 scope，或名称报价变化；仅为候选对应。 |
| 旧计划及 69 个旧捕获均无同目的地引用 | 28 | 本轮新观察到的换算币对，属于首次保留的材料，不能去重。 |

130 个同 scope 项的 URL、region、label、role、kind/value、public stableKey、targetBinding 均相同。116 项与旧源 declared context、ruleVersion 相同，但控制 identityId、document/instance owner 已更换；14 项既有 identityId 保持。重算 781 个旧来源动作比较：697 次只有内部 scope.stableKey 改变，84 次完全相同。例如 1h 的旧内部键包含 owner 87b91bd6…:1388，本轮包含 bbb4c5c4…:1518；record 和 slot 没变，public scope 已采用 record/template/slot 提示，因此没有变化。

根因有两层。browserOperationKey v2 优先使用 c.stableKey，而捕获对结构记录生成的 stableKey 含 ownerInstanceId。因此一次文档重建就产生新的调度 revision。另 auditRemainingScopes → unexecutedAction → gap 把首个 blocker reason 加入创建键 {reason,scope,operationConditionKey}；临时缺少区域审阅会为旧待测操作追加新理由行。这是调度/记账问题，不能通过忽略未知依赖解决。

174/174 的 browserBranchConditions 与 browserTargetConditions 均不可得，sourceConditions 明确为 unverified。同 scope、同 key 或同 native reference 不是 SDK 对应证明，不能合并历史义务、授予恢复或完成。116 项可仅规范化调度提示中的 DOM owner，保留原 key/source/attempt 及审计；A/B、context、record、template/slot、业务绑定变化仍须区分，旧尝试/unknown 债不能因新提示刷新。

时序：23:12:54.284 选择本轮来源返回；23:13:09.889 返回 SOURCE_REACHED，严格恢复/控件权限字段均 false；23:13:11.318 的 scope.audit 已登记这 174 项，23:13:12.508 projection 从 546 到 721（另有 1 个 Trade discovery）；23:13:12.522 选择 Trade，随后成功。20 个后续区域模型请求晚于此次增长，故不是模型直接生成 174 行。

JEV 26 次中 region-review 21 次（80.8%）：1 次在旧 modal，20 次在返回并点击 Trade 后的 4 个观察，每观察 5 个候选。当前非 observed-ui 路径每 5 项 flush 并 recapture，全部返回 include。另有 classification 1、identity 1、control-risk 1、probe-risk 2；模型调用数不是执行动作数。

| JEV purpose | 次数 | 输入 tokens | 输出 tokens | decision elapsed 合计 ms |
|---|---:|---:|---:|---:|
'''
for k,v in stats.items():text+=f"| {k} | {v['count']} | {v['inputTokens']} | {v['outputTokens']} | {v['elapsedMs']} |\n"
text+='''
上述 elapsed 来自原 decision 日志，不是新性能基准，不含浏览器 capture、审阅命令 recapture 或全轮耗时。region-review 是否可批量化由独立诊断负责；此报告不据同标签认定重复。

旧 USD review 92e78cad 仍 unresolved、无 attempts，唯一变化是追加 c11 的当前来源；原 5 个 run4 来源保留。run5 严格失败 route 59eb7890 的 scheduling record 与 retry ledger 均逐结构不变。页面位置返回使用独立 observed-source route，没有清除旧严格恢复债。

建议：版本化 owner 无关的调度提示及旧 hint 审计/预算兼容；把 blocker 作为待测来源的动态审计事实，保留不同条件、路径与历史；新执行只完成确实被验证的来源，其他仍保留未测。必要反例包括同 DOM 换业务绑定、record/slot/A-B/context 改变、未知分支、旧 split/attempt/unknown 与跨 session。不得把 174 行整体删除或按 hash 合并。

复核顺序：plan-growth-extract.py（immutable 原始 SQL）、Node 24 --import tsx --conditions=development plan-growth-diagnosis.ts（纯函数投影）、plan-growth-report.py（原 decision 合计与报告）。JSON 保存逐项证据，extraction JSON 保存原库/raw SHA 和解码计数。后一次补充 provider 统计的纯投影重跑因另一 agent 改 runtime 触发源码不变断言，已停止；最终投影沿用此前成功且源码 hash 不变的结果，provider 合计独立取自原始决策，不以变化中的源码冒充冻结版本。
'''
(p/'plan-growth-diagnosis.md').write_text(text)
