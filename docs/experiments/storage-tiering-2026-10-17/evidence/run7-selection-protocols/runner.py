import pathlib, subprocess, json, hashlib, os, time, sys
root=pathlib.Path('/Users/xietian/.codex/worktrees/exploration-layered-refactor/browser-interaction-engine')
base=root/'docs/experiments/storage-tiering-2026-10-17/evidence/run6-factory-protocols'
out=root/'docs/experiments/storage-tiering-2026-10-17/evidence/run7-selection-protocols'
out.mkdir(exist_ok=False)
revision=subprocess.check_output(['git','rev-parse','HEAD'],cwd=root,text=True).strip()
assert revision == 'cbd5b878329f8d3e454e8fd5110d0e2da4f749a7', revision
node='/Users/xietian/.local/share/fnm/node-versions/v24.22.0/installation/bin/node'
env=dict(os.environ);env['PATH']=str(pathlib.Path(node).parent)+':'+env['PATH']
def sources():
 files=subprocess.check_output(['rg','--files','packages','apps','scripts','tests'],cwd=root,text=True).splitlines()
 return {p:hashlib.sha256((root/p).read_bytes()).hexdigest() for p in sorted(files) if '/dist/' not in p and '/node_modules/' not in p}
def save(name,data): (out/name).write_text(json.dumps(data,indent=2)+'\n')
before=sources();save('source-before.json',{'revision':revision,'files':before})
commands=[];fatal=None
try:
 for old in json.loads((base/'commands.json').read_text()):
  command=[arg.replace(str(base),str(out)).replace('900edf7d5c60c3ddcf9265538758033ccecc5832',revision) for arg in old['command']]
  # Identical protocol scripts and repeat counts, one owned fixture at a time.
  record={'index':old['index'],'name':old['name'],'command':command,'startedAtEpoch':time.time(),'log':old['log']}
  print(json.dumps({'started':record['name'],'index':record['index']}),flush=True)
  with (out/record['log']).open('w') as f: result=subprocess.run(command,cwd=root,env=env,stdout=f,stderr=subprocess.STDOUT)
  record.update(exitCode=result.returncode,elapsedSeconds=time.time()-record['startedAtEpoch']);commands.append(record);save('commands.json',commands)
  print(json.dumps({'finished':record['name'],'index':record['index'],'exitCode':result.returncode}),flush=True)
  if result.returncode: raise RuntimeError('protocol process failed')
except Exception as e: fatal=str(e)
finally:
 after=sources();after_revision=subprocess.check_output(['git','rev-parse','HEAD'],cwd=root,text=True).strip();save('source-after.json',{'revision':revision,'files':after});save('execution.json',{'revision':revision,'sourceUnchanged':before==after and revision==after_revision,'afterRevision':after_revision,'commands':len(commands),'allExitZero':all(c['exitCode']==0 for c in commands) and len(commands)==8,'fatal':fatal})
if fatal or before!=after or revision!=after_revision: sys.exit(1)
