/** Pure scheduling prefilter benchmark; host answers are a deterministic stub.
 * This measures CPU/request equivalence, not real SDK coverage correctness. */
import { resolve,join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import type { Observation,ActionCandidate } from '@interaction/browser';
import type { ExplorerHost,Task,PlanItem } from '../packages/explorer-plugin/src/types.js';
const args=Object.fromEntries(process.argv.slice(2).map(a=>{const i=a.indexOf('=');return [a.slice(2,i),a.slice(i+1)];}));
const root=resolve(args['source-root']||'.'),count=Number(args.count||1000),iterations=Number(args.iterations||10);
const {completedOperations}=await import(pathToFileURL(join(root,'packages/explorer-plugin/src/completion-evidence.ts')).href) as typeof import('../packages/explorer-plugin/src/completion-evidence.js');
const o={id:'observation',sessionId:'s',url:'https://fixture.invalid/',regions:[{key:'main',label:'Main'}],controls:Array.from({length:count},(_,i)=>({localId:`control-${i}`,stableKey:`key-${i}`,name:`Target ${i}`,label:`Target ${i}`,role:'button',region:'main',tag:'button'}))} as Observation;
const actions=Array.from({length:count},(_,i)=>({id:`action-${i}`,localId:`control-${i}`,label:`Target ${i}`,kind:'click'})) as ActionCandidate[];
const plan:PlanItem[]=actions.map((a,i)=>({id:`item-${i}`,title:a.label,scope:{label:a.label,kind:a.kind,url:o.url},prerequisites:[],completion:'Observed',required:true,dispatchScope:false,status:'succeeded',reason:'action_verified',evidence:[],attempts:[],resolvedBy:{sessionId:'source',observationId:`old-${i}`,attemptId:a.id}}));
const task={plan} as Task;
let requests=0,lastRequests:unknown;
const host={operationCorrespondences:(sessionId:string,batch:Parameters<ExplorerHost['operationCorrespondences']>[1])=>{requests+=batch.requests.length;lastRequests=batch.requests;return {sessionId,observationId:batch.observationId,results:batch.requests.map(r=>({equivalent:r.source.attemptId===r.actionId&&Number(r.actionId.split('-')[1])%4!==0,source:r.source,target:{sessionId,observationId:batch.observationId,actionId:r.actionId}}))};}} as ExplorerHost;
completedOperations(host,task,o,actions);requests=0;const elapsed:number[]=[];const cpu=process.cpuUsage();let ids:string[]=[];
for(let i=0;i<iterations;i++){const start=performance.now();ids=[...completedOperations(host,task,o,actions)].map(a=>a.id);elapsed.push(performance.now()-start);}
const usage=process.cpuUsage(cpu),sorted=[...elapsed].sort((a,b)=>a-b);
const hash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const result={sourceRoot:root,node:process.version,count,iterations,requests,completed:ids.length,requestsHash:hash(lastRequests),completedHash:hash(ids),fixtureHash:hash({o,actions,plan}),medianMs:sorted[Math.floor(iterations/2)],totalMs:elapsed.reduce((a,b)=>a+b,0),cpuMs:(usage.user+usage.system)/1000,scope:'synthetic prefilter only; actual SDK equivalence still verified in browser regression tests'};
if(result.completed!==count-Math.ceil(count/4)||requests!==count*iterations)throw Error('Result/request drift');
const json=JSON.stringify(result,null,2)+'\n';if(args.output)writeFileSync(args.output,json);else console.log(json);
