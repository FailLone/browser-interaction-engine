import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {Session} from 'node:inspector/promises';
import {performance} from 'node:perf_hooks';
import {createHash} from 'node:crypto';
import {BrowserEngine,canonical} from '@interaction/browser';
import {SqliteStore} from '@interaction/storage-sqlite';
const [directory,output,mode='interventions']=process.argv.slice(2);
assert.ok(directory&&output&&directory.includes('/bie-global-recovery-cost-'));
assert.ok(['interventions','afterCapture'].includes(mode));
const sid='412937f3-c4f5-4799-b86c-74adf480f329';
const store=new SqliteStore(directory),engine=new BrowserEngine({persistence:store});
(engine as any).adapter.createDriver=()=>{throw Error('Offline diagnostic forbids browser creation');};
const observation=engine.observation(sid),counts=store.db.prepare('SELECT kind,count(*) AS count FROM entities WHERE session_id=? GROUP BY kind').all(sid);
const profiler=new Session();profiler.connect();await profiler.post('Profiler.enable');await profiler.post('Profiler.setSamplingInterval',{interval:1000});await profiler.post('Profiler.start');
const began=performance.now();let result:any;
if(mode==='interventions')result=engine.interventionMaterial(sid);
else {await (engine as any).afterCapture(observation);result=engine.interventionMaterial(sid);}
const elapsedMs=performance.now()-began,profile=(await profiler.post('Profiler.stop')).profile;profiler.disconnect();
const digest=createHash('sha256').update(canonical(result)).digest('hex');
const self=new Map<number,number>();for(let i=0;i<(profile.samples?.length??0);i++){const id=profile.samples![i];self.set(id,(self.get(id)||0)+(profile.timeDeltas?.[i]||0));}
const nodes=new Map(profile.nodes.map(n=>[n.id,n])),parents=new Map<number,number>();for(const n of profile.nodes)for(const id of n.children||[])parents.set(id,n.id);
const inclusive=new Map<number,number>();for(const [id,us] of self){let n:number|undefined=id;while(n!==undefined){inclusive.set(n,(inclusive.get(n)||0)+us);n=parents.get(n);}}
const row=(id:number,us:number)=>{const f=nodes.get(id)!.callFrame;return{function:f.functionName,url:f.url,line:f.lineNumber+1,ms:us/1000};};
const report={mode,observationId:observation.id,controls:observation.controls.length,entityCounts:counts,elapsedMs,outputSha256:digest,items:result.items.length,readyIds:result.readyIds.length,topSelf:[...self].sort((a,b)=>b[1]-a[1]).slice(0,25).map(([id,us])=>row(id,us)),topInclusive:[...inclusive].sort((a,b)=>b[1]-a[1]).slice(0,45).map(([id,us])=>row(id,us)),browserStarted:false,taskDatabaseOpened:false};
writeFileSync(output,JSON.stringify(report,null,2)+'\n',{flag:'wx'});writeFileSync(output+'.cpuprofile',JSON.stringify(profile),{flag:'wx'});
console.log(JSON.stringify({mode,elapsedMs,items:report.items,outputSha256:digest,top:report.topInclusive.slice(0,15)},null,2));await engine.close();
