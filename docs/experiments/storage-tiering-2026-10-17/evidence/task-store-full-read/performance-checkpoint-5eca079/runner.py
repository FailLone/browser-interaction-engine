#!/usr/bin/env python3
"""One fixed BLOB/isUtf8 candidate comparison; prepare now, run only in an assigned CPU window."""
import argparse,gzip,hashlib,json,os,pathlib,shutil,signal,statistics,subprocess,tarfile,tempfile,time

HERE=pathlib.Path(__file__).resolve().parent
SEALED=HERE.parent
ROOT=HERE.parents[5]
REVISION='5eca079d01e88dbc7da5e1f61f5553499dd25d8e'
NODE=pathlib.Path('/Users/xietian/.local/share/fnm/node-versions/v24.22.0/installation/bin/node')
STORE='packages/explorer-plugin/src/store.ts'
TEST='tests/explorer-store-read-cost.test.ts'
EXPECTED={
 'baseline':'cc60e84799f47ecd6ff33c0f8780c5e5bab0c7d16186c506a38e2cdafcaa5b33',
 'candidate':'deade4423dce192152bc44f7342f7bc0a393cc98940dc524da0c285a302a6450',
 'test':'ab6fca037764d0c301d4ae6fd6fb8fb821401a468c7382445856afc2a3852b2b',
 'patch':'fa09e95c752ccc35bf7c1b72abae062cdf6df6f9967e0bc16768093903a71fcb',
}
SEEDS=pathlib.Path('/private/var/folders/s9/dy_jbdrs3fn1qzt_gnsy4tgw0000gn/T/bie-task-store-hot-write-t3vwwbqd/seeds')
FIXTURES={
 'run7':{'database':str(SEEDS/'run7.sqlite'),'taskId':'6c56a979-34f0-4599-a5b7-9461c357144d','sha256':'92eee981059d9163784380915492d2b3292cd83c980eb5ccb36a570d29138b50'},
 'history':{'database':str(SEEDS/'history.sqlite'),'taskId':'history-fixture','sha256':'4c42e7661cb8a1efbfac1d78bef676602015c4f3686338c574de64171d283904'},
}

def sha(path):
 h=hashlib.sha256()
 with open(path,'rb') as stream:
  for block in iter(lambda:stream.read(1048576),b''):h.update(block)
 return h.hexdigest()
def digest(value):return hashlib.sha256(json.dumps(value,ensure_ascii=False,separators=(',',':')).encode()).hexdigest()
def write(path,value):path.write_text(json.dumps(value,ensure_ascii=False,indent=2)+'\n')
def source_manifest(root):
 return [{'path':str(p.relative_to(root)),'bytes':p.stat().st_size,'sha256':sha(p)} for p in sorted(root.rglob('*'))
         if p.is_file() and not p.is_symlink() and not {'node_modules','.data'}.intersection(p.relative_to(root).parts)]
def source_summary(rows):return {'files':len(rows),'bytes':sum(r['bytes'] for r in rows),'manifestSha256':digest(rows)}
def archive(path):
 path.mkdir()
 # Complete tracked product/source/test trees and root configuration; old evidence is referenced, not copied.
 tracked=subprocess.check_output(['git','ls-tree','--name-only',REVISION],cwd=ROOT,text=True).splitlines()
 included=[p for p in tracked if p not in ['docs','.data']]
 tar=path/'.source.tar'
 with open(tar,'wb') as stream:subprocess.run(['git','archive','--format=tar',REVISION,'--',*included],cwd=ROOT,stdout=stream,check=True)
 with tarfile.open(tar) as stream:
  for entry in stream.getmembers():
   name=pathlib.PurePosixPath(entry.name)
   assert not name.is_absolute() and '..' not in name.parts and not entry.issym() and not entry.islnk()
  stream.extractall(path)
 tar.unlink()
 packages=[path/'package.json']+sorted((path/'packages').glob('*/package.json'))+sorted((path/'apps').glob('*/package.json'))
 names={json.loads(p.read_text())['name']:p.parent for p in packages[1:]}
 links=[];external={}
 for package in packages:
  local=package.parent/'node_modules';original=ROOT/package.parent.relative_to(path)/'node_modules';local.mkdir(exist_ok=True)
  def link(name,source):
   dest=local/name
   if dest.exists():return
   target=names[name] if name in names else source.resolve(strict=True)
   dest.parent.mkdir(parents=True,exist_ok=True);dest.symlink_to(target,target_is_directory=True)
   if name in names:
    assert dest.resolve().is_relative_to(path);links.append(str(dest.relative_to(path)))
   else:
    assert 'node_modules' in target.parts
    package_json=target/'package.json'
    external[name]={'target':str(target),'packageJsonSha256':sha(package_json) if package_json.exists() else None}
  if original.is_dir():
   for entry in sorted(original.iterdir()):
    if entry.name.startswith('.'):continue
    if entry.name.startswith('@'):
     for dep in sorted(entry.iterdir()):link(entry.name+'/'+dep.name,dep)
    else:link(entry.name,entry)
  metadata=json.loads(package.read_text())
  for name in {**metadata.get('dependencies',{}),**metadata.get('devDependencies',{})}:
   if name in names:link(name,names[name])
 (path/'.data').mkdir();shutil.copy2(SEALED/'worker.ts',path/'.data/worker.ts')
 return {'root':str(path),'workspaceLinksInsideArchive':True,'workspaceLinkCount':len(links),'externalDependencies':external}

def prepare():
 assert not (HERE/'preparation.json').exists(),'Never replace preparation or prior results'
 assert sha(ROOT/STORE)==EXPECTED['baseline'] and sha(SEALED/'candidate.patch')==EXPECTED['patch']
 owned=pathlib.Path(tempfile.mkdtemp(prefix='bie-task-full-read-5eca079-')).resolve()
 write(owned/'ownership.json',{'purpose':'fixed full-read candidate performance checkpoint','revision':REVISION,'evidence':str(HERE)})
 variants={name:archive(owned/name) for name in ['baseline','candidate']}
 candidate=pathlib.Path(variants['candidate']['root'])
 subprocess.run(['git','apply','--check',str(SEALED/'candidate.patch')],cwd=candidate,check=True)
 subprocess.run(['git','apply',str(SEALED/'candidate.patch')],cwd=candidate,check=True)
 assert sha(candidate/STORE)==EXPECTED['candidate'] and sha(candidate/TEST)==EXPECTED['test']
 for name,variant in variants.items():
  rows=source_manifest(pathlib.Path(variant['root']));write(owned/(name+'-source.json'),rows)
  variant.update(source=source_summary(rows),sourceManifest=str(owned/(name+'-source.json')),storeSha256=sha(pathlib.Path(variant['root'])/STORE))
 left={r['path']:r['sha256'] for r in json.loads((owned/'baseline-source.json').read_text())}
 right={r['path']:r['sha256'] for r in json.loads((owned/'candidate-source.json').read_text())}
 changes=sorted(p for p in left.keys()|right.keys() if left.get(p)!=right.get(p));assert changes==sorted([STORE,TEST])
 fixtures={}
 for name,fixture in FIXTURES.items():
  path=pathlib.Path(fixture['database']);assert sha(path)==fixture['sha256']
  assert all(not pathlib.Path(str(path)+suffix).exists() for suffix in ['-wal','-shm'])
  fixtures[name]={**fixture,'bytes':path.stat().st_size}
 references={p:{'path':str(SEALED/p),'sha256':sha(SEALED/p)} for p in ['candidate.patch','worker.ts','sealed-candidate.json','checkpoint.json','behavior-56.log','checks.json','typecheck.log']}
 cfg={'status':'prepared; workers not run; awaiting exclusive CPU window','revision':REVISION,'preparedAt':time.strftime('%Y-%m-%dT%H:%M:%S%z'),
      'ownedDirectory':str(owned),'variants':variants,'fixtures':fixtures,'references':references,'changedArchiveFiles':changes,
      'workerSha256':sha(SEALED/'worker.ts'),'runnerSha256':sha(__file__),'node':str(NODE),'nodeVersion':subprocess.check_output([str(NODE),'--version'],text=True).strip(),
      'sharedStoreSha256':sha(ROOT/STORE),'plan':{'processes':6,'pairs':3,'order':'AB,BA,AB','fixtureOrder':['run7','history'],
      'repeatsPerWarmPhase':7,'expectedWallSeconds':[20,90],'additionalRepoByteBudget':6291456,
      'semanticRetention':'All complete state/events/decisions compared byte-for-byte; one gzip per distinct logical hash shared by every equal run/variant.',
      'timingExclusions':['imports','DB copying','deep equality','JSON serialization','hashing','events/decisions export'],
      'firstRead':'First taskState read for a new store, not an OS-cold claim; history follows run7 in each process.',
      'noNewBehaviorTestRun':True,'noSharedProductEdits':True,'noOriginalOrFrozenDatabaseOpened':True}}
 write(HERE/'preparation.json',cfg)
 print(json.dumps({'ready':True,'ownedDirectory':str(owned),'sourceChanges':changes,'fixtures':fixtures,'sharedStoreSha256':cfg['sharedStoreSha256']}))

def environment(owned):
 env={k:os.environ[k] for k in ['HOME','LANG','LC_ALL'] if k in os.environ}
 env.update(PATH=str(NODE.parent)+':/usr/bin:/bin:/usr/sbin:/sbin',CI='true',NO_COLOR='1',TSX_DISABLE_CACHE='1',TMPDIR=str(owned));return env
def verify(cfg):
 assert sha(__file__)==cfg['runnerSha256']
 assert all(sha(ref['path'])==ref['sha256'] for ref in cfg['references'].values())
 assert all(sha(f['database'])==f['sha256'] for f in cfg['fixtures'].values())
 assert all(source_summary(source_manifest(pathlib.Path(v['root'])))==v['source'] for v in cfg['variants'].values())
 assert all(sha(pathlib.Path(v['root'])/'.data/worker.ts')==cfg['workerSha256'] for v in cfg['variants'].values())
 assert sha(ROOT/STORE)==cfg['sharedStoreSha256']
def semantic_inventory(value):
 state=value['state'];task=state['task']
 def counts(values):
  result={}
  for item in values:result[item]=result.get(item,0)+1
  return result
 return {'planOccurrences':len(state['plan']),'roundOccurrences':len(state['rounds']),
         'planStatuses':counts([i['status'] for i in task['plan']]),
         'attemptOutcomes':counts([a['outcome'] for i in task['plan'] for a in i['attempts']]),
         'planBusinessIdsUnique':len(set(i['id'] for i in task['plan'])),
         'orderedOccurrencesSha256':digest({'plan':state['plan'],'rounds':state['rounds']}),
         'unknownAndDebtSha256':digest({'unknownPlanItems':[i for i in task['plan'] if i.get('reason')=='unknown_action_outcome' or any(a['outcome'] in ['unknown','executing'] for a in i['attempts'])],
           'pendingDispatch':task.get('pendingDispatch'),'unverifiedNavigations':task.get('unverifiedNavigations'),'routeRetries':task.get('routeRetries'),'rounds':task['rounds']}),
         'events':len(value['events']),'decisions':len(value['decisions'])}
def run():
 cfg=json.loads((HERE/'preparation.json').read_text());assert not (HERE/'execution.json').exists(),'One fixed run only'
 verify(cfg);owned=pathlib.Path(cfg['ownedDirectory']);rows=[];semantics={};error=None
 objects=HERE/'semantic-objects';objects.mkdir()
 try:
  for pair in range(1,4):
   for position,variant in enumerate(['baseline','candidate'] if pair%2 else ['candidate','baseline'],1):
    verify(cfg);source=cfg['variants'][variant];name=f'pair-{pair}-{position}-{variant}';fixtures=[]
    for scenario,fixture in cfg['fixtures'].items():
     database=owned/(name+'-'+scenario+'.sqlite');shutil.copy2(fixture['database'],database)
     fixtures.append({**fixture,'name':scenario,'database':str(database),'seedSha256':fixture['sha256'],'semantic':str(owned/(name+'-'+scenario+'-semantic.json'))})
    report=HERE/(name+'.json');config=owned/(name+'-config.json')
    write(config,{'sourceRoot':source['root'],'revision':REVISION+(' + sealed candidate' if variant=='candidate' else ''),'fixtures':fixtures,'output':str(report)})
    argv=[str(NODE),'--max-old-space-size=4096','--conditions=development','--import=tsx',str(pathlib.Path(source['root'])/'.data/worker.ts'),str(config)]
    row={'name':name,'pair':pair,'position':position,'variant':variant,'report':report.name,'argv':argv,'startedEpoch':time.time()};rows.append(row)
    with open(HERE/(name+'.log'),'wb') as log:
     child=subprocess.Popen(argv,cwd=source['root'],env=environment(owned),stdout=log,stderr=subprocess.STDOUT,start_new_session=True);row['pid']=child.pid;write(HERE/'progress.json',rows)
     try:row['exitCode']=child.wait(timeout=180)
     except subprocess.TimeoutExpired:row['timedOut']=True;os.killpg(child.pid,signal.SIGTERM);row['exitCode']=child.wait(timeout=10)
    row['finishedEpoch']=time.time();write(HERE/'progress.json',rows);assert row['exitCode']==0,name
    data=json.loads(report.read_text())
    for scenario,facts in data['scenarios'].items():
     path=pathlib.Path(facts['semantic']);raw=path.read_bytes();logical=hashlib.sha256(raw).hexdigest();assert logical==facts['semanticSha256']
     dest=objects/(logical+'.json.gz')
     if dest.exists():assert gzip.decompress(dest.read_bytes())==raw
     else:dest.write_bytes(gzip.compress(raw,compresslevel=6,mtime=0))
     invariant=semantic_inventory(json.loads(raw))
     reference=semantics.setdefault(scenario,{'logicalSha256':logical,'logicalBytes':len(raw),'artifact':str(dest.relative_to(HERE)),'artifactSha256':sha(dest),'inventory':invariant,'runs':[]})
     assert reference['logicalSha256']==logical and reference['inventory']==invariant,'Full semantic bytes differ'
     reference['runs'].append(name);path.unlink()
    verify(cfg)
 except BaseException as exc:error=f'{type(exc).__name__}: {exc}'
 finally:
  checks={}
  try:verify(cfg);checks['allPinnedInputsUnchanged']=True
  except BaseException as exc:checks['allPinnedInputsUnchanged']=False;checks['error']=str(exc)
  write(HERE/'semantic-index.json',semantics)
  execution={'commands':rows,'allExitZero':len(rows)==6 and all(r.get('exitCode')==0 for r in rows),'fullSemanticByteEquality':len(semantics)==2 and all(len(s['runs'])==6 for s in semantics.values()),'error':error,'checks':checks,'finishedAt':time.strftime('%Y-%m-%dT%H:%M:%S%z')}
  write(HERE/'execution.json',execution)
 if error:raise RuntimeError(error)
 assert execution['allExitZero'] and execution['fullSemanticByteEquality'] and checks['allPinnedInputsUnchanged']
 summarize()
def summarize():
 execution=json.loads((HERE/'execution.json').read_text());assert execution['allExitZero'] and execution['fullSemanticByteEquality']
 scenarios={}
 for scenario in FIXTURES:
  variants={}
  for variant in ['baseline','candidate']:
   reports=[json.loads((HERE/r['report']).read_text()) for r in execution['commands'] if r['variant']==variant]
   facts=[r['scenarios'][scenario] for r in reports]
   timings={phase:{'perProcessMedians':[f['timingsMs'][phase]['median'] for f in facts],'medianMs':statistics.median(f['timingsMs'][phase]['median'] for f in facts)} for phase in facts[0]['timingsMs']}
   variants[variant]={'timings':timings,'resources':[r['resources'] for r in reports],'phaseMemory':[f['memory'] for f in facts],
       'files':[{'before':f['filesBefore'],'open':f['filesOpen'],'closed':f['filesClosed']} for f in facts],
       'hashes':{k:facts[0][k] for k in ['taskSha256','stateSha256','eventsSha256','decisionsSha256','semanticSha256','fileHashBefore','fileHashAfter']},
       'counts':facts[0]['counts'],'bytes':facts[0]['bytes'],'mechanism':facts[0]['mechanism'],'rowCounts':facts[0]['rowCounts']}
  scenarios[scenario]={'variants':variants,'candidateOverBaseline':{phase:variants['candidate']['timings'][phase]['medianMs']/variants['baseline']['timings'][phase]['medianMs'] for phase in variants['baseline']['timings']}}
 write(HERE/'summary.json',{'scenarios':scenarios,'semantics':'semantic-index.json','execution':'execution.json','limits':[
  'Only synchronous store read cost; no end-to-end round/browser/provider throughput claim.',
  'First read is first API read per store. OS page cache is uncontrolled; history follows run7 in every process.',
  'Peak RSS includes previous fixture, correctness snapshots, semantic serialization, and GC; measured difference retained but not isolated production heap.',
  'No write algorithm, format, schema or storage-reduction claim. Startup maintenance, if any, must leave DB hash and total_changes unchanged.',
  'Three fixed AB/BA/AB pairs only. All negative phase/history/RSS results retained; no parameter retries.',
  'Prior 56 behavior tests are referenced, not rerun and not counted as performance evidence.']} )
 print(json.dumps({name:result['candidateOverBaseline'] for name,result in scenarios.items()},indent=2))

if __name__=='__main__':
 parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--prepare',action='store_true');parser.add_argument('--run',action='store_true');parser.add_argument('--summarize',action='store_true');args=parser.parse_args()
 if args.prepare:prepare()
 elif args.run:run()
 elif args.summarize:summarize()
 else:print('Preparation only until root grants the exclusive CPU window. Use --prepare; later --run exactly once.')
