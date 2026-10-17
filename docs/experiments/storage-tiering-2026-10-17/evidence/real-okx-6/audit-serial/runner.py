#!/usr/bin/env python3
"""Prepare isolated full-source archives; --run explicitly executes ten serial fresh processes.
No install, builds, tests, SDK instance, database, provider, or browser use.
"""
import argparse,hashlib,json,os,pathlib,shutil,signal,subprocess,tarfile,tempfile,time,statistics
SOURCE=pathlib.Path('/Users/xietian/.codex/worktrees/exploration-layered-refactor/browser-interaction-engine')
HERE=pathlib.Path(__file__).resolve().parent
EVIDENCE=SOURCE/'docs/experiments/storage-tiering-2026-10-17/evidence/real-okx-6/audit-serial'
ORIGINAL=EVIDENCE.parent
NODE=pathlib.Path('/Users/xietian/.local/share/fnm/node-versions/v24.22.0/installation/bin/node')
REVISIONS={'baseline':'f6d7b9e2b427b5edf1fad359ecf8cc5a3df8ffcf','current':'d103747ee78779b3f1df8223854600cd321e36ee'}
def sha(p):
 h=hashlib.sha256()
 with open(p,'rb') as f:
  for c in iter(lambda:f.read(1048576),b''):h.update(c)
 return h.hexdigest()
def write(p,v):p.write_text(json.dumps(v,ensure_ascii=False,indent=2)+'\n')
def manifest(root):
 return [{'path':str(p.relative_to(root)),'bytes':p.stat().st_size,'sha256':sha(p)} for p in sorted(root.rglob('*')) if p.is_file() and not p.is_symlink() and not {'node_modules','.data'}.intersection(p.relative_to(root).parts)]
def protect_inputs():
 files=['full-audit-counterfactual-indexed.ts','full-audit-counterfactual-indexed.json','full-audit-indexed-source.json','plan-growth-extraction.json']
 return {p:sha(ORIGINAL/p) for p in files}
def setup_archive(path,revision):
 path.mkdir();tar=path/'.source.tar'
 with open(tar,'wb') as f:subprocess.run(['git','archive','--format=tar',revision],cwd=SOURCE,stdout=f,check=True)
 with tarfile.open(tar) as tf:
  for m in tf.getmembers():
   p=pathlib.PurePosixPath(m.name)
   assert not p.is_absolute() and '..' not in p.parts and not m.issym() and not m.islnk()
   assert not any(x=='.env' or x.startswith('.env.') and not x.endswith('.example') for x in p.parts)
  tf.extractall(path)
 tar.unlink();before=manifest(path)
 packages=[path/'package.json']+sorted((path/'packages').glob('*/package.json'))+sorted((path/'apps').glob('*/package.json'))
 names={json.loads(p.read_text())['name']:p.parent for p in packages[1:]};links=[];external=[]
 for package in packages:
  local=package.parent/'node_modules';original=SOURCE/package.parent.relative_to(path)/'node_modules';local.mkdir(exist_ok=True)
  def link(name,src):
   dst=local/name
   if dst.exists():return
   target=names.get(name,src.resolve(strict=True));dst.parent.mkdir(parents=True,exist_ok=True);dst.symlink_to(target,target_is_directory=True)
   row={'name':name,'link':str(dst.relative_to(path)),'target':str(dst.resolve())}
   if name in names:assert dst.resolve().is_relative_to(path);links.append(row)
   else:assert 'node_modules' in target.parts;external.append(row)
  if original.is_dir():
   for e in sorted(original.iterdir()):
    if e.name.startswith('.'):continue
    if e.name.startswith('@'):
     for dep in sorted(e.iterdir()):link(e.name+'/'+dep.name,dep)
    else:link(e.name,e)
  meta=json.loads(package.read_text())
  for name in {**meta.get('dependencies',{}),**meta.get('devDependencies',{})}:
   if name in names:link(name,names[name])
 (path/'.data').mkdir();shutil.copy2(HERE/'worker.ts',path/'.data/worker.ts')
 return {'revision':revision,'root':str(path),'sourceManifest':before,'workspaceLinks':links,'externalDependencies':external,'workerSha256':sha(path/'.data/worker.ts')}
def prepare():
 assert not EVIDENCE.exists(),'Never replace a previous preparation/run'
 EVIDENCE.mkdir()
 original=json.loads((ORIGINAL/'full-audit-counterfactual-indexed.json').read_text())
 extracted=json.loads((ORIGINAL/'plan-growth-extraction.json').read_text());material=pathlib.Path(extracted['material'])
 assert sha(material)==original['inputs']['materialSha256']
 base=json.loads(pathlib.Path('/tmp/okx-run6-audit-baseline.json').read_text());assert base['revision']==REVISIONS['baseline']
 owned=pathlib.Path(tempfile.mkdtemp(prefix='bie-run6-audit-serial-owned-')).resolve();write(owned/'ownership.json',{'purpose':'run6-serial-fixed-input-audit','revisions':REVISIONS})
 private_material=owned/'material.json';shutil.copy2(material,private_material);assert sha(private_material)==sha(material)
 archives={name:setup_archive(owned/name,revision) for name,revision in REVISIONS.items()}
 existing=pathlib.Path(base['sourceRoot']).resolve();matches=[];mismatches=[]
 for row in archives['baseline']['sourceManifest']:
  p=existing/row['path']
  (matches if p.is_file() and sha(p)==row['sha256'] else mismatches).append(row['path'])
 assert not mismatches, f'Existing original baseline archive differs from f6: {mismatches}'
 for name,a in archives.items():write(EVIDENCE/(name+'-source-before.json'),a['sourceManifest'])
 # Preparation only: parse/count/hash the same material; no plugin import or algorithm execution.
 inspect=owned/'inspect.mjs'
 inspect.write_text("""import fs from 'node:fs';import crypto from 'node:crypto';
const m=JSON.parse(fs.readFileSync(process.argv[2],'utf8')),hash=v=>crypto.createHash('sha256').update(JSON.stringify(v)).digest('hex'),c='c11abe9e-e2a4-44f2-bf53-64ebf22a1dd2',audit=m.events.find(e=>e.type==='scope.audit'&&e.data.observationId===c),r=m.events.find(e=>e.type==='recovery.position_reconciled'&&e.data.position?.observationId===c),t=structuredClone(m.before);t.rounds.at(-1).entryPath=structuredClone(r.data.path);t.rounds.at(-1).position=structuredClone(r.data.position);const count=rows=>rows.reduce((a,r)=>(a[r.status||r.outcome]=(a[r.status||r.outcome]||0)+1,a),{});
console.log(JSON.stringify({taskRows:t.plan.length,taskBeforeHash:hash(m.before),reconciledTaskHash:hash(t),entryPath:r.data.path,eventSequence:r.sequence,allActions:m.actions[c].length,pendingActions:audit.data.pendingActions.length,operationFacts:audit.data.operationFacts.length,identityObligations:audit.data.obligations.identities.length,observations:Object.keys(m.observations).length,actionGroups:Object.keys(m.actions).length,attempts:m.attempts.length,attemptStatuses:count(m.attempts),planStatuses:count(t.plan),planAttemptOutcomes:count(t.plan.flatMap(i=>i.attempts)),taskPendingDispatch:t.pendingDispatch||null,routeRetries:t.routeRetries||null,scheduling:t.scheduling||null,nonemptyPrerequisiteRows:t.plan.filter(i=>i.prerequisites.length).length,exactEvidenceRefs:t.plan.reduce((n,i)=>n+i.evidence.length,0),roundsHash:hash(t.rounds),routeRetriesHash:hash(t.routeRetries??null),schedulingHash:hash(t.scheduling??null)}));
""")
 p=subprocess.run([str(NODE),str(inspect),str(private_material)],check=True,capture_output=True,text=True)
 inspected=json.loads(p.stdout);assert inspected['reconciledTaskHash']==original['results']['baseline']['inputTaskSha256'];assert inspected['entryPath']==[] and inspected['pendingActions']==204 and inspected['allActions']==206
 write(EVIDENCE/'fixed-input-inspection.json',inspected)
 for p in [HERE/'worker.ts',HERE/'runner.py',HERE/'make-worker.py',HERE/'oracle-equivalence.json']:shutil.copy2(p,EVIDENCE/p.name)
 config={'preparedAt':time.strftime('%Y-%m-%dT%H:%M:%S%z'),'originalInputs':protect_inputs(),'originalMaterial':str(material),'material':str(private_material),'materialBytes':private_material.stat().st_size,'materialSha256':sha(private_material),'expectedInputs':original['inputs'],'expectedReconciledTaskSha256':inspected['reconciledTaskHash'],'ownedDirectory':str(owned),'archives':archives,'originalBaselineVerification':{'root':str(existing),'matchedTrackedFiles':len(matches),'mismatches':mismatches,'allWorkspaceImportsInsideOwnedArchives':True},'workerSha256':sha(HERE/'worker.ts'),'runnerSha256':sha(HERE/'runner.py'),'plan':{'processes':10,'pairs':5,'order':'AB,BA,AB,BA,AB','freshProcesses':True,'phaseBoundaries':['plugin constructor','startup scheduling normalization','complete auditRemainingScopes'],'clockExclusions':['archive/material construction','module import','JSON parse','report/oracle/hash/byte accounting','plugin close'],'memoryHostAndSink':True,'databaseBrowserProviderUse':False}}
 write(EVIDENCE/'preparation.json',config)
 print(json.dumps({'prepared':True,'directory':str(EVIDENCE),'ownedDirectory':str(owned),'originalBaselineMatchedFiles':len(matches),'worker':config['workerSha256'],'fixture':{k:inspected[k] for k in ['taskRows','allActions','pendingActions','entryPath','nonemptyPrerequisiteRows','attemptStatuses','planAttemptOutcomes']}}))
def run():
 config=json.loads((EVIDENCE/'preparation.json').read_text());assert protect_inputs()==config['originalInputs'];assert sha(config['material'])==config['materialSha256'];assert sha(HERE/'worker.ts')==config['workerSha256'];assert sha(HERE/'runner.py')==config['runnerSha256']
 assert not (EVIDENCE/'execution.json').exists(),'Never rerun into existing execution evidence'
 env={k:os.environ[k] for k in ['HOME','LANG','LC_ALL'] if k in os.environ};env.update({'PATH':str(NODE.parent)+':/usr/bin:/bin:/usr/sbin:/sbin','CI':'true','NO_COLOR':'1','TSX_DISABLE_CACHE':'1'})
 owned=pathlib.Path(config['ownedDirectory']);tmp=owned/'runtime-tmp';tmp.mkdir();env['TMPDIR']=str(tmp)
 results=[];ok=False;error=None
 try:
  for pair in range(1,6):
   order=['baseline','current'] if pair%2 else ['current','baseline']
   for index,name in enumerate(order):
    a=config['archives'][name];archive=pathlib.Path(a['root']);assert manifest(archive)==a['sourceManifest'];assert sha(archive/'.data/worker.ts')==config['workerSha256']
    output=EVIDENCE/f'pair-{pair}-{index+1}-{name}.json';cfg={k:config[k] for k in ['material','materialSha256','expectedInputs','expectedReconciledTaskSha256']};cfg.update(sourceRoot=str(archive),revision=a['revision'],variant=name,normalize=name=='current',output=str(output));cf=archive/'.data/config.json';write(cf,cfg)
    argv=[str(NODE),'--max-old-space-size=4096','--conditions=development','--import=tsx',str(archive/'.data/worker.ts'),str(cf)]
    row={'pair':pair,'order':index+1,'variant':name,'pid':None,'argv':argv,'startedEpoch':time.time(),'log':output.with_suffix('.log').name,'report':output.name};results.append(row)
    with open(output.with_suffix('.log'),'wb') as log:
     child=subprocess.Popen(argv,cwd=archive,env=env,stdout=log,stderr=subprocess.STDOUT,start_new_session=True);row['pid']=child.pid
     try:code=child.wait(timeout=90)
     except subprocess.TimeoutExpired:
      row['timedOut']=True;os.killpg(child.pid,signal.SIGTERM);code=child.wait(timeout=10)
    row.update(exitCode=code,finishedEpoch=time.time());write(EVIDENCE/'progress.json',results)
    if code:raise RuntimeError(f'{row["log"]} failed exit {code}')
    assert manifest(archive)==a['sourceManifest'];report=json.loads(output.read_text());row['jsonSha256']=sha(output);row['workerPid']=report['report']['process']['pid']
  ok=True
 except BaseException as e:error=type(e).__name__+': '+str(e)
 finally:
  original_unchanged=protect_inputs()==config['originalInputs'];material_unchanged=sha(config['material'])==config['materialSha256'];sources_unchanged={name:manifest(pathlib.Path(a['root']))==a['sourceManifest'] for name,a in config['archives'].items()}
  for name,a in config['archives'].items():write(EVIDENCE/(name+'-source-after.json'),manifest(pathlib.Path(a['root'])))
  execution={'allExitZero':ok,'error':error,'commands':results,'originalCounterfactualInputsUnchanged':original_unchanged,'fixedMaterialUnchanged':material_unchanged,'archiveSourcesUnchanged':sources_unchanged,'independentWorkerPids':len(set(r.get('workerPid') for r in results if r.get('workerPid'))),'finishedAt':time.strftime('%Y-%m-%dT%H:%M:%S%z')};write(EVIDENCE/'execution.json',execution)
 if not ok:raise RuntimeError(error)
 assert original_unchanged and material_unchanged and all(sources_unchanged.values())
 summarize()
def summarize():
 execution=json.loads((EVIDENCE/'execution.json').read_text());groups={name:[json.loads((EVIDENCE/r['report']).read_text())['report'] for r in execution['commands'] if r['variant']==name] for name in REVISIONS};summary={}
 for name,rows in groups.items():
  timings={key:{'samples':[r['phaseTimingsMs'][key] for r in rows],'min':min(r['phaseTimingsMs'][key] for r in rows),'median':statistics.median(r['phaseTimingsMs'][key] for r in rows),'max':max(r['phaseTimingsMs'][key] for r in rows)} for key in ['constructor','startupNormalization','audit','normalizationPlusAudit']}
  stablekeys=['inputTaskSha256','inputTaskRows','resultTaskRows','newRows','newByReason','newByStatus','beforeByStatus','afterByStatus','normalizedBefore','normalizationReads','auditReads','totalReads','eventCounts','pendingActions','incomplete','bytes','oldIntegrity','logicalReturnedJsonBytes','saveCalls']
  stable={key:rows[0][key] for key in stablekeys};assert all(all(row[key]==stable[key] for key in stablekeys) for row in rows),'Semantic/byte/count report unstable within revision'
  summary[name]={'revision':REVISIONS[name],'processes':len(rows),'timingsMs':timings,'stableResult':stable,'peakRssKiB':[r['process']['resourceUsage']['maxRSS'] for r in rows]}
 a,b=summary['baseline'],summary['current'];summary['deltas']={'auditMedianMs':b['timingsMs']['audit']['median']-a['timingsMs']['audit']['median'],'auditMedianRatio':b['timingsMs']['audit']['median']/a['timingsMs']['audit']['median'],'normalizationPlusAuditMedianRatio':b['timingsMs']['normalizationPlusAudit']['median']/a['timingsMs']['normalizationPlusAudit']['median'],'newRows':b['stableResult']['newRows']-a['stableResult']['newRows'],'finalTaskJsonBytes':b['stableResult']['bytes']['finalTask']-a['stableResult']['bytes']['finalTask']}
 summary['methodology']={'processes':10,'pairs':5,'order':'AB,BA,AB,BA,AB','input':'Exact unchanged material; task-before with recorded seq2952 empty path/position only. Same original oracle retained verbatim.','timing':'First-call synchronous CPU wall time in fresh Node processes. Startup normalization separate. Original oracle, output serialization, import and parse outside phase clocks.','boundaries':'Memory host and sink; no DB decoding, SQLite storage, browser, network/provider, complete resume or end-to-end performance measured.','hostJsonBytes':'Serialized logical size of returned objects outside clock, not bytes actually read.','warmCache':'No warmup or repeated in-process calls; TSX cache disabled. OS file/dependency caches not controlled and import/parse excluded.','cohost':'Root released CPU window; root may perform light report/hash/Git work. No OS-wide exclusivity or repeated-hardware validation.'}
 summary['execution']=execution;write(EVIDENCE/'summary.json',summary);print(json.dumps(summary['deltas']))
if __name__=='__main__':
 p=argparse.ArgumentParser(description=__doc__);p.add_argument('--run',action='store_true');a=p.parse_args();run() if a.run else prepare()
