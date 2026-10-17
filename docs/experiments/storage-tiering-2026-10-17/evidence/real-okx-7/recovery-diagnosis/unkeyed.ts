// Pure archived-object diagnostics; no engine/database/driver/provider.
// node --import tsx --conditions=development unkeyed.ts REPOSITORY PRIVATE_FRAMES OUTPUT
import {readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import assert from 'node:assert/strict';
const [root,input,output]=process.argv.slice(2);
assert(root&&input&&output,'Expected repository, extracted private frames and output');
const imp=(p:string)=>import(pathToFileURL(root+'/'+p).href);
const {canonical}=await imp('packages/core/src/util.ts');
const {browserBranchConditions,MAX_BRANCH_CONDITIONS}=await imp('packages/adapter-playwright/src/branch-conditions.ts');
const {browserTargetConditions}=await imp('packages/adapter-playwright/src/target-arrival.ts');
const {formBinding}=await imp('packages/adapter-playwright/src/util.ts');
const hash=(x:Buffer|string)=>createHash('sha256').update(x).digest('hex');
const files=['packages/core/src/engine.ts','packages/adapter-playwright/src/branch-conditions.ts','packages/adapter-playwright/src/target-arrival.ts','packages/adapter-playwright/src/util.ts'];
const sourceSha256=Object.fromEntries(files.map(p=>[p,hash(readFileSync(root+'/'+p))]));
const raw=readFileSync(input),frames=JSON.parse(raw.toString());
function selectors(o:any,action:any){
 const selected=new Map((o.components||[]).flatMap((c:any)=>c.members.filter((m:any)=>typeof m.selected==='boolean').map((m:any)=>[m.localId,m.selected])));
 const target=o.controls.find((c:any)=>c.localId===action.localId);
 const rows=o.controls.flatMap((c:any)=>{
  const state:Record<string,unknown>={};let missing=false;
  if(c.checked!==null&&c.checked!==undefined)state.checked=c.checked;else if(['checkbox','radio','switch'].includes(c.role))missing=true;
  if(c.pressed!==null&&c.pressed!==undefined)state.pressed=c.pressed;
  if(c.expanded!==null&&c.expanded!==undefined)state.expanded=c.expanded;
  if(c.tag==='select')state.selected=[...c.selected].sort();else if(['tab','option','treeitem'].includes(c.role)){
   if(c.selected.length)state.selected=true;else if(selected.has(c.localId))state.selected=selected.get(c.localId);else if(['tab','option'].includes(c.role))missing=true;
  }
  if(!missing&&!Object.keys(state).length)return [];
  if(c===target&&['check','fill','select'].includes(action.kind))return [];
  const item=c.structuralItem,binding=canonical({tag:c.tag,role:c.role,name:c.label||c.name,type:c.constraints.type,
   anchor:item?{record:item.recordKey,template:item.template,slot:item.slot}:c.stableKey,scope:c.identityContext?.scope,binding:c.identityContext?.binding,form:formBinding(c)});
  const reasons=[...(missing?['missing_state']:[]),...(c.readiness?.status==='unstable'?['unstable']:[]),...(c.hypothesisId?['unresolved_identity']:[]),
   ...(c.identityScope==='instance'?['instance_only']:[]),...(item&&!item.recordKey?['missing_record']:[])];
  return [{localId:c.localId,instanceId:c.instanceId,name:c.name,visible:c.visible,identityScope:c.identityScope,hypothesisId:c.hypothesisId,region:c.region,state,binding,reasons}];
 });
 const counts=new Map<string,number>();for(const r of rows)counts.set(r.binding,(counts.get(r.binding)||0)+1);
 for(const r of rows)if(counts.get(r.binding)!>1)r.reasons.push('duplicate_binding');
 return rows;
}
const report={sourceSha256,inputSha256:hash(raw),limit:MAX_BRANCH_CONDITIONS,
 disclaimer:'Reasons are independently sampled from the unchanged v2 contract. No selector is removed from product facts, no SDK result or permission is altered.',
 attempts:frames.map(({attempt:a,before:o}:any)=>{
  const rows=selectors(o,a.action),bad=rows.filter((r:any)=>r.reasons.length);
  return {attemptId:a.id,status:a.status,kind:a.action.kind,label:a.action.label,value:a.action.value,replayable:a.action.replayable,beforeId:o.id,documentId:o.documentId,
   stable:o.stable,criticalGaps:o.gaps.filter((g:any)=>g.critical),knownContext:Object.values(o.context).every((c:any)=>c.status==='known'),
   actionTarget:a.action.target,branchAvailable:!!browserBranchConditions(a.action,o),targetConditionsAvailable:!!browserTargetConditions(a.action,o),selectorCount:rows.length,
   reasonCounts:Object.fromEntries(['missing_state','unstable','unresolved_identity','instance_only','missing_record','duplicate_binding'].map(reason=>[reason,bad.filter((r:any)=>r.reasons.includes(reason)).length])),
   problemSelectors:bad,selectors:rows};
 })};
for(const row of report.attempts){assert.equal(row.status,'succeeded');assert.equal(row.branchAvailable,false);assert.equal(row.targetConditionsAvailable,false);}
for(const [p,digest] of Object.entries(sourceSha256))assert.equal(hash(readFileSync(root+'/'+p)),digest);
writeFileSync(output,JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify(report.attempts.map(({selectors,problemSelectors,...r}:any)=>({...r,problemSelectors:problemSelectors.map(({binding,...r}:any)=>r)})),null,2));
