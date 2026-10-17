#!/usr/bin/env python3
"""Execute only with --run. Isolated d103 vs 900edf7 fixed-input serial CPU comparison.
Six independent processes; complete task/event equality gates timing aggregation.
"""
import pathlib,json,os,subprocess,time,signal,shutil,statistics,importlib.util,tempfile,argparse
HERE=pathlib.Path(__file__).resolve().parent
SOURCE=pathlib.Path('/Users/xietian/.codex/worktrees/exploration-layered-refactor/browser-interaction-engine')
BASE=SOURCE/'docs/experiments/storage-tiering-2026-10-17/evidence/real-okx-6'
EVIDENCE=BASE/'audit-factory'
REVISIONS={'baseline':'d103747ee78779b3f1df8223854600cd321e36ee','current':'900edf7d5c60c3ddcf9265538758033ccecc5832'}
def load_module(name,path):
 spec=importlib.util.spec_from_file_location(name,path);module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module);return module
h=load_module('archive_helpers',BASE/'audit-serial/runner.py');h.HERE=HERE
sha,write,manifest,NODE=h.sha,h.write,h.manifest,h.NODE
comparison=load_module('semantic_comparator',HERE/'compare-semantic.py')
def old_evidence_state():
 state={}
 for name in ['audit-serial','audit-steady','audit-profile']:
  p=BASE/name;mf=json.loads((p/'artifact-manifest.json').read_text());assert all(sha(p/x['path'])==x['sha256'] for x in mf)
  state[name]={'manifestSha256':sha(p/'artifact-manifest.json'),'files':len(mf)}
 return state

def main():
 parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--run',action='store_true');args=parser.parse_args()
 if not args.run:print('Prepared only; requires exact frozen revisions and root CPU-window authorization.');return
 assert not EVIDENCE.exists(),'Never overwrite existing results'
 assert subprocess.check_output(['git','rev-parse',REVISIONS['current']+'^'],cwd=SOURCE,text=True).strip()==REVISIONS['baseline']
 changed=subprocess.check_output(['git','diff-tree','--no-commit-id','--name-only','-r',REVISIONS['current']],cwd=SOURCE,text=True).splitlines()
 protected=old_evidence_state();original_inputs=h.protect_inputs();cfg0=json.loads((BASE/'audit-serial/preparation.json').read_text());assert sha(cfg0['material'])==cfg0['materialSha256'];assert sha(HERE/'worker.ts')==json.loads((HERE/'worker-provenance.json').read_text())['workerSha256']
 EVIDENCE.mkdir();owned=pathlib.Path(tempfile.mkdtemp(prefix='bie-run6-audit-factory-owned-')).resolve();write(owned/'ownership.json',{'purpose':'isolated-factory-comparison','revisions':REVISIONS})
 material=owned/'material.json';shutil.copy2(cfg0['material'],material);assert sha(material)==cfg0['materialSha256']
 archives={name:h.setup_archive(owned/name,rev) for name,rev in REVISIONS.items()}
 for name,a in archives.items():write(EVIDENCE/(name+'-source-before.json'),a['sourceManifest'])
 for p in HERE.iterdir():
  if p.is_file() and p.name!='run.log':shutil.copy2(p,EVIDENCE/p.name)
 setup={'revisions':REVISIONS,'currentParent':REVISIONS['baseline'],'changedFiles':changed,'ownedDirectory':str(owned),'material':str(material),'materialBytes':material.stat().st_size,'materialSha256':cfg0['materialSha256'],'expectedInputs':cfg0['expectedInputs'],'expectedReconciledTaskSha256':cfg0['expectedReconciledTaskSha256'],'workerSha256':sha(HERE/'worker.ts'),'comparatorSha256':sha(HERE/'compare-semantic.py'),'runnerSha256':sha(HERE/'runner.py'),'archives':archives,'protectedEvidenceBefore':protected,'originalCounterfactualInputsBefore':original_inputs,'order':['baseline','current']*3,'processes':6,'auditsPerProcess':3,'normalization':'Both revisions execute startup normalization once; actual internal audit normalization is retained','semanticPolicy':'Full initial task plus complete task and accumulated event snapshots after each audit. Only genuinely newly appended plan UUID values mapped by append order. No field/key/array sorting/removal; dictionary comparison ignores object key order only.'};write(EVIDENCE/'setup.json',setup)
 tmp=owned/'runtime-tmp';tmp.mkdir();env={k:os.environ[k] for k in ['HOME','LANG','LC_ALL'] if k in os.environ};env.update({'PATH':str(NODE.parent)+':/usr/bin:/bin:/usr/sbin:/sbin','CI':'true','NO_COLOR':'1','TSX_DISABLE_CACHE':'1','TMPDIR':str(tmp)})
 commands=[];comparisons=[];canonical_first={};canonical_last={};ok=False;error=None
 def compare(left,right,label):
  aa,am=comparison.canonicalize(left);bb,bm=comparison.canonicalize(right);equal=aa==bb
  report={'label':label,'left':left.name,'right':right.name,'leftRawSha256':sha(left),'rightRawSha256':sha(right),'leftCanonical':am,'rightCanonical':bm,'equal':equal,'differences':comparison.differences(aa,bb),'policy':setup['semanticPolicy']}
  path=EVIDENCE/(label+'.json');write(path,report);comparisons.append({'file':path.name,'equal':equal,'sha256':sha(path),'canonicalSha256':am['canonicalSha256'] if equal else None});assert equal,f'Semantic difference: {path.name}'
 try:
  for pair in range(1,4):
   for order,name in enumerate(['baseline','current'],1):
    a=archives[name];archive=pathlib.Path(a['root']);assert manifest(archive)==a['sourceManifest'];assert sha(archive/'.data/worker.ts')==setup['workerSha256']
    output=EVIDENCE/f'pair-{pair}-{order}-{name}.json';semantic=EVIDENCE/f'pair-{pair}-{order}-{name}-semantic.json';cfg={k:cfg0[k] for k in ['materialSha256','expectedInputs','expectedReconciledTaskSha256']};cfg.update(material=str(material),sourceRoot=str(archive),revision=a['revision'],variant=name,normalize=True,output=str(output),semanticOutput=str(semantic));cf=archive/'.data/factory-config.json';write(cf,cfg)
    argv=[str(NODE),'--max-old-space-size=4096','--conditions=development','--import=tsx',str(archive/'.data/worker.ts'),str(cf)];row={'pair':pair,'order':order,'variant':name,'argv':argv,'startedEpoch':time.time(),'report':output.name,'semantic':semantic.name,'log':output.with_suffix('.log').name};commands.append(row)
    with open(output.with_suffix('.log'),'wb') as log:
     child=subprocess.Popen(argv,cwd=archive,env=env,stdout=log,stderr=subprocess.STDOUT,start_new_session=True);row['pid']=child.pid
     try:code=child.wait(timeout=90)
     except subprocess.TimeoutExpired:
      row['timedOut']=True;os.killpg(child.pid,signal.SIGTERM)
      try:code=child.wait(timeout=10)
      except subprocess.TimeoutExpired:os.killpg(child.pid,signal.SIGKILL);code=child.wait()
    row.update(exitCode=code,finishedEpoch=time.time());write(EVIDENCE/'progress.json',commands)
    if code:raise RuntimeError(f'{row["log"]} exited {code}')
    row.update(reportSha256=sha(output),semanticSha256=sha(semantic));assert manifest(archive)==a['sourceManifest']
    if name in canonical_first:compare(canonical_first[name],semantic,f'semantic-within-{name}-pair-{pair}')
    else:canonical_first[name]=semantic
    canonical_last[name]=semantic
   compare(canonical_last['baseline'],canonical_last['current'],f'semantic-cross-pair-{pair}')
  ok=True
 except BaseException as exc:error=f'{type(exc).__name__}: {exc}'
 finally:
  source_unchanged={name:manifest(pathlib.Path(a['root']))==a['sourceManifest'] for name,a in archives.items()};material_unchanged=sha(material)==cfg0['materialSha256'];old_unchanged=old_evidence_state()==protected;original_unchanged=h.protect_inputs()==original_inputs
  for name,a in archives.items():write(EVIDENCE/(name+'-source-after.json'),manifest(pathlib.Path(a['root'])))
  execution={'allExitZero':len(commands)==6 and all(r.get('exitCode')==0 for r in commands),'semanticGatePassed':ok,'error':error,'commands':commands,'comparisons':comparisons,'sourcesUnchanged':source_unchanged,'materialUnchanged':material_unchanged,'oldEvidenceUnchanged':old_unchanged,'originalCounterfactualInputsUnchanged':original_unchanged,'distinctProcesses':len(set(r['pid'] for r in commands))};write(EVIDENCE/'execution.json',execution)
 if not ok:raise RuntimeError(error)
 assert all(source_unchanged.values()) and material_unchanged and old_unchanged and original_unchanged
 summary={}
 for name in ['baseline','current']:
  reports=[json.loads((EVIDENCE/r['report']).read_text()) for r in commands if r['variant']==name];phases=[]
  for index in range(3):
   rows=[report['phases'][index] for report in reports];keys=['inputTaskRows','resultTaskRows','newRows','newByReason','newByStatus','normalizedBefore','normalizationReads','auditReads','totalReads','eventCounts','auditEventCounts','pendingActions','bytes','oldIntegrity','logicalReturnedJsonBytes','saveCalls','startupNormalizationApplied','cumulativeEvents','cumulativeSaveCalls','carryForward']
   stable={k:rows[0][k] for k in keys};assert all(all(row[k]==stable[k] for k in keys) for row in rows),'Same-revision structural results vary'
   timing={k:{'samples':[r['phaseTimingsMs'][k] for r in rows],'median':statistics.median(r['phaseTimingsMs'][k] for r in rows),'min':min(r['phaseTimingsMs'][k] for r in rows),'max':max(r['phaseTimingsMs'][k] for r in rows)} for k in ['constructor','startupNormalization','audit','normalizationPlusAudit']}
   cpu={k:{'samples':[r['phaseCpuMs'][k]['total'] for r in rows],'median':statistics.median(r['phaseCpuMs'][k]['total'] for r in rows)} for k in ['startupNormalization','audit']}
   phases.append({'phase':index+1,'timingsMs':timing,'phaseCpuMs':cpu,'peakRssKiB':[r['process']['resourceUsage']['maxRSS'] for r in rows],'stableResult':stable})
  summary[name]={'revision':REVISIONS[name],'processes':len(reports),'phases':phases}
 summary['auditMedianRatios']=[summary['current']['phases'][i]['timingsMs']['audit']['median']/summary['baseline']['phases'][i]['timingsMs']['audit']['median'] for i in range(3)];summary['startupNormalizationMedianRatio']=summary['current']['phases'][0]['timingsMs']['startupNormalization']['median']/summary['baseline']['phases'][0]['timingsMs']['startupNormalization']['median'];summary['firstNormalizationPlusAuditMedianRatio']=summary['current']['phases'][0]['timingsMs']['normalizationPlusAudit']['median']/summary['baseline']['phases'][0]['timingsMs']['normalizationPlusAudit']['median'];summary['semanticEquivalence']={'comparisons':len(comparisons),'allEqual':True,'canonicalSha256s':list(set(c['canonicalSha256'] for c in comparisons)),'policy':setup['semanticPolicy']};summary['execution']=execution;summary['limits']=['Three samples/version; no OS-wide exclusivity or multi-machine guarantee.','Same static snapshot through three audits, not live recapture or a complete resumed task.','Memory host/sink; no SQL/CAS/compression/network/model/browser/end-to-end performance claim.','Material parse, import, oracle, JSON-byte accounting and full semantic snapshot serialization occur outside phase clocks.','Peak RSS includes 327 MB material and full semantic snapshots, not production footprint.','The real fixed input has no nonempty unknown action or route flag; all original status/attempt/debt fields are preserved and fully compared.'];write(EVIDENCE/'summary.json',summary);print(json.dumps({'semanticEquivalence':summary['semanticEquivalence'],'auditMedianRatios':summary['auditMedianRatios'],'startupRatio':summary['startupNormalizationMedianRatio'],'combinedFirstRatio':summary['firstNormalizationPlusAuditMedianRatio'],'phases':{name:[{'phase':p['phase'],'startupMs':p['timingsMs']['startupNormalization']['median'],'auditMs':p['timingsMs']['audit']['median'],'newRows':p['stableResult']['newRows']} for p in summary[name]['phases']] for name in ['baseline','current']}}))
if __name__=='__main__':main()
