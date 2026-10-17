import { conditionSplitIssues, boundOperationCondition, schedulableObligation } from './plan-state.js';
import { createHash } from 'node:crypto';
import { browserControlCorrespondence, browserControlBindingKey, browserTargetConditions, browserOperationKey, browserOperationSchedulingKey, legacyBrowserOperationKey, navigationIntent, type ActionAvailability, type ActionCandidate, type Observation } from '@interaction/browser';
import type { Scope, PlanItem, ExplorerHost, Task, EvidenceRef } from './types.js';
const ordered=(value:unknown):unknown=>Array.isArray(value)?value.map(ordered):value&&typeof value==='object'?Object.fromEntries(Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>[k,ordered(v)])):value;
export const digest=(value:unknown)=>createHash('sha256').update(JSON.stringify(ordered(value))).digest('hex');
/** Task policy consumes host semantics; these opaque keys retain old task compatibility. */
export const navigationTarget=(a:ActionCandidate,o:Observation)=>navigationIntent(a,o)?.targetUrl;
export const scopeControlKey=(c:Observation['controls'][number])=>browserControlCorrespondence(c)?.key;
function actionScope(action:ActionCandidate,o:Observation,c:Observation['controls'][number]|undefined,r:Observation['regions'][number]|undefined):Scope {
  const key=c&&scopeControlKey(c),targetBinding=c&&browserControlBindingKey(c,o);
  return {url:o.url,...(r?{region:r.label}:{}),label:action.label,...(c?{role:c.role, ...(key?{stableKey:key}:{}),...(targetBinding?{targetBinding}:{})}:{}),kind:action.kind,...(['string','boolean','number'].includes(typeof action.value)?{value:action.value as string|boolean|number}:{})};
}
export function scopeFor(action:ActionCandidate,o:Observation):Scope {const c=o.controls.find(c=>c.localId===action.localId);return actionScope(action,o,c,o.regions.find(r=>r.key===c?.region));}
/** Indexes only captured facts for one synchronous pass. Never retain this
 * reader across an await, a new observation or a review/identity revision. */
export function actionScopeReader(o:Observation) {
  const controls=new Map<string,Observation['controls'][number]>(),regions=new Map<string,Observation['regions'][number]>();
  for(const c of o.controls)if(!controls.has(c.localId))controls.set(c.localId,c);
  for(const r of o.regions)if(!regions.has(r.key))regions.set(r.key,r);
  return (action:ActionCandidate)=>{const c=action.localId?controls.get(action.localId):undefined;return actionScope(action,o,c,c?regions.get(c.region):undefined);};
}
/** Review gaps bind to the observed control, including controls without an explicit label or an action yet. */
export function scopeForControl(c:Observation['controls'][number],o:Observation):Scope {
  const label=c.name||c.label,region=o.regions.find(r=>r.key===c.region)?.label,stableKey=scopeControlKey(c),targetBinding=browserControlBindingKey(c,o);
  return {url:o.url,...(region?{region}:{}),...(label?{label}:{}),...(c.role?{role:c.role}:{}),...(stableKey?{stableKey}:{}),...(targetBinding?{targetBinding}:{})};
}
/** Model-only view: retain equality hints without repeated document/DOM fingerprints. */
export function decisionScope(scope:Scope):Scope {return {...scope,...(scope.stableKey?{stableKey:`sha256:${digest(scope.stableKey)}`}:{})};}
/** Accepted authority and exclusions are relevant to selection; the growing evidence ledger is not. */
export function decisionPlan(plan:PlanItem[]) {
  return plan.filter(i=>(i.required&&i.dispatchScope===true)||i.reason==='user_excluded').map(i=>({title:i.title,scope:decisionScope(i.scope),prerequisites:i.prerequisites.map(decisionScope),required:i.required}));
}
export function matches(scope:Scope,action:ActionCandidate,o:Observation) {
  const actual=scopeFor(action,o);
  return Object.entries(scope).every(([key,value])=>JSON.stringify(actual[key as keyof Scope])===JSON.stringify(value));
}
/** Only page/region scopes imply discovery navigation; an unnamed operation is still bounded. */
export const broadScope=(scope:Scope)=>!scope.label&&!scope.role&&!scope.stableKey&&!scope.targetBinding&&!scope.kind&&scope.value===undefined;
function controlScope(control:Observation['controls'][number],o:Observation):Scope {
  return {url:o.url,region:o.regions.find(r=>r.key===control.region)?.label,label:control.name||control.label,role:control.role,stableKey:scopeControlKey(control),targetBinding:browserControlBindingKey(control,o)};
}
function matchesControlScope(scope:Scope,actual:Scope) {
  if((scope.kind||scope.value!==undefined)&&!scope.label&&!scope.stableKey)return false;
  return Object.entries(scope).filter(([key])=>!['kind','value'].includes(key)).every(([key,value])=>actual[key as keyof Scope]===value);
}
export function controlInScope(scope:Scope,control:Observation['controls'][number],o:Observation,actions:ActionCandidate[]) {
  if(actions.some(a=>a.localId===control.localId&&matches(scope,a,o)))return true;
  // A named target may need classification before candidates exist. An operation-only
  // target must bind to a real candidate; dropping kind/value would match the entire page.
  return matchesControlScope(scope,controlScope(control,o));
}
/** A single synchronous scope-matching pass; rebuilt for every observation/read. */
export function controlScopeMatcher(o:Observation,actions:ActionCandidate[]) {
  // Keep each occurrence's fallback facts even if malformed/ambiguous input
  // repeats a local ID. Action lookup still uses scopeFor's first-match rules.
  const controls=new Map(o.controls.map(c=>[c,controlScope(c,o)])),operations=new Map<ActionCandidate['localId'],Scope[]>(),readScope=actionScopeReader(o);
  for(const a of actions){const scopes=operations.get(a.localId)||[];scopes.push(a.localId?readScope(a):scopeFor(a,o));operations.set(a.localId,scopes);}
  return (scope:Scope,control:Observation['controls'][number])=>(operations.get(control.localId)||[]).some(actual=>Object.entries(scope).every(([key,value])=>JSON.stringify(actual[key as keyof Scope])===JSON.stringify(value)))
    ||matchesControlScope(scope,controls.get(control)||controlScope(control,o));
}
export const keyFor=browserOperationKey;
export const operationConditionPolicy='browser-operation-key-v2' as const;
export const schedulingKeyFor=browserOperationSchedulingKey;
export const schedulingOperationConditionPolicy='browser-operation-key-v3' as const;
export {normalizeOperationScheduling} from './operation-scheduling.js';
export {schedulingOperationCondition,operationSchedulingAliases} from './plan-state.js';
type ConditionAudit=NonNullable<PlanItem['conditionMigration']>;
const conditionSplitPolicy='operation-condition-split-v1' as const;
const sourceRefKey=(ref:EvidenceRef)=>JSON.stringify([ref.sessionId,ref.observationId,ref.attemptId||'']);
/** Upgrade unattempted scheduling hints from every retained original source.
 * A split transfers all known source obligations, including explicit residual
 * gaps; neither it nor its children grant current execution or past coverage. */
export function migrateOperationConditions(task:Pick<Task,'plan'>,host:Pick<ExplorerHost,'observation'|'actions'>) {
  const changes:{itemId:string;audit:ConditionAudit}[]=[],byId=new Map(task.plan.map(item=>[item.id,item])),integrity=conditionSplitIssues(task.plan);
  const records=new Map<string,{observation:Observation;actions:ActionCandidate[]}|undefined>();
  for(const item of [...task.plan]) {
    if(item.status==='superseded'||item.conditionMigration?.status==='split'){
      const issue=integrity.get(item.id),previous=item.conditionMigration?.integrityFailure;
      if(issue&&(issue!==previous||item.status!=='blocked')){item.conditionMigration??={version:2,status:'invalidated',reason:'missing_split_audit',fromKey:item.operationConditionKey||'unknown',sources:[]};item.status='blocked';item.reason=`condition_split_invalid:${issue}`;item.conditionMigration.integrityFailure=issue;changes.push({itemId:item.id,audit:item.conditionMigration});}
      continue;
    }
    const oldInvalidation=item.conditionMigration?.status==='invalidated'&&item.conditionMigration.reason==='multiple_current_conditions'&&!item.conditionMigration.version;
    if(item.dispatchScope!==false||!item.operationConditionKey||item.operationConditionPolicy===operationConditionPolicy||item.operationConditionPolicy===schedulingOperationConditionPolicy||item.conditionMigration&&!oldInvalidation
      ||!['pending','unresolved','blocked'].includes(item.status)||item.attempts.length||item.resolvedBy||item.reviewResolvedBy||item.coverageResolvedBy
      ||!oldInvalidation&&!['observed_in_scope','operation_not_executed'].includes(item.reason))continue;
    const fromKey=item.operationConditionKey,sources:ConditionAudit['sources']=[],unverified:NonNullable<ConditionAudit['unverifiedSources']>=[];
    const groups=new Map<string,{key:string;scope:Scope;sources:EvidenceRef[]}>();
    const refs=[...new Map(item.evidence.map(ref=>[sourceRefKey(ref),ref])).values()];
    for(const ref of refs) {
      const reject=(reason:string)=>unverified.push({source:{...ref},reason});
      if(ref.attemptId){reject('attempt_source_requires_review');continue;}
      const sourceKey=sourceRefKey(ref);
      if(!records.has(sourceKey)) {
        try{const observation=host.observation(ref.sessionId,ref.observationId);
          records.set(sourceKey,observation.id===ref.observationId&&observation.sessionId===ref.sessionId?{observation,actions:host.actions(ref.sessionId,ref.observationId)}:undefined);
        }catch{records.set(sourceKey,undefined);}
      }
      const record=records.get(sourceKey);
      records.delete(sourceKey);records.set(sourceKey,record);while(records.size>8)records.delete(records.keys().next().value!);
      if(!record){reject('missing_source');continue;}
      if(record.observation.gaps.some(g=>g.critical)||Object.values(record.observation.context).some(c=>c.status!=='known')){reject('incomplete_source');continue;}
      const candidates=record.actions.filter(a=>a.sessionId===ref.sessionId&&a.observationId===ref.observationId&&matches(item.scope,a,record.observation));
      if(candidates.length!==1){reject('source_not_unique');continue;}
      const action=candidates[0],key=keyFor(action,record.observation);
      if(fromKey!==key&&fromKey!==legacyBrowserOperationKey(action,record.observation)){reject('source_key_mismatch');continue;}
      // An unverified-marker key is only a retry hint. The SDK must have a known
      // branch projection (including selector bounds/uniqueness) before splitting.
      if(!browserTargetConditions(action,record.observation)){reject('source_conditions_unverified');continue;}
      const scope=scopeFor(action,record.observation),groupKey=digest({key,scope}),group=groups.get(groupKey)||{key,scope,sources:[]};
      group.sources.push({...ref});groups.set(groupKey,group);sources.push({...ref,actionId:action.id});
    }
    const common={version:2 as const,fromKey,sources,...oldInvalidation?{previousInvalidation:{reason:item.conditionMigration!.reason,sources:item.conditionMigration!.sources}}:{}};
    let audit:ConditionAudit;
    if(groups.size===1&&!unverified.length){
      const key=[...groups.values()][0].key;audit={...common,status:'migrated',toKey:key,reason:'retained_source_key_verified'};
      item.operationConditionKey=key;item.operationConditionPolicy=operationConditionPolicy;
      if(oldInvalidation){item.status=item.required?'pending':'untested';item.reason='observed_in_scope';}
    }else if(groups.size){
      const children:NonNullable<ConditionAudit['children']>=[],prepared:PlanItem[]=[];
      const append=(kind:'condition'|'unverified-source',scope:Scope,key:string,refs:EvidenceRef[],reason='observed_in_scope')=>{
        const id=`${item.id}:split:${digest({policy:conditionSplitPolicy,kind,key,scope,sources:kind==='unverified-source'?refs:undefined})}`;
        const child:PlanItem={id,title:item.title,scope:structuredClone(scope),prerequisites:structuredClone(item.prerequisites),completion:item.completion,required:item.required,dispatchScope:false,
          status:kind==='condition'?(item.required?'pending':'untested'):'blocked',reason,operationConditionKey:key,...kind==='condition'?{operationConditionPolicy}:{},
          conditionLineage:{parentItemId:item.id,policy:conditionSplitPolicy,kind,fromKey},evidence:structuredClone(refs),attempts:[],
          ...kind==='unverified-source'?{conditionMigration:{version:2,status:'invalidated',fromKey,reason:reason.slice('condition_policy_invalidated:'.length),sources:[],unverifiedSources:refs.map(source=>({source:{...source},reason:reason.slice('condition_policy_invalidated:'.length)}))}}:{}};
        prepared.push(child);children.push({itemId:id,kind,scope:structuredClone(scope),required:child.required,dispatchScope:false,...kind==='condition'?{operationConditionKey:key}:{},sources:structuredClone(refs)});
      };
      for(const group of groups.values())append('condition',group.scope,group.key,group.sources);
      for(const gap of unverified)append('unverified-source',item.scope,fromKey,[gap.source],`condition_policy_invalidated:${gap.reason}`);
      audit={...common,status:'split',reason:unverified.length?'retained_sources_split_with_gaps':'retained_sources_split',children,...unverified.length?{unverifiedSources:unverified}:{}};
      if(prepared.some(child=>byId.has(child.id))){audit={...common,status:'invalidated',reason:'child_id_collision'};item.status='blocked';item.reason='condition_policy_invalidated:child_id_collision';}
      else {for(const child of prepared){task.plan.push(child);byId.set(child.id,child);}item.status='superseded';item.reason='condition_scope_split';}
    }else{
      const reason=unverified[0]?.reason||'missing_source';audit={...common,status:'invalidated',reason,...unverified.length?{unverifiedSources:unverified}:{}};
      item.status='blocked';item.reason=`condition_policy_invalidated:${reason}`;
    }
    item.conditionMigration=audit;changes.push({itemId:item.id,audit});
  }
  return changes;
}
export function permitted(action:ActionCandidate,o:Observation,availability:ActionAvailability) {
  return availability.observationId===o.id&&action.observationId===o.id&&availability.actions.some(a=>a.actionId===action.id&&a.executable);
}
/** Translate host facts into task gaps; do not reconstruct execution or sampling rules. */
export function unexecutedAction(action:ActionCandidate,availability:ActionAvailability) {
  const fact=availability.actions.find(a=>a.actionId===action.id);
  const selection=fact?.blockers.find(b=>b.selection)?.selection;
  if(selection?.state==='skipped'||selection?.state==='unselected')return {reason:'sample_unselected',required:false};
  if(selection?.state==='deferred')return {reason:'scope_deferred',required:true};
  const blocker=fact?.blockers[0];
  return {reason:fact?.executable?'operation_not_executed':blocker?(['ACTION_BLOCKED','ACTION_EXCLUDED'].includes(blocker.code)?blocker.reason:blocker.code):'operation_unavailable',required:true};
}
export function includesScope(plan:PlanItem[],action:ActionCandidate,o:Observation):'target'|'prerequisite'|undefined {
  if(plan.some(i=>!i.required&&i.reason==='user_excluded'&&matches(i.scope,action,o)))return;
  const allowed=plan.filter(i=>i.required&&i.dispatchScope===true&&i.status!=='excluded'&&schedulableObligation(i));
  if(action.kind==='scroll'&&!allowed.some(i=>i.scope.kind==='scroll'&&matches(i.scope,action,o))&&allowed.some(i=>broadScope(i.scope)&&(!i.scope.url||i.scope.url===o.url)))return 'prerequisite';
  if(o.boundaries?.length&&action.boundary?.intent==='exit'&&!allowed.some(i=>i.scope.label&&i.scope.kind&&matches(i.scope,action,o)))return 'prerequisite';
  const explicit=allowed.some(i=>i.scope.label&&i.scope.kind&&matches(i.scope,action,o));
  // A page-level capability gap describes unobservable content, not a ban on
  // every supported control on that page. Keep it untested without masking grants.
  if(!explicit&&plan.some(i=>!i.required&&!i.reason.startsWith('missing_capability:')&&['untested','excluded'].includes(i.status)&&matches(i.scope,action,o)))return;
  if(allowed.some(i=>matches(i.scope,action,o)&&(!boundOperationCondition(i)||boundOperationCondition(i)===schedulingKeyFor(action,o))))return 'target';
  if(allowed.some(i=>i.status!=='succeeded'&&i.prerequisites.some(p=>matches(p,action,o))))return 'prerequisite';
  if(o.boundaries?.length&&action.boundary?.intent==='exit')return 'prerequisite';
}
