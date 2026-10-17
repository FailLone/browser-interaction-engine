#!/usr/bin/env python3
"""Fixed-source, serial SDK read comparison. --run is required; no browser or SDK constructor."""
import argparse,gzip,hashlib,importlib.util,json,os,pathlib,shutil,signal,statistics,subprocess,tempfile,time
HERE=pathlib.Path(__file__).resolve().parent
ROOT=HERE.parents[5]
OLD=HERE.parent/'route-selection'
BASE='106a1cdfddfe3e73cab9e01b28ba4dd8439653e2'
NODE=pathlib.Path('/Users/xietian/.local/share/fnm/node-versions/v24.22.0/installation/bin/node')
def sha(p):
 h=hashlib.sha256()
 with open(p,'rb') as f:
  for block in iter(lambda:f.read(1048576),b''):h.update(block)
 return h.hexdigest()
def write(p,value):p.write_text(json.dumps(value,ensure_ascii=False,indent=2)+'\n')
def main():
 ap=argparse.ArgumentParser(description=__doc__);ap.add_argument('--run',action='store_true');ap.add_argument('--current',required=True);args=ap.parse_args()
 if not args.run:print('Prepared only; --run executes six serial read-only workers.');return
 assert not (HERE/'execution.json').exists() and not (HERE/'setup.json').exists(),'Never overwrite an experiment'
 prior=json.loads((OLD/'setup.json').read_text());prep=json.loads((OLD/'fresh-deferrals-preparation.json').read_text())
 assert sha(pathlib.Path(prep['input']))==prep['inputSha256']
 for root in ['frozen','copy']:
  assert all(sha(pathlib.Path(prior[root])/name)==value for name,value in prior['frozenDatabasesBefore'].items())
 helper=ROOT/'docs/experiments/storage-tiering-2026-10-17/evidence/real-okx-6/audit-serial/runner.py'
 spec=importlib.util.spec_from_file_location('archive',helper);h=importlib.util.module_from_spec(spec);spec.loader.exec_module(h);h.HERE=HERE
 owned=pathlib.Path(tempfile.mkdtemp(prefix='bie-run7-source-material-isolation-')).resolve()
 write(owned/'ownership.json',{'purpose':'source-material readonly comparison','baseline':BASE,'current':args.current})
 inp=owned/'input.json';shutil.copy2(prep['input'],inp)
 archives={name:h.setup_archive(owned/name,revision) for name,revision in [('baseline',BASE),('current',args.current)]}
 for name,archive in archives.items():write(HERE/f'{name}-source.json',archive['sourceManifest'])
 setup={'ownedDirectory':str(owned),'archives':archives,'input':str(inp),'inputSha256':sha(inp),'taskSha256':prep['taskSha256'],
  'copy':prior['copy'],'frozen':prior['frozen'],'databaseHashes':prior['frozenDatabasesBefore'],'priorPreparation':str(OLD/'fresh-deferrals-preparation.json'),
  'priorPreparationSha256':sha(OLD/'fresh-deferrals-preparation.json'),'workerSha256':sha(HERE/'worker.ts'),'runnerSha256':sha(HERE/'runner.py'),
  'scope':'Final task with all debt; prior real observation; cursor and deferred cache changes documented by prior preparation; not exact live pre-state.'}
 write(HERE/'setup.json',setup)
 env={k:os.environ[k] for k in ['HOME','LANG','LC_ALL'] if k in os.environ};env.update(PATH=str(NODE.parent)+':/usr/bin:/bin:/usr/sbin:/sbin',CI='true',NO_COLOR='1',TSX_DISABLE_CACHE='1',TMPDIR=str(owned))
 commands=[];comparisons=[];error=None;semanticIndex={};reports={name:[] for name in archives}
 try:
  for pair in range(1,4):
   outputs={}
   for name in (['baseline','current'] if pair%2 else ['current','baseline']):
    archive=archives[name];stem=f'pair-{pair}-{name}';semantic=owned/f'{stem}.json'
    config={'mode':'sqlite','sourceRoot':archive['root'],'revision':archive['revision'],'input':str(inp),'taskSha256':prep['taskSha256'],
      'database':str(pathlib.Path(prior['copy'])/'engine/engine.sqlite'),'material':str(owned/f'{stem}-material.json'),
      'output':str(HERE/f'{stem}.json'),'semantic':str(semantic)}
    cf=owned/f'{stem}-config.json';write(cf,config)
    argv=[str(NODE),'--max-old-space-size=6144','--conditions=development','--import=tsx',str(pathlib.Path(archive['root'])/'.data/worker.ts'),str(cf)]
    row={'pair':pair,'variant':name,'argv':argv,'startEpoch':time.time()};commands.append(row)
    with open(HERE/f'{stem}.log','wb') as log:
     child=subprocess.Popen(argv,cwd=archive['root'],env=env,stdout=log,stderr=subprocess.STDOUT,start_new_session=True);row['pid']=child.pid
     write(HERE/'progress.json',commands)
     try:row['exitCode']=child.wait(timeout=180)
     except subprocess.TimeoutExpired:
      row['timedOut']=True;os.killpg(child.pid,signal.SIGTERM);row['exitCode']=child.wait(timeout=15)
    row['endEpoch']=time.time();write(HERE/'progress.json',commands);assert row['exitCode']==0,stem
    outputs[name]=semantic;reports[name].append(json.loads((HERE/f'{stem}.json').read_text()))
    logicalHash=sha(semantic);objects=HERE/'semantic-objects';objects.mkdir(exist_ok=True);packed=objects/f'{logicalHash}.json.gz'
    if not packed.exists():
     with open(packed,'wb') as raw,gzip.GzipFile(fileobj=raw,mode='wb',mtime=0) as out:out.write(semantic.read_bytes())
    assert hashlib.sha256(gzip.decompress(packed.read_bytes())).hexdigest()==logicalHash
    semanticIndex[stem]={'path':str(packed.relative_to(HERE)),'logicalSha256':logicalHash,'logicalBytes':semantic.stat().st_size,'gzipSha256':sha(packed)}
   assert outputs['baseline'].read_bytes()==outputs['current'].read_bytes(),'Complete task/choice/events differ'
   comparisons.append({'pair':pair,'equal':True,'completeSha256':sha(outputs['baseline'])})
   if pair==1:assert reports['current'][0]['timingsMs']['total']<reports['baseline'][0]['timingsMs']['total'],'No first-pair gain; stop'
 except BaseException as exc:error=f'{type(exc).__name__}: {exc}'
 finally:
  integrity={name:h.manifest(pathlib.Path(archive['root']))==archive['sourceManifest'] for name,archive in archives.items()}
  result={'commands':commands,'error':error,'comparisons':comparisons,'archivesUnchanged':integrity,
    'inputUnchanged':sha(inp)==setup['inputSha256'],'workerUnchanged':sha(HERE/'worker.ts')==setup['workerSha256'],
    'archiveWorkersUnchanged':all(sha(PathRoot/'.data/worker.ts')==setup['workerSha256'] for PathRoot in [pathlib.Path(a['root']) for a in archives.values()]),
    'copyDatabasesUnchanged':all(sha(pathlib.Path(prior['copy'])/p)==v for p,v in prior['frozenDatabasesBefore'].items()),
    'frozenDatabasesUnchanged':all(sha(pathlib.Path(prior['frozen'])/p)==v for p,v in prior['frozenDatabasesBefore'].items())}
  write(HERE/'execution.json',result);write(HERE/'semantic-artifacts.json',semanticIndex)
 if error:raise RuntimeError(error)
 assert all(integrity.values()) and all(result[k] for k in ['inputUnchanged','workerUnchanged','archiveWorkersUnchanged','copyDatabasesUnchanged','frozenDatabasesUnchanged'])
 summary={name:{'revision':archives[name]['revision'],'samplesMs':[r['timingsMs']['total'] for r in rr],
  'medianMs':statistics.median(r['timingsMs']['total'] for r in rr),'maxRSSKiB':[r['resources']['maxRSS'] for r in rr],
  'reads':rr[0]['reads'],'events':rr[0]['events'],'byteCounts':rr[0]['byteCounts']} for name,rr in reports.items()}
 summary['ratio']=summary['current']['medianMs']/summary['baseline']['medianMs'];summary['comparisons']=comparisons
 write(HERE/'summary.json',summary);print(json.dumps({k:summary[k]['medianMs'] for k in reports}))
if __name__=='__main__':main()
