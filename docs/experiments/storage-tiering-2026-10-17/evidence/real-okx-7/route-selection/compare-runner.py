#!/usr/bin/env python3
"""069 vs cbd5: exact complete semantic gate before three serial fresh-deferral timing pairs."""
import json,pathlib,subprocess,os,time,signal,importlib.util,argparse,statistics
HERE=pathlib.Path(__file__).resolve().parent
spec=importlib.util.spec_from_file_location('base',HERE/'runner.py');b=importlib.util.module_from_spec(spec);spec.loader.exec_module(b)
sha,write,NODE=b.sha,b.write,b.NODE
PATCH='cbd5b878329f8d3e454e8fd5110d0e2da4f749a7'
def main():
 ap=argparse.ArgumentParser(description=__doc__);ap.add_argument('--run',action='store_true');args=ap.parse_args()
 if not args.run:print('Prepared only. --run starts fixed archives, no live resources.');return
 assert not (HERE/'comparison-execution.json').exists()
 setup=json.loads((HERE/'setup.json').read_text());owned=pathlib.Path(setup['ownedDirectory']);baseline=setup['archive']
 helper=b.ROOT/'docs/experiments/storage-tiering-2026-10-17/evidence/real-okx-6/audit-serial/runner.py'
 sp=importlib.util.spec_from_file_location('archive',helper);h=importlib.util.module_from_spec(sp);sp.loader.exec_module(h);h.HERE=HERE
 current=h.setup_archive(owned/'patched',PATCH);write(HERE/'patched-source-before.json',current['sourceManifest'])
 archives={'baseline':baseline,'current':current};commands=[];comparisons=[];error=None
 controlled=json.loads((HERE/'controlled-preparation.json').read_text());fresh=json.loads((HERE/'fresh-deferrals-preparation.json').read_text())
 env={k:os.environ[k] for k in ['HOME','LANG','LC_ALL'] if k in os.environ};env.update({'PATH':str(NODE.parent)+':/usr/bin:/bin:/usr/sbin:/sbin','CI':'true','NO_COLOR':'1','TSX_DISABLE_CACHE':'1','TMPDIR':str(owned)})
 def execute(name,variant,input):
  arc=archives[variant];cfg={'mode':'sqlite','sourceRoot':arc['root'],'revision':arc['revision'],'input':input['input'],'database':str(pathlib.Path(setup['copy'])/'engine/engine.sqlite'),'taskSha256':input['taskSha256'],'material':str(owned/(name+'-material.json')),'output':str(HERE/(name+'.json')),'semantic':str(HERE/(name+'-semantic.json'))}
  cf=owned/(name+'-config.json');write(cf,cfg)
  cmd=[str(NODE),'--max-old-space-size=6144','--conditions=development','--import=tsx',str(pathlib.Path(arc['root'])/'.data/worker.ts'),str(cf)]
  row={'name':name,'variant':variant,'argv':cmd,'startedEpoch':time.time()};commands.append(row)
  with open(HERE/(name+'.log'),'wb') as log:
   child=subprocess.Popen(cmd,cwd=arc['root'],env=env,stdout=log,stderr=subprocess.STDOUT,start_new_session=True);row['pid']=child.pid
   try:row['exitCode']=child.wait(timeout=300)
   except subprocess.TimeoutExpired:row['timedOut']=True;os.killpg(child.pid,signal.SIGTERM);row['exitCode']=child.wait(timeout=15)
  row['finishedEpoch']=time.time();write(HERE/'comparison-progress.json',commands);assert row['exitCode']==0
  return json.loads((HERE/(name+'.json')).read_text())
 def compare(left,right,label):
  lp=HERE/(left+'-semantic.json');rp=HERE/(right+'-semantic.json');l=json.loads(lp.read_text());r=json.loads(rp.read_text());equal=l==r
  item={'label':label,'equal':equal,'left':lp.name,'right':rp.name,'leftSha256':sha(lp),'rightSha256':sha(rp),'comparison':'Entire input, entire selected result, entire task, ordered full events. No normalization or omitted fields.'};comparisons.append(item);write(HERE/(label+'.json'),item);assert equal,label
 try:
  first=execute('patched-cursor','current',controlled);compare('controlled-sqlite','patched-cursor','cursor-cross-semantic')
  base=json.loads((HERE/'controlled-sqlite.json').read_text())
  assert first['timingsMs']['total']<base['timingsMs']['total'],'No improvement in first controlled diagnostic; stop before repeats'
  for pair in range(1,4):
   for order,variant in enumerate(['baseline','current'],1):execute(f'pair-{pair}-{order}-{variant}',variant,fresh)
   compare(f'pair-{pair}-1-baseline',f'pair-{pair}-2-current',f'fresh-cross-semantic-{pair}')
   if pair>1:
    for order,variant in enumerate(['baseline','current'],1):compare(f'pair-1-{order}-{variant}',f'pair-{pair}-{order}-{variant}',f'fresh-within-{variant}-{pair}')
   if pair==1:
    aa=json.loads((HERE/'pair-1-1-baseline.json').read_text());bb=json.loads((HERE/'pair-1-2-current.json').read_text());assert bb['timingsMs']['total']<aa['timingsMs']['total'],'No first-pair net gain; stop'
 except BaseException as exc:error=f'{type(exc).__name__}: {exc}'
 finally:
  integrity={name:h.manifest(pathlib.Path(arc['root']))==arc['sourceManifest'] for name,arc in archives.items()}
  write(HERE/'patched-source-after.json',h.manifest(pathlib.Path(current['root'])))
  result={'revisions':{name:arc['revision'] for name,arc in archives.items()},'commands':commands,'comparisons':comparisons,'error':error,'archivesUnchanged':integrity,'copyDatabasesUnchanged':all(sha(pathlib.Path(setup['copy'])/p)==v for p,v in setup['frozenDatabasesBefore'].items()),'frozenDatabasesUnchanged':all(sha(pathlib.Path(setup['frozen'])/p)==v for p,v in setup['frozenDatabasesBefore'].items()),'workerUnchanged':sha(HERE/'worker.ts')==setup['workerSha256'],'runnerSha256':sha(HERE/'compare-runner.py')};write(HERE/'comparison-execution.json',result)
 if error:raise RuntimeError(error)
 summary={}
 for order,name in enumerate(['baseline','current'],1):
  reports=[json.loads((HERE/f'pair-{pair}-{order}-{name}.json').read_text()) for pair in range(1,4)]
  summary[name]={'revision':archives[name]['revision'],'samplesMs':[r['timingsMs']['total'] for r in reports],'medianMs':statistics.median(r['timingsMs']['total'] for r in reports),'reads':reports[0]['reads'],'events':reports[0]['events'],'completeSemanticSha256':reports[0]['completeSemanticSha256'],'byteCounts':reports[0]['byteCounts'],'maxRSS':[r['resources']['maxRSS'] for r in reports]}
 summary.update(ratio=summary['current']['medianMs']/summary['baseline']['medianMs'],semanticComparisons=comparisons,limits=['Counterfactual final task with real prior cursor; fresh current-reason cache only. All route failure debt/plan/source retained.','One synchronous selector, no actual recovery, browser/provider, task-store writes, or end-to-end speed claim.','Three serial fresh-process samples/version; controlled cursor baseline profile is excluded from these medians.','Time includes readonly SQLite/codec reads. Host return JSON byte accounting, material/report serialization, imports and setup excluded.'])
 write(HERE/'comparison-summary.json',summary);print(json.dumps({name:summary[name]['medianMs'] for name in ['baseline','current']}))
if __name__=='__main__':main()
