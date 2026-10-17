import { conditionSplitIssues, boundOperationCondition, schedulingOperationCondition } from './plan-state.js';
import { browserControlCorrespondence, browserOperationCorrespondenceHint, browserTargetConditions, type ActionAttempt, type ActionCandidate, type BrowserEngine, type ContinuationRecord, type Observation } from '@interaction/browser';
import type { EvidenceRef, ExplorerHost, PlanItem, Scope, Task } from './types.js';
import { broadScope, controlScopeMatcher, digest, matches, scopeFor } from './policy.js';
import {observationActionIndex} from './observation-action-index.js';

/** A scheduling view of the immutable discovery ledger, never coverage or permission. */
export type ObligationState = 'active' | 'waiting' | 'unreachable' | 'alias' | 'resolved' | 'excluded' | 'authority' | 'superseded';
export interface ObligationEntry {
  itemId:string; groupId:string; state:ObligationState; reason:string;
  conditionVersion:string; currentActionId?:string; aliasOf?:string;
  source?:EvidenceRef & {actionId:string};
  /** Only this observation's host proof supports an alias. It expires on the next read. */
  correspondence?:{policy?:string;evidence:string[];invalidatedBy:string[]};
}
export interface ObligationProjection {
  version:1; sessionId:string; observationId:string; conditionVersion:string;
  entries:ObligationEntry[];
  counts:{rows:number;active:number;waiting:number;unreachable:number;aliases:number;superseded?:number;resolved:number;excluded:number;authority:number;unresolved:number;unresolvedGroups:number};
}
export interface ObligationLifecycleEvent {
  itemId:string; from?:ObligationState; to:ObligationState; reason:string; groupId:string;
  conditionVersion:string; currentExecution:false; coverageGranted:false;
}
export interface ObligationRouteCondition {
  itemId:string; conditionVersion:string; status:'unreachable'|'invalidated'; reason:string;
}
type ProjectionHost = Pick<ExplorerHost,'observation'|'actions'> & Partial<Pick<BrowserEngine,'explorationTargetCorrespondences'>>;

/** A condition revision describes declared context and semantic boundary state,
 * not observation identity, display prices, DOM occurrence IDs or elapsed time.
 * targetConditionKeys must be SDK dependency projections, never model prose.
 * This is a retry budget key; it grants neither correspondence nor permission.
 */
export function recoveryConditionVersion(o:Observation,targetConditionKeys:readonly string[]=[]):string {
  return digest({policy:'explorer-recovery-condition-v1',url:o.url,ruleVersion:o.ruleVersion,
    context:Object.fromEntries(Object.entries(o.context).map(([key,value])=>[key,{status:value.status,value:value.value}])),
    boundaries:(o.boundaries||[]).map(b=>{const region=o.regions.find(r=>r.key===b.region);return {name:b.name,region:region&&{label:region.label,role:region.role}};}),
    targets:[...new Set(targetConditionKeys)].sort()});
}

/** Only the currently observed route/target operations contribute retry changes.
 * A mode selector in their SDK dependency projection or their own readiness may
 * justify a new attempt; unrelated controls and passive text cannot do so.
 * Missing targets are represented as missing, never guessed from old node IDs.
 */
export function recoveryRouteConditionVersion(o:Observation,actions:ActionCandidate[],scopes:readonly Scope[]):string {
  const keys=scopes.map((scope,index)=>{
    const candidates=actions.filter(a=>a.sessionId===o.sessionId&&a.observationId===o.id&&matches(scope,a,o));
    if(candidates.length!==1)return digest({index,match:candidates.length?'ambiguous':'absent'});
    const action=candidates[0],control=o.controls.find(c=>c.localId===action.localId),conditions=browserTargetConditions(action,o);
    return digest({index,condition:conditions?.key||'unverified',visible:action.preconditions.visible,enabled:action.preconditions.enabled,
      excluded:action.excluded,exclusionReason:action.exclusionReason,basis:action.basis?.status,
      blockers:[...new Set(action.preconditions.blockers?.map(b=>b.code)||[])].sort(),readiness:control?.readiness?.status,
      hitTarget:control?.actionable?.hitTarget,unknown:control?.actionable?.unknown});
  });
  return recoveryConditionVersion(o,keys);
}

/** A recovery budget belongs to a semantic route, not a generated checkpoint.
 * Only uniquely matched retained operations receive SDK correspondence hints;
 * unmatched review/page scopes keep their literal meaning. This key limits work
 * and cannot establish identity, coverage, reachability or repetition permission.
 * Source mode state belongs to the separate condition version, so A-B-A does not
 * silently mint a new route when checkpoint/document IDs change.
 */
export function recoveryRouteKey(source:Observation,actions:ActionCandidate[],targets:readonly Scope[],path:readonly Scope[]=[]):string {
  const semantic=(scope:Scope)=>{
    const matchesSource=actions.filter(a=>a.sessionId===source.sessionId&&a.observationId===source.id&&matches(scope,a,source));
    if(matchesSource.length!==1||!scope.kind)return {recordedScope:scope};
    const action=matchesSource[0],control=source.controls.find(c=>c.localId===action.localId);
    if(!control)return {recordedScope:scope};
    const native=browserOperationCorrespondenceHint(control,action.kind,source),hint=native||browserControlCorrespondence(control);
    const region=source.regions.find(r=>r.key===control.region),{instanceId:_formInstance,...form}=control.formOwner||{};
    return {operation:action.kind,value:action.value,reference:hint&&{key:hint.key,policy:hint.policy},
      target:{tag:control.tag,role:control.role,...native?{}:{name:control.label||control.name},
        region:region?{label:region.label,role:region.role}:scope.region,
        context:control.identityContext&&{scope:control.identityContext.scope,binding:control.identityContext.binding},
        form:control.formOwner?form:undefined}};
  };
  return digest({policy:'explorer-recovery-route-v1',url:source.url,
    context:Object.fromEntries(Object.entries(source.context).map(([key,value])=>[key,{status:value.status,value:value.value}])),
    targets:[...new Set(targets.map(scope=>digest(semantic(scope))))].sort(),path:path.map(semantic)});
}

const passiveOperationReasons=new Set(['observed_in_scope','operation_not_executed']);
function aliasCandidate(item:PlanItem):boolean {
  // Unknown, attempted, recovery and capability obligations must never disappear
  // behind another row, even when the target itself has a positive match.
  return item.required&&item.dispatchScope===false&&!!item.scope.kind&&!!(item.scope.label||item.scope.stableKey)
    &&!(item.conditionCompletion?.status==='unverified'&&item.conditionCompletion.waiting!==false)
    &&['pending','unresolved','blocked'].includes(item.status)&&passiveOperationReasons.has(item.reason)
    &&item.attempts.length===0&&!item.resolvedBy&&!item.reviewResolvedBy&&!item.coverageResolvedBy
    &&item.evidence.every(e=>!e.attemptId);
}
function unresolved(entry:ObligationEntry){return ['active','waiting','unreachable','alias'].includes(entry.state);}
function sameRef(a:EvidenceRef&{actionId:string},b:EvidenceRef&{actionId:string}) {
  return a.sessionId===b.sessionId&&a.observationId===b.observationId&&a.actionId===b.actionId;
}
function knownContext(o:Observation){return !o.gaps.some(g=>g.critical)&&Object.values(o.context).every(v=>v.status==='known');}
function contextKey(o:Observation){return digest(Object.fromEntries(Object.entries(o.context).map(([k,v])=>[k,{status:v.status,value:v.value}])));}
function visibleAction(action:ActionCandidate,o:Observation){return action.preconditions.visible&&(!action.localId||o.controls.some(c=>c.localId===action.localId&&c.visible));}

/** Rebuild after every observation/review change. No prior positive alias is
 * reused: previous only stabilizes group IDs and generates transition events.
 * Hidden and absent controls remain waiting; absence is never removal proof.
 * All source reads and candidate caches are local to this synchronous call.
 */
export function projectObligations(host:ProjectionHost,task:Pick<Task,'plan'>,o:Observation,actions:ActionCandidate[],previous?:ObligationProjection,routeConditions:readonly ObligationRouteCondition[]=[]):{projection:ObligationProjection;events:ObligationLifecycleEvent[]} {
  const conditionVersion=recoveryConditionVersion(o),current=actions.filter(a=>a.sessionId===o.sessionId&&a.observationId===o.id);
  const currentIndex=observationActionIndex(o,current),matchControl=controlScopeMatcher(o,current);
  const previousEntries=new Map(previous?.version===1?previous.entries.map(e=>[e.itemId,e]):[]);
  const splitIssues=conditionSplitIssues(task.plan);
  const entries:ObligationEntry[]=task.plan.map(item=>{
    const entry:ObligationEntry={itemId:item.id,groupId:item.id,state:'waiting',reason:'target_not_observed',conditionVersion};
    if(splitIssues.has(item.id))return {...entry,state:'unreachable',reason:`condition_split_invalid:${splitIssues.get(item.id)}`};
    if(item.status==='superseded')return {...entry,state:'superseded',reason:'original_scope_transferred_to_children'};
    if(item.conditionMigration?.status==='split')return {...entry,state:'unreachable',reason:item.reason};
    if(item.status==='succeeded')return {...entry,state:'resolved',reason:'original_ledger_resolved'};
    // Nonrequired unsupported content is an untested limitation, not evidence of
    // user exclusion or successful coverage. Preserve it in the unresolved view.
    if(item.reason.startsWith('missing_capability:'))return {...entry,state:'active',reason:'capability_obligation_preserved'};
    if(!item.required||item.status==='excluded')return {...entry,state:'excluded',reason:'original_ledger_excluded'};
    if(item.scope.kind&&item.conditionCompletion?.status==='unverified'&&item.conditionCompletion.waiting!==false
      &&!item.attempts.some(a=>['unknown','executing'].includes(a.outcome)))return {...entry,state:'waiting',reason:'operation_conditions_unverified'};
    if(item.dispatchScope===false&&item.conditionMigration?.status==='invalidated')return {...entry,state:'unreachable',reason:item.reason};
    if(item.dispatchScope===true&&broadScope(item.scope))return {...entry,state:'authority',reason:'task_scope_authority'};
    const scoped=currentIndex.matching(item.scope);
    const condition=boundOperationCondition(item),candidates=scoped.filter(a=>!condition||condition===currentIndex.condition(a));
    if(candidates.length===1){entry.state=visibleAction(candidates[0],o)?'active':'waiting';entry.reason=entry.state==='active'?'current_target_observed':'target_hidden';entry.currentActionId=candidates[0].id;}
    else if(candidates.length>1){entry.state='active';entry.reason='current_target_ambiguous';}
    else if(scoped.length&&item.operationConditionKey)entry.reason='operation_conditions_changed';
    else {
      const controls=o.controls.filter(c=>matchControl(item.scope,c));
      if(controls.some(c=>c.visible)){entry.state='active';entry.reason='target_observed_operation_unavailable';}
      else if(controls.length)entry.reason='target_hidden';
    }
    if(item.attempts.some(a=>a.outcome==='unknown'||a.outcome==='executing')){entry.state='active';entry.reason='execution_result_unresolved';}
    const route=routeConditions.find(r=>r.itemId===item.id&&r.conditionVersion===conditionVersion);
    if(route?.status==='unreachable'&&entry.state==='waiting'){entry.state='unreachable';entry.reason=route.reason;}
    if(route?.status==='invalidated'&&entry.state==='waiting')entry.reason=route.reason;
    return entry;
  });
  const byId=new Map(entries.map(e=>[e.itemId,e]));
  const query=host.explorationTargetCorrespondences;
  if(query&&knownContext(o)) {
    type Source={ref:EvidenceRef&{actionId:string};action:ActionCandidate;observation:Observation};
    const retained=new Map<string,{observation:Observation;index:ReturnType<typeof observationActionIndex>}|undefined>();
    const currentKey=`${o.sessionId}:${o.id}`,currentRecord={observation:o,index:currentIndex};
    const candidates=new Map<string,{action:ActionCandidate;hint?:string}[]>();
    for(const action of current){const key=JSON.stringify([action.kind,action.value]),values=candidates.get(key)||[],control=o.controls.find(c=>c.localId===action.localId);
      values.push({action,hint:control&&browserOperationCorrespondenceHint(control,action.kind,o)?.key});candidates.set(key,values);}
    const requests:Parameters<NonNullable<ProjectionHost['explorationTargetCorrespondences']>>[1]['requests']=[];
    const requestPositions=new Map<string,number>(),positions=new Map<string,number[]>(),sources=new Map<number,Source['ref']>();
    for(const item of task.plan.filter(aliasCandidate)) {
      // A PlanItem may contain several visits. Select a retained exact source in
      // this context, never reinterpret its label to manufacture a source.
      let source:Source|undefined,otherKnownContext=false,sourceConditionMismatch=false;
      for(const ref of [...item.evidence].reverse()) {
        const key=`${ref.sessionId}:${ref.observationId}`;
        if(key!==currentKey&&!retained.has(key)) {
          try{const observation=host.observation(ref.sessionId,ref.observationId);
            if(observation.sessionId===ref.sessionId&&observation.id===ref.observationId){
              const actions=host.actions(ref.sessionId,ref.observationId).filter(a=>a.sessionId===ref.sessionId&&a.observationId===ref.observationId);
              retained.set(key,{observation,index:observationActionIndex(observation,actions)});
            }else retained.set(key,undefined);
          }catch{retained.set(key,undefined);}
        }
        const record=key===currentKey?currentRecord:retained.get(key);
        // Full retained captures can be megabytes each. Keep only eight source
        // documents; outgoing requests contain IDs, never captured documents.
        if(key!==currentKey){retained.delete(key);retained.set(key,record);while(retained.size>8)retained.delete(retained.keys().next().value!);}
        if(!record||!knownContext(record.observation))continue;
        if(contextKey(record.observation)!==contextKey(o)){otherKnownContext=true;continue;}
        const scopedSources=record.index.matching(item.scope);
        const condition=schedulingOperationCondition(item),found=scopedSources.filter(a=>!condition||condition===record.index.condition(a));
        if(scopedSources.length&&!found.length&&item.operationConditionKey)sourceConditionMismatch=true;
        if(found.length!==1)continue;
        source={ref:{sessionId:ref.sessionId,observationId:ref.observationId,actionId:found[0].id},action:found[0],observation:record.observation};break;
      }
      if(!source){if(otherKnownContext||sourceConditionMismatch){const entry=byId.get(item.id)!;entry.state='waiting';entry.reason=otherKnownContext?'source_context_changed':'source_condition_unverified';delete entry.currentActionId;}continue;}
      const sourceControl=source.observation.controls.find(c=>c.localId===source!.action.localId);
      const sourceHint=sourceControl&&browserOperationCorrespondenceHint(sourceControl,source.action.kind,source.observation)?.key;
      for(const {action,hint} of candidates.get(JSON.stringify([source.action.kind,source.action.value]))||[]) {
        // Bound comparisons using SDK hints and literal semantic names. This is
        // only a prefilter; the host must prove every resulting equivalence.
        if(action.label!==source.action.label&&(!sourceHint||sourceHint!==hint))continue;
        const request={actionId:action.id,source:source.ref},key=JSON.stringify(request);let index=requestPositions.get(key);
        if(index===undefined){index=requests.length;requests.push(request);requestPositions.set(key,index);sources.set(index,source.ref);}
        const indices=positions.get(item.id)||[];indices.push(index);positions.set(item.id,indices);
      }
    }
    if(requests.length)try {
      const results:(ReturnType<NonNullable<ProjectionHost['explorationTargetCorrespondences']>>['results'][number]|undefined)[]=[];
      // The SDK reader memoizes full source captures within a batch. Bound each
      // batch so a long history cannot retain every multi-megabyte document.
      for(let offset=0;offset<requests.length;offset+=16)try{
        const result=query.call(host,o.sessionId,{observationId:o.id,requests:requests.slice(offset,offset+16)});
        if(result.sessionId===o.sessionId&&result.observationId===o.id)for(let i=0;i<Math.min(16,result.results.length,requests.length-offset);i++)results[offset+i]=result.results[i];
      }catch{/* Only this chunk loses its proof; its obligations stay unresolved. */}
      {
        const groups=new Map<string,ObligationEntry[]>();
        for(const [itemId,indices] of positions) {
          const accepted=indices.filter(index=>{const proof=results[index],request=requests[index];return proof?.equivalent
            &&proof.identityAuthorized===false&&proof.replayAuthorized===false&&proof.currentExecution===false
            &&proof.target.sessionId===o.sessionId&&proof.target.observationId===o.id&&proof.target.actionId===request.actionId
            &&sameRef(proof.source,request.source);});
          const targetIds=new Set(accepted.map(index=>requests[index].actionId));if(targetIds.size!==1)continue;
          const index=accepted[0],proof=results[index]!,entry=byId.get(itemId)!;
          entry.state=visibleAction(current.find(a=>a.id===proof.target.actionId)!,o)?'active':'waiting';entry.reason=entry.state==='active'?'sdk_current_target_equivalent':'target_hidden';entry.currentActionId=proof.target.actionId;entry.source=sources.get(index)!;
          entry.correspondence={policy:proof.policy,evidence:proof.evidence,invalidatedBy:proof.invalidatedBy};
          const group=groups.get(proof.target.actionId)||[];group.push(entry);groups.set(proof.target.actionId,group);
        }
        for(const members of groups.values()) {
          // Retaining a previous group's name does not retain its applicability.
          // Every member above has a fresh proof for the same current operation.
          const oldIds=members.map(m=>previousEntries.get(m.itemId)?.groupId).filter((id):id is string=>!!id&&members.some(m=>m.itemId===id));
          const representative=members.find(m=>m.itemId===oldIds[0])||members[0];
          for(const entry of members){entry.groupId=representative.itemId;if(entry!==representative){entry.state='alias';entry.aliasOf=representative.itemId;entry.reason='sdk_equivalent_unexecuted_target';}}
        }
      }
    }catch{/* Missing or invalid source evidence keeps the original obligation. */}
  }
  const counts={rows:entries.length,active:0,waiting:0,unreachable:0,aliases:0,superseded:0,resolved:0,excluded:0,authority:0,unresolved:0,unresolvedGroups:0};
  for(const entry of entries){if(entry.state==='alias')counts.aliases++;else counts[entry.state]++;if(unresolved(entry))counts.unresolved++;}
  counts.unresolvedGroups=new Set(entries.filter(unresolved).map(e=>e.groupId)).size;
  const projection:ObligationProjection={version:1,sessionId:o.sessionId,observationId:o.id,conditionVersion,entries,counts};
  const events=entries.flatMap(entry=>{const old=previousEntries.get(entry.itemId);return old&&old.state===entry.state&&old.reason===entry.reason&&old.groupId===entry.groupId&&old.conditionVersion===entry.conditionVersion?[]:[{
    itemId:entry.itemId,...old?{from:old.state}:{},to:entry.state,reason:entry.reason,groupId:entry.groupId,conditionVersion,currentExecution:false as const,coverageGranted:false as const}];});
  return {projection,events};
}

export type RouteRetryOutcome = 'verified'|'unreachable'|'unverified'|'unknown'|'no_progress'|'review_material_available';
export interface RouteUnknownSource {sessionId:string;attemptIds:string[]}
export interface RouteFailureCondition {
  conditionVersion:string;evidence:EvidenceRef;basis:'complete-observation'|'replay-target-unavailable'|'review-material-observed';
}
export interface RouteRetryRecord {
  attempts:number;outcome:RouteRetryOutcome;reason:string;evidence?:EvidenceRef;attemptKey?:string;
  /** The condition left by this failed attempt is not a new retry opportunity. */
  resultCondition?:RouteFailureCondition;
  unknownSource?:RouteUnknownSource;
  /** The old outcome remains unknown; this is only a verified continuation basis. */
  recoveryVerificationId?:string;
}
export interface RouteRecoveryVerification {
  id:string;sessionId:string;attemptIds:string[];
  continuations:{id:string;attemptIds:string[];evidence:string[]}[];
  unknownRecords:{conditionVersion:string;record:RouteRetryRecord}[];
  consumedBy?:{conditionVersion:string;attemptKey?:string};
}
export interface RouteRetryLedger {
  version:1; routes:Record<string,{conditions:Record<string,RouteRetryRecord>;unknown?:boolean;saturated?:boolean;completedProgressKeys:string[];
    /** Survives replacement of one starting-condition record by a renewed attempt. */
    failedResultConditions?:Record<string,RouteFailureCondition&{sourceConditionVersion:string;attemptKey?:string}>;
    recoveryVerifications?:RouteRecoveryVerification[];recoveryAllowance?:string}>;
}
export interface RouteRetryDecision {allowed:boolean;reason:'new_condition'|'verified_recovery'|'condition_attempted'|'failed_result_condition'|'unknown_result'|'condition_limit'|'review_material_available';attempts:number}
const maxConditionsPerRoute=16;
export function routeRetryEligibility(ledger:RouteRetryLedger|undefined,routeKey:string,conditionVersion:string):RouteRetryDecision {
  const route=ledger?.version===1?ledger.routes[routeKey]:undefined,record=route?.conditions[conditionVersion];
  if(route?.unknown)return {allowed:false,reason:'unknown_result',attempts:record?.attempts||0};
  if(route?.recoveryAllowance&&route.recoveryVerifications?.some(v=>v.id===route.recoveryAllowance&&!v.consumedBy))return {allowed:true,reason:'verified_recovery',attempts:record?.attempts||0};
  if(record)return {allowed:false,reason:'condition_attempted',attempts:record.attempts};
  if(Object.values(route?.conditions||{}).some(prior=>prior.outcome==='review_material_available'&&prior.resultCondition?.conditionVersion===conditionVersion))
    return {allowed:false,reason:'review_material_available',attempts:0};
  if(route?.failedResultConditions?.[conditionVersion]||Object.values(route?.conditions||{}).some(prior=>(prior.outcome==='unverified'||prior.outcome==='unreachable')&&prior.resultCondition?.conditionVersion===conditionVersion))
    return {allowed:false,reason:'failed_result_condition',attempts:0};
  if(route?.saturated||Object.keys(route?.conditions||{}).length>=maxConditionsPerRoute)return {allowed:false,reason:'condition_limit',attempts:0};
  return {allowed:true,reason:'new_condition',attempts:0};
}
/** Reserve a route before dispatch with no_progress; the normal durable dispatch
 * record still owns in-flight/unknown execution. Reuse attemptKey when recording
 * the final result to avoid double counting. Unknown results close this route;
 * only exact original-source continuation evidence can grant one further attempt.
 * A fresh document/context or a later successful attempt never clears the debt.
 */
export function recordRouteRetry(ledger:RouteRetryLedger|undefined,input:{routeKey:string;conditionVersion:string;outcome:RouteRetryOutcome;reason:string;evidence?:EvidenceRef;attemptKey?:string;unknownSource?:RouteUnknownSource;resultCondition?:RouteFailureCondition}):RouteRetryLedger {
  const result:RouteRetryLedger=ledger?.version===1?structuredClone(ledger):{version:1,routes:{}};
  const route=result.routes[input.routeKey]||={conditions:{},completedProgressKeys:[]};
  const existing=route.conditions[input.conditionVersion];
  const allowance=!route.unknown&&route.recoveryVerifications?.find(v=>v.id===route.recoveryAllowance&&!v.consumedBy);
  if(existing?.outcome==='unknown'&&input.outcome!=='unknown'&&!allowance)return result;
  if(allowance){
    allowance.consumedBy={conditionVersion:input.conditionVersion,...input.attemptKey?{attemptKey:input.attemptKey}:{}};delete route.recoveryAllowance;
    // Its original unknown record is retained in the verification audit. Reuse
    // that slot for the one explicitly renewed attempt if conditions are full.
    if(!existing&&Object.keys(route.conditions).length>=maxConditionsPerRoute){const recovered=Object.entries(route.conditions).find(([,r])=>r.recoveryVerificationId===allowance.id);if(recovered)delete route.conditions[recovered[0]];}
  }
  if(!existing&&Object.keys(route.conditions).length>=maxConditionsPerRoute){route.saturated=true;if(input.outcome==='unknown')route.unknown=true;return result;}
  const supplied=input.unknownSource,validSource=supplied?.sessionId&&supplied.attemptIds.length&&supplied.attemptIds.every(id=>typeof id==='string'&&id.length>0)&&(!input.evidence||input.evidence.sessionId===supplied.sessionId);
  let unknownSource=input.outcome==='unknown'&&validSource?{sessionId:supplied.sessionId,attemptIds:[...new Set(supplied.attemptIds)].sort()}:undefined;
  if(existing?.outcome==='unknown'&&!existing.recoveryVerificationId&&input.outcome==='unknown'){
    unknownSource=unknownSource&&existing.unknownSource?.sessionId===unknownSource.sessionId?{sessionId:unknownSource.sessionId,attemptIds:[...new Set([...existing.unknownSource.attemptIds,...unknownSource.attemptIds])].sort()}:undefined;
  }
  route.conditions[input.conditionVersion]={attempts:(existing?.attempts||0)+(input.attemptKey&&existing?.attemptKey===input.attemptKey?0:1),outcome:input.outcome,reason:input.reason,...input.evidence?{evidence:input.evidence}:{},...input.attemptKey?{attemptKey:input.attemptKey}:{},...unknownSource?{unknownSource}:{}};
  // Exposed current material consumes navigation only. It never verifies an old
  // source or enters the failed-result ledger; a changed material key can retry.
  if(input.outcome==='review_material_available'&&input.resultCondition?.basis==='review-material-observed'
    &&input.resultCondition.evidence.sessionId===input.evidence?.sessionId&&input.resultCondition.evidence.observationId===input.evidence?.observationId)
    route.conditions[input.conditionVersion].resultCondition=structuredClone(input.resultCondition);
  else retainFailureCondition(route,input.conditionVersion,input.resultCondition);
  if(input.outcome==='unknown'){route.unknown=true;delete route.recoveryAllowance;}
  return result;
}

function retainFailureCondition(route:RouteRetryLedger['routes'][string],sourceConditionVersion:string,condition?:RouteFailureCondition) {
  const record=route.conditions[sourceConditionVersion];
  if(condition&&(record.outcome==='unverified'||record.outcome==='unreachable')
    &&condition.evidence.sessionId===record.evidence?.sessionId&&condition.evidence.observationId===record.evidence.observationId){
    record.resultCondition=structuredClone(condition);
    const results=route.failedResultConditions??={};
    if(!results[condition.conditionVersion]){
      if(Object.keys(results).length>=maxConditionsPerRoute){route.saturated=true;return;}
      results[condition.conditionVersion]={...structuredClone(condition),sourceConditionVersion,...record.attemptKey?{attemptKey:record.attemptKey}:{}};
    }
  }
}
/** Upgrade retained failure evidence without inventing or recounting an attempt. */
export function retainRouteFailureCondition(ledger:RouteRetryLedger,routeKey:string,conditionVersion:string,resultCondition:RouteFailureCondition):RouteRetryLedger {
  const result=structuredClone(ledger),record=result.routes[routeKey]?.conditions[conditionVersion];
  if(record&&!record.resultCondition)retainFailureCondition(result.routes[routeKey],conditionVersion,resultCondition);
  return result;
}

/** Read the original SDK ledger, never a caller's declaration of recovery.
 * This renews one scheduling attempt only: the SDK must still establish current
 * arrival and repetition permission. Missing or unmapped legacy evidence stays
 * locked. The same original unknown IDs can never mint a second allowance.
 */
export function releaseRouteRetriesForVerifiedRecovery(host:Pick<ExplorerHost,'list'>,ledger:RouteRetryLedger|undefined,sessionId:string) {
  const result:RouteRetryLedger=ledger?.version===1?structuredClone(ledger):{version:1,routes:{}};
  const released:{routeKey:string;verificationId:string;attemptIds:string[];continuationIds:string[]}[]=[];
  const pending=Object.entries(result.routes).filter(([,r])=>r.unknown);
  if(!pending.length)return {ledger:result,released};
  let attempts:ActionAttempt[],continuations:ContinuationRecord[];
  try{attempts=host.list<ActionAttempt>(sessionId,'attempt');continuations=host.list<ContinuationRecord>(sessionId,'continuation');}catch{return {ledger:result,released};}
  for(const [routeKey,route] of pending){
    const unknownRecords=Object.entries(route.conditions).filter(([,r])=>r.outcome==='unknown'&&!r.recoveryVerificationId).map(([conditionVersion,record])=>({conditionVersion,record}));
    if(!unknownRecords.length||unknownRecords.some(({record})=>record.unknownSource?.sessionId!==sessionId||!record.unknownSource.attemptIds.length))continue;
    const attemptIds=[...new Set(unknownRecords.flatMap(({record})=>record.unknownSource!.attemptIds))].sort();
    if(attemptIds.some(id=>!attempts.some(a=>a.id===id&&a.sessionId===sessionId&&a.status!=='executing')))continue;
    const proof=continuations.filter(c=>c.sessionId===sessionId&&c.id&&c.verifiedRecovery?.evidence.length&&c.verifiedRecovery.evidence.every(e=>typeof e==='string'&&e.trim())&&c.verifiedRecovery.attemptIds.some(id=>attemptIds.includes(id)));
    if(attemptIds.some(id=>!proof.some(c=>c.verifiedRecovery!.attemptIds.includes(id))))continue;
    const verificationId=digest({policy:'explorer-route-recovery-v1',sessionId,attemptIds});
    if(route.recoveryVerifications?.some(v=>v.id===verificationId))continue;
    (route.recoveryVerifications??=[]).push({id:verificationId,sessionId,attemptIds,
      continuations:proof.map(c=>({id:c.id,attemptIds:[...c.verifiedRecovery!.attemptIds],evidence:[...c.verifiedRecovery!.evidence]})),unknownRecords:structuredClone(unknownRecords)});
    for(const {record} of unknownRecords)record.recoveryVerificationId=verificationId;
    route.unknown=false;route.recoveryAllowance=verificationId;
    released.push({routeKey,verificationId,attemptIds,continuationIds:proof.map(c=>c.id)});
  }
  return {ledger:result,released};
}
/** Only new verified target progress renews a no-progress allowance. The caller
 * supplies a stable completed obligation key, not an observation/attempt UUID.
 * Unknown results still require a separate explicit recovery assessment.
 */
export function releaseRouteRetryForProgress(ledger:RouteRetryLedger|undefined,routeKey:string,completedObligationKey:string):RouteRetryLedger {
  const result:RouteRetryLedger=ledger?.version===1?structuredClone(ledger):{version:1,routes:{}};
  const route=result.routes[routeKey];if(!route||route.unknown||route.completedProgressKeys.includes(completedObligationKey))return result;
  route.completedProgressKeys.push(completedObligationKey);route.conditions={};delete route.failedResultConditions;route.saturated=false;return result;
}
