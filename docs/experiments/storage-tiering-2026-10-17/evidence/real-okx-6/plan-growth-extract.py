"""Read only frozen-6 with immutable/query_only SQLite; no SDK construction."""
import collections,gzip,hashlib,json,pathlib,sqlite3,tempfile
root=pathlib.Path(__file__).resolve().parents[5];out=pathlib.Path(__file__).parent;frozen=root/'.data/okx-storage-acceptance-20261017-v1-frozen-6'
sha=lambda b:hashlib.sha256(b).hexdigest()
raw=['task-before.json','task-after.json','summary.json','active-run.json'];rawhash={p:sha((out/p).read_bytes()) for p in raw}
dbpaths=['engine/engine.sqlite','plugin/explorer.sqlite'];dbhash={p:sha((frozen/p).read_bytes()) for p in dbpaths}
before=json.loads((out/raw[0]).read_text());after=json.loads((out/raw[1]).read_text());summary=json.loads((out/raw[2]).read_text());start=json.loads((out/raw[3]).read_text())['startedAt']
oldids={i['id'] for i in before['plan']};new=[i for i in after['plan'] if i['id'] not in oldids]
def connect(p):
 c=sqlite3.connect(p.as_uri()+'?mode=ro&immutable=1',uri=True);c.row_factory=sqlite3.Row;c.execute('pragma query_only=on');return c
p=connect(frozen/dbpaths[1]);events=[dict(json.loads(r['json']),sequence=r['sequence']) for r in p.execute('select sequence,json from events') if json.loads(r['json'])['at']>=start];decisions=[json.loads(r['json']) for r in p.execute('select json from decisions')];p.close()
c=connect(frozen/dbpaths[0]);checks=collections.Counter();packs={};objects={}
def row(kind,id):
 r=c.execute('select * from entities where kind=? and id=?',(kind,id)).fetchone();assert r is not None;return r
def plain(kind,id):
 r=row(kind,id);assert r['compressed_json'] is None;return json.loads(r['json'])
def observation(id):
 r=row('observation',id);m=json.loads(r['json']);h=m.get('$interactionStorage')
 if not h:b=r['json'].encode()
 elif h['version']==1:b=gzip.decompress(r['compressed_json'])
 else:
  layout=gzip.decompress(r['compressed_json']);assert len(layout)==h['layoutBytes'] and sha(layout)==h['layoutSha256'];buf=[]
  for part in json.loads(layout):
   if isinstance(part,str):buf.append(part.encode());continue
   if part not in objects:
    obj=c.execute('select * from observation_objects where id=?',(part,)).fetchone();assert obj['session_id']==r['session_id']==h['sessionId']
    if obj['pack_id'] not in packs:
     pack=c.execute('select * from observation_packs where id=?',(obj['pack_id'],)).fetchone();assert pack['session_id']==r['session_id'];data=gzip.decompress(pack['data']) if pack['codec']=='gzip' else pack['data'];assert len(data)==pack['bytes'] and sha(data)==pack['sha256'].hex();packs[pack['id']]=data;checks['packHashes']+=1
    b=packs[obj['pack_id']][obj['byte_offset']:obj['byte_offset']+obj['bytes']];assert len(b)==obj['bytes'] and sha(b)==obj['sha256'].hex();objects[part]=b;checks['objectHashes']+=1
   buf.append(objects[part])
  b=b''.join(buf);checks['layoutHashes']+=1
 if h:assert len(b)==h['bytes'] and sha(b)==h['sha256'];checks['observationHashes']+=1
 o=json.loads(b);assert o['id']==id and o['sessionId']==r['session_id'];return o

ids={ref['observationId'] for i in before['plan']+new for ref in i['evidence']}
ids.update(e['observationId'] for e in events if e.get('observationId'))
known={r[0] for r in c.execute("select id from entities where kind='observation'")};missing=sorted(ids-known);ids=known # Include every retained observation to distinguish first discovery from absent plan rows.
observations={id:observation(id) for id in sorted(ids)};actions=collections.defaultdict(list)
for r in c.execute("select json,compressed_json from entities where kind='action' and json_extract(json,'$.observationId') in ("+','.join('?' for _ in ids)+')',list(ids)):
 assert r['compressed_json'] is None;a=json.loads(r['json']);actions[a['observationId']].append(a)
attempts=[json.loads(r[0]) for r in c.execute("select json from entities where kind='attempt'")]
engineEvents=[] # Plugin event bridge already includes the required SDK timeline.
c.close();assert dbhash=={p:sha((frozen/p).read_bytes()) for p in dbpaths};assert rawhash=={p:sha((out/p).read_bytes()) for p in raw}
tmp=pathlib.Path(tempfile.mkdtemp(prefix='okx-run6-plan-growth-'));(tmp/'material.json').write_text(json.dumps({'before':before,'after':after,'attempts':attempts,'events':events,'engineEvents':engineEvents,'decisions':decisions,'observations':observations,'actions':actions},ensure_ascii=False))
metadata={'inputHashes':dbhash,'rawHashes':rawhash,'inputsUnchanged':True,'immutableReadOnly':True,'queryOnly':True,'sdkConstructors':0,'browserProviderNetworkCalls':0,'checks':dict(checks),'observations':len(observations),'missingObservationIds':missing,'material':str(tmp/'material.json')};(out/'plan-growth-extraction.json').write_text(json.dumps(metadata,indent=2)+'\n');print(json.dumps(metadata,indent=2))
