// Pure archived-object diagnostics. No engine, database, driver or provider.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import {canonical} from '../../../../../packages/core/src/util.ts';
import {browserBranchConditions,MAX_BRANCH_CONDITIONS} from '../../../../../packages/adapter-playwright/src/branch-conditions.ts';
import {browserTargetConditions} from '../../../../../packages/adapter-playwright/src/target-arrival.ts';
import {formBinding} from '../../../../../packages/adapter-playwright/src/util.ts';
import type {ActionCandidate,Control,Observation} from '../../../../../packages/adapter-playwright/src/types.ts';
const out=path.dirname(fileURLToPath(import.meta.url)),root=path.resolve(out,'../../../../..'),reportPath=path.join(out,'selector-condition-diagnosis.json');
const report=JSON.parse(fs.readFileSync(reportPath,'utf8'));
const sha=(data:Buffer|string)=>createHash('sha256').update(data).digest('hex');
const checkSources=()=>{for(const [file,digest] of Object.entries(report.sourceSha256))assert.equal(sha(fs.readFileSync(path.join(root,file))),digest);};
checkSources();
const raw=fs.readFileSync(report.privateFrames);assert.equal(sha(raw),report.privateFramesSha256);
const frames=JSON.parse(raw.toString()) as {observation:Observation;actions:ActionCandidate[]}[];
function selectors(o:Observation){
 const selections=new Map((o.components||[]).flatMap(c=>c.members.filter(m=>typeof m.selected==='boolean').map(m=>[m.localId,m.selected!] as const)));
 return o.controls.flatMap(c=>{
  const state:Record<string,unknown>={};let missing=false;
  if(c.checked!==null&&c.checked!==undefined)state.checked=c.checked;else if(['checkbox','radio','switch'].includes(c.role))missing=true;
  if(c.pressed!==null&&c.pressed!==undefined)state.pressed=c.pressed;
  if(c.expanded!==null&&c.expanded!==undefined)state.expanded=c.expanded;
  if(c.tag==='select')state.selected=[...c.selected].sort();else if(['tab','option','treeitem'].includes(c.role)){
   if(c.selected.length)state.selected=true;else if(selections.has(c.localId))state.selected=selections.get(c.localId);else if(['tab','option'].includes(c.role))missing=true;
  }
  if(!missing&&!Object.keys(state).length)return [];
  const item=c.structuralItem,binding=canonical({tag:c.tag,role:c.role,name:c.label||c.name,type:c.constraints.type,anchor:item?{record:item.recordKey,template:item.template,slot:item.slot}:c.stableKey,scope:c.identityContext?.scope,binding:c.identityContext?.binding,form:formBinding(c)});
  return [{localId:c.localId,instanceId:c.instanceId,name:c.name,visible:c.visible,state,missing,unstable:c.readiness?.status==='unstable',identityScope:c.identityScope,hypothesisId:c.hypothesisId,structuralWithoutRecord:!!item&&!item.recordKey,binding}];
 });
}
const count=(o:Observation,actions:ActionCandidate[])=>({actions:actions.length,branchUnavailable:actions.filter(a=>!browserBranchConditions(a,o)).length,targetConditionsUnavailable:actions.filter(a=>!browserTargetConditions(a,o)).length});
report.frames=frames.map(({observation:o,actions})=>{
 const s=selectors(o),counts=new Map<string,number>();for(const row of s)counts.set(row.binding,(counts.get(row.binding)||0)+1);
 return {observationId:o.id,stable:o.stable,sessionId:o.sessionId,documentId:o.documentId,instanceScope:o.instanceScope,context:o.context,criticalGaps:o.gaps.filter(g=>g.critical),...count(o,actions),selectorCount:s.length,limit:MAX_BRANCH_CONDITIONS,selectors:s,
  reasonCounts:{unresolved:s.filter(x=>x.hypothesisId).length,instanceOnly:s.filter(x=>x.identityScope==='instance').length,missingRecord:s.filter(x=>x.structuralWithoutRecord).length,missingState:s.filter(x=>x.missing).length,unstable:s.filter(x=>x.unstable).length,duplicateBindingGroups:[...counts.values()].filter(n=>n>1).length,overflow:s.length>MAX_BRANCH_CONDITIONS}};
});
const first=frames[0];
const noHypothesis={...first.observation,controls:first.observation.controls.map(c=>c.name==='Open sub-menu'?{...c,hypothesisId:undefined}:c)};
const distinguishButKeepUnresolved={...first.observation,controls:first.observation.controls.map(c=>c.name==='Open sub-menu'?{...c,stableKey:`diagnostic-only:${c.instanceId}`}:c)};
report.isolationChecks={scope:'in-memory negative controls only; neither changed object is persisted or proof of equivalence',
 removeOnlyTwoHypotheses:count(noHypothesis,first.actions),
 distinguishOnlyTwoBindingsKeepHypotheses:count(distinguishButKeepUnresolved,first.actions)};
assert.equal(report.isolationChecks.removeOnlyTwoHypotheses.branchUnavailable,first.actions.length);
assert.equal(report.isolationChecks.distinguishOnlyTwoBindingsKeepHypotheses.branchUnavailable,first.actions.length);
// Minimum failure independent of the large page: any one unresolved selector
// fails, and two resolved equal selector bindings independently fail.
const target=first.observation.controls.find(c=>c.name==='Trade')!;
const ambiguities=first.observation.controls.filter(c=>c.name==='Open sub-menu');
const minimal=(controls:Control[])=>({...first.observation,controls,regions:[],components:[],gaps:[],context:{},boundaries:[],overlays:[]});
const action={kind:'click',localId:target.localId};
const single=minimal([target,{...ambiguities[0]}]);
const duplicate=minimal([target,...ambiguities.map(c=>({...c,hypothesisId:undefined}))]);
report.minimalFailures={oneUnresolvedHiddenSelector:!browserBranchConditions(action,single),twoEqualResolvedHiddenSelectorBindings:!browserBranchConditions(action,duplicate)};
assert(Object.values(report.minimalFailures).every(Boolean));
const semanticFields=['tag','role','name','label','stableKey','region','regionInstanceId','form','formOwner','identityContext','reviewBinding','purposeBinding','reviewAttributes','reviewReuseBinding','classificationBinding','structuralItem','list','readOnly','constraints','options','actions','actionBasis','interactionHints'] as const;
const semantic=(c:Control)=>Object.fromEntries(semanticFields.map(k=>[k,c[k]]));
report.sameDocumentPotential=frames.slice(1).map((frame,i)=>{
 const before=frames[i].observation,after=frame.observation,a=selectors(before),b=selectors(after),changes=[];
 for(const c of a){const prior=before.controls.find(x=>x.localId===c.localId)!,other=after.controls.filter(x=>x.instanceId===c.instanceId),next=b.find(x=>x.instanceId===c.instanceId);
  const reasons=[];if(other.length!==1||!next)reasons.push('selector_instance_missing_or_nonunique');else {if(canonical(c.state)!==canonical(next.state))reasons.push('state_changed');if(canonical(semantic(prior))!==canonical(semantic(other[0])))reasons.push('captured_semantics_changed');}
  if(reasons.length)changes.push({instanceId:c.instanceId,name:c.name,reasons});
 }
 return {beforeId:before.id,afterId:after.id,sameSession:before.sessionId===after.sessionId,sameDocument:before.documentId===after.documentId&&before.instanceScope===after.instanceScope,sameBrowserSession:!!before.navigation?.browserSessionId&&before.navigation.browserSessionId===after.navigation?.browserSessionId,sameRules:before.ruleVersion===after.ruleVersion,sameKnownContext:canonical(before.context)===canonical(after.context)&&Object.values(after.context).every(v=>v.status==='known'),selectorCounts:[a.length,b.length],uniqueSelectorInstances:[a.every(c=>!!c.instanceId&&before.controls.filter(other=>other.instanceId===c.instanceId).length===1),b.every(c=>!!c.instanceId&&after.controls.filter(other=>other.instanceId===c.instanceId).length===1)],changes,
  interpretation:!changes.length&&a.length===b.length?'Potential selector-continuity input only; not an implemented SDK proof. Parent business bindings must be captured/validated independently.':'Existing changes prevent equal complete selector conditions.'};
});
checkSources();report.sourceHashesUnchanged=true;
fs.writeFileSync(reportPath,JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({frames:report.frames.map(({selectors,...rest}:any)=>rest),isolationChecks:report.isolationChecks,minimalFailures:report.minimalFailures,sameDocumentPotential:report.sameDocumentPotential},null,2));
