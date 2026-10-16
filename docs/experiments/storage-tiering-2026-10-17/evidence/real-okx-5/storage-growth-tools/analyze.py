import pathlib,sqlite3,json,hashlib,gzip,collections,datetime,statistics,subprocess
root=pathlib.Path('/Users/xietian/.codex/worktrees/exploration-layered-refactor/browser-interaction-engine');out=pathlib.Path(__file__).parent
sha=lambda b:hashlib.sha256(b).hexdigest();size=lambda x:len(x.encode()) if isinstance(x,str) else len(x or b'');compact=lambda v:json.dumps(v,ensure_ascii=False,separators=(',',':')).encode();D=json.JSONDecoder()
def fields(text):
 at=1;r={}
 while at<len(text)-1:
  if text[at]==',':at+=1
  key,end=D.raw_decode(text,at);at=end+1;_,end=D.raw_decode(text,at);r[key]=text[at:end].encode();at=end
 return r
def inventory(n):
 f=root/f'.data/okx-storage-acceptance-20261017-v1-frozen-{n}';m=root/f'docs/experiments/storage-tiering-2026-10-17/evidence/real-okx-{n}/frozen-snapshot.json';e=json.loads(m.read_text())['files'];a={str(p.relative_to(f)):{'bytes':p.stat().st_size,'sha256':sha(p.read_bytes())} for p in f.rglob('*') if p.is_file()};assert a==e
 return {'directory':str(f),'manifest':str(m),'manifestSha256':sha(m.read_bytes()),'files':a,'fileCount':len(a),'bytes':sum(v['bytes'] for v in a.values())}
def connect(n,name):
 p=root/f'.data/okx-storage-acceptance-20261017-v1-frozen-{n}'/name/('engine.sqlite' if name=='engine' else 'explorer.sqlite');c=sqlite3.connect(p.as_uri()+'?mode=ro&immutable=1',uri=True);c.row_factory=sqlite3.Row;c.execute('pragma query_only=on');return c
def allocation(c):
 tables={r['name']:dict(r) for r in c.execute('select name,count(*) pages,sum(pgsize) allocatedBytes,sum(payload) payloadBytes,sum(unused) unusedBytes from dbstat group by name')};ps=c.execute('pragma page_size').fetchone()[0];free=c.execute('pragma freelist_count').fetchone()[0];pages=c.execute('pragma page_count').fetchone()[0]
 return {'pageSize':ps,'pageCount':pages,'fileBytes':ps*pages,'freelistPages':free,'freelistBytes':free*ps,'payloadBytes':sum(r['payloadBytes'] for r in tables.values()),'allocatedUnusedBytes':sum(r['unusedBytes'] for r in tables.values()),'btreeOverheadBytes':sum(r['allocatedBytes']-r['payloadBytes']-r['unusedBytes'] for r in tables.values()),'tables':tables}
def delta(a,b):return {k:b.get(k,0)-a.get(k,0) for k in set(a)|set(b)}
before={n:inventory(n) for n in [4,5]};engines={};plugins={};rows={};events={};pevents={};obs={};objectrows={};packs={}
for n in [4,5]:
 c=connect(n,'engine');rows[n]={r['id']:dict(r) for r in c.execute('select * from entities')};events[n]={r['sequence']:dict(r) for r in c.execute('select * from events')};objectrows[n]={r['id']:dict(r) for r in c.execute('select * from observation_objects')};packs[n]={r['id']:dict(r) for r in c.execute('select * from observation_packs')};kinds={}
 for r in rows[n].values():
  k=kinds.setdefault(r['kind'],{'rows':0,'jsonBytes':0,'compressedBytes':0,'logicalBytes':0});k['rows']+=1;k['jsonBytes']+=size(r['json']);k['compressedBytes']+=size(r['compressed_json']);m=json.loads(r['json']);h=m.get('$interactionStorage');k['logicalBytes']+=h['bytes'] if h else size(r['json'])
 engines[n]={'allocation':allocation(c),'kinds':kinds,'eventRows':len(events[n]),'eventJsonBytes':sum(size(r['json']) for r in events[n].values()),'requestRows':c.execute('select count(*) from requests').fetchone()[0],'requestPayloadBytes':c.execute('select sum(length(cast(payload as blob))) from requests').fetchone()[0],'schemaVersion':c.execute("select value from metadata where key='schemaVersion'").fetchone()[0]};c.close()
 c=connect(n,'plugin');items=[dict(r) for r in c.execute('select * from task_items')];tasks=[dict(r) for r in c.execute('select * from tasks')];decisions=[dict(r) for r in c.execute('select * from decisions')];pevents[n]={r['sequence']:dict(r) for r in c.execute('select * from events')};pround=json.loads(next(r['json'] for r in items if r['kind']=='rounds'))
 plugins[n]={'allocation':allocation(c),'taskRows':len(tasks),'taskProjectionJsonBytes':sum(size(r['json']) for r in tasks),'taskPackedHeaderBytes':sum(size(r['header_data']) for r in tasks),'taskHeaderLogicalBytes':sum(r['header_size'] or size(r['json']) for r in tasks),'itemKinds':{k:{'rows':sum(r['kind']==k for r in items),'jsonBytes':sum(size(r['json']) for r in items if r['kind']==k),'packedRows':sum(r['kind']==k and r['chunk_id'] is not None for r in items)} for k in ['plan','rounds']},'chunkRows':c.execute('select count(*) from task_chunks').fetchone()[0],'chunkStoredBytes':c.execute('select coalesce(sum(length(data)),0) from task_chunks').fetchone()[0],'decisionRows':len(decisions),'decisionJsonBytes':sum(size(r['json']) for r in decisions),'eventRows':len(pevents[n]),'eventJsonBytes':sum(size(r['json']) for r in pevents[n].values()),'roundFields':{k:{'bytes':len(v),'count':len(pround[k]) if isinstance(pround[k],(list,dict)) else None} for k,v in fields(next(r['json'] for r in items if r['kind']=='rounds')).items()}}
 (out/f'plugin-header-{n}.json').write_text(json.dumps([{'id':r['id'],'json':r['json'],'content_hash':r['header_hash'],'raw_size':r['header_size'],'dataHex':r['header_data'].hex()} for r in tasks]));c.close()
entityGrowth={}
for kind in engines[5]['kinds']:
 a={i:r for i,r in rows[4].items() if r['kind']==kind};b={i:r for i,r in rows[5].items() if r['kind']==kind};new=set(b)-set(a);old=set(a)-set(b);common=set(a)&set(b);sz=lambda r:size(r['json'])+size(r['compressed_json'])
 entityGrowth[kind]={**delta(engines[4]['kinds'].get(kind,{}),engines[5]['kinds'][kind]),'rowsAdded':len(new),'rowsRemoved':len(old),'commonRowsChanged':sum(a[i]['json']!=b[i]['json'] or a[i]['compressed_json']!=b[i]['compressed_json'] for i in common),'addedStoredBytes':sum(sz(b[i]) for i in new),'removedStoredBytes':sum(sz(a[i]) for i in old),'commonStoredBytesDelta':sum(sz(b[i])-sz(a[i]) for i in common)}
 if kind in ['identity','action']:
  af=collections.Counter();bf=collections.Counter()
  for r in a.values():af.update({k:len(v) for k,v in fields(r['json']).items()})
  for r in b.values():bf.update({k:len(v) for k,v in fields(r['json']).items()})
  entityGrowth[kind]['fieldByteDeltas']=dict(sorted(delta(af,bf).items(),key=lambda x:-x[1]))
newobs=[i for i,r in rows[5].items() if r['kind']=='observation' and i not in rows[4]];newrefs=collections.Counter();allrefs=collections.Counter();decodedpacks={};decodechecks=collections.Counter()
def decodepack(id):
 if id not in decodedpacks:
  p=packs[5][id];b=gzip.decompress(p['data']) if p['codec']=='gzip' else p['data'];assert len(b)==p['bytes'] and sha(b)==p['sha256'].hex();decodedpacks[id]=b;decodechecks['packs']+=1
 return decodedpacks[id]
for i,r in rows[5].items():
 if r['kind']!='observation':continue
 m=json.loads(r['json']);h=m.get('$interactionStorage');refs=[]
 if h and h['version']==2:
  layout=gzip.decompress(r['compressed_json']);assert len(layout)==h['layoutBytes'] and sha(layout)==h['layoutSha256'];parts=json.loads(layout);refs=[p for p in parts if isinstance(p,int)];allrefs.update(refs)
  if i not in newobs:continue
  newrefs.update(refs);pieces=[]
  for p in parts:
   if isinstance(p,str):pieces.append(p.encode());continue
   obj=objectrows[5][p];pack=packs[5][obj['pack_id']];assert obj['session_id']==pack['session_id']==r['session_id']==h['sessionId'];b=decodepack(obj['pack_id'])[obj['byte_offset']:obj['byte_offset']+obj['bytes']];assert len(b)==obj['bytes'] and sha(b)==obj['sha256'].hex();pieces.append(b);decodechecks['objectReferences']+=1
  b=b''.join(pieces);decodechecks['layouts']+=1
 elif i not in newobs:continue
 elif h:b=gzip.decompress(r['compressed_json'])
 else:b=r['json'].encode()
 if h:assert len(b)==h['bytes'] and sha(b)==h['sha256']
 v=json.loads(b);assert v['id']==r['id'] and v['sessionId']==r['session_id'];obs[i]={'value':v,'raw':b};decodechecks['observations']+=1
oldobj=set(objectrows[4]);newobj=set(objectrows[5])-oldobj;newpack=set(packs[5])-set(packs[4]);oldstate={i for i,r in rows[4].items() if r['kind']=='state'}
obgrowth={'newObservationIds':newobs,'newObservationCount':len(newobs),'newLogicalBytes':sum(len(v['raw']) for v in obs.values()),'newRowStoredBytes':entityGrowth['observation']['addedStoredBytes'],'newObjectRows':len(newobj),'newObjectLogicalBytes':sum(objectrows[5][i]['bytes'] for i in newobj),'newPackRows':len(newpack),'newPackStoredBytes':sum(size(packs[5][i]['data']) for i in newpack),'newPackCodecs':dict(collections.Counter(packs[5][i]['codec'] for i in newpack)),'newReferenceOccurrences':sum(newrefs.values()),'newReferenceBytes':sum(objectrows[5][i]['bytes']*count for i,count in newrefs.items()),'referencesToPriorObjects':sum(v for i,v in newrefs.items() if i in oldobj),'bytesReferencedFromPriorObjects':sum(objectrows[5][i]['bytes']*v for i,v in newrefs.items() if i in oldobj),'distinctPriorObjectsReused':len(set(newrefs)&oldobj),'newObservationsUsingPreviousStateIds':sum(v['value']['stateId'] in oldstate for v in obs.values()),'oldObservationRowsUnchanged':all(rows[4][i]==r for i,r in rows[5].items() if r['kind']=='observation' and i in rows[4]),'oldObjectRowsUnchanged':all(objectrows[4][i]==objectrows[5][i] for i in oldobj),'oldPacksUnchanged':all(packs[4][i]==packs[5][i] for i in packs[4]),'orphanObjects':len(set(objectrows[5])-set(allrefs)),'packFragmentedLogicalBytes':sum(p['bytes'] for p in packs[5].values())-sum(objectrows[5][i]['bytes'] for i in allrefs),'decodeChecks':dict(decodechecks)}
newActions=[json.loads(r['json']) for i,r in rows[5].items() if r['kind']=='action' and i not in rows[4]];obgrowth['actionRowsByNewObservation']={i:sum(a['observationId']==i for a in newActions) for i in newobs};obgrowth['newActionsOnOldObservations']=sum(a['observationId'] not in newobs for a in newActions)
# File accounting has no double-counted categories.
def category(p):
 if p=='engine/engine.sqlite':return 'engineDatabase'
 if p=='plugin/explorer.sqlite':return 'pluginDatabase'
 if p.endswith(('-wal','-shm')):return 'walOrShm'
 if p.startswith('engine/evidence/blobs/'):return 'evidenceBlobs'
 if p.startswith('engine/evidence/') and p.endswith('.meta.json'):return 'evidenceManifests'
 if p.startswith('runs/'):return 'runAuditExports'
 return 'otherControlFiles'
filecategories={n:dict(collections.Counter({k:sum(v['bytes'] for p,v in before[n]['files'].items() if category(p)==k) for k in set(map(category,before[n]['files']))})) for n in [4,5]}
a,b=before[4]['files'],before[5]['files'];added=set(b)-set(a);removed=set(a)-set(b);common=set(a)&set(b);runid=json.loads((root/'docs/experiments/storage-tiering-2026-10-17/evidence/real-okx-5/summary.json').read_text())['runId'];currentprefix=f'runs/{runid}/';auditfiles={p[len(currentprefix):]:v for p,v in b.items() if p.startswith(currentprefix)}
filegrowth={'categoryTotals':filecategories,'categoryDeltas':delta(filecategories[4],filecategories[5]),'addedFiles':len(added),'removedFiles':len(removed),'changedCommonFiles':len([p for p in common if a[p]!=b[p]]),'addedFileBytes':sum(b[p]['bytes'] for p in added),'removedFileBytes':sum(a[p]['bytes'] for p in removed),'changedCommonByteDelta':sum(b[p]['bytes']-a[p]['bytes'] for p in common),'changedCommonPaths':{p:{'before':a[p]['bytes'],'after':b[p]['bytes'],'delta':b[p]['bytes']-a[p]['bytes']} for p in common if a[p]!=b[p]},'oldRunAuditFilesUnchanged':all(a[p]==b[p] for p in a if p.startswith('runs/')),'currentRunAuditFiles':auditfiles,'currentRunAuditBytes':sum(v['bytes'] for v in auditfiles.values()),'walShmFiles':[p for p in b if p.endswith(('-wal','-shm'))]}
raw=root/'docs/experiments/storage-tiering-2026-10-17/evidence/real-okx-5';lines=(raw/'metrics.jsonl').read_bytes().splitlines(keepends=True);metrics=[json.loads(l) for l in lines];bytype={t:{'rows':sum(e['type']==t for e in metrics),'bytes':sum(len(l) for l,e in zip(lines,metrics) if e['type']==t)} for t in sorted(set(e['type'] for e in metrics))}
new_events=[r for k,r in events[5].items() if k not in events[4]];new_pevents=[r for k,r in pevents[5].items() if k not in pevents[4]];engineRaw={r['json'].encode() for r in new_events};pluginCopies=[fields(r['json']).get('data',b'') for r in new_pevents];copies=[p for p in pluginCopies if p in engineRaw]
exportverify={}
for typ,db in [('engine.event',events[5]),('plugin.event',pevents[5])]:
 selected=[e['data'] for e in metrics if e['type']==typ];matches=[]
 for e in selected:
  row=db[e['sequence']];v=json.loads(row['json'])
  if typ=='engine.event':
   expected={'sequence':row['sequence'],'sessionId':row['session_id'],'type':row['type'],'at':row['at']};expected.update({out:v[key] for out,key in [('entityId','id'),('observationId','observationId'),('beforeId','beforeId'),('afterId','afterId'),('status','status'),('reason','reason')] if key in v});matches.append(e==expected)
  else:matches.append({k:value for k,value in e.items() if k!='sequence'}==v)
 exportverify[typ]={'rows':len(selected),'matchingDatabasePayloadsOrEngineProjections':sum(matches),'fullPayloadCopied':typ!='engine.event','sourceDatabaseJsonBytes':sum(size(db[e['sequence']]['json']) for e in selected),'metricsLineBytes':bytype[typ]['bytes']}
summary=json.loads((raw/'summary.json').read_text());t=lambda s:datetime.datetime.fromisoformat(s.replace('Z','+00:00')).timestamp()*1000
obsEvents={json.loads(r['json'])['observationId']:r for r in new_events if r['type']=='observation.created'};visits={json.loads(r['json'])['observationId']:json.loads(r['json']) for r in rows[5].values() if r['kind']=='visit'}
timings=[]
for id in newobs:
 o=obs[id]['value'];v=visits[id];e=obsEvents[id];timings.append({'observationId':id,'cause':o['cause'],'url':o['url'],'controls':len(o['controls']),'actions':obgrowth['actionRowsByNewObservation'][id],'capturedAt':o['capturedAt'],'screenshotAt':o.get('screenshotAt'),'visitAt':v['at'],'eventAt':e['at'],'captureMarkerToVisitMs':round(t(v['at'])-t(o['capturedAt'])),'visitToObservationEventMs':round(t(e['at'])-t(v['at'])),'captureMarkerToObservationEventMs':round(t(e['at'])-t(o['capturedAt'])),'captureToScreenshotMs':round(t(o['screenshotAt'])-t(o['capturedAt'])) if o.get('screenshotAt') else None,'stable':o['stable'],'criticalGapCodes':[g['code'] for g in o['gaps'] if g.get('critical')]})
def stats(v):return {'count':len(v),'sum':sum(v),'min':min(v),'median':statistics.median(v),'max':max(v)} if v else {}
performance={'window':summary['windowBudget'],'providerCounts':summary['providerCounts'],'actualAttemptDurationsMs':[e['data']['elapsedMs'] for e in metrics if e['type']=='attempt.completed'],'recovery':[{k:v for k,v in e['data'].items() if k!='result'} for e in metrics if e['type']=='recovery.returned'],'observations':timings,'timestampIntervalStatistics':{k:stats([r[k] for r in timings]) for k in ['captureMarkerToVisitMs','visitToObservationEventMs','captureMarkerToObservationEventMs','captureToScreenshotMs']},'clockLimits':'Wall-clock timestamp differences, not instrumented phase timers. capturedAt is assigned after DOM stability/detailed collection, before history/screenshot/ARIA/evidence writes. visit.at follows driver return, identity matching and initial state grouping. observation.created is emitted near transaction end after discovery, final projection, state/identity/action/frontier writes. No pure capture/projection/save duration can be isolated from these markers.'}
allocationGrowth={name:{k:delta(globals()[name][4]['allocation'],globals()[name][5]['allocation'])[k] for k in []} for name in []}
allocs={name:{'summaryDelta':{k:after['allocation'][k]-prior['allocation'][k] for k in ['fileBytes','freelistBytes','payloadBytes','allocatedUnusedBytes','btreeOverheadBytes']},'tableDelta':{k:{x:after['allocation']['tables'].get(k,{}).get(x,0)-prior['allocation']['tables'].get(k,{}).get(x,0) for x in ['pages','allocatedBytes','payloadBytes','unusedBytes']} for k in set(prior['allocation']['tables'])|set(after['allocation']['tables'])}} for name,prior,after in [('engine',engines[4],engines[5]),('plugin',plugins[4],plugins[5])]}
result={'protocol':'run5-storage-growth-v1','at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'sourceRevision':json.loads((raw/'frozen-snapshot.json').read_text())['sourceRevision'],'method':'SQLite mode=ro&immutable=1 + query_only against only frozen-4/frozen-5. No SDK/store constructors, no benchmark, no browser/provider/network; only new observation bytes are decompressed with checksums and ownership checked.','inputs':{n:{k:v for k,v in before[n].items() if k!='files'}|{'databaseHashes':{p:v['sha256'] for p,v in before[n]['files'].items() if p in ['engine/engine.sqlite','plugin/explorer.sqlite']}} for n in [4,5]},'fileGrowth':filegrowth,'engine':engines,'plugin':plugins,'allocationGrowth':allocs,'entityGrowth':entityGrowth,'observationGrowth':obgrowth,'events':{'engineRowsAdded':len(new_events),'engineJsonBytesAdded':sum(size(r['json']) for r in new_events),'oldEngineEventsUnchanged':all(events[4][k]==events[5][k] for k in events[4]),'pluginRowsAdded':len(new_pevents),'pluginJsonBytesAdded':sum(size(r['json']) for r in new_pevents),'oldPluginEventsUnchanged':all(pevents[4][k]==pevents[5][k] for k in pevents[4]),'pluginEventsCopyingExactNewEnginePayload':{'rows':len(copies),'bytes':sum(map(len,copies))}},'auditExports':{'metricsTypes':bytype,'databaseEventCopyValidation':exportverify,'metricsBytes':sum(map(len,lines)),'repoRawFilesBytes':sum(p.stat().st_size for p in raw.iterdir() if p.is_file()),'repoRawOutsideFrozenTotal':True},'performance':performance}
after={n:inventory(n) for n in [4,5]};assert before==after;result['integrity']={'allFrozenHashesMatchManifests':True,'allFrozenFileHashesBeforeAfterEqual':True,'fileCounts':{n:before[n]['fileCount'] for n in before},'databaseConnections':'immutable read-only only','originalDatabaseConnections':0,'walShmAbsent':not filegrowth['walShmFiles']}
(out/'analysis.json').write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n');print(json.dumps({'fileGrowth':filegrowth['categoryDeltas'],'engineAllocation':allocs['engine']['summaryDelta'],'pluginAllocation':allocs['plugin']['summaryDelta'],'observationGrowth':obgrowth,'entityGrowth':{k:entityGrowth[k] for k in ['action','identity','state','observation']},'auditExports':exportverify,'performance':{k:v for k,v in performance.items() if k!='observations'}},ensure_ascii=False,indent=2))
