"""Closed-run summaries; JSON only, no database opens or recovery writes."""
import json,sys,collections
from pathlib import Path
p=Path(sys.argv[1]).resolve()
rows=[json.loads(l) for l in (p/'timeline.jsonl').read_text().splitlines()]
samples=[json.loads(l) for l in (p/'cost-samples.jsonl').read_text().splitlines()] if (p/'cost-samples.jsonl').exists() else []
spans=collections.defaultdict(list)
for r in rows:
 d=r['data']
 if r['type']=='sdk.call':spans['sdk:'+d['method']].append((d['at'],d['at']+d['elapsedMs']))
 elif r['type']=='readDOM.span':spans['readDOM'].append((d['at'],d['at']+d['elapsedMs']))
 elif r['type']=='capture.end':spans['capture'].append((r['at']-d['elapsedMs'],r['at']))
def union(v):
 total=0;end=0
 for a,b in sorted(v):total+=max(0,b-max(a,end));end=max(end,b)
 return total
metrics={k:{'calls':len(v),'inclusiveMs':sum(b-a for a,b in v),'unionMs':union(v)} for k,v in spans.items()}
buckets=collections.Counter()
for f in p.rglob('*'):
 if not f.is_file():continue
 name=f.relative_to(p).as_posix();key='auditCopies' if name.startswith('audit-copy/') else 'evidence' if name.startswith('engine/evidence/') else {'engine/engine.sqlite':'engineDB','engine/engine.sqlite-wal':'engineWAL','engine/engine.sqlite-shm':'engineSHM','explorer.sqlite':'explorerDB','explorer.sqlite-wal':'explorerWAL','explorer.sqlite-shm':'explorerSHM'}.get(name,'exportsAndLogs')
 buckets[key]+=f.stat().st_size
profile=json.loads((p/'worker.cpuprofile').read_text()) if (p/'worker.cpuprofile').exists() else None
cpu=[]
if profile:
 nodes={n['id']:n for n in profile['nodes']};selftime=collections.Counter()
 for nid,micros in zip(profile['samples'],profile['timeDeltas']):
  c=nodes[nid]['callFrame'];selftime[(c['url'],c['functionName'],c['lineNumber'])]+=micros/1000
 cpu=[{'url':u,'function':f,'line':l+1,'sampledMs':n} for (u,f,l),n in selftime.most_common(35)]
result=json.loads((p/'result.json').read_text())
out={'run':p.name,'result':{k:result.get(k) for k in ['accepted','elapsedMs','actions','branchCount','strictChains','chainRegions','reason']},'timings':metrics,'timingCaveat':'Inclusive spans overlap. Unions are only within the named category; categories must not be added. CPU profile is sampled active/idle stack time, not exact CPU or browser time. Missing spans remain unattributed.','closedBytes':dict(buckets),'samples':samples,'workerPeakRSSKiB':max((s['resource']['maxRSS'] for s in samples),default=None),'workerMaxSampledHeapUsed':max((s['memory']['heapUsed'] for s in samples),default=None),'memoryCaveat':'Only this Node worker, including harness/profiler overhead; browser tree excluded. Samples may be delayed by synchronous work. No leakage or long-term convergence inference.','topSelfSamples':cpu}
(p/'cost-summary.json').write_text(json.dumps(out,ensure_ascii=False,indent=2)+'\n')
print(json.dumps({k:v for k,v in out.items() if k not in ['samples','timings']},ensure_ascii=False,indent=2))
