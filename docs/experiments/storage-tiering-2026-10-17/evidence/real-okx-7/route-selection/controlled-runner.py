#!/usr/bin/env python3
"""Explicit cursor-only counterfactual. Never removes final facts, failure debt or deferrals."""
import json,pathlib,subprocess,os,time,signal,importlib.util,copy,argparse
HERE=pathlib.Path(__file__).resolve().parent
spec=importlib.util.spec_from_file_location('base',HERE/'runner.py');base=importlib.util.module_from_spec(spec);spec.loader.exec_module(base)
sha,write,NODE=base.sha,base.write,base.NODE
def main():
 ap=argparse.ArgumentParser(description=__doc__);ap.add_argument('--run',action='store_true');ap.add_argument('--case',choices=['cursor','fresh-deferrals'],default='cursor');args=ap.parse_args()
 prefix='controlled' if args.case=='cursor' else 'fresh-deferrals'
 setup=json.loads((HERE/'setup.json').read_text());owned=pathlib.Path(setup['ownedDirectory']);archive=pathlib.Path(setup['archive']['root']);sourceInput=json.loads(pathlib.Path(setup['input']).read_text());input=copy.deepcopy(sourceInput)
 rows=[json.loads(l) for l in (HERE.parent/'run/metrics.jsonl').read_text().splitlines()];events=[r['data'] for r in rows if r['type']=='plugin.event']
 previous=[e for e in events if e['type']=='obligation.selected' and e['sequence']<5138][-1]
 assert previous['sequence']==4918 and previous['data']['itemId']=='5480402f-ee64-49fc-9f3e-1cfe5ffce00f'
 oldCursor=input['task']['scheduling']['cursor'];input['task']['scheduling']['cursor']=previous['data']['itemId']
 paths=['task.scheduling.cursor']
 if args.case=='fresh-deferrals':input['task']['scheduling']['deferred']={};paths.append('task.scheduling.deferred')
 check=copy.deepcopy(input);check['task']['scheduling']['cursor']=oldCursor
 if args.case=='fresh-deferrals':check['task']['scheduling']['deferred']=copy.deepcopy(sourceInput['task']['scheduling']['deferred'])
 assert check==sourceInput
 inp=owned/(prefix+'-input.json');write(inp,input)
 taskHash=subprocess.check_output([str(NODE),'--input-type=module','-e',"import fs from 'node:fs';import c from 'node:crypto';console.log(c.createHash('sha256').update(JSON.stringify(JSON.parse(fs.readFileSync(process.argv[1])).task)).digest('hex'))",str(inp)],text=True).strip()
 preparation={'description':'Final task, cursor restored from actual prior obligation.selected sequence4918. In fresh-deferrals only, clear current scan-reason cache scheduling.deferred; all route failure debt remains. Not exact pre-selection task; not expected to reproduce original selected item.', 'case':args.case,'sourceInputSha256':setup['inputSha256'],'input':str(inp),'inputSha256':sha(inp),'taskSha256':taskHash,'onlyChangedPaths':paths,'from':oldCursor,'to':previous['data']['itemId'],'sourceEvent':previous,'allOtherFieldsEqual':True,'originalFailureDebtPreserved':True,'runtimeWorkerUnchanged':sha(HERE/'worker.ts')==setup['workerSha256']}
 if not args.run:write(HERE/(prefix+'-preparation.json'),preparation);print(json.dumps(preparation));return
 assert not (HERE/(prefix+'-execution.json')).exists(),'Do not overwrite earlier results';assert json.loads((HERE/(prefix+'-preparation.json')).read_text())==preparation
 commands=[];error=None;env={k:os.environ[k] for k in ['HOME','LANG','LC_ALL'] if k in os.environ};env.update({'PATH':str(NODE.parent)+':/usr/bin:/bin:/usr/sbin:/sbin','CI':'true','NO_COLOR':'1','TSX_DISABLE_CACHE':'1','TMPDIR':str(owned)})
 try:
  for mode in ['sqlite','memory']:
   cfg={'mode':mode,'sourceRoot':str(archive),'revision':setup['revision'],'input':str(inp),'database':str(pathlib.Path(setup['copy'])/'engine/engine.sqlite'),'taskSha256':taskHash,'material':str(owned/(prefix+'-material.json')),'output':str(HERE/(prefix+'-'+mode+'.json')),'semantic':str(HERE/(prefix+'-'+mode+'-semantic.json'))}
   cf=owned/(prefix+'-'+mode+'-config.json');write(cf,cfg)
   cmd=[str(NODE),'--max-old-space-size=6144']
   if mode=='sqlite' and args.case=='cursor':cmd+=['--cpu-prof','--cpu-prof-dir='+str(HERE),'--cpu-prof-name='+prefix+'-sqlite.cpuprofile']
   cmd+=['--conditions=development','--import=tsx',str(archive/'.data/worker.ts'),str(cf)]
   row={'mode':mode,'argv':cmd,'startedEpoch':time.time()};commands.append(row)
   with open(HERE/(prefix+'-'+mode+'.log'),'wb') as log:
    child=subprocess.Popen(cmd,cwd=archive,env=env,stdout=log,stderr=subprocess.STDOUT,start_new_session=True);row['pid']=child.pid
    try:row['exitCode']=child.wait(timeout=300)
    except subprocess.TimeoutExpired:row['timedOut']=True;os.killpg(child.pid,signal.SIGTERM);row['exitCode']=child.wait(timeout=15)
   row['finishedEpoch']=time.time();write(HERE/(prefix+'-progress.json'),commands);assert row['exitCode']==0
  left=json.loads((HERE/(prefix+'-sqlite-semantic.json')).read_text());right=json.loads((HERE/(prefix+'-memory-semantic.json')).read_text());assert left==right
  write(HERE/(prefix+'-semantic-comparison.json'),{'equal':True,'policy':'Complete input/selected/task/events; no field normalization','sqliteSha256':sha(HERE/(prefix+'-sqlite-semantic.json')),'memorySha256':sha(HERE/(prefix+'-memory-semantic.json'))})
 except BaseException as exc:error=f'{type(exc).__name__}: {exc}'
 finally:
  current={p['path']:sha(archive/p['path']) for p in setup['archive']['sourceManifest']}
  write(HERE/(prefix+'-execution.json'),{'commands':commands,'error':error,'sourceUnchanged':all(current[p['path']]==p['sha256'] for p in setup['archive']['sourceManifest']),'copyDatabasesUnchanged':all(sha(pathlib.Path(setup['copy'])/p)==v for p,v in setup['frozenDatabasesBefore'].items()),'frozenDatabasesUnchanged':all(sha(pathlib.Path(setup['frozen'])/p)==v for p,v in setup['frozenDatabasesBefore'].items()),'inputUnchanged':sha(inp)==preparation['inputSha256']})
 if error:raise RuntimeError(error)
 print('Controlled SQLite and memory complete semantic comparison passed')
if __name__=='__main__':main()
