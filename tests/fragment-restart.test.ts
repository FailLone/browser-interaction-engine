import {expect,it} from 'vitest';
import {spawn} from 'node:child_process';
import {createServer} from 'node:http';
import {mkdirSync,mkdtempSync,readFileSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
const worker=(dir:string,url:string,phase:string)=>new Promise<number>((done,reject)=>{
 const child=spawn(process.execPath,['--conditions=development','--import','tsx',resolve('scripts/fragment-restart-worker.ts'),dir,url,phase],{cwd:process.cwd(),stdio:['ignore','pipe','pipe']});
 let log='';child.stdout.on('data',data=>log+=data);child.stderr.on('data',data=>log+=data);child.on('error',reject);child.on('exit',code=>{writeFileSync(join(dir,`worker-${phase}.log`),log);done(code??-1);});
});
it.each(['first','crash'] as const)('retains fragment access and immutable pending IDs across a real %s process exit',async phase=>{
 const nav='<header><nav aria-label="Public navigation"><details id="menu"><summary>Menu</summary><a href="/b">Overview</a><a href="/detail">Original detail</a></details></nav></header>';
 const server=createServer((req,res)=>{res.setHeader('Content-Type','text/html');res.end('<!doctype html><html><head><title>Restart</title></head><body>'+(['/','/b'].includes(req.url||'')?nav:'')+(req.url==='/b'?'<main><a href="/c">Unique destination</a></main>':'')+'<canvas></canvas></body></html>');});
 await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const url=`http://127.0.0.1:${(server.address() as any).port}/`;
 mkdirSync(resolve('.data/broader-ui'),{recursive:true});const dir=mkdtempSync(resolve(`.data/broader-ui/fragment-restart-${phase}-`));
 try{
  expect(await worker(dir,url,phase)).toBe(phase==='crash'?76:0);
  const old=JSON.parse(readFileSync(join(dir,phase==='crash'?'crash-intent.json':'task-first.json'),'utf8')),before=phase==='crash'?old:old.task;
  expect(before.fragmentTraversal.events.length).toBeGreaterThanOrEqual(2);
  const pending=before.plan.filter((i:any)=>i.required&&!['succeeded','superseded','excluded'].includes(i.status));expect(pending.length).toBeGreaterThan(0);
  expect(await worker(dir,url,'resume')).toBe(0);const after=JSON.parse(readFileSync(join(dir,'task-resume.json'),'utf8'));
  if(phase==='first')expect(after.pid).not.toBe(old.pid);
  for(const event of before.fragmentTraversal.events)expect(after.task.fragmentTraversal.events.filter((e:any)=>e.id===event.id)).toEqual([event]);
  for(const item of pending)expect(after.task.plan.some((i:any)=>i.id===item.id)).toBe(true);
  if(phase==='crash'){
   expect(before.pendingDispatch).toBeDefined();
   expect(after.task.fragmentTraversal.events.some((e:any)=>e.actionId===before.pendingDispatch.actionId)).toBe(false);
   for(const id of before.pendingDispatch.itemIds)expect(after.task.plan.find((i:any)=>i.id===id).status).not.toBe('succeeded');
  }else{
   expect(after.events.some((e:any)=>e.type==='fragment.frontier'&&e.data.pruned.length)).toBe(true);
   expect(after.attempts.some((a:any)=>a.action.label==='Original detail'&&a.status==='succeeded')).toBe(true);
  }
 }finally{await new Promise<void>(r=>server.close(()=>r()));}
},90000);
