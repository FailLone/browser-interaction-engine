import hashlib,json,os,pathlib,shutil,signal,subprocess,time
out=pathlib.Path(__file__).resolve().parent;root=out.parents[4]
protocol=json.loads((out/'protocol.json').read_text());source=root/protocol['source']
node=pathlib.Path('/Users/xietian/.local/share/fnm/node-versions/v24.22.0/installation/bin/node')
assert hashlib.sha256(source.read_bytes()).hexdigest()==protocol['sourceSha256']
wal=source.with_name(source.name+'-wal');assert not wal.exists() or wal.stat().st_size==0
env=os.environ.copy();env['PATH']=str(node.parent)+':'+env['PATH'];env['NODE_OPTIONS']='--conditions=development'
reports=[]
for variant in protocol['variants']:
 dest=root/('.data/okx-coverage-query-20261018-'+variant)/'engine';assert not dest.exists();dest.mkdir(parents=True)
 shutil.copy2(source,dest/source.name)
 began=time.monotonic()
 with (out/(variant+'.log')).open('x') as log:
  p=subprocess.Popen([str(node),'--conditions=development','--import','tsx',str(out/'measure.mts'),variant,str(dest),str(out/(variant+'.json'))],cwd=root,env=env,stdout=log,stderr=subprocess.STDOUT,start_new_session=True)
  timed_out=False
  try:code=p.wait(timeout=protocol['externalLimitSecondsPerVariant'])
  except subprocess.TimeoutExpired:
   timed_out=True;os.killpg(p.pid,signal.SIGKILL);code=p.wait()
 reports.append({'variant':variant,'exitCode':code,'timedOut':timed_out,'processElapsedSeconds':time.monotonic()-began,'ownedDirectory':str(dest)})
 if code!=0:break
after=hashlib.sha256(source.read_bytes()).hexdigest()
comparison={'runs':reports,'sourceUnchanged':after==protocol['sourceSha256'],'sourceSha256':after}
if len(reports)==2 and all(r['exitCode']==0 for r in reports):
 a,b=[json.loads((out/(v+'.json')).read_text()) for v in protocol['variants']]
 comparison.update({'sameCompleteFrontier':a['frontierSha256']==b['frontierSha256'] and a['frontierBytes']==b['frontierBytes'],
  'sameEquivalentCount':a['equivalentItems']==b['equivalentItems'],'eagerMs':a['elapsedMs'],'boundedMs':b['elapsedMs'],
  'eagerMaxRssKiB':a['maxRssKiB'],'boundedMaxRssKiB':b['maxRssKiB'],'requestedReads':b['requestedObservationReads'],'distinctRequestedObservations':b['distinctRequestedObservations']})
(out/'comparison.json').write_text(json.dumps(comparison,indent=2)+'\n');print(json.dumps(comparison,indent=2))
assert comparison['sourceUnchanged']
