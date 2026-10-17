#!/usr/bin/env python3
"""One diagnostic profiled d103 worker, excluded from all timing aggregates."""
import pathlib,json,os,subprocess,time,shutil,importlib.util
ROOT=pathlib.Path('/Users/xietian/.codex/worktrees/exploration-layered-refactor/browser-interaction-engine');E=ROOT/'docs/experiments/storage-tiering-2026-10-17/evidence/real-okx-6';out=E/'audit-profile';out.mkdir(exist_ok=False)
spec=importlib.util.spec_from_file_location('helper',E/'audit-serial/runner.py');h=importlib.util.module_from_spec(spec);spec.loader.exec_module(h)
c=json.loads((E/'audit-serial/preparation.json').read_text());a=c['archives']['current'];archive=pathlib.Path(a['root']);assert h.manifest(archive)==a['sourceManifest'];worker=archive/'.data/steady-worker.ts';assert h.sha(worker)==h.sha(E/'audit-steady/worker.ts')
shutil.copy2(__file__,out/'profile.py');shutil.copy2(worker,out/'worker.ts')
config={k:c[k] for k in ['material','materialSha256','expectedInputs','expectedReconciledTaskSha256']};config.update(sourceRoot=str(archive),revision=a['revision'],variant='current-profile-only',normalize=True,output=str(out/'worker-result.json'));cf=archive/'.data/profile-config.json';h.write(cf,config)
env={k:os.environ[k] for k in ['HOME','LANG','LC_ALL'] if k in os.environ};env.update({'PATH':str(h.NODE.parent)+':/usr/bin:/bin:/usr/sbin:/sbin','CI':'true','NO_COLOR':'1','TSX_DISABLE_CACHE':'1','TMPDIR':str(pathlib.Path(c['ownedDirectory'])/'runtime-tmp')})
argv=[str(h.NODE),'--cpu-prof','--cpu-prof-interval=1000','--cpu-prof-dir='+str(out),'--max-old-space-size=4096','--conditions=development','--import=tsx',str(worker),str(cf)]
start=time.time()
with open(out/'worker.log','wb') as f:p=subprocess.run(argv,cwd=archive,env=env,stdout=f,stderr=subprocess.STDOUT,timeout=90)
report={'argv':argv,'exitCode':p.returncode,'elapsedSeconds':time.time()-start,'excludedFromPerformanceAggregates':True,'archiveSourceUnchanged':h.manifest(archive)==a['sourceManifest'],'materialUnchanged':h.sha(c['material'])==c['materialSha256'],'workerSha256':h.sha(worker),'profiles':[{'path':p.name,'bytes':p.stat().st_size,'sha256':h.sha(p)} for p in out.glob('*.cpuprofile')]};h.write(out/'execution.json',report);print(json.dumps(report));assert p.returncode==0 and report['archiveSourceUnchanged'] and report['materialUnchanged']
