import pathlib,json,sqlite3,collections,gzip,datetime
ROOT=pathlib.Path.cwd()
def ms(t):return datetime.datetime.fromisoformat(t.replace('Z','+00:00')).timestamp()*1000

def summary(name):
 p=ROOT/'.data'/name;rows=[json.loads(x) for x in (p/'timeline.jsonl').read_text().splitlines()];ev=[x['data'] for x in rows if x['type']=='plugin.event'];result=json.loads((p/'result.json').read_text());budget=p/'budget.json';began=json.loads(budget.read_text())['began'] if budget.exists() else rows[0]['at'];db=sqlite3.connect((p/'explorer.sqlite').as_uri()+'?mode=ro&immutable=1',uri=True);ds=[json.loads(j) for j, in db.execute('select json from decisions')];db.close()
 purposes={}
 for d in ds:
  z=purposes.setdefault(d['purpose'],{'requests':0,'returned':0,'elapsedMsSum':0,'gateSatisfied':0,'undetermined':0});z['requests']+=1;z['returned']+=int('answer' in d);z['elapsedMsSum']+=d.get('elapsedMs',0) or 0;v=d.get('resolution',{}).get('value')
  if isinstance(v,dict):
   kinds=[k[10:] for k in v if k.startswith('interface_')];z['gateSatisfied']+=sum(v.get('interface_'+k) is True and v.get('external_'+k) is False for k in kinds);z['undetermined']+=int(any(x is None for x in v.values()))
 captures=[x['data']['elapsedMs'] for x in rows if x['type']=='capture'];first=next((x['data'] for x in rows if x['type']=='dom.initial'),{});before={x['data'].get('number'):x['data'] for x in rows if x['type']=='dom.before'};dispatches={x['data'].get('number'):x for x in rows if x['type']=='browser.dispatch'};moves=[];menus=[]
 for x in rows:
  if x['type']!='browser.executed':continue
  inv=x['data'].get('inventory',{});number=x['data'].get('number');b=before.get(number,{}).get('inventory',first);dispatch=dispatches.get(number,{}).get('data',{});a=dispatch.get('action',{});control=dispatch.get('control') or {}
  if inv.get('url') and inv.get('url')!=b.get('url'):moves.append({'atMs':x['at']-began,'kind':a.get('kind'),'url':inv['url']})
  def links(i):return {q.get('href') for q in i.get('controls',i.get('visibleLinks',[])) if q.get('href')}
  newly=links(inv)-links(b)
  if control.get('landmark') in ['banner','navigation'] or inv.get('expanded')=='true':menus.append({'atMs':x['at']-began,'kind':a.get('kind'),'label':a.get('label'),'newVisibleHrefs':sorted(newly)})
 engine=sqlite3.connect((p/'engine/engine.sqlite').as_uri()+'?mode=ro&immutable=1',uri=True);resolved={json.loads(j)['id']:ms(at) for at,j in engine.execute("select at,json from events where type='identity.resolved'")};tails=[]
 for e in ev:
  if e['type']=='program.review' and e['data'].get('command',{}).get('type')=='resolveIdentity':
   start=resolved.get(e['data']['command']['hypothesisId']);
   if start is not None:tails.append(round(ms(e['at'])-start))
 counts=[];packs={}
 def obj(i):
  pack,off,size=engine.execute('select pack_id,byte_offset,bytes from observation_objects where id=?',(i,)).fetchone()
  if pack not in packs:
   codec,b=engine.execute('select codec,data from observation_packs where id=?',(pack,)).fetchone();packs[pack]=gzip.decompress(b) if codec=='gzip' else b
  return packs[pack][off:off+size]
 rr=engine.execute("select json,compressed_json from entities where kind='observation' order by rowid").fetchall()
 for j,b in ([rr[0],rr[-1]] if rr else []):
  manifest=json.loads(j)
  if manifest.get('$interactionStorage',{}).get('codec')=='structural':o=json.loads(b''.join(v.encode() if isinstance(v,str) else obj(v) for v in json.loads(gzip.decompress(b))))
  elif b:o=json.loads(gzip.decompress(b))
  else:o=manifest
  counts.append({'observationId':o['id'],'controls':len(o['controls']),'visibleControls':sum(c.get('visible',False) for c in o['controls']),'tentativeControls':sum(any(v.get('status')=='tentative' for v in c.get('actionBasis',{}).values()) for c in o['controls']),'headerControls':sum(c.get('landmark')=='banner' for c in o['controls'])})
 engine.close()
 return {'run':name,'elapsedMs':result.get('elapsedMs'),'commands':result.get('actions',result.get('commands')),'firstNavigationAfterStartupMs':moves[0]['atMs'] if moves else None,'navigationsAfterStartup':moves,'firstToLastCandidateCounts':counts,'modelStages':purposes,'captureElapsedMsSum':sum(captures) if captures else None,'captureTimingNote':'Directly instrumented' if captures else 'Not instrumented in original run; no fabricated collection-duration attribution','identityPostResolutionTailsMs':tails,'identityTailNote':'Engine identity.resolved to plugin program.review; includes capture and bookkeeping, excludes preflight and is not a pure capture measurement','menuExecutions':menus,'newVisibleNavigationHrefs':sorted({href for m in menus for href in m['newVisibleHrefs']}),'actualBrowserDispatches':len(dispatches),'sdkProbeDispatchEvents':sum(e['type']=='probe.dispatch' for e in ev),'strictChains':len(result.get('chains',[])) if not result.get('diagnosticOnly') else None,'riskGateNote':'gateSatisfied counts model conjunctions before SDK checks; never execution permission or a successful dispatch','retainedFinite':result.get('coverage',{}).get('finite'),'status':result.get('taskStatus',result.get('status'))}
report={'runs':[summary(n) for n in ['stage2-okx-1','stage2-okx-2','stage2-okx-3','stage2-react-menu-1']]};out=ROOT/'.data/stage2-phase-comparison.json';out.write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n')
for r in report['runs']:print(r['run'],r['commands'],'menu',len(r['menuExecutions']),'navigation',r['firstNavigationAfterStartupMs'],'modelMs',sum(p['elapsedMsSum'] for p in r['modelStages'].values()),'identityTailMs',sum(r['identityPostResolutionTailsMs']))
