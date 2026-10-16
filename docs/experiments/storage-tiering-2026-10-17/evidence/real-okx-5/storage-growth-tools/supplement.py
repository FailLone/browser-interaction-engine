import pathlib,sqlite3,json,gzip,hashlib,collections,datetime,statistics
root=pathlib.Path('/Users/xietian/.codex/worktrees/exploration-layered-refactor/browser-interaction-engine');out=pathlib.Path(__file__).parent;report=json.loads((out/'analysis.json').read_text());sha=lambda b:hashlib.sha256(b).hexdigest();sz=lambda v:len(json.dumps(v,ensure_ascii=False,separators=(',',':')).encode())
def con(n,kind):
 p=root/f'.data/okx-storage-acceptance-20261017-v1-frozen-{n}'/kind/('engine.sqlite' if kind=='engine' else 'explorer.sqlite');c=sqlite3.connect(p.as_uri()+'?mode=ro&immutable=1',uri=True);c.row_factory=sqlite3.Row;c.execute('pragma query_only=on');return c
ident={};states={};formatRows=[];header=[]
for n in [4,5]:
 c=con(n,'engine');ident[n]={r['id']:json.loads(r['json']) for r in c.execute("select id,json from entities where kind='identity'")};states[n]={r['id']:dict(r) for r in c.execute("select * from entities where kind='state'")}
 if n==5:
  for id in report['observationGrowth']['newObservationIds']:
   r=c.execute('select json,compressed_json from entities where id=?',(id,)).fetchone();h=json.loads(r['json'])['$interactionStorage'];formatRows.append({'id':id,'format':h['codec'],'version':h['version'],'logicalBytes':h['bytes'],'storedRowBytes':len(r['json'].encode())+len(r['compressed_json'])})
 c.close();c=con(n,'plugin')
 for r in c.execute('select * from tasks'):
  assert sha(r['json'].encode()+b':'+r['header_hash'].encode())==r['header_proof'];header.append({'run':n,'id':r['id'],'json':r['json'],'content_hash':r['header_hash'],'raw_size':r['header_size'],'dataHex':r['header_data'].hex(),'proofChecked':True})
 for r in c.execute('select * from task_items'):
  assert r['chunk_id'] is None and sha(r['json'].encode())==r['content_hash']
 c.close()
(out/'headers.json').write_text(json.dumps(header))
newstate=set(states[5])-set(states[4]);statechecks=[]
for id in newstate:
 r=states[5][id];m=json.loads(r['json']);h=m['$interactionStorage'];b=gzip.decompress(r['compressed_json']);v=json.loads(b);assert len(b)==h['bytes'] and sha(b)==h['sha256'] and v['id']==r['id']==m['id'] and v['sessionId']==r['session_id']==m['sessionId'];statechecks.append({'id':id,'format':h['codec'],'logicalBytes':len(b),'storedRowBytes':len(r['json'].encode())+len(r['compressed_json'])})
common=set(ident[4])&set(ident[5]);prefix=all(ident[5][i]['occurrences'][:len(ident[4][i]['occurrences'])]==ident[4][i]['occurrences'] for i in common)
identity={'beforeOccurrences':sum(len(v['occurrences']) for v in ident[4].values()),'afterOccurrences':sum(len(v['occurrences']) for v in ident[5].values()),'oldOccurrencePrefixesPreserved':prefix,'oldIdentityRowsRemoved':len(set(ident[4])-set(ident[5]))}
identity['occurrencesAdded']=identity['afterOccurrences']-identity['beforeOccurrences']
# Audit projection checks: complete payload copies versus compact references.
raw=root/'docs/experiments/storage-tiering-2026-10-17/evidence/real-okx-5';lines=(raw/'metrics.jsonl').read_bytes().splitlines(keepends=True);metrics=[json.loads(l) for l in lines];c=con(5,'plugin');lookup={r['sequence']:r['json'] for r in c.execute('select * from events')};copies=[];projected=[]
for e in metrics:
 if e['type']!='plugin.event':continue
 data=e['data'];v=json.loads(lookup[data['sequence']]);actual={k:v for k,v in data.items() if k!='sequence'}
 if actual==v:copies.append(len(lookup[data['sequence']].encode()))
 else:
  assert v['type'].startswith('decision.');expected=dict(v);expected['data']={k:v['data'][k] for k in ['reason','kind','purpose','policy'] if k in v['data']};assert actual==expected;projected.append(v['type'])
c.close()
metricsRefs={'fullPluginPayloadCopies':len(copies),'fullPluginDatabaseJsonBytesCopied':sum(copies),'projectedDecisionEvents':len(projected),'projectedDecisionTypes':dict(collections.Counter(projected)),'engineEventsOnlyMetadataProjections':229}
newrun=report['fileGrowth']['currentRunAuditFiles'];repoMatches={n:{'bytes':(raw/n).stat().st_size,'matchesFrozenRunExport':sha((raw/n).read_bytes())==v['sha256']} for n,v in newrun.items()};assert all(r['matchesFrozenRunExport'] for r in repoMatches.values())
# Times for run4 are just matching retained markers, not a controlled before/after test.
def ms(s):return datetime.datetime.fromisoformat(s.replace('Z','+00:00')).timestamp()*1000
def stats(v):return {'count':len(v),'sum':sum(v),'min':min(v),'median':statistics.median(v),'max':max(v)} if v else {}
prior= root/'docs/experiments/storage-tiering-2026-10-17/evidence/real-okx-4/metrics.jsonl';m4=[json.loads(l) for l in prior.read_text().splitlines()];ids4={e['data']['observationId'] for e in m4 if e['type']=='engine.event' and e['data']['type']=='observation.created'};c=con(4,'engine');visits={json.loads(r['json'])['observationId']:json.loads(r['json']) for r in c.execute("select json from entities where kind='visit'")};events={json.loads(r['json'])['observationId']:dict(r) for r in c.execute("select * from events where type='observation.created'")};t4=[]
for id in ids4:
 v=json.loads(c.execute('select json from entities where id=?',(id,)).fetchone()[0]);t4.append({'observationId':id,'captureMarkerToVisitMs':round(ms(visits[id]['at'])-ms(v['capturedAt'])),'visitToObservationEventMs':round(ms(events[id]['at'])-ms(visits[id]['at'])),'captureMarkerToObservationEventMs':round(ms(events[id]['at'])-ms(v['capturedAt']))})
c.close()
r={'newObservationFormats':dict(collections.Counter(r['format'] for r in formatRows)),'newObservationRows':formatRows,'newStateChecks':statechecks,'oldStateRowsUnchanged':all(states[4][i]==states[5][i] for i in states[4]),'identity':identity,'taskHeaderCompressedProofsAndAllPlainItemHashesChecked':True,'metricPayloadDuplication':metricsRefs,'repoCopiesOfFrozenExports':repoMatches,'repoExactExportDuplicateBytesOutsideFrozenTotal':sum(r['bytes'] for r in repoMatches.values()),'run4DescriptiveTimestampStatistics':{k:stats([r[k] for r in t4]) for k in ['captureMarkerToVisitMs','visitToObservationEventMs','captureMarkerToObservationEventMs']},'run4Rows':t4,'run4ActualAttemptDurationsMs':[e['data']['elapsedMs'] for e in m4 if e['type']=='attempt.completed' and e['data'].get('purpose')!='recovery'],'limits':'Different real-world actions/observations, browser/session conditions and source changes. Timestamp markers overlap larger capture/action/recovery intervals. Do not sum them as disjoint CPU costs or attribute a performance change to one fix.'}
(out/'supplement.json').write_text(json.dumps(r,ensure_ascii=False,indent=2)+'\n');print(json.dumps({k:v for k,v in r.items() if k not in ['newObservationRows','newStateChecks','repoCopiesOfFrozenExports','run4Rows']},ensure_ascii=False,indent=2))
