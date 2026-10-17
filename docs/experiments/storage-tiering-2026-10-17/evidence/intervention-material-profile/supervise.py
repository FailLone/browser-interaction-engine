import hashlib,json,os,pathlib,signal,subprocess,time
out=pathlib.Path(__file__).resolve().parent
root=out.parents[4]
prep=json.loads((out/'preparation.json').read_text())
source=pathlib.Path(prep['source'])
node=pathlib.Path('/Users/xietian/.local/share/fnm/node-versions/v24.22.0/installation/bin/node')
env=os.environ.copy();env['PATH']=str(node.parent)+':'+env['PATH'];env['NODE_OPTIONS']='--conditions=development'
assert not (out/'execution.json').exists()
before=hashlib.sha256(source.read_bytes()).hexdigest();assert before==prep['sourceSha256']
started=time.monotonic()
with (out/'process.log').open('x') as log:
 p=subprocess.Popen([str(node),'--conditions=development','--import','tsx',str(out/'measure.mts')],cwd=root,env=env,stdout=log,stderr=subprocess.STDOUT,start_new_session=True)
 timed_out=False
 try:code=p.wait(timeout=30)
 except subprocess.TimeoutExpired:
  timed_out=True;os.killpg(p.pid,signal.SIGKILL);code=p.wait()
after=hashlib.sha256(source.read_bytes()).hexdigest()
report={'exitCode':code,'timedOut':timed_out,'limitSeconds':30,'elapsedSeconds':time.monotonic()-started,'sourceUnchanged':before==after,'sourceSha256':after}
(out/'execution.json').write_text(json.dumps(report,indent=2)+'\n');print(json.dumps(report));assert before==after
