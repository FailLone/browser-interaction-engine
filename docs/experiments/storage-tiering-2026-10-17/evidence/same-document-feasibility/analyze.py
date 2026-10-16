"""Small frozen-frame feasibility read. No SDK/browser/provider and no DB writes.
All DB queries use an immutable readonly connection to a private temporary copy.
The comparison below is a diagnostic proposal, NOT an SDK correspondence proof.
"""
import collections, copy, gzip, hashlib, json, pathlib, shutil, sqlite3, subprocess, tempfile

root=pathlib.Path(__file__).resolve().parents[5]
out=pathlib.Path(__file__).parent
frozen=root/'.data/okx-storage-acceptance-20261017-v1-frozen-4/engine/engine.sqlite'
archive=pathlib.Path('/tmp/okx-run4-unkeyed-9TLnw4/selected.json')
sha=lambda b:hashlib.sha256(b).hexdigest()
encoded=lambda v:json.dumps(v,ensure_ascii=False,sort_keys=True,separators=(',',':'))
source_paths=['packages/adapter-playwright/src/branch-conditions.ts','packages/adapter-playwright/src/exploration.ts','packages/adapter-playwright/src/target-arrival.ts','packages/core/src/engine.ts','packages/browser/src/index.ts']
source_hashes={p:sha((root/p).read_bytes()) for p in source_paths}
input_hash=sha(frozen.read_bytes());archive_hash=sha(archive.read_bytes())
known=json.loads(archive.read_text());observations={r['observation']['id']:r['observation'] for r in known}
ids=['5f80a3df-8355-444a-8499-4a625cb89577','c446073e-8db5-49cd-b6d3-0052622bb861','f6c6f3c2-9550-40d2-b4f0-8b39c38fe6a4','d0b567f7-791f-49b5-9a0d-80a6cd81ed35','9ca9a659-c1af-47c6-af1c-40b77b5803a3','c4fae20b-a313-48bb-a1f6-22f793550193']
checks=collections.Counter()
with tempfile.TemporaryDirectory(prefix='okx-same-document-') as temp:
 db=pathlib.Path(temp)/'engine.sqlite';shutil.copyfile(frozen,db)
 c=sqlite3.connect(db.as_uri()+'?mode=ro&immutable=1',uri=True);c.row_factory=sqlite3.Row;c.execute('pragma query_only=on')
 packs={};objects={}
 def decode(id):
  r=c.execute("select * from entities where kind='observation' and id=?",(id,)).fetchone();m=json.loads(r['json']);h=m.get('$interactionStorage')
  if not h:b=r['json'].encode()
  elif h['version']==1:b=gzip.decompress(r['compressed_json'])
  else:
   layout=gzip.decompress(r['compressed_json']);assert len(layout)==h['layoutBytes'] and sha(layout)==h['layoutSha256'];buf=[]
   for p in json.loads(layout):
    if isinstance(p,str):buf.append(p.encode());continue
    if p not in objects:
     obj=c.execute('select * from observation_objects where id=?',(p,)).fetchone();assert obj['session_id']==r['session_id']==h['sessionId']
     if obj['pack_id'] not in packs:
      pack=c.execute('select * from observation_packs where id=?',(obj['pack_id'],)).fetchone();assert pack['session_id']==r['session_id'];data=gzip.decompress(pack['data']) if pack['codec']=='gzip' else pack['data'];assert len(data)==pack['bytes'] and sha(data)==pack['sha256'].hex();packs[pack['id']]=data;checks['packHashes']+=1
     b=packs[obj['pack_id']][obj['byte_offset']:obj['byte_offset']+obj['bytes']];assert sha(b)==obj['sha256'].hex() and len(b)==obj['bytes'];objects[p]=b;checks['objectHashes']+=1
    buf.append(objects[p])
   b=b''.join(buf);checks['layoutHashes']+=1
  if h:assert len(b)==h['bytes'] and sha(b)==h['sha256'];checks['observationHashes']+=1
  v=json.loads(b);assert v['id']==id and v['sessionId']==r['session_id'];return v
 for id in ids:
  if id not in observations:observations[id]=decode(id)
 placeholders=','.join('?' for _ in ids)
 rows=c.execute("select json,compressed_json from entities where kind='action' and json_extract(json,'$.observationId') in ("+placeholders+")",ids).fetchall()
 actions=collections.defaultdict(list)
 for row in rows:
  assert row['compressed_json'] is None
  a=json.loads(row['json']);actions[a['observationId']].append(a)
 c.close()

# Captured semantic bindings deliberately include parent/form/record/owner and
# review attributes. Same instance IDs alone cannot hide business rebinding.
semantic_fields=['tag','role','name','label','stableKey','region','regionInstanceId','form','formOwner','identityContext','reviewBinding','purposeBinding','reviewAttributes','reviewReuseBinding','classificationBinding','structuralItem','list','readOnly','constraints','options','actions','actionBasis','interactionHints']
def semantic(c):return {k:c[k] for k in semantic_fields if k in c}
def diff_fields(a,b):return [k for k in sorted(set(a)|set(b)) if a.get(k)!=b.get(k)]
def selector_state(c,selections):
 state={}
 if c.get('checked') is not None:state['checked']=c['checked']
 elif c['role'] in ['checkbox','radio','switch']:return None
 if c.get('pressed') is not None:state['pressed']=c['pressed']
 if c.get('expanded') is not None:state['expanded']=c['expanded']
 if c['tag']=='select':state['selected']=sorted(c['selected'])
 elif c['role'] in ['tab','option','treeitem']:
  if c['selected']:state['selected']=True
  elif c['localId'] in selections:state['selected']=selections[c['localId']]
  elif c['role'] in ['tab','option']:return None
 return state or False
def selectors(o):
 selections={m['localId']:m['selected'] for component in o.get('components',[]) for m in component['members'] if isinstance(m.get('selected'),bool)}
 result=[]
 for c in o['controls']:
  state=selector_state(c,selections)
  if state is not False:result.append((c,state))
 return result
def slim(c):return {'instanceId':c.get('instanceId'),'localId':c['localId'],'name':c['name'],'role':c['role'],'visible':c['visible'],'identityScope':c.get('identityScope'),'hypothesisId':c.get('hypothesisId')}
def compare(before,after):
 reasons=[];bo=observations[before];ao=observations[after]
 for field in ['sessionId','instanceScope','documentId','url','ruleVersion','context']:
  if bo.get(field)!=ao.get(field):reasons.append(field+'_changed')
 for field in ['instanceScope','documentId']:
  if not bo.get(field) or not ao.get(field):reasons.append(field+'_missing')
 if bo.get('navigation',{}).get('browserSessionId')!=ao.get('navigation',{}).get('browserSessionId'):reasons.append('browser_session_changed')
 if not bo.get('navigation',{}).get('browserSessionId') or not ao.get('navigation',{}).get('browserSessionId'):reasons.append('browser_session_missing')
 if any(g.get('critical') for o in [bo,ao] for g in o['gaps']):reasons.append('critical_capture_gap')
 if any(v['status']!='known' for o in [bo,ao] for v in o['context'].values()):reasons.append('unknown_context')
 if not bo['stable'] or not ao['stable']:reasons.append('observation_unstable')
 if bo.get('boundaries',[])!=ao.get('boundaries',[]):reasons.append('boundary_changed')
 bc=collections.Counter(c.get('instanceId') for c in bo['controls']);ac=collections.Counter(c.get('instanceId') for c in ao['controls'])
 bs=selectors(bo);ass=selectors(ao);bm={c['instanceId']:(c,s) for c,s in bs};am={c['instanceId']:(c,s) for c,s in ass}
 selector_changes=[]
 if len(bs)>32 or len(ass)>32:reasons.append('selector_overflow')
 for instance in sorted(set(bm)|set(am)):
  b=bm.get(instance);a=am.get(instance);rs=[];changed=[]
  if not b:rs.append('selector_added')
  if not a:rs.append('selector_removed')
  if b and a:
   if not instance or bc[instance]!=1 or ac[instance]!=1:rs.append('selector_instance_not_unique')
   if b[1] is None or a[1] is None:rs.append('selector_state_unknown')
   if b[1]!=a[1]:rs.append('selector_state_changed')
   changed=diff_fields(semantic(b[0]),semantic(a[0]))
   if changed:rs.append('selector_semantics_changed')
   if b[0].get('readiness') or a[0].get('readiness'):rs.append('selector_unstable')
  if rs:selector_changes.append({'instanceId':instance,'before':slim(b[0]) if b else None,'after':slim(a[0]) if a else None,'reasons':rs,'semanticFields':changed,'beforeState':b[1] if b else None,'afterState':a[1] if a else None})
 if selector_changes:reasons+=sorted({r for d in selector_changes for r in d['reasons']})
 # Full component evidence except viewport geometry, so a changed declared
 # relationship cannot disappear merely because selector IDs stay constant.
 components=lambda o:[{k:v for k,v in x.items() if k!='rect'} for x in o.get('components',[])]
 if components(bo)!=components(ao):reasons.append('component_evidence_changed')
 targets=[];after_controls={x['localId']:x for x in ao['controls']};before_controls={x['localId']:x for x in bo['controls']}
 for action in actions[before]:
  if action['kind']!='click' or action['label'] not in ['1W','Trade','1h','24h']:continue
  target=before_controls.get(action.get('localId'));matches=[]
  if target:matches=[a for a in actions[after] if a['kind']==action['kind'] and a.get('value')==action.get('value') and after_controls.get(a.get('localId'),{}).get('instanceId')==target['instanceId']]
  rs=[];semantic_changes=[];adiffs=[];readiness=[]
  if not target or bc[target['instanceId']]!=1 or ac[target['instanceId']]!=1:rs.append('target_instance_not_unique_or_missing')
  if len(matches)!=1:rs.append('target_action_not_unique_or_missing')
  if len(matches)==1:
   other=after_controls[matches[0]['localId']];semantic_changes=diff_fields(semantic(target),semantic(other))
   if semantic_changes:rs.append('target_semantics_changed')
   afields=['kind','value','risk','basis','replayable','sampleValidity','excluded','exclusionReason']
   adiffs=[k for k in afields if action.get(k)!=matches[0].get(k)]
   if adiffs:rs.append('operation_semantics_changed')
   readiness=[k for k in ['visible','enabled','editable','readiness','actionable'] if target.get(k)!=other.get(k)]
  targets.append({'label':action['label'],'sourceActionId':action['id'],'targetActionId':matches[0]['id'] if len(matches)==1 else None,'source':slim(target) if target else None,'matchingActions':len(matches),'reasons':rs,'semanticFields':semantic_changes,'operationFields':adiffs,'readinessDifferences':readiness,'potential':not reasons and not rs})
 return {'beforeId':before,'afterId':after,'globalReasons':sorted(set(reasons)),'selectorCounts':{'before':len(bs),'after':len(ass),'matchedInstances':len(set(bm)&set(am)),'uniqueMatchedInstances':sum(bc[x]==1 and ac[x]==1 for x in set(bm)&set(am)),'hiddenBefore':sum(not c['visible'] for c,s in bs),'hiddenAfter':sum(not c['visible'] for c,s in ass),'nonportableBefore':sum(bool(c.get('hypothesisId') or c.get('identityScope')=='instance' or c.get('structuralItem') and not c['structuralItem'].get('recordKey')) for c,s in bs),'nonportableAfter':sum(bool(c.get('hypothesisId') or c.get('identityScope')=='instance' or c.get('structuralItem') and not c['structuralItem'].get('recordKey')) for c,s in ass)},'selectorChangeCounts':dict(collections.Counter(r for d in selector_changes for r in d['reasons'])),'selectorChanges':selector_changes,'targets':targets,'potentialTargetCount':sum(t['potential'] for t in targets)}

pairs=[compare(ids[a],ids[b]) for a,b in [(0,1),(1,2),(2,3),(3,4),(0,3),(0,4),(4,5)]]
potential=[{'beforeId':p['beforeId'],'afterId':p['afterId'],'label':t['label'],'sourceActionId':t['sourceActionId'],'targetActionId':t['targetActionId']} for p in pairs for t in p['targets'] if t['potential']]
# Counterfactual diagnostic guard, explicitly not an additional real observation:
# preserve every instance ID but change a target business binding in memory.
counterfactual=None
if potential:
 p=potential[0];o=observations[p['afterId']];altered=copy.deepcopy(o);action=next(a for a in actions[o['id']] if a['id']==p['targetActionId']);target=next(c for c in altered['controls'] if c['localId']==action['localId']);target.setdefault('reviewBinding',{}).setdefault('attributes',{})['data-record-id']='counterfactual-other-business-record'
 observations[o['id']]=altered;changed=compare(p['beforeId'],p['afterId']);observations[o['id']]=o
 affected=next(t for t in changed['targets'] if t['sourceActionId']==p['sourceActionId']);assert not affected['potential'] and 'target_semantics_changed' in affected['reasons'];counterfactual={'scope':'in-memory negative control only; no source observation modified','change':'same DOM instance; reviewBinding.attributes.data-record-id changes','result':affected}
assert sha(frozen.read_bytes())==input_hash and sha(archive.read_bytes())==archive_hash
assert source_hashes=={p:sha((root/p).read_bytes()) for p in source_paths}
report={'protocol':'same-document-conditions-feasibility-v1','head':subprocess.check_output(['git','rev-parse','HEAD'],cwd=root,text=True).strip(),'sourceHashes':source_hashes,'frozenDatabaseSha256':input_hash,'archivedObservationsSha256':archive_hash,'integrity':{'originalDatabaseConnections':0,'privateCopyMode':'ro&immutable=1; query_only','productOrTestWrites':0,'browserCalls':0,'providerCalls':0,'networkCalls':0,'sourceAndInputHashesUnchanged':True,'decodedAdditionalFrames':2,'checks':dict(checks)},'method':{'scope':'Potential same-document source/audit continuation only; no SDK contract is implemented or validated','selectorPolicy':'All captured selectors including hidden/nonlocal; missing state/unique instance, unstable or >32 declines; no target starting-state exclusions because evaluated actions are clicks','semanticFields':semantic_fields,'componentPolicy':'Full captured component objects excluding rect','excludedComparisonFields':['volatile identityId/hypothesisId verdict IDs (reported as portability limits)','selector/target viewport rect','target preflight actionable/readiness (differences reported, grants nothing)'],'limits':['Uncaptured JavaScript state/free-text business dependencies still require declared context rules.','Capture retains noncritical structural/event-listener/canvas gaps; this is not proof of exhaustive document semantics.','Equality of this proposed projection is only feasibility evidence, not identity/execution/coverage/recovery authorization.']},'frames':[{'id':id,'sessionId':observations[id]['sessionId'],'instanceScope':observations[id]['instanceScope'],'documentId':observations[id].get('documentId'),'browserSessionId':observations[id].get('navigation',{}).get('browserSessionId'),'stable':observations[id]['stable'],'gaps':dict(collections.Counter(g['code'] for g in observations[id]['gaps'])),'controls':len(observations[id]['controls']),'actions':len(actions[id]),'selectorCount':len(selectors(observations[id]))} for id in ids],'pairs':pairs,'summary':{'pairs':len(pairs),'pairsWithPotential':sum(p['potentialTargetCount']>0 for p in pairs),'potentialTargetComparisons':len(potential),'globalReasonCounts':dict(collections.Counter(r for p in pairs for r in p['globalReasons'])),'targetReasonCounts':dict(collections.Counter(r for p in pairs for t in p['targets'] for r in t['reasons']))},'potential':potential,'sameInstanceBusinessRebindingCounterfactual':counterfactual,'authorizations':{'identity':False,'execution':False,'coverage':False,'recovery':False,'retryRelease':False}}
(out/'feasibility.json').write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n')
print(json.dumps({'summary':report['summary'],'potential':potential,'pairs':[{'before':p['beforeId'],'after':p['afterId'],'reasons':p['globalReasons'],'selectors':p['selectorCounts'],'selectorChanges':p['selectorChangeCounts'],'targets':[{k:t[k] for k in ['label','potential','reasons','semanticFields','operationFields','readinessDifferences']} for t in p['targets']]} for p in pairs]},ensure_ascii=False,indent=2))
