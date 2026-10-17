#!/usr/bin/env python3
"""Retain full field/event differences and produce a behavior-only report."""
import collections,difflib,gzip,hashlib,json,pathlib
HERE=pathlib.Path(__file__).resolve().parent
def load(name):return json.loads((HERE/name).read_text())
def sha(path):return hashlib.sha256(path.read_bytes()).hexdigest()
def write(path,value):path.write_text(json.dumps(value,ensure_ascii=False,indent=2)+'\n')
def text(value):return json.dumps(value,ensure_ascii=False,separators=(',',':'))
def escaped(value):return str(value).replace('~','~0').replace('/','~1')
def diff(a,b,path=''):
 if a==b:return []
 if isinstance(a,dict) and isinstance(b,dict):
  out=[]
  for key in sorted(a.keys()|b.keys()):
   p=path+'/'+escaped(key)
   if key not in a:out.append({'path':p,'beforePresent':False,'afterPresent':True,'after':b[key]})
   elif key not in b:out.append({'path':p,'beforePresent':True,'before':a[key],'afterPresent':False})
   else:out.extend(diff(a[key],b[key],p))
  return out
 if isinstance(a,list) and isinstance(b,list) and len(a)==len(b):
  return [row for index,(aa,bb) in enumerate(zip(a,b)) for row in diff(aa,bb,path+'/'+str(index))]
 return [{'path':path,'beforePresent':True,'before':a,'afterPresent':True,'after':b}]
setup=load('setup.json');execution=load('execution.json');proof=load('event-basis.json')
a=json.loads(gzip.decompress((HERE/'baseline-semantic.json.gz').read_bytes()));b=json.loads(gzip.decompress((HERE/'current-semantic.json.gz').read_bytes()))
assert a['input']==b['input'] and b['selected'] is None
assert proof['everyNewDeferHasIndependentBasis'] and proof['readBoundary']['totalChanges']==0
initial=b['input'];assert len(initial['plan'])==803
for key in ['plan','rounds','routeRetries','pendingDispatch','unverifiedRecoveries']:
 assert (key in initial)==(key in b['task']) and initial.get(key)==b['task'].get(key),key
oldRoutes=initial.get('scheduling',{}).get('routes',{})
assert b['task']['scheduling']['routes']==oldRoutes
assert all(a['task']['scheduling']['routes'].get(key)==value for key,value in oldRoutes.items())
assert set(a['task']['scheduling']['routes'])-set(oldRoutes)=={a['selected']['routeKey']}
assert a['events'][:269]==b['events'][:269]
taskDiff=diff(a['task'],b['task'],'/task');fromInput=diff(initial,b['task'],'/task')
assert all(row['path'].startswith('/task/scheduling/deferred/') for row in fromInput),'Unexpected non-defer mutation'
eventDiff=[]
keys=lambda events:[json.dumps(event,sort_keys=True,ensure_ascii=False,separators=(',',':')) for event in events]
for op,i,j,k,l in difflib.SequenceMatcher(a=keys(a['events']),b=keys(b['events']),autojunk=False).get_opcodes():
 eventDiff.append({'operation':op,'baselineRange':[i,j],'currentRange':[k,l],**({} if op=='equal' else {'before':a['events'][i:j],'after':b['events'][k:l]})})
full={'policy':'Complete JSON differences. No ignored keys or business-field normalization. Full selected and ordered event payloads retained; equal ranges refer to complete semantic archives.','inputEqual':True,'selectedDiff':diff(a['selected'],b['selected'],'/selected'),'taskDiff':taskDiff,'taskChangesFromInput':fromInput,'orderedEventDiff':eventDiff}
with (HERE/'full-diff.json.gz').open('wb') as raw,gzip.GzipFile(fileobj=raw,mode='wb',mtime=0) as out:out.write(text(full).encode())
reasons=dict(collections.Counter(r['event']['data']['reason'] for r in proof['newEvents']))
debt=initial.get('routeRetries',{});routeRows=list(debt.get('routes',{}).values());conditions=[c for r in routeRows for c in r.get('conditions',{}).values()]
inventory={'planOccurrences':len(initial['plan']),'distinctBusinessIds':len({r['id'] for r in initial['plan']}),'planAttemptUnknowns':sum(x.get('outcome')=='unknown' for i in initial['plan'] for x in i.get('attempts',[])),'pendingDispatchPresent':'pendingDispatch' in initial,'unverifiedRecoveryRows':len(initial.get('unverifiedRecoveries',[])),'retryRoutes':len(routeRows),'unknownRetryRoutes':sum(bool(r.get('unknown')) for r in routeRows),'retryConditionOutcomes':dict(collections.Counter(c.get('outcome') for c in conditions)),'oldScheduledRouteBindings':len(oldRoutes)}
changedEvents=[r for r in eventDiff if r['operation']!='equal'];summary={'baselineRevision':setup['baselineRevision'],'currentRevision':setup['currentRevision'],'noPerformanceComparison':True,'baselineChoice':proof['baselineSelected']['choice'],'currentChoice':None,'restorationExecuted':False,'recoverySucceeded':False,'inputInventory':inventory,'preservation':{'inputEqual':True,'full803PlanEqual':True,'planArrayOrderEqual':True,'roundsEqual':True,'oldRetryLedgerEqual':True,'unknownFieldsPresenceAndValuesEqual':True,'oldScheduledRouteBindingsRetained':True,'onlyDeferredChangedFromInput':True},'events':{'baseline':len(a['events']),'current':len(b['events']),'newOrChanged':len(proof['newEvents']),'newOrChangedReasons':reasons,'orderedDiff':changedEvents},'taskDiff':taskDiff,'newDefersAllIndependentlyExplained':True,'semanticFiles':{name:{'storedBytes':(HERE/name).stat().st_size,'storedSha256':sha(HERE/name),'logicalBytes':len(gzip.decompress((HERE/name).read_bytes())),'logicalSha256':hashlib.sha256(gzip.decompress((HERE/name).read_bytes())).hexdigest()} for name in ['baseline-semantic.json.gz','current-semantic.json.gz','full-diff.json.gz']},'limits':['Terminal-task counterfactual; actual live pre-selection state cannot be exactly reconstructed.','Baseline selected53cc4e09 differs from live selected35a22c35 because final failed-route debt is retained.','No alternative route was selected. This is not a successful recovery or a claim of scope exhaustion.','Real selected sources here have no active boundary; actual hidden targets are evidenced, while background-boundary behavior is covered by dedicated tests.','No active unknown dispatch exists in this fixed input; exact unknown fields and old failure ledger remain unchanged. Separate unknown-debt tests cover nonempty unknown execution debt.','Raw worker retains its inherited performance-protocol description/timing fields; this experiment adds only one e06 process and does not compare performance.']}
write(HERE/'summary.json',summary)
lines=['# Run7 retained review-source counterfactual','',
'The visibility gate prevents the prior hidden review destination from being selected. **The new result is no selected route, not a successful recovery.** One `e06f057` read-only selector process reused the completed `875ce50` baseline’s full semantic output and the identical fixed input and worker. No browser, provider, navigation or execution ran.','',
'## Exact scope of the comparison','',
'This is the terminal run7 task with all 803 ordered plan occurrences and final failed-route debt retained, paired with the earlier observed current frame. The prior documented fixture changes only the scheduler cursor to the actual earlier selection and clears its deferred-reason cache. It cannot reconstruct the exact live pre-selection task.','',
'The pure-performance baseline actually selected item `53cc4e09-7c99-43e6-bb57-272e46dbc6b3`, route `384664f26110b4b21e407321678506726127c64e8239f83730d8beaa547b5001`, checkpoint `b1e80845-ab4f-4c31-809d-ba37be180e92`, source `5f80a3df-8355-444a-8499-4a625cb89577`. The original live selection was item `35a22c35-fa78-47fb-8681-2ac3250539cd`; those are not interchangeable. Its later failure was never deleted to force a replay.','',
'`e06f057ecc1fd43feaa8cfa42d14c65e9750a08e` differs from `875ce5019751c8222df23cba00a63a1ddc1c29c9` by the source-review visibility gate and its tests. The complete result changed to null. No replacement route or restoration success is inferred. Changed work means this is a behavior comparison, not a performance comparison; raw legacy worker timing fields are retained without ratios.','',
'## Source evidence and additional deferrals','',
'Both blocked review obligations point to the same retained source. Its context/URL/gap gates pass, but the exact production control-scope matcher finds only hidden controls:','',
'| Obligation | Matched source localId suffixes | Visible | Enabled |','|---|---|---|---|',
'| `35a22c35…`, Open sub-menu review | `:1491`, `:1497` | false, false | true, true |',
'| `53cc4e09…`, bound link review | `:1496`, `:1499` | false, false | true, true |','',
'All four belong to document/instance prefix `87b91bd6-ee8a-4d8e-9567-574f45b28a78`. The source has no active boundary. This real sample directly verifies hidden-target rejection; background/innermost-boundary cases remain covered by `tests/explorer-review-source-visibility.test.ts`, rather than claimed as real-run observations. Ambiguous visible review material would remain reviewable and would not gain action permission.','',
'Events change from 270 to 282. The first 269 events are unchanged in order; the old last defer is replaced and twelve later defers are added, producing thirteen new or changed payloads. Each has independent retained-material support:','',
'| Reason | Count | Checked basis |','|---|---:|---|',
'| source_review_target_not_available | 2 | The exact source matches above are all hidden. |',
'| current_review_occurrence_present | 1 | Five visible, enabled current controls match by exact scope and/or SDK retained-control transition. |',
'| source_target_unverified | 9 | Each has exactly one filtered action at the retained source, but production browserTargetConditions returns undefined. Visibility alone does not authorize recovery. |',
'| unchanged_unresolved_review | 1 | The production wait validator confirms the stored unresolved review still matches its source material. |','',
'`event-basis.json` retains every full event and plan item plus exact matched controls/actions, conditions, current-presence mappings and wait proof. The proof reader used three retained observations from the same private read-only copy, invoked no selector a second time and constructed no engine or store. SQLite query_only was enabled and total_changes remained zero.','',
'## Complete state differences and retained debt','',
f"All **803 plan occurrences**, array order and complete rounds are unchanged. The entire original retry ledger is identical: **{inventory['retryRoutes']} routes**, outcomes {inventory['retryConditionOutcomes']}. All **{inventory['oldScheduledRouteBindings']}** pre-existing scheduled-route bindings remain equal. Pending/unknown field presence and values are unchanged.",'',
f"This input contains {inventory['planAttemptUnknowns']} unknown plan attempts, {inventory['unknownRetryRoutes']} unknown retry-route flags and {inventory['unverifiedRecoveryRows']} unverified-recovery rows; pendingDispatch present = {inventory['pendingDispatchPresent']}. It is not a new nonempty-unknown execution test.",'',
'Relative to the original fixed input, only scheduling.deferred changes. Relative to the baseline result, the following exact paths differ (complete before/after values, including the full selected object, are retained in full-diff.json.gz):','']
lines += ['- `'+r['path']+'`' for r in taskDiff]
lines += ['','The omitted baseline route binding was created by that baseline selection and was absent from the input. No old route failure, source reference, attempt, review wait or plan entry was erased. Ordered event opcodes and full differing event payloads are stored in the diff; no fields are ignored to declare equivalence.','',
'## Integrity and reproduction','',
'The baseline full semantic archive is copied from source-material-isolation/pair-1-current. Its three completed `875ce50` samples agreed before reuse. The new run uses a complete Git archive of e06 and the exact same worker bytes; source/input/private-copy/frozen-database hashes all remained unchanged. Both complete semantic results and the complete difference are retained losslessly as gzip. No temporary DB or large material export is committed.','',
'Run `runner.py --run` only in a new empty evidence directory after the prerequisite source-material-isolation experiment finishes. It creates one independent archive and one read-only worker. Then invoke explain.ts with Node24/tsx from that archive and this evidence directory as its argument, followed by `python3 -B finalize.py`. setup.json and the execution records retain exact paths, commands and source hashes. The archived worker’s inherited “three pairs” description belongs to its source protocol; this wrapper explicitly ran one new behavior process.','',
'These results justify rejecting this unavailable retained review source. They do not establish a navigation path that reveals it, erase the unresolved work, weaken SDK target conditions, or declare the exploration complete.','']
(HERE/'README.md').write_text('\n'.join(lines))
manifest=[{'path':str(p.relative_to(HERE)),'bytes':p.stat().st_size,'sha256':sha(p)} for p in sorted(HERE.rglob('*')) if p.is_file() and p.name!='artifact-manifest.json'];write(HERE/'artifact-manifest.json',manifest)
print(json.dumps({'taskDiffPaths':[r['path'] for r in taskDiff],'inputInventory':inventory,'reportSha256':sha(HERE/'README.md'),'summarySha256':sha(HERE/'summary.json'),'manifestSha256':sha(HERE/'artifact-manifest.json'),'files':len(manifest)+1,'bytes':sum(r['bytes'] for r in manifest)+(HERE/'artifact-manifest.json').stat().st_size},ensure_ascii=False))
