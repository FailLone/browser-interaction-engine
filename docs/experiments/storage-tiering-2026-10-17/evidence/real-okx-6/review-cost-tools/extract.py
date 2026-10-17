"""Reconstruct review evidence with Python stdlib; immutable SQL, no SDK/browser.
Usage: python3 extract.py REPOSITORY TEMP_OUTPUT
Copies entire frozen-4 and frozen-6, verifies every manifest entry, then reads copies.
"""
import collections,gzip,hashlib,json,pathlib,shutil,sqlite3,sys
root=pathlib.Path(sys.argv[1]).resolve();out=pathlib.Path(sys.argv[2]).resolve();out.mkdir(parents=True,exist_ok=True)
evidence=root/'docs/experiments/storage-tiering-2026-10-17/evidence';sha=lambda b:hashlib.sha256(b).hexdigest()
def manifest(folder):return {str(p.relative_to(folder)):{'bytes':p.stat().st_size,'sha256':sha(p.read_bytes())} for p in folder.rglob('*') if p.is_file()}
def connect(p):
 c=sqlite3.connect(p.as_uri()+'?mode=ro&immutable=1',uri=True);c.row_factory=sqlite3.Row;c.execute('pragma query_only=on');return c
allruns={};checks=collections.Counter();inputs={}
for n in [4,6]:
 raw=evidence/f'real-okx-{n}';frozen=root/f'.data/okx-storage-acceptance-20261017-v1-frozen-{n}';expected=json.loads((raw/'frozen-snapshot.json').read_text());before=manifest(frozen);assert before==expected['files'];copy=out/f'frozen-{n}';shutil.copytree(frozen,copy);assert manifest(copy)==before
 metrics=[json.loads(s) for s in (raw/'metrics.jsonl').read_text().splitlines()];requested={x['data']['requestId'] for x in metrics if x['type']=='provider.started'}
 c=connect(copy/'plugin/explorer.sqlite');ds=[json.loads(r['json']) for r in c.execute('select json from decisions')];decisions=[d for d in ds if d['request']['id'] in requested];assert len(decisions)==len(requested)
 start=json.loads((raw/'active-run.json').read_text())['startedAt'];events=[json.loads(r['json']) for r in c.execute('select json from events') if json.loads(r['json'])['at']>=start];c.close()
 c=connect(copy/'engine/engine.sqlite');kinds=['control-classification','region-review','session','control-review','hypothesis'];entities={k:[json.loads(r['json']) for r in c.execute('select json,compressed_json from entities where kind=?',(k,))] for k in kinds}
 engineEvents=[dict(r,json=json.loads(r['json'])) for r in c.execute('select * from events where at>=?',(start,))]
 ids={d['observationId'] for d in decisions};ids.update(r['observationId'] for k in ['control-classification','region-review','control-review'] for r in entities[k]);ids.update(e['observationId'] for e in events if e.get('observationId'))
 for e in engineEvents:
  if e['type'] in ['control.classification_invalidated','region.review_invalidated','control.classified','region.reviewed']:ids.add(e['json']['observationId'])
 observations={};packs={};objects={}
 for oid in sorted(ids):
  r=c.execute("select * from entities where kind='observation' and id=?",(oid,)).fetchone();assert r is not None;h=json.loads(r['json']).get('$interactionStorage')
  if not h:b=r['json'].encode()
  elif h['version']==1:b=gzip.decompress(r['compressed_json'])
  else:
   layout=gzip.decompress(r['compressed_json']);assert len(layout)==h['layoutBytes'] and sha(layout)==h['layoutSha256'];parts=[];checks['layouts']+=1
   for part in json.loads(layout):
    if isinstance(part,str):parts.append(part.encode());continue
    if part not in objects:
     obj=c.execute('select * from observation_objects where id=?',(part,)).fetchone();assert obj['session_id']==r['session_id']==h['sessionId']
     if obj['pack_id'] not in packs:
      pack=c.execute('select * from observation_packs where id=?',(obj['pack_id'],)).fetchone();assert pack['session_id']==r['session_id'];v=gzip.decompress(pack['data']) if pack['codec']=='gzip' else pack['data'];assert len(v)==pack['bytes'] and sha(v)==pack['sha256'].hex();packs[pack['id']]=v;checks['packs']+=1
     v=packs[obj['pack_id']][obj['byte_offset']:obj['byte_offset']+obj['bytes']];assert len(v)==obj['bytes'] and sha(v)==obj['sha256'].hex();objects[part]=v;checks['objects']+=1
    parts.append(objects[part])
   b=b''.join(parts)
  if h:assert len(b)==h['bytes'] and sha(b)==h['sha256']
  o=json.loads(b);assert o['id']==oid and o['sessionId']==r['session_id'];observations[oid]=o;checks['observations']+=1
 actions=collections.defaultdict(list)
 for r in c.execute("select json from entities where kind='action'"):
  a=json.loads(r['json'])
  if a['observationId'] in ids:actions[a['observationId']].append(a)
 c.close();assert manifest(frozen)==before and manifest(copy)==before
 selectedRaw=['metrics.jsonl','summary.json','task-before.json','task-after.json','active-run.json','frozen-snapshot.json'];inputs[n]={'frozen':str(frozen),'copy':str(copy),'fileCount':len(before),'bytes':sum(v['bytes'] for v in before.values()),'manifestSha256':sha((raw/'frozen-snapshot.json').read_bytes()),'databaseHashes':{p:before[p] for p in ['engine/engine.sqlite','plugin/explorer.sqlite']},'allFrozenAndCopyHashesUnchanged':True,'rawHashes':{p:sha((raw/p).read_bytes()) for p in selectedRaw}}
 allruns[n]={'decisions':decisions,'events':events,'engineEvents':engineEvents,'observations':observations,'actions':actions,'entities':entities,'metrics':metrics,'summary':json.loads((raw/'summary.json').read_text())}
(out/'material.json').write_text(json.dumps(allruns,ensure_ascii=False));(out/'inputs.json').write_text(json.dumps({'inputs':inputs,'checks':dict(checks),'immutable':True,'queryOnly':True,'sdkConstructors':0,'browserProviderNetworkCalls':0},indent=2)+'\n');print(json.dumps({'out':str(out),'decisions':{n:len(v['decisions']) for n,v in allruns.items()},'checks':dict(checks)},indent=2))
