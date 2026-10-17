import json,pathlib,collections,hashlib
root=pathlib.Path('/Users/xietian/.codex/worktrees/exploration-layered-refactor/browser-interaction-engine');out=root/'docs/experiments/storage-tiering-2026-10-17/evidence/real-okx-6/audit-profile';files=list(out.glob('*.cpuprofile'));assert len(files)==1;p=files[0];c=json.loads(p.read_text());nodes={n['id']:n for n in c['nodes']};parents={child:n['id'] for n in c['nodes'] for child in n.get('children',[])}
def chain(id):
 out=[]
 while id in nodes:
  out.append(nodes[id]);id=parents.get(id)
 return out
def key(frame):return (frame['functionName'],frame['url'],frame['lineNumber'],frame['columnNumber'])
phases=collections.Counter();selfs=collections.defaultdict(collections.Counter);inclusive=collections.defaultdict(collections.Counter);chains=collections.Counter();samplecounts=collections.Counter()
for id,delta in zip(c['samples'],c['timeDeltas']):
 stack=chain(id);names=[n['callFrame']['functionName'] for n in stack]
 phase='audit' if 'auditRemainingScopes' in names else 'startupNormalization' if 'normalizeScheduling' in names else 'outsideMeasuredMethods'
 phases[phase]+=delta;samplecounts[phase]+=1;selfs[phase][key(stack[0]['callFrame'])]+=delta
 for k in set(key(n['callFrame']) for n in stack):inclusive[phase][k]+=delta
 if phase=='audit':
  nms=[n['callFrame']['functionName'] or '(anonymous)' for n in reversed(stack) if '/packages/' in n['callFrame']['url']];chains[' → '.join(nms)]+=delta

def rows(counter,n=25,onlyProduct=False):
 result=[]
 for (name,url,line,col),us in counter.most_common():
  if onlyProduct and '/packages/' not in url:continue
  result.append({'function':name or '(anonymous)','url':url,'profilerLine0':line,'profilerColumn0':col,'sampledMs':us/1000})
  if len(result)>=n:break
 return result
report={'profile':p.name,'profileSha256':hashlib.sha256(p.read_bytes()).hexdigest(),'samplingIntervalRequestedUs':1000,'profileDurationMs':(c['endTime']-c['startTime'])/1000,'sampledDurationMs':sum(c['timeDeltas'])/1000,'samples':len(c['samples']),'phaseSampledMs':{k:v/1000 for k,v in phases.items()},'phaseSampleCounts':dict(samplecounts),'methods':{phase:{'selfTop':rows(selfs[phase]),'productInclusiveTop':rows(inclusive[phase],30,True)} for phase in ['startupNormalization','audit']},'auditProductStacksTop':[{'stack':k,'sampledMs':v/1000} for k,v in chains.most_common(20)],'limits':['One sampled diagnostic process with startup and three carried-state audit calls; excluded from performance aggregates.','Phase classification uses auditRemainingScopes / normalizeScheduling ancestors, not production instrumentation. Audit phases are aggregated here; no claim of exact per-call counts from sampled stacks.','Inclusive times overlap and must not be summed. Native work inherits its sampled JS ancestry; GC/other samples without these ancestors stay outside.','Profiler source lines are raw V8 coordinates after TSX transformation, not asserted TypeScript line mappings.','Whole-process parse/import/report/JSON-byte serialization dominate other samples but are excluded from method categories.']}
(out/'hotspots.json').write_text(json.dumps(report,indent=2)+'\n');import shutil;shutil.copy2(__file__,out/'analyze-profile.py');print(json.dumps({'phaseMs':report['phaseSampledMs'],'auditInclusiveTop':report['methods']['audit']['productInclusiveTop'][:14],'startupInclusiveTop':report['methods']['startupNormalization']['productInclusiveTop'][:8],'stacks':report['auditProductStacksTop'][:8]},indent=2))
