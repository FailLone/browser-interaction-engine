import datetime,hashlib,json,os,pathlib,subprocess,sys,time
BASE=pathlib.Path(__file__).parent
NODE='/Users/xietian/.local/share/fnm/node-versions/v24.22.0/installation/bin/node'
ROOT=pathlib.Path('/Users/xietian/.codex/worktrees/exploration-layered-refactor/browser-interaction-engine')
SCRIPT=BASE/'identity-bench.mjs';sha=lambda p:hashlib.sha256(p.read_bytes()).hexdigest()
mode=sys.argv[1];script_hash=sha(SCRIPT)
if mode=='prepare':
 results=[]
 for codec in ('plain','gzip3-32k','gzip3-1k'):
  log=BASE/f'prepare-{codec}.log'
  with log.open('w') as f:r=subprocess.run([NODE,'--expose-gc',str(SCRIPT),str(BASE),'prepare',codec],stdout=f,stderr=subprocess.STDOUT)
  if r.returncode:raise RuntimeError(f'prepare failed {codec}: {log.read_text()[-3000:]}')
  value=json.loads((BASE/'prepared'/codec/'prepared.json').read_text());results.append(value)
  print(json.dumps({'codec':codec,'identityRows':value['originalIdentityRows'],'compressedRows':value['storage']['compressedRows'],'databaseBytes':value['compacted']['databaseBytes'],'identityBytes':value['storage']['jsonBytes']+value['storage']['compressedBytes'],'negativeChecks':len(value['negativeDecodeChecks'])}),flush=True)
 assert len({x['decodedDigest'] for x in results})==1
 assert len({x['retainedAuditContent']['sha256'] for x in results})==1
 assert sha(SCRIPT)==script_hash
 (BASE/'prepared-summary.json').write_text(json.dumps({'scriptSHA256':script_hash,'variants':results},indent=2))
elif mode=='run':
 orders=[['plain','gzip3-32k','gzip3-1k'],['gzip3-1k','gzip3-32k','plain'],['gzip3-32k','plain','gzip3-1k']]
 status={'startedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'scriptSHA256':script_hash,'sourceRevision':subprocess.check_output(['git','rev-parse','HEAD'],cwd=ROOT,text=True).strip(),
 'host':{'platform':sys.platform,'uname':list(os.uname()),'cpuCount':os.cpu_count(),'initialLoadAverage':os.getloadavg()},'orders':orders,'trials':[],
 'concurrencyNote':'Root explicitly released CPU window after lifecycle timing. Root reserved itself to coding/light reads, but this is a shared Mac with background desktop/browser processes; no OS cache flush, CPU affinity or guaranteed host isolation. Feasibility only, not a final performance acceptance result.'}
 for round_index,order in enumerate(orders):
  for index,codec in enumerate(order):
   name=f'r{round_index+1}-{index+1}-{codec}';log=BASE/f'{name}.log';load=os.getloadavg();started=datetime.datetime.now(datetime.timezone.utc).isoformat()
   with log.open('w') as f:r=subprocess.run([NODE,'--expose-gc',str(SCRIPT),str(BASE),'trial',codec,name],stdout=f,stderr=subprocess.STDOUT)
   assert sha(SCRIPT)==script_hash
   record={'trial':name,'codec':codec,'round':round_index+1,'position':index+1,'startedAt':started,'finishedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'exitCode':r.returncode,'loadBefore':load,'loadAfter':os.getloadavg(),'log':str(log)}
   status['trials'].append(record);(BASE/'execution.json').write_text(json.dumps(status,indent=2))
   if r.returncode:raise RuntimeError(f'trial failed {name}: {log.read_text()[-3000:]}')
   result=json.loads((BASE/'trials'/name/'result.json').read_text());print(json.dumps({'trial':name,'exit':r.returncode,'firstListMs':result['firstListMs'],'peakRssBytes':result['peakRssBytes'],'compactedBytes':result['compacted']['databaseBytes'],'finalDigest':result['finalDigest']}),flush=True)
 status['finishedAt']=datetime.datetime.now(datetime.timezone.utc).isoformat();status['allExitZero']=all(x['exitCode']==0 for x in status['trials']);status['scriptUnchanged']=sha(SCRIPT)==script_hash
 (BASE/'execution.json').write_text(json.dumps(status,indent=2))
else:raise ValueError(mode)
