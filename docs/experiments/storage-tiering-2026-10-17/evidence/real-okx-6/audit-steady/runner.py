#!/usr/bin/env python3
"""Six serial fresh workers, each carrying one task/plugin through three real audits."""
import pathlib,json,hashlib,os,subprocess,time,signal,shutil,statistics,importlib.util
HERE=pathlib.Path(__file__).resolve().parent
SOURCE=pathlib.Path('/Users/xietian/.codex/worktrees/exploration-layered-refactor/browser-interaction-engine')
ORIGINAL=SOURCE/'docs/experiments/storage-tiering-2026-10-17/evidence/real-okx-6/audit-serial'
EVIDENCE=ORIGINAL.parent/'audit-steady'
spec=importlib.util.spec_from_file_location('first_runner',ORIGINAL/'runner.py');helper=importlib.util.module_from_spec(spec);spec.loader.exec_module(helper)
sha=helper.sha;write=helper.write;manifest=helper.manifest;NODE=helper.NODE
config=json.loads((ORIGINAL/'preparation.json').read_text())
assert json.loads((ORIGINAL/'execution.json').read_text())['allExitZero']
assert not EVIDENCE.exists();EVIDENCE.mkdir()
first_manifest_sha=sha(ORIGINAL/'artifact-manifest.json')
for p in HERE.iterdir():
 if p.is_file():shutil.copy2(p,EVIDENCE/p.name)
for name,a in config['archives'].items():
 archive=pathlib.Path(a['root']);assert manifest(archive)==a['sourceManifest'];shutil.copy2(HERE/'worker.ts',archive/'.data/steady-worker.ts')
write(EVIDENCE/'setup.json',{'firstExperiment':str(ORIGINAL),'firstManifestSha256':first_manifest_sha,'fixedMaterial':config['material'],'materialSha256':config['materialSha256'],'sourceRevisions':{name:a['revision'] for name,a in config['archives'].items()},'workerSha256':sha(HERE/'worker.ts'),'runnerSha256':sha(HERE/'runner.py'),'order':['baseline','current']*3,'processes':6,'auditsPerProcess':3,'startupNormalization':'Current only, once before first audit; never reset task/metadata/event state'})
env={k:os.environ[k] for k in ['HOME','LANG','LC_ALL'] if k in os.environ};env.update({'PATH':str(NODE.parent)+':/usr/bin:/bin:/usr/sbin:/sbin','CI':'true','NO_COLOR':'1','TSX_DISABLE_CACHE':'1','TMPDIR':str(pathlib.Path(config['ownedDirectory'])/'runtime-tmp')})
commands=[];ok=False;error=None
try:
 for pair in range(1,4):
  for order,name in enumerate(['baseline','current'],1):
   a=config['archives'][name];archive=pathlib.Path(a['root']);output=EVIDENCE/f'pair-{pair}-{order}-{name}.json';cfg={k:config[k] for k in ['material','materialSha256','expectedInputs','expectedReconciledTaskSha256']};cfg.update(sourceRoot=str(archive),revision=a['revision'],variant=name,normalize=name=='current',output=str(output));cf=archive/'.data/steady-config.json';write(cf,cfg)
   argv=[str(NODE),'--max-old-space-size=4096','--conditions=development','--import=tsx',str(archive/'.data/steady-worker.ts'),str(cf)];row={'pair':pair,'order':order,'variant':name,'argv':argv,'startedEpoch':time.time(),'report':output.name,'log':output.with_suffix('.log').name};commands.append(row)
   with open(output.with_suffix('.log'),'wb') as log:
    child=subprocess.Popen(argv,cwd=archive,env=env,stdout=log,stderr=subprocess.STDOUT,start_new_session=True);row['pid']=child.pid
    try:code=child.wait(timeout=90)
    except subprocess.TimeoutExpired:os.killpg(child.pid,signal.SIGTERM);code=child.wait(timeout=10)
   row.update(exitCode=code,finishedEpoch=time.time());write(EVIDENCE/'progress.json',commands)
   if code:raise RuntimeError(f'{row["log"]} exited {code}')
   row['sha256']=sha(output);assert manifest(archive)==a['sourceManifest']
 ok=True
except BaseException as e:error=f'{type(e).__name__}: {e}'
finally:
 source_unchanged={name:manifest(pathlib.Path(a['root']))==a['sourceManifest'] for name,a in config['archives'].items()};material_unchanged=sha(config['material'])==config['materialSha256'];first_unchanged=sha(ORIGINAL/'artifact-manifest.json')==first_manifest_sha and all(sha(ORIGINAL/r['path'])==r['sha256'] for r in json.loads((ORIGINAL/'artifact-manifest.json').read_text()))
 execution={'allExitZero':ok,'error':error,'commands':commands,'sourcesUnchanged':source_unchanged,'materialUnchanged':material_unchanged,'firstExperimentUnchanged':first_unchanged,'distinctProcesses':len(set(r['pid'] for r in commands))};write(EVIDENCE/'execution.json',execution)
if not ok:raise RuntimeError(error)
assert all(source_unchanged.values()) and material_unchanged and first_unchanged
summary={}
for name in ['baseline','current']:
 reports=[json.loads((EVIDENCE/r['report']).read_text()) for r in commands if r['variant']==name];phases=[]
 for index in range(3):
  rows=[report['phases'][index] for report in reports];keys=['inputTaskRows','resultTaskRows','newRows','newByReason','newByStatus','normalizedBefore','normalizationReads','auditReads','totalReads','eventCounts','auditEventCounts','pendingActions','bytes','oldIntegrity','logicalReturnedJsonBytes','saveCalls','startupNormalizationApplied','cumulativeEvents','cumulativeSaveCalls','carryForward']
  stable={k:rows[0][k] for k in keys};assert all(all(row[k]==stable[k] for k in keys) for row in rows),'Same-revision structural results vary'
  timing={k:{'samples':[r['phaseTimingsMs'][k] for r in rows],'median':statistics.median(r['phaseTimingsMs'][k] for r in rows),'min':min(r['phaseTimingsMs'][k] for r in rows),'max':max(r['phaseTimingsMs'][k] for r in rows)} for k in ['startupNormalization','audit','normalizationPlusAudit']}
  phases.append({'phase':index+1,'timingsMs':timing,'stableResult':stable})
 summary[name]={'revision':config['archives'][name]['revision'],'processes':len(reports),'phases':phases}
summary['auditMedianRatios']=[summary['current']['phases'][i]['timingsMs']['audit']['median']/summary['baseline']['phases'][i]['timingsMs']['audit']['median'] for i in range(3)];summary['limits']=['All three calls share the exact static snapshot. No capture, event replay or new real browser state is simulated.','Task/plugin/cumulative events and saves are carried forward; startup normalization only once.','Memory host/sink do not measure DB reads/writes or complete task resume.','Root released CPU window; light reporting/hash/Git may coexist; no OS-exclusive guarantee.'];summary['execution']=execution;write(EVIDENCE/'summary.json',summary);print(json.dumps({'auditMedianRatios':summary['auditMedianRatios'],'phases':{name:[{'phase':p['phase'],'auditMs':p['timingsMs']['audit']['median'],'newRows':p['stableResult']['newRows'],'events':p['stableResult']['eventCounts']} for p in summary[name]['phases']] for name in ['baseline','current']}}))
