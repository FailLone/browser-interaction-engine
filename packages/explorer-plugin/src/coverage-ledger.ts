import {browserControlBindingKey,type Observation,type ActionAttempt} from '@interaction/browser';
import type {ExplorerHost,Task} from './types.js';
import {digest,scopeFor} from './policy.js';

/** Read-only projection of retained discovery and dispatch records. No success
 * flag is written here; condition combinations never inherit sampled coverage. */
export function coverageLedger(host:ExplorerHost,task:Task) {
 const attempts=task.rounds.flatMap(r=>host.list<ActionAttempt>(r.sessionId,'attempt'));
 const byBefore=new Map<string,ActionAttempt[]>();for(const a of attempts){const k=`${a.sessionId}:${a.beforeId}`;byBefore.set(k,[...(byBefore.get(k)||[]),a]);}
 const proofs=new Map<string,boolean>();
 for(const r of task.rounds){const rows=attempts.filter(a=>a.sessionId===r.sessionId&&a.status==='succeeded');const batch=host.operationReceiptConditions?.(r.sessionId,{attemptIds:rows.map(a=>a.id)});for(const [i,a] of rows.entries()){const p=batch?.results[i];proofs.set(a.id,p?.source.attemptId===a.id&&p.source.sessionId===a.sessionId&&p.conditionVerified===true);}}
 type Combination={key:string;conditions:unknown;sources:{sessionId:string;observationId:string}[];operations:Record<string,{scope:ReturnType<typeof scopeFor>;observed:string[];executed:{attemptId:string;observationId:string;verified:boolean}[];status:'observed_not_executed'|'execution_evidence_only'}>};
 const combinations=new Map<string,Combination>(),gaps:{sessionId:string;observationId:string;code:string;critical:boolean;message:string}[]=[];
 for(const round of task.rounds)for(const o of host.list<Observation>(round.sessionId,'observation')){
  const conditions={url:o.url,context:o.context,boundaries:(o.boundaries||[]).map(b=>({name:b.name,region:b.region})),
   controls:o.controls.filter(c=>c.checked!=null||c.expanded!=null||c.pressed!=null||c.tag==='select'||c.editable).map(c=>({reference:browserControlBindingKey(c,o),key:c.stableKey,tag:c.tag,role:c.role,name:c.label||c.name,visible:c.visible,enabled:c.enabled,checked:c.checked,expanded:c.expanded,pressed:c.pressed,selected:c.selected,value:c.editable?c.value:undefined,constraints:c.constraints})).sort((a,b)=>digest(a).localeCompare(digest(b)))};
  const key=digest({policy:'observed-condition-combinations-v1',conditions}),row=combinations.get(key)||{key,conditions,sources:[],operations:{}};
  row.sources.push({sessionId:o.sessionId,observationId:o.id});
  const actual=byBefore.get(`${o.sessionId}:${o.id}`)||[];
  for(const action of host.actions(o.sessionId,o.id)){
   const scope=scopeFor(action,o),operation=digest(scope),entry=row.operations[operation]||{scope,observed:[],executed:[],status:'observed_not_executed' as const};entry.observed.push(o.id);
   for(const a of actual.filter(a=>a.action.localId===action.localId&&a.action.kind===action.kind&&digest(a.action.value??null)===digest(action.value??null)&&a.status==='succeeded'))if(!entry.executed.some(e=>e.attemptId===a.id))entry.executed.push({attemptId:a.id,observationId:o.id,verified:proofs.get(a.id)===true});
   if(entry.executed.length)entry.status='execution_evidence_only';row.operations[operation]=entry;
  }
  for(const g of o.gaps)gaps.push({sessionId:o.sessionId,observationId:o.id,code:g.code,critical:g.critical===true,message:g.message});combinations.set(key,row);
 }
 const obligations=task.plan.filter(i=>i.required&&!!i.scope.kind).map(i=>({itemId:i.id,scope:i.scope,conditionKey:i.operationConditionKey,status:i.status,reason:i.reason,
   verified:i.status==='succeeded'&&i.conditionCompletion?.status==='verified'&&!!i.resolvedBy?.attemptId&&proofs.get(i.resolvedBy.attemptId)===true,
   discovery:i.evidence.filter(e=>!e.attemptId),completion:i.resolvedBy,completionAssessment:i.conditionCompletion}));
 return {version:1,policy:task.sessionOptions.coveragePolicy||'legacy-source-conditions',taskId:task.id,
  claim:'Finite observed UI operation samples only; neither all condition combinations nor business effects are certified',
  finite:{obligations,total:obligations.length,verified:obligations.filter(i=>i.verified).length,remaining:obligations.filter(i=>!i.verified).map(i=>i.itemId)},
  conditionCombinations:{policy:'observed-condition-combinations-v1',exhaustive:false,rows:[...combinations.values()],count:combinations.size,
   meaning:'Exact observed conditions with actual before-frame execution evidence. Untested combinations and causal independence remain unproved.'},
  unknownDependencies:{status:'unproved',categories:['unobserved JavaScript dependencies','unobserved condition combinations','unbounded free-input values','unassessed business effects'],observations:gaps},
  blockers:task.plan.filter(i=>i.required&&!['succeeded','superseded'].includes(i.status)).map(i=>({itemId:i.id,scope:i.scope,status:i.status,reason:i.reason})),
  unsuccessfulExecutions:attempts.filter(a=>a.status!=='succeeded').map(a=>({attemptId:a.id,status:a.status,reason:a.reason})),
  recovery:attempts.filter(a=>a.purpose==='recovery'||a.repetitionSource).map(a=>({attemptId:a.id,status:a.status,repetitionSource:a.repetitionSource,purpose:a.purpose}))};
}
