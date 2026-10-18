import {expect,it} from 'vitest';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {ExplorerPlugin,ExplorerStore} from '@interaction/explorer-plugin';
import {explorerFixture,fakeProviders} from './explorer-plugin-helpers.js';

it('persists completed negative review decisions before starting the next bounded review unit',async()=>{
 const html=Array.from({length:6},(_,i)=>`<div id="unknown-${i}" role="button" tabindex="0" onclick="void 0">Unknown ${i}</div>`).join('')+'<canvas></canvas>';
 const f=await explorerFixture(html),path=join(f.dir,'quota.sqlite'),store=new ExplorerStore(path),providers=fakeProviders(f.url),original=providers.jev.decide;
 let checks=0,persisted:any[]=[];
 providers.jev.decide=async(request,signal)=>{
  if(request.purpose==='control-classification')return {model:'explicit-fixture',value:'interaction',confidence:1};
  if(request.purpose==='control-risk'){
   if(++checks===3){
    const reader=new DatabaseSync(path,{readOnly:true});
    try{persisted=(reader.prepare("SELECT json FROM decisions WHERE task_id=? AND json_extract(json,'$.purpose')='control-risk' AND json_extract(json,'$.status')!='requested'").all(store.tasks()[0].id) as {json:string}[]).map(row=>JSON.parse(row.json));}finally{reader.close();}
   }
   return {model:'explicit-fixture',value:Object.fromEntries(Object.keys(request.checks!).map(k=>[k,k.startsWith('external_')?.99:.01])),confidence:1};
  }
  return original(request,signal);
 };
 const plugin=new ExplorerPlugin(f.host,store,providers);
 try{
  const task=plugin.create({url:f.url,coverageContract:{version:1,mode:'exhaustive',roots:[{url:f.url}],exclusions:[],allowedOperations:['click','hover','focus']},sessionOptions:{executionPolicy:'interface-only',coveragePolicy:'finite-ui-v1',headless:true},budget:{rounds:1,actions:5,durationMs:20000}});
  plugin.start(task.id);await plugin.waitForIdle(task.id);const final=store.task(task.id);
  expect(checks,JSON.stringify({reason:final.reason,persisted:persisted.map(d=>({id:d.id,status:d.status,reason:d.reason}))})).toBe(6);expect(persisted).toHaveLength(2);expect(persisted.every(d=>d.status==='applied'&&d.reason==='used_in_review')).toBe(true);
  expect(final.rounds.flatMap(r=>f.host.list(r.sessionId,'attempt'))).toEqual([]);
  expect(final.plan.some(i=>i.required&&i.reason==='operation_risk_unresolved')).toBe(true);
  expect(final.plan.some(i=>i.required&&i.reason==='missing_capability:UNSUPPORTED_CANVAS')).toBe(true);expect(final.status).not.toBe('completed');
 }finally{await plugin.close();await f.close();}
});
