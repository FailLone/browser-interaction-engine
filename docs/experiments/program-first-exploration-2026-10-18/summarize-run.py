"""Summarize completed runs only; immutable SQLite avoids touching their evidence."""
import collections,json,sqlite3,sys,hashlib
from pathlib import Path
p=Path(sys.argv[1]).resolve()
source=json.loads((p/'source.json').read_text())
result=json.loads((p/'result.json').read_text());audit_unavailable=result.get('strictAuditAvailability') or ('audit_unavailable' if result.get('reason')=='audit_unavailable' else None);budget=json.loads((p/'budget.json').read_text())
rows=[json.loads(l) for l in (p/'timeline.jsonl').read_text().splitlines()]
con=sqlite3.connect((p/'engine/engine.sqlite').as_uri()+'?mode=ro&immutable=1',uri=True)
entities=lambda kind:[json.loads(row[0]) for row in con.execute('select json from entities where kind=?',(kind,))]
attempts=entities('attempt');observations=entities('observation');by_obs={o['id']:o for o in observations}
succeeded=[a for a in attempts if a['status']=='succeeded']
events=[r['data'] for r in rows if r['type']=='plugin.event']
def elapsed(t):return next((r['at']-budget['began'] for r in rows if r['type']==t),None)
requests={e['decisionId']:e for e in events if e['type']=='decision.requested'}
ends={}
for r in rows:
 if r['type']=='plugin.event' and r['data']['type'] in ['decision.returned','decision.failed','decision.cancelled','decision.stale']:ends.setdefault(r['data'].get('decisionId'),r['at'])
starts={r['data']['decisionId']:r['at'] for r in rows if r['type']=='plugin.event' and r['data']['type']=='decision.requested'}
models=[{'actor':e['actor'],'purpose':e['data']['purpose'],'elapsedMs':ends[k]-starts[k] if k in ends else None} for k,e in requests.items()]
# Human-readable target samples, not cross-version semantic/identity equivalence.
targets=collections.Counter((by_obs.get(a['beforeId'],{}).get('url'),a['action'].get('label'),a['action']['kind'],str(a['action'].get('value'))) for a in succeeded)
summary={'run':p.name,'sourceRevision':source['revision'],'sourceFilesDigest':hashlib.sha256(json.dumps(source['files'],sort_keys=True).encode()).hexdigest(),'elapsedMs':result['elapsedMs'],'countedCommands':budget['actions'],'firstDispatchMs':elapsed('browser.dispatch'),'firstExecutedMs':elapsed('browser.executed'),'actualBrowserExecuted':sum(r['type']=='browser.executed' for r in rows),'allowedBrowserDispatches':sum(r['type']=='browser.dispatch' and r['data'].get('guardAllowed') is not False for r in rows),'browserExecutionErrors':sum(r['type']=='browser.error' for r in rows),'guardRefusals':sum(r['type']=='scope.dispatch_refused' for r in rows),'attemptStatuses':dict(collections.Counter(a['status'] for a in attempts)),'capturedObservations':len(observations),'capturedStateIds':len({o['stateId'] for o in observations}),'stateCountCaveat':'State canonicalization changed across revisions; these counts are not equivalent coverage.','successfulTargetSamples':[{'url':url,'label':label,'kind':kind,'value':value,'count':count} for (url,label,kind,value),count in targets.items()],'targetSampleCount':len(targets),'targetSampleCaveat':'URL,label,kind,value tuple for readable throughput only; not SDK control identity or finite coverage.','recoverySelections':sum(e['type']=='recovery.selected' for e in events),'recoveryResults':dict(collections.Counter(e['data'].get('status') for e in events if e['type']=='recovery.result')),'strictChains':None if audit_unavailable else sum(c.get('accepted',False) for c in result.get('chains',[])),'strictAuditAvailability':audit_unavailable or 'current_unchanged_original_child_auditor','accepted':result.get('accepted',False),'models':models,'modelWallMs':sum(m['elapsedMs'] or 0 for m in models),'coverage':result.get('coverage'),'taskStatus':result.get('taskStatus'),'taskReason':result.get('taskReason'),'aborted':(p/'aborted.json').exists()}
task=json.loads((p/'task-final.json').read_text()) if (p/'task-final.json').exists() else {}
gaps=list(task.get('programModelGaps',{}).values());by_attempt={a['id']:a for a in attempts}
summary['modelGaps']=[{'key':g['key'],'kind':g['kind'],'question':g['question'],'status':g['status'],'calls':g['calls'],'elapsedMs':g.get('elapsedMs'),'decisionIds':g['decisionIds'],'validations':g['validations'],'newlyExecutableCount':len(g['newlyExecutable']),'executions':[dict(gain,label=by_attempt.get(gain['attemptId'],{}).get('action',{}).get('label'),kind=by_attempt.get(gain['attemptId'],{}).get('action',{}).get('kind')) for gain in g['gains']]} for g in gaps]
summary['verifiedModelExecutionGains']=sum(gain['status']=='succeeded' and gain['conditionVerified'] for g in gaps for gain in g['gains'])
summary['modelGainCaveat']='Actual operation receipts after SDK-accepted review, not business correctness. Zero calls or zero receipts means no measured model execution gain.'
captures=[r['data']['elapsedMs'] for r in rows if r['type']=='capture.end']
correspondences=[r['data'] for r in rows if r['type']=='sdk.targetCorrespondences']
summary.update({'captureCount':len(captures),'captureWallMs':sum(captures),'targetCorrespondenceBatches':len(correspondences),'targetCorrespondenceTimedBatches':sum('elapsedMs' in c for c in correspondences),'targetCorrespondenceWallMs':sum(c.get('elapsedMs',0) for c in correspondences) if all('elapsedMs' in c for c in correspondences) else None,'timingCaveat':'Capture and model spans are measured. Other time includes dispatch, scheduling, persistence, matching and audit; it is not attributed to any one cause.'})
(p/'metrics.json').write_text(json.dumps(summary,ensure_ascii=False,indent=2)+'\n');con.close()
print(json.dumps({k:v for k,v in summary.items() if k not in ['successfulTargetSamples','coverage','models','modelGaps']},ensure_ascii=False,indent=2))
