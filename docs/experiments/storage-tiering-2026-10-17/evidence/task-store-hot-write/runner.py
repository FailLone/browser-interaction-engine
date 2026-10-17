#!/usr/bin/env python3
"""Prepare/run isolated 106a1cd vs 855a3a4 task-store trials. No live resources."""
import argparse,gzip,hashlib,importlib.util,json,os,pathlib,shutil,signal,statistics,subprocess,tempfile,time
HERE=pathlib.Path(__file__).resolve().parent
ROOT=HERE.parents[4]
NODE=pathlib.Path('/Users/xietian/.local/share/fnm/node-versions/v24.22.0/installation/bin/node')
REVISIONS={'baseline':'106a1cdfddfe3e73cab9e01b28ba4dd8439653e2','current':'855a3a47b513305077ef160a8d4d5716fe1780f9'}
HELPER=ROOT/'docs/experiments/storage-tiering-2026-10-17/evidence/real-okx-6/audit-serial/runner.py'
def sha(path):
 h=hashlib.sha256()
 with open(path,'rb') as f:
  for block in iter(lambda:f.read(1048576),b''):h.update(block)
 return h.hexdigest()
def write(path,value):path.write_text(json.dumps(value,ensure_ascii=False,indent=2)+'\n')
def archive_tools():
 spec=importlib.util.spec_from_file_location('task_store_archive',HELPER);h=importlib.util.module_from_spec(spec);spec.loader.exec_module(h);h.HERE=HERE;h.SOURCE=ROOT;return h
def environment(owned):
 env={k:os.environ[k] for k in ['HOME','LANG','LC_ALL'] if k in os.environ}
 env.update(PATH=str(NODE.parent)+':/usr/bin:/bin:/usr/sbin:/sbin',CI='true',NO_COLOR='1',TSX_DISABLE_CACHE='1',TMPDIR=str(owned));return env
def execute(archive,cfg,name,owned):
 cf=owned/(name+'-config.json');write(cf,cfg)
 cmd=[str(NODE),'--max-old-space-size=4096','--conditions=development','--import=tsx',str(pathlib.Path(archive['root'])/'.data/worker.ts'),str(cf)]
 row={'name':name,'argv':cmd,'startedEpoch':time.time()}
 with open(HERE/(name+'.log'),'wb') as log:
  proc=subprocess.Popen(cmd,cwd=archive['root'],env=environment(owned),stdout=log,stderr=subprocess.STDOUT,start_new_session=True);row['pid']=proc.pid
  try:row['exitCode']=proc.wait(timeout=120)
  except subprocess.TimeoutExpired:row['timedOut']=True;os.killpg(proc.pid,signal.SIGTERM);row['exitCode']=proc.wait(timeout=10)
 row['finishedEpoch']=time.time();return row
def prepare():
 assert not (HERE/'preparation.json').exists(),'Never overwrite previous preparation'
 freeze=json.loads((HERE.parent/'real-okx-7/freeze.json').read_text());assert freeze['allHashesEqual'] and freeze['walShmFiles']==0 and not freeze['processPresent']
 frozen=pathlib.Path(freeze['frozen']);assert frozen.name.endswith('frozen-7')
 protected={p:sha(frozen/p) for p in ['engine/engine.sqlite','plugin/explorer.sqlite']}
 owned=pathlib.Path(tempfile.mkdtemp(prefix='bie-task-store-hot-write-')).resolve();copy=owned/'frozen-copy';shutil.copytree(frozen,copy)
 assert all(sha(copy/p)==digest for p,digest in protected.items())
 h=archive_tools();archives={key:h.setup_archive(owned/key,revision) for key,revision in REVISIONS.items()}
 for name,archive in archives.items():write(HERE/(name+'-source-before.json'),archive['sourceManifest'])
 seeds=owned/'seeds';seeds.mkdir();real=seeds/'run7.sqlite';shutil.copy2(copy/'plugin/explorer.sqlite',real)
 # The initializer may open only this writable duplicate, never either frozen DB.
 cfg={'mode':'seed','sourceRoot':archives['baseline']['root'],'sourceDatabase':str(real),'taskId':'6c56a979-34f0-4599-a5b7-9461c357144d','database':str(seeds/'history.sqlite'),'output':str(HERE/'history-fixture.json')}
 command=execute(archives['baseline'],cfg,'seed-history',owned);assert command['exitCode']==0
 fixtures={'run7':{'database':str(real),'taskId':cfg['taskId']},'history':{'database':str(seeds/'history.sqlite'),'taskId':'history-fixture'}}
 for f in fixtures.values():f['sha256']=sha(f['database']);f['bytes']=pathlib.Path(f['database']).stat().st_size
 assert fixtures['run7']['sha256']==protected['plugin/explorer.sqlite'],'Opening the settled seed changed its persisted input'
 write(HERE/'preparation.json',{'revisions':REVISIONS,'ownedDirectory':str(owned),'copy':str(copy),'frozen':str(frozen),'protectedDatabases':protected,'archives':archives,'fixtures':fixtures,'seedCommand':command,'workerSha256':sha(HERE/'worker.ts'),'runnerSha256':sha(HERE/'runner.py'),'archiveHelperSha256':sha(HELPER),'preparedAt':time.strftime('%Y-%m-%dT%H:%M:%S%z'),'plan':{'pairsPerScenario':3,'scenarios':list(fixtures),'measurementProcesses':12,'order':'AB,BA,AB within each scenario; all processes serial','noLiveResources':True}})
 print(json.dumps({'prepared':True,'ownedDirectory':str(owned),'fixtures':fixtures}))
def run():
 assert not (HERE/'execution.json').exists(),'Never overwrite previous execution'
 cfg=json.loads((HERE/'preparation.json').read_text());owned=pathlib.Path(cfg['ownedDirectory']);h=archive_tools()
 assert sha(HERE/'worker.ts')==cfg['workerSha256'] and sha(HERE/'runner.py')==cfg['runnerSha256'] and sha(HELPER)==cfg['archiveHelperSha256']
 rows=[];comparisons=[];error=None
 try:
  for scenario,fixture in cfg['fixtures'].items():
   assert sha(fixture['database'])==fixture['sha256']
   for pair in range(1,4):
    order=['baseline','current'] if pair%2 else ['current','baseline'];names={}
    for index,variant in enumerate(order,1):
     archive=cfg['archives'][variant];assert h.manifest(pathlib.Path(archive['root']))==archive['sourceManifest']
     name=f'{scenario}-pair-{pair}-{index}-{variant}';names[variant]=name;db=owned/(name+'.sqlite');shutil.copy2(fixture['database'],db)
     trial={'mode':'measure','sourceRoot':archive['root'],'revision':archive['revision'],'scenario':scenario,'database':str(db),'taskId':fixture['taskId'],'output':str(HERE/(name+'.json')),'semantic':str(HERE/(name+'-semantic.json.gz'))}
     row=execute(archive,trial,name,owned);row.update(pair=pair,variant=variant,scenario=scenario,report=name+'.json',semantic=name+'-semantic.json.gz');rows.append(row);write(HERE/'progress.json',rows)
     assert row['exitCode']==0,name
    left=gzip.decompress((HERE/(names['baseline']+'-semantic.json.gz')).read_bytes());right=gzip.decompress((HERE/(names['current']+'-semantic.json.gz')).read_bytes())
    equal=json.loads(left)==json.loads(right);comparison={'scenario':scenario,'pair':pair,'equal':equal,'left':names['baseline']+'-semantic.json.gz','right':names['current']+'-semantic.json.gz','leftSha256':hashlib.sha256(left).hexdigest(),'rightSha256':hashlib.sha256(right).hexdigest(),'policy':'Complete initial/final task, ordered occurrence handles, original events and decisions; every intermediate full task also checked against expected state and phase hash. No business fields omitted.'};comparisons.append(comparison);assert equal,comparison
 except BaseException as exc:error=f'{type(exc).__name__}: {exc}'
 finally:
  intact={key:h.manifest(pathlib.Path(a['root']))==a['sourceManifest'] for key,a in cfg['archives'].items()}
  for key,a in cfg['archives'].items():write(HERE/(key+'-source-after.json'),h.manifest(pathlib.Path(a['root'])))
  result={'commands':rows,'comparisons':comparisons,'error':error,'allExitZero':len(rows)==12 and all(row['exitCode']==0 for row in rows),'archiveSourcesUnchanged':intact,'workerUnchanged':sha(HERE/'worker.ts')==cfg['workerSha256'],'fixtureSeedsUnchanged':{k:sha(v['database'])==v['sha256'] for k,v in cfg['fixtures'].items()},'frozenDatabasesUnchanged':{p:sha(pathlib.Path(cfg['frozen'])/p)==v for p,v in cfg['protectedDatabases'].items()},'privateReadCopyUnchanged':{p:sha(pathlib.Path(cfg['copy'])/p)==v for p,v in cfg['protectedDatabases'].items()}}
  write(HERE/'execution.json',result)
 if error:raise RuntimeError(error)
 assert all(intact.values()) and result['workerUnchanged'] and all(result['fixtureSeedsUnchanged'].values()) and all(result['frozenDatabasesUnchanged'].values()) and all(result['privateReadCopyUnchanged'].values())
 summarize()
def summarize():
 execution=json.loads((HERE/'execution.json').read_text());assert execution['allExitZero'] and all(c['equal'] for c in execution['comparisons'])
 scenarios={}
 for scenario in ['run7','history']:
  variants={}
  for variant in ['baseline','current']:
   reports=[json.loads((HERE/r['report']).read_text()) for r in execution['commands'] if r['scenario']==scenario and r['variant']==variant]
   phases={key:{'perProcessMedians':[r['timingsMs'][key]['median'] for r in reports],'medianMs':statistics.median(r['timingsMs'][key]['median'] for r in reports)} for key in reports[0]['timingsMs']}
   transactions={key:{'perProcessMedians':[r['transactionBodyMs'][key]['median'] for r in reports],'medianMs':statistics.median(r['transactionBodyMs'][key]['median'] for r in reports)} for key in reports[0]['transactionBodyMs']}
   for key in ['bytes','counts','mechanism','initialLayout','phaseChecks','semanticSha256','versionContract']:
    assert all(r[key]==reports[0][key] for r in reports),f'unstable {scenario}/{variant}/{key}'
   variants[variant]={'revision':REVISIONS[variant],'timings':phases,'transactionBodies':transactions,'maxRSSKiB':[r['resources']['maxRSSKiB'] for r in reports],'medianMaxRSSKiB':statistics.median(r['resources']['maxRSSKiB'] for r in reports),'bytes':reports[0]['bytes'],'counts':reports[0]['counts'],'mechanism':reports[0]['mechanism'],'initialLayout':reports[0]['initialLayout'],'semanticSha256':reports[0]['semanticSha256'],'databaseFiles':[{'beforeMaintenance':r['beforeMaintenance'],'afterMaintenance':r['afterMaintenance'],'closed':r['closedFiles']} for r in reports]}
  ratios={key:variants['current']['timings'][key]['medianMs']/variants['baseline']['timings'][key]['medianMs'] for key in variants['baseline']['timings']}
  scenarios[scenario]={'variants':variants,'currentOverBaseline':ratios}
 write(HERE/'summary.json',{'scenarios':scenarios,'execution':execution,'limits':['Store-only benchmark; no browser/recovery/round throughput claim.','Full-read implementation unchanged; negative samples retained.','First process API read is not an OS page-cache cold read.','RSS includes correctness material and semantic export, not isolated production heap.','Changed-row canonical JSON.parse moves inside the write transaction; transaction body measurements are reported separately.','Packing threshold hits add a bounded qualification probe; below-threshold maintenance timing is unchanged logically.']})
 print(json.dumps({s:d['currentOverBaseline'] for s,d in scenarios.items()},indent=2))
if __name__=='__main__':
 parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--prepare',action='store_true');parser.add_argument('--run',action='store_true');parser.add_argument('--summarize',action='store_true');args=parser.parse_args()
 if args.prepare:prepare()
 elif args.run:run()
 elif args.summarize:summarize()
 else:print('Prepared source only. --prepare creates complete private copies/archives and synthetic seed; --run executes 12 serial processes. Await CPU window.')
