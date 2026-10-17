#!/usr/bin/env python3
"""Prepare and run a readonly route-selection counterfactual, only with --run."""
import pathlib,json,subprocess,shutil,tempfile,os,hashlib,importlib.util,time,signal,argparse
HERE=pathlib.Path(__file__).resolve().parent
ROOT=HERE.parents[5]
REV='069b65b47d951cdcced4d895e2abe33738267e5a'
NODE=pathlib.Path('/Users/xietian/.local/share/fnm/node-versions/v24.22.0/installation/bin/node')
def sha(p):
 h=hashlib.sha256()
 with open(p,'rb') as f:
  for b in iter(lambda:f.read(1048576),b''):h.update(b)
 return h.hexdigest()
def write(p,x):p.write_text(json.dumps(x,indent=2,ensure_ascii=False)+'\n')
def main():
 ap=argparse.ArgumentParser(description=__doc__);ap.add_argument('--run',action='store_true');args=ap.parse_args()
 if not args.run:print('Prepared; --run performs two serial fresh readonly diagnostic processes.');return
 assert not (HERE/'execution.json').exists(),'Never overwrite previous execution'
 freeze=json.loads((HERE.parent/'freeze.json').read_text());assert freeze['allHashesEqual'] and freeze['walShmFiles']==0 and not freeze['processPresent']
 frozen=pathlib.Path(freeze['frozen']);assert frozen.name.endswith('frozen-7')
 inputs={name:sha(frozen/name) for name in ['engine/engine.sqlite','plugin/explorer.sqlite']}
 raw=HERE.parent/'run';rawHashes={name:sha(raw/name) for name in ['task-after.json','metrics.jsonl']}
 task=json.loads((raw/'task-after.json').read_text());rows=[json.loads(l) for l in (raw/'metrics.jsonl').read_text().splitlines()];events=[r['data'] for r in rows if r['type']=='plugin.event']
 selection=[r for r in events if r['type']=='recovery.selected'][-1];current=selection['data']['currentObservationId'];audit=[r for r in events if r['type']=='scope.audit' and r['observationId']==current][-1]
 assert audit['sequence']==5138 and selection['sequence']==5369 and current=='f6ad38c2-acb1-4801-9edb-6ec802ce8ae7'
 assert len(task['plan'])==803 and selection['data']['routeKey'] in task['routeRetries']['routes']
 owned=pathlib.Path(tempfile.mkdtemp(prefix='bie-run7-route-owned-')).resolve();write(owned/'ownership.json',{'purpose':'readonly run7 route diagnostic','revision':REV})
 copy=owned/'full';shutil.copytree(frozen,copy)
 assert all(sha(copy/p)==v for p,v in inputs.items())
 helper=ROOT/'docs/experiments/storage-tiering-2026-10-17/evidence/real-okx-6/audit-serial/runner.py'
 spec=importlib.util.spec_from_file_location('archive_helpers',helper);h=importlib.util.module_from_spec(spec);spec.loader.exec_module(h);h.HERE=HERE
 archive=h.setup_archive(owned/'baseline',REV);write(HERE/'source-before.json',archive['sourceManifest'])
 cfgInput={'task':task,'sessionId':selection['sessionId'],'currentId':current,'audit':audit,'actualLiveSelectionEvent':selection}
 inp=owned/'input.json';write(inp,cfgInput)
 taskHash=hashlib.sha256(json.dumps(task,ensure_ascii=False,separators=(',',':')).encode()).hexdigest()
 # JavaScript JSON.stringify differs from Python for float spelling; record the exact JS hash.
 taskHash=subprocess.check_output([str(NODE),'--input-type=module','-e',"import fs from 'node:fs';import c from 'node:crypto';console.log(c.createHash('sha256').update(JSON.stringify(JSON.parse(fs.readFileSync(process.argv[1])).task)).digest('hex'))",str(inp)],text=True).strip()
 setup={'revision':REV,'ownedDirectory':str(owned),'copy':str(copy),'frozen':str(frozen),'frozenDatabasesBefore':inputs,'rawHashes':rawHashes,'archive':archive,'helperSha256':sha(helper),'input':str(inp),'inputSha256':sha(inp),'taskSha256':taskHash,'workerSha256':sha(HERE/'worker.ts'),'runnerSha256':sha(HERE/'runner.py'),'selectionReconstruction':'none: final task retained verbatim, paired with real earlier observation and availability','actualLiveScopeAuditSequence':5138,'actualLiveSelectionSequence':5369,'processes':2,'modes':['sqlite-profile','memory'],'originalFailureDebtPreserved':True}
 write(HERE/'setup.json',setup);commands=[];error=None
 env={k:os.environ[k] for k in ['HOME','LANG','LC_ALL'] if k in os.environ};env.update({'PATH':str(NODE.parent)+':/usr/bin:/bin:/usr/sbin:/sbin','CI':'true','NO_COLOR':'1','TSX_DISABLE_CACHE':'1','TMPDIR':str(owned)})
 try:
  for mode in ['sqlite','memory']:
   cfg={'mode':mode,'sourceRoot':archive['root'],'revision':REV,'input':str(inp),'database':str(copy/'engine/engine.sqlite'),'taskSha256':taskHash,'material':str(owned/'material.json'),'output':str(HERE/(mode+'.json')),'semantic':str(HERE/(mode+'-semantic.json'))}
   cf=owned/(mode+'-config.json');write(cf,cfg)
   cmd=[str(NODE),'--max-old-space-size=6144']
   if mode=='sqlite':cmd+=['--cpu-prof','--cpu-prof-dir='+str(HERE),'--cpu-prof-name=sqlite.cpuprofile']
   cmd+=['--conditions=development','--import=tsx',str(pathlib.Path(archive['root'])/'.data/worker.ts'),str(cf)]
   row={'mode':mode,'argv':cmd,'startEpoch':time.time()};commands.append(row)
   with open(HERE/(mode+'.log'),'wb') as log:
    child=subprocess.Popen(cmd,cwd=archive['root'],env=env,stdout=log,stderr=subprocess.STDOUT,start_new_session=True);row['pid']=child.pid
    try:row['exitCode']=child.wait(timeout=300)
    except subprocess.TimeoutExpired:
     row['timedOut']=True;os.killpg(child.pid,signal.SIGTERM);row['exitCode']=child.wait(timeout=15)
   row['endEpoch']=time.time();write(HERE/'progress.json',commands);assert row['exitCode']==0,f'{mode} exit {row["exitCode"]}'
   assert all(sha(copy/p)==v for p,v in inputs.items())
  left=json.loads((HERE/'sqlite-semantic.json').read_text());right=json.loads((HERE/'memory-semantic.json').read_text())
  assert left==right,'Complete input/selected/task/events differ'
  write(HERE/'semantic-comparison.json',{'equal':True,'policy':'Entire input/selected/task/events compared structurally, order retained; no fields or IDs removed','sqliteSha256':sha(HERE/'sqlite-semantic.json'),'memorySha256':sha(HERE/'memory-semantic.json')})
 except BaseException as exc:error=f'{type(exc).__name__}: {exc}'
 finally:
  after=h.manifest(pathlib.Path(archive['root']));write(HERE/'source-after.json',after)
  execution={'commands':commands,'allExitZero':len(commands)==2 and all(c.get('exitCode')==0 for c in commands),'error':error,'sourceUnchanged':after==archive['sourceManifest'],'frozenDatabasesUnchanged':all(sha(frozen/p)==v for p,v in inputs.items()),'copyDatabasesUnchanged':all(sha(copy/p)==v for p,v in inputs.items()),'rawInputsUnchanged':all(sha(raw/p)==v for p,v in rawHashes.items()),'inputUnchanged':sha(inp)==setup['inputSha256'],'workerUnchanged':sha(HERE/'worker.ts')==setup['workerSha256']}
  write(HERE/'execution.json',execution)
 if error:raise RuntimeError(error)
 print(json.dumps(execution))
if __name__=='__main__':main()
