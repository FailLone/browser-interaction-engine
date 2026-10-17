import {readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {BrowserEngine,browserOperationKey} from '@interaction/browser';
import {SqliteStore} from '@interaction/storage-sqlite';
import {matches} from '../packages/explorer-plugin/src/policy.js';
import {browserBranchConditions} from '../packages/adapter-playwright/src/branch-conditions.js';
const [dir,out]=process.argv.slice(2);const task=JSON.parse(readFileSync(join(dir,'task.json'),'utf8'));
const engine=new BrowserEngine({persistence:new SqliteStore(join(dir,'engine'))});
const rows=task.plan.filter((i:any)=>i.required&&!['succeeded','superseded'].includes(i.status)).map((item:any)=>{
 const sources=item.evidence.filter((e:any)=>!e.attemptId).map((ref:any)=>{
  try{const o=engine.observation(ref.sessionId,ref.observationId),actions=engine.operationCoverageCandidates(ref.sessionId,ref.observationId).filter(a=>matches(item.scope,a,o));
   return {ref,matches:actions.length,operations:actions.map(a=>({kind:a.kind,value:a.value,legacyKey:browserOperationKey(a,o),finiteCandidateKey:browserOperationKey(a,{...o,coveragePolicy:'finite-ui-v1'}),observedModes:browserBranchConditions(a,o)?.conditions,finitePolicyRequiresNewRun:true}))};
  }catch(e){return {ref,error:String(e)}}
 });return {id:item.id,scope:item.scope,reason:item.reason,sources,disposition:'retain-original-obligation-and-receipts; proposed sampling projection grants no historical completion'};
});
writeFileSync(out,JSON.stringify({policy:'finite-ui-v1',sourceTask:task.id,sourcePolicy:'retained-source-condition-sampling',migration:'read-only explanation; no legacy flags changed; finite runs require explicit caller selection',rows},null,2));await engine.close();
