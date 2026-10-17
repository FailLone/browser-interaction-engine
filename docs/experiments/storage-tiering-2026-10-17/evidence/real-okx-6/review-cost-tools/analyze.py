"""Analyze extract.py material. No DB/SDK calls; diagnostic normalization grants nothing."""
import collections,datetime,hashlib,json,pathlib,re,sys
p=pathlib.Path(sys.argv[1]);allruns=json.loads((p/'material.json').read_text());sha=lambda b:hashlib.sha256(b).hexdigest();compact=lambda v:json.dumps(v,sort_keys=True,ensure_ascii=False,separators=(',',':')).encode();dig=lambda v:sha(compact(v));dt=lambda x:datetime.datetime.fromisoformat(x.replace('Z','+00:00')).timestamp()*1000
instance=re.compile(r'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:(\d+)$')
def norm(v):
 if isinstance(v,str):
  m=instance.fullmatch(v);return 'capture-node:'+m[1] if m else v
 if isinstance(v,list):return [norm(x) for x in v]
 if isinstance(v,dict):return {k:norm(x) for k,x in v.items() if k!='observationId'}
 return v
def changes(a,b,path=''):
 if type(a)!=type(b):return [path]
 if isinstance(a,dict):return [p for k in sorted(set(a)|set(b)) for p in ([path+'/'+k] if k not in a or k not in b else changes(a[k],b[k],path+'/'+k))]
 if isinstance(a,list):return [path+'/length'] if len(a)!=len(b) else [p for i,(x,y) in enumerate(zip(a,b)) for p in changes(x,y,path+'/'+str(i))]
 return [] if a==b else [path]
def material(d):return d['request']['state'].get('material',d['request']['state'])
result={'format':'okx-run6-review-cost-v1','input':json.loads((p/'inputs.json').read_text()),'runs':{},'regionPairs':[]}
for n,r in allruns.items():
 ret={e['data']['requestId']:e for e in r['metrics'] if e['type']=='provider.returned'};stats={};rows=[]
 for d in r['decisions']:
  purpose=d['purpose'];m=material(d);returned=ret[d['request']['id']];elapsed=returned['data']['elapsedMs'];u=d['answer'].get('usage',{});s=stats.setdefault(purpose,{'calls':0,'elapsedMs':0,'inputTokens':0,'outputTokens':0,'cost':0});s['calls']+=1;s['elapsedMs']+=elapsed;s['inputTokens']+=u.get('input_tokens',0);s['outputTokens']+=u.get('output_tokens',0);s['cost']+=u.get('cost',0)
  target=m.get('candidate') or m.get('control');current=m.get('current');row={'decisionId':d['id'],'requestId':d['request']['id'],'purpose':purpose,'observationId':d['observationId'],'startedAt':d['startedAt'],'returnedAt':returned['at'],'elapsedMs':elapsed,'inputTokens':u.get('input_tokens',0),'materialSha256':dig(m),'capturePrefixNormalizedMaterialSha256':dig(norm(m)),'answer':d['answer']['value'],'resolution':d['resolution'],'status':d['status']}
  if target:row.update({'targetName':target.get('name') or target.get('label'),'selector':target.get('selector'),'localId':target.get('localId'),'candidateId':target.get('id'),'controlCount':len(m.get('controls',[]))})
  elif current:row['targetControls']=[{k:x.get(k) for k in ['localId','name','role','tag','selector','identityId','hypothesisId']} for x in current];row['candidateIdentities']=len(m.get('candidates',[]));row['blockedOptions']=d['request'].get('blockedOptions',[])
  rows.append(row)
 regionEvents=[e for e in r['engineEvents'] if e['type']=='region.reviewed'];batches=[]
 for e in regionEvents:
  v=e['json'];assigned=[d for d in rows if 'explorer-decision:'+d['decisionId'] in v['evidence']];o=r['observations'][v['observationId']];batches.append({'at':e['at'],'reviewId':v['id'],'observationId':v['observationId'],'instanceScope':v['instanceScope'],'decisionIds':[d['decisionId'] for d in assigned],'newDecisions':len(assigned),'totalRegions':len(v['regions']),'baseReviewId':v.get('baseReviewId'),'regionReuseContracts':sum(bool(x.get('reuse')) for x in v['regions']),'providerElapsedMs':sum(d['elapsedMs'] for d in assigned),'firstProviderToRecordMs':dt(e['at'])-dt(assigned[0]['startedAt']) if assigned else None,'lastProviderToRecordMs':dt(e['at'])-dt(assigned[-1]['returnedAt']) if assigned else None})
 invalid=[{'at':e['at'],'type':e['type'],'data':e['json']} for e in r['engineEvents'] if e['type'] in ['region.review_invalidated','control.classification_invalidated']]
 result['runs'][n]={'purposeTotals':stats,'calls':rows,'batches':batches,'invalidations':invalid,'classificationReuse':[e for e in r['events'] if e['type']=='classification.reused'],'regionReviewRecords':len(r['entities']['region-review']),'regionRecordsWithReuse':sum(any(x.get('reuse') for x in rr['regions']) for rr in r['entities']['region-review']),'sessionExecutionPolicy':r['entities']['session'][0]['options']['executionPolicy'],'summary':{k:r['summary'].get(k) for k in ['runId','providerCounts','windowBudget','diskAfterClose']}}
old=[d for d in allruns['4']['decisions'] if d['purpose']=='region-review']
for d in [d for d in allruns['6']['decisions'] if d['purpose']=='region-review']:
 m=material(d);prior=[x for x in old if material(x)['candidate']['selector']==m['candidate']['selector'] and material(x)['candidate']['label']==m['candidate']['label']];assert len(prior)==1;before=prior[0];a=material(before);oa=allruns['4']['observations'][before['observationId']];ob=allruns['6']['observations'][d['observationId']];ca=next(x for x in oa['regionCandidates'] if x['id']==a['candidate']['id']);cb=next(x for x in ob['regionCandidates'] if x['id']==m['candidate']['id']);diff=changes(norm(a),norm(m));result['regionPairs'].append({'run4DecisionId':before['id'],'run6DecisionId':d['id'],'label':m['candidate']['label'],'selector':m['candidate']['selector'],'exactMaterialEqual':a==m,'capturePrefixNormalizedEqual':norm(a)==norm(m),'normalizedChangedPaths':diff,'selectedControlFactsEqual':[{k:v for k,v in x.items() if k!='localId'} for x in a['controls']]==[{k:v for k,v in x.items() if k!='localId'} for x in m['controls']],'structureEqual':a['candidate']['structure']==m['candidate']['structure'],'selectedControls':[len(a['controls']),len(m['controls'])],'rawBindingEqual':ca['binding']==cb['binding'],'prefixNormalizedBindingEqual':norm(ca['binding'])==norm(cb['binding']),'reuseBindingPresent':[bool(ca.get('reuseBinding')),bool(cb.get('reuseBinding'))],'reuseBindingEqual':bool(ca.get('reuseBinding')) and ca.get('reuseBinding')==cb.get('reuseBinding'),'reuseBindingChangedPaths':changes(ca.get('reuseBinding'),cb.get('reuseBinding'))})
for n in ['4','6']:
 r=allruns[n];ev=[e for e in r['engineEvents'] if e['type']=='exploration.group_invalidated'];result['runs'][n]['groupInvalidationReasons']=dict(collections.Counter(e['json'].get('reason') for e in ev));result['runs'][n]['pageObservationIds']=[d['observationId'] for d in result['runs'][n]['calls'] if d['purpose']=='region-review' and d['targetName']!='div 容器']
result['comparisonLimits']=['Normalization removes observationId and only UUID:node capture prefixes; it is a diagnostic, never SDK identity/correspondence/coverage authority.','Region matching uses selector+label to locate comparison pairs; actual applicability is governed by SDK captured bindings and explicit reuse provenance.','Engine event timestamps bound mixed capture/projection/persistence work; they are not CPU phase timers. No benchmark performed.']
(p/'analysis.json').write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n')
print(json.dumps({'purposes':{n:v['purposeTotals'] for n,v in result['runs'].items()},'pairs':[{k:x[k] for k in ['label','selectedControls','capturePrefixNormalizedEqual','structureEqual','selectedControlFactsEqual','reuseBindingEqual','normalizedChangedPaths','reuseBindingChangedPaths']} for x in result['regionPairs']],'batches':result['runs']['6']['batches'],'groupInvalidationReasons':{n:r['groupInvalidationReasons'] for n,r in result['runs'].items()}},ensure_ascii=False,indent=2))
