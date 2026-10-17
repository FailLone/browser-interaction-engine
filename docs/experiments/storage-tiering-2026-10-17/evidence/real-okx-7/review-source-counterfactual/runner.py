#!/usr/bin/env python3
"""One behavior-only e06 selector run, reusing completed 875 full semantic evidence."""
import argparse,gzip,hashlib,importlib.util,json,os,pathlib,shutil,signal,subprocess,tempfile,time
HERE=pathlib.Path(__file__).resolve().parent
ROOT=HERE.parents[5]
PRIOR=HERE.parent/'source-material-isolation'
BASE='875ce5019751c8222df23cba00a63a1ddc1c29c9'
CURRENT='e06f057ecc1fd43feaa8cfa42d14c65e9750a08e'
NODE=pathlib.Path('/Users/xietian/.local/share/fnm/node-versions/v24.22.0/installation/bin/node')
def sha(p):
 h=hashlib.sha256()
 with open(p,'rb') as f:
  for block in iter(lambda:f.read(1048576),b''):h.update(block)
 return h.hexdigest()
def write(p,v):p.write_text(json.dumps(v,ensure_ascii=False,indent=2)+'\n')
def main():
 ap=argparse.ArgumentParser(description=__doc__);ap.add_argument('--run',action='store_true');args=ap.parse_args()
 if not args.run:print('Prepared only. --run adds one e06 read-only worker; no new baseline run, no performance comparison.');return
 assert not (HERE/'setup.json').exists(),'Never overwrite execution'
 old=json.loads((PRIOR/'setup.json').read_text());execution=json.loads((PRIOR/'execution.json').read_text());index=json.loads((PRIOR/'semantic-artifacts.json').read_text())
 assert old['archives']['current']['revision']==BASE and execution['error'] is None and len(execution['commands'])==6 and all(r['exitCode']==0 for r in execution['commands'])
 assert all(execution['archivesUnchanged'].values()) and execution['inputUnchanged'] and execution['workerUnchanged']
 assert sha(HERE/'worker.ts')==old['workerSha256'] and sha(pathlib.Path(old['input']))==old['inputSha256']
 base=index['pair-1-current'];packed=PRIOR/base['path'];assert sha(packed)==base['gzipSha256'];assert hashlib.sha256(gzip.decompress(packed.read_bytes())).hexdigest()==base['logicalSha256']
 for where in ['copy','frozen']:
  assert all(sha(pathlib.Path(old[where])/name)==value for name,value in old['databaseHashes'].items())
 owned=pathlib.Path(tempfile.mkdtemp(prefix='bie-run7-review-source-')).resolve();inp=owned/'input.json';shutil.copy2(old['input'],inp)
 helper=ROOT/'docs/experiments/storage-tiering-2026-10-17/evidence/real-okx-6/audit-serial/runner.py'
 spec=importlib.util.spec_from_file_location('archive',helper);h=importlib.util.module_from_spec(spec);spec.loader.exec_module(h);h.HERE=HERE
 archive=h.setup_archive(owned/'current',CURRENT);write(HERE/'source-before.json',archive['sourceManifest']);shutil.copy2(packed,HERE/'baseline-semantic.json.gz');shutil.copy2(PRIOR/'pair-1-current.json',HERE/'baseline-worker.json')
 setup={'baselineRevision':BASE,'currentRevision':CURRENT,'baselineEvidence':str(PRIOR),'baselineExecutionSha256':sha(PRIOR/'execution.json'),'baselineSemantic':base,'ownedDirectory':str(owned),'archive':archive,'input':str(inp),'inputSha256':sha(inp),'taskSha256':old['taskSha256'],'copy':old['copy'],'frozen':old['frozen'],'databaseHashes':old['databaseHashes'],'workerSha256':sha(HERE/'worker.ts'),'runnerSha256':sha(HERE/'runner.py'),'archiveHelperSha256':sha(helper),'scope':'Behavior-only final-task counterfactual. Full803 plan/final failed route remain; earlier observed current/cursor plus cleared deferred cache from prior preparation. Not exact live prestate; baseline choice53cc4e09 differs from live35a22c35.'};write(HERE/'setup.json',setup)
 cfg={'mode':'sqlite','sourceRoot':archive['root'],'revision':CURRENT,'input':str(inp),'taskSha256':old['taskSha256'],'database':str(pathlib.Path(old['copy'])/'engine/engine.sqlite'),'material':str(owned/'current-material.json'),'output':str(HERE/'current-worker.json'),'semantic':str(owned/'current-semantic.json')};cf=owned/'config.json';write(cf,cfg)
 env={k:os.environ[k] for k in ['HOME','LANG','LC_ALL'] if k in os.environ};env.update(PATH=str(NODE.parent)+':/usr/bin:/bin:/usr/sbin:/sbin',CI='true',NO_COLOR='1',TSX_DISABLE_CACHE='1',TMPDIR=str(owned))
 cmd=[str(NODE),'--max-old-space-size=6144','--conditions=development','--import=tsx',str(pathlib.Path(archive['root'])/'.data/worker.ts'),str(cf)];row={'argv':cmd,'startEpoch':time.time()}
 with open(HERE/'current-worker.log','wb') as log:
  child=subprocess.Popen(cmd,cwd=archive['root'],env=env,stdout=log,stderr=subprocess.STDOUT,start_new_session=True);row['pid']=child.pid;write(HERE/'progress.json',row)
  try:row['exitCode']=child.wait(timeout=180)
  except subprocess.TimeoutExpired:row['timedOut']=True;os.killpg(child.pid,signal.SIGTERM);row['exitCode']=child.wait(timeout=15)
 row['endEpoch']=time.time();write(HERE/'progress.json',row)
 after=h.manifest(pathlib.Path(archive['root']));write(HERE/'source-after.json',after)
 result={'command':row,'sourceUnchanged':after==archive['sourceManifest'],'inputUnchanged':sha(inp)==setup['inputSha256'],'workerUnchanged':sha(HERE/'worker.ts')==setup['workerSha256'],'archiveWorkerUnchanged':sha(pathlib.Path(archive['root'])/'.data/worker.ts')==setup['workerSha256'],'copyUnchanged':all(sha(pathlib.Path(old['copy'])/name)==value for name,value in old['databaseHashes'].items()),'frozenUnchanged':all(sha(pathlib.Path(old['frozen'])/name)==value for name,value in old['databaseHashes'].items()),'noPerformanceComparison':True}
 if row['exitCode']==0:
  logical=pathlib.Path(cfg['semantic']).read_bytes()
  with open(HERE/'current-semantic.json.gz','wb') as raw,gzip.GzipFile(fileobj=raw,mode='wb',mtime=0) as out:out.write(logical)
  result['currentSemantic']={'logicalBytes':len(logical),'logicalSha256':hashlib.sha256(logical).hexdigest(),'storedSha256':sha(HERE/'current-semantic.json.gz')}
 write(HERE/'execution.json',result);assert row['exitCode']==0 and all(result[k] for k in ['sourceUnchanged','inputUnchanged','workerUnchanged','archiveWorkerUnchanged','copyUnchanged','frozenUnchanged']);print(json.dumps(result))
if __name__=='__main__':main()
