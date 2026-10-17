import { isUnfinished, schedulableObligation } from './plan-state.js';
import { reusableClassifications } from './classification-reuse.js';
import { z } from 'zod';
import type { ActionCandidate, IdentityHypothesis, ControlIdentity, Observation, ExplorationGroup, PurposeReview, RegionCandidate } from '@interaction/browser';
import type { ExplorerHost, Task, ModelRequest, Decision, Scope } from './types.js';
import { jsonSchema } from './schema.js';
import { digest, matches, includesScope, broadScope, decisionPlan, scopeForControl, navigationTarget, controlScopeMatcher } from './policy.js';
import type { SemanticReview } from './semantic-review.js';

export interface ReviewContext {
  host:ExplorerHost;task:Task;observation:Observation;
  /** Yield to local actions only while the scheduler can still prefer them to recovery. */
  allowLocalActionYield?:boolean;
  /** One freshly bound selected child can continue after recovery at the local quota. */
  allowPriorityActionYield?:boolean;
  /** Current SDK-corresponding child actions. Ordering only; never execution permission. */
  priorityActionIds?:readonly string[];
  choose(purpose:string,instructions:string,state:unknown,options:Record<string,unknown>,constraints?:ChoiceConstraints):Promise<{value:string;decision:Decision}>;
  assess(purpose:string,state:unknown,checks:NonNullable<ModelRequest['checks']>):Promise<{values:Record<string,boolean|null>;decision:Decision}>;
  refresh(decision:Decision,key:string):Promise<boolean>;
  clarify(request:SemanticReview):Promise<{value:string;decision:Decision}>;
  generate<T>(purpose:string,instructions:string,state:unknown,schema:z.ZodType<T>):Promise<{value:T;decision:Decision}>;
  apply(decision:Decision|Decision[],command:unknown):Promise<void>;
  /** Deterministic bookkeeping/observation decisions, with no fabricated model record. */
  programApply?(command:unknown,reason:string,details?:unknown):Promise<void>;
  probe(decision:Decision,localId:string,kind:'hover'|'focus'):Promise<void>;
  /** An SDK-available bounded observation, not model authorization or execution coverage. */
  programProbe?(localId:string,kind:'hover'|'focus',reason:string):Promise<void>;
  defer(decision:Decision,reason:string):void;
  unchanged?(evidence:{sourceDecisionId:string;sourceObservationId:string;scope:Scope}):void;
  /** Negative evidence only; no successful review, operation or coverage. */
  unresolvedReview?(evidence:{localId:string;decisionId:string;kind:'purpose'|'probe'}):void;
  retain(groups:RetainedScope[]):Promise<void>;
  gap(reason:string,scope:Scope,required?:boolean,prerequisites?:Scope[]):void;
  hasPendingAction(filter?:(action:ActionCandidate)=>boolean,freshOnly?:boolean):boolean;
}
export type ChoiceConstraints=Pick<ModelRequest,'allowedReductions'|'blockedOptions'>;
export interface RetainedScope {id:string;revision:number;label:string;memberKeys:string[];actionIds:string[];historicalMemberCount:number}
const evidence=(d:Decision)=>[`explorer-decision:${d.id}`];
const source='explorer-plugin';
// Execution IDs change on recapture; model evidence describes the operation, not a dispatch grant.
const semanticActions=(actions:ActionCandidate[])=>actions.map(({kind,label,value,basis,risk})=>({kind,label,value,basis,risk}));
/** A translation alone adds no purpose evidence. Preserve all other facts, and never cache a grant here. */
export function unresolvedPurposeKey(o:Observation,item:ReturnType<ExplorerHost['controlReviewMaterial']>['controls'][number],revision:number) {
  const {x:_x,y:_y,...size}=item.control.rect;
  const actionable=item.control.actionable&&(()=>{
    // A scroll changes sampled pointer geometry, not unresolved purpose. Preserve
    // actual state/obstruction and every other unknown fact; dispatch reads them all
    // freshly and never consumes this negative cache as operation permission.
    const {clickPoint:_point,hitTarget:_hit,unknown,...state}=item.control.actionable;
    return {...state,unknown:unknown?.filter(reason=>reason!=='off-viewport-hit-target')};
  })();
  return digest({protocol:'unresolved-purpose/v1',revision,instance:o.instanceScope,url:o.url,context:o.context,boundaries:o.boundaries,
    surroundings:item.surroundings,control:{...item.control,rect:size,...(actionable?{actionable}:{})},reviews:item.reviews.map(r=>[r.id,r.status]),actions:item.actions.map(a=>({kind:a.kind,risk:a.risk,value:a.value,basis:a.basis}))});
}
/** The host retains exact bindings for validation; grouping needs semantic evidence, not repeated dispatch fingerprints. */
function regionEvidence(candidate:RegionCandidate) {
  const {binding,reuseBinding,controlIds,...description}=candidate;
  const facts=binding as Record<string,unknown>;
  return {...description,memberCount:controlIds.length,structure:Object.fromEntries(['tag','role','heading','label','layout','border','semantic','root'].filter(k=>facts[k]!==undefined).map(k=>[k,facts[k]]))};
}
/** Submit one guarded review command at a time; it may recapture and invalidate all other material. */
export async function reviewNext(c:ReviewContext):Promise<boolean> {
  const {host,task,observation:o}=c;const sid=o.sessionId;const round=task.rounds.at(-1)!;
  const sessionOptions=host.session?.(sid)?.options;
  const observedUI=!!sessionOptions&&'executionPolicy' in sessionOptions&&sessionOptions.executionPolicy==='observed-ui';
  const done=(key:string)=>round.reviewed.includes(key);const mark=(key:string)=>round.reviewed.push(key);
  const available=host.actions(sid);
  const boundary=o.boundaries?.at(-1),overlay=o.overlays?.find(b=>b.key===boundary?.key);
  const boundaryIds=overlay?new Set(overlay.controlIds):undefined;
  const inCurrentBoundary=(action:ActionCandidate)=>!boundary||action.boundary?.key===boundary.key;
  const pendingPlan=task.plan.filter(isUnfinished);
  const inScope=controlScopeMatcher(o,available);
  const relevant=(control:Observation['controls'][number])=>{
    // Background obligations remain in the plan. Review them after the active boundary exits.
    if(boundaryIds&&!boundaryIds.has(control.localId))return false;
    if(available.some(a=>a.localId===control.localId&&includesScope(pendingPlan,a,o)))return true;
    if(task.plan.some(i=>!i.required&&i.reason==='user_excluded'&&inScope(i.scope,control)))return false;
    return pendingPlan.some(i=>i.required&&i.dispatchScope===true&&[i.scope,...i.prerequisites].some(scope=>inScope(scope,control)));
  };
  const allRelevantIds=new Set(o.controls.filter(relevant).map(c=>c.localId));
  const requested=new Set(c.priorityActionIds||[]),actionCounts=new Map<string,number>();
  for(const action of available)actionCounts.set(action.id,(actionCounts.get(action.id)||0)+1);
  const priority=available.filter(action=>requested.has(action.id)&&actionCounts.get(action.id)===1&&action.sessionId===sid&&action.observationId===o.id
    &&inCurrentBoundary(action)&&!!includesScope(task.plan,action,o)&&(!action.localId||o.controls.filter(control=>control.localId===action.localId).length===1));
  const priorityIds=new Set(priority.map(action=>action.id)),priorityControls=new Set(priority.flatMap(action=>action.localId&&allRelevantIds.has(action.localId)?[action.localId]:[]));
  const priorityFilter=(action:ActionCandidate)=>priorityIds.has(action.id)&&action.sessionId===sid&&action.observationId===o.id;
  // Ordinary early yield stays in place. A selected child may also navigate,
  // but only after fresh SDK availability and retention of unresolved controls.
  const inPlace=(a:ActionCandidate)=>inCurrentBoundary(a)&&!['dismiss','history'].includes(a.kind)&&a.boundary?.intent!=='exit'&&!navigationTarget(a,o);
  const retainBeforeYield=()=>{
    // Local actions and scrolling may hide current controls too. Retain obligations
    // before yielding; these are evidence gaps, never new dispatch authority. A later
    // pass reviews them normally because no reviewed key or decision is fabricated.
    const recorded=new Set(task.plan.filter(i=>i.status==='unresolved'&&i.required).map(i=>digest({reason:i.reason,scope:i.scope})));
    const retain=(reason:string,control:Observation['controls'][number])=>{
      if(!allRelevantIds.has(control.localId))return;
      const scope=scopeForControl(control,o),key=digest({reason,scope});if(recorded.has(key))return;
      c.gap(reason,scope,true,round.entryPath);recorded.add(key);
    };
    const interpretations=host.controlInterpretationSnapshot(sid,o.id);
    for(const item of interpretations.classifications.controls)if(item.needsClassification)retain('classification_unresolved',item.control);
    for(const item of interpretations.operations.controls)if(item.needsReview)retain('operation_basis_unconfirmed',item.control);
    const pendingIdentities=new Set(host.list<IdentityHypothesis>(sid,'hypothesis').filter(h=>h.status==='pending').map(h=>h.id));
    for(const control of o.controls)if(control.hypothesisId&&pendingIdentities.has(control.hypothesisId))retain('identity_unresolved',control);
  };
  // These read models live only inside this call. Every command/probe that can
  // recapture returns immediately; the next step rebuilds all material.
  let regions:ReturnType<ExplorerHost['regionReviewMaterial']>|undefined;
  let exploration:ReturnType<ExplorerHost['explorationReviewMaterial']>|{groups:ExplorationGroup[]}|undefined;
  let classification:ReturnType<ExplorerHost['controlClassificationMaterial']>|undefined;
  let operations:ReturnType<ExplorerHost['controlReviewMaterial']>|undefined;
  const readRegions=()=>regions??=host.regionReviewMaterial(sid);
  const readExploration=()=>exploration??=(available.length?host.explorationReviewMaterial(sid):{groups:[]});
  const readClassification=()=>classification??=host.controlClassificationMaterial(sid);
  const readOperations=()=>operations??=host.controlReviewMaterial(sid);
  const pendingScopes=(focused:boolean)=>readExploration().groups.filter(g=>g.status==='pending'||!g.decisions.length).flatMap(group=>{
    const key=`group:${group.id}:${group.revision}`;if(done(key))return [];
    const members=group.members.filter(m=>available.some(a=>a.id===m.actionId));
    if(!members.some(m=>{const action=available.find(a=>a.id===m.actionId)!;return inCurrentBoundary(action)&&includesScope(pendingPlan,action,o);})
      ||focused&&!members.some(m=>priorityIds.has(m.actionId)))return [];
    const explicit=members.some(m=>{const action=available.find(a=>a.id===m.actionId)!;return task.plan.some(i=>i.required&&schedulableObligation(i)&&i.scope.label&&i.scope.kind&&matches(i.scope,action,o));});
    return [{group,key,members,allowedReductions:task.coverageMode==='representative'&&!explicit?['sample']:[]}];
  });
  const retainGroups=(scopes:ReturnType<typeof pendingScopes>)=>{
    const retained=scopes.filter(s=>!s.allowedReductions.length).slice(0,50);
    if(!retained.length)return false;
    for(const s of retained)mark(s.key);
    return c.retain(retained.map(({group,members})=>({id:group.id,revision:group.revision,label:group.label,memberKeys:members.map(m=>m.key),actionIds:members.map(m=>m.actionId),historicalMemberCount:group.members.length-members.length})));
  };
  const reviewGroup=async({group,key,members,allowedReductions}:ReturnType<typeof pendingScopes>[number])=>{
    const plan=decisionPlan(task.plan);
    const d=await c.choose('scope-review','Choose exhaustive traversal or representative sampling of current observed members. Sampling requires the supplied user permission; every omitted member remains untested. Never skip a group based only on confidence. Program scope matching still limits execution to the selected task.',{observationId:o.id,goal:task.goal||'Explore all discovered interactions within the current page boundary and preserve unresolved gaps',coverageMode:task.coverageMode||'all',allowedReductions,plan,group:{...group,members,historicalMemberCount:group.members.length-members.length}},
      {all:'Keep all observed members available for in-scope traversal',sample:'User explicitly permits representative sampling',defer:'Cannot proceed yet',skip:'Outside the task',uncertain:'Unable to decide'},{allowedReductions});
    const mode=d.value==='uncertain'?'defer':d.value;let memberKeys:string[]=[];
    if(mode==='sample') {
      // Deterministic batching avoids silently discarding candidates above JEV's option limit.
      for(let offset=0;offset<members.length;offset+=200) {
        const options:Record<string,unknown>=Object.fromEntries(members.slice(offset,offset+200).map(m=>[m.key,{label:m.label,kind:m.kind,value:m.value,risk:m.risk}]));
        options.none='No representative needed from this batch';options.uncertain='Cannot choose';
        const sample=await c.choose('sample-selection','Select one representative from this batch, or none. Each batch is reviewed; no omitted member counts as covered.',{observationId:o.id,goal:task.goal||'Explore all discovered interactions within the current page boundary and preserve unresolved gaps',groupLabel:group.label,batch:offset/200},options);
        if(!['none','uncertain'].includes(sample.value))memberKeys.push(sample.value);
      }
    }
    mark(key);
    const finalMode=mode==='sample'&&!memberKeys.length?'defer':mode;
    await c.apply(d.decision,{type:'decideExplorationGroup',groupId:group.id,revision:group.revision,decision:{mode:finalMode,...(finalMode==='sample'?{memberKeys}:{}),source,evidence:evidence(d.decision)}});
    for(const member of members)if(finalMode==='skip'||(finalMode==='sample'&&!memberKeys.includes(member.key))) {
      const action=host.actions(sid).find(a=>a.id===member.actionId);
      if(action){const s={url:o.url,label:action.label,kind:action.kind,...(action.value===undefined?{}:{value:action.value as string|boolean|number})};c.gap(finalMode==='skip'?'scope_excluded':'sample_unselected',s,false);}
    }
    if(finalMode==='defer')c.gap('scope_deferred',{url:o.url,region:group.label});
    return true;
  };
  for(const focused of priorityIds.size?[true,false]:[false]) {
  const relevantIds=focused?priorityControls:allRelevantIds;
  const finiteNeedsReview=o.coveragePolicy==='finite-ui-v1'&&(readClassification().controls.some(item=>item.needsClassification&&allRelevantIds.has(item.control.localId)&&!done(digest({type:'classification',instance:o.instanceScope,control:item.control,reviews:item.classifications.map(r=>[r.id,r.status])})))
    ||o.controls.some(x=>x.hypothesisId&&allRelevantIds.has(x.localId)&&host.list<IdentityHypothesis>(sid,'hypothesis').some(h=>h.id===x.hypothesisId&&h.status==='pending')));
  if(!finiteNeedsReview&&(focused?(c.allowPriorityActionYield??c.allowLocalActionYield):c.allowLocalActionYield)!==false&&(focused?c.hasPendingAction(priorityFilter,true):available.some(inPlace)&&c.hasPendingAction(inPlace,true))){retainBeforeYield();return false;}
  if(observedUI&&!c.programApply){c.gap('missing_capability:program_review',{url:o.url});return false;}
  if(focused){const scopes=pendingScopes(true),retained=retainGroups(scopes);if(retained){await retained;return true;}if(scopes.length)return reviewGroup(scopes[0]);}
  const region=readRegions();
  const broad=!focused&&pendingPlan.some(i=>i.required&&i.dispatchScope===true&&broadScope(i.scope)&&(!i.scope.url||i.scope.url===o.url));
  if(region.enabled&&(region.unassignedControlIds.some(id=>relevantIds.has(id))||(!boundary&&region.unassignedPageTraversal&&broad))) {
    // Reuse only a fresh SDK mapping of an explicitly reusable source. This
    // task/rule scope does not inherit dispatch, depth or completion decisions.
    const businessScope=`explorer-region/v1:${digest({taskId:task.id,goal:task.goal,intent:task.intent,coverageMode:task.coverageMode||'all',sessionOptions:task.sessionOptions,
      authority:[...new Set(task.plan.filter(i=>i.dispatchScope===true).map(i=>digest({scope:i.scope,prerequisites:i.prerequisites,required:i.required,excluded:i.status==='excluded'})))].sort()})}`;
    const reusableScene=!boundary&&!o.gaps?.some(g=>g.critical)&&Object.values(o.context).every(value=>value.status==='known');
    if(c.programApply&&reusableScene&&region.sessionId===sid&&region.observationId===o.id&&region.review) {
      const keys=new Set((region.delta?.canUpdate?region.review.regions:[]).map(r=>r.key)),used=new Set<string>(),selectedKeys=new Set<string>();let traversal=false;
      const reuse=(region.reuseCandidates||[]).filter(candidate=>{
        if(candidate.businessScope!==businessScope||candidate.pageTraversal&&(!broad||traversal)||candidate.controlIds.some(id=>used.has(id)||!region.unassignedControlIds.includes(id))
          ||!candidate.controlIds.some(id=>relevantIds.has(id))&&!candidate.pageTraversal||!keys.has(candidate.regionKey)&&keys.size>=500)return false;
        if(selectedKeys.has(candidate.regionKey))return false;
        keys.add(candidate.regionKey);selectedKeys.add(candidate.regionKey);candidate.controlIds.forEach(id=>used.add(id));traversal ||= candidate.pageTraversal;return true;
      });
      if(reuse.length){await c.programApply({type:'reuseRegionReviews',review:{observationId:o.id,baseReviewId:region.review.id,source:'explorer-program',businessScope,
        evidence:[`observation:${o.id}`,'SDK verified explicitly reusable region boundaries'],regions:reuse.map(({reviewId,regionKey,conditionKey})=>({reviewId,regionKey,conditionKey}))}},'region_reused',
        {sourceReviews:reuse.map(({reviewId,regionKey})=>({reviewId,regionKey})),currentExecution:false,executionAuthorized:false,coverageGranted:false});return true;}
    }
    const key=digest({type:'regions',instance:o.instanceScope,candidates:region.candidates,unassigned:region.unassignedControlIds,review:region.review&&{id:region.review.id,regions:region.review.regions.map(r=>r.status)},...(focused?{priorityControlIds:[...priorityControls].sort()}:{})});
    if(!done(key)) {
      const boundaryInstance=o.regions.find(r=>r.key===boundary?.key)?.instanceId;
      const candidates=region.candidates.filter(r=>r.controlIds.some(id=>relevantIds.has(id)&&region.unassignedControlIds.includes(id)));
      const strength={heading:3,semantic:2,layout:1,document:0};
      candidates.sort((a,b)=>Number(b.id===boundaryInstance)-Number(a.id===boundaryInstance)
        ||(boundaryIds?a.controlIds.filter(id=>!boundaryIds.has(id)).length-b.controlIds.filter(id=>!boundaryIds.has(id)).length:0)
        ||strength[b.basis]-strength[a.basis]||b.controlIds.length-a.controlIds.length);
      const batch:{candidate:RegionCandidate;controlIds:string[];decision?:Decision}[]=[],reserved=new Set<string>(),overCapacity=new Set<string>();
      const bindingCounts=new Map<string,number>();
      if(!observedUI&&reusableScene)for(const candidate of region.candidates)if(candidate.reuseBinding){const binding=digest(candidate.reuseBinding);bindingCounts.set(binding,(bindingCounts.get(binding)||0)+1);}
      // One current observation supplies every deterministic grouping. The SDK
      // validates the whole command and recaptures once; five-item batches only
      // repeated that capture without adding evidence. Its 500-region limit also
      // includes regions retained by an incremental update (even invalidated ones).
      const incremental=region.review&&region.delta?.canUpdate;
      const existing=region.review?.regions.filter(r=>r.status==='active').map(r=>({key:r.key,label:r.label,candidateIds:r.anchors.map(a=>a.id),controlIds:r.controlIds,pageTraversal:r.pageTraversal})) || [];
      const partitionKeys=new Set((incremental?region.review!.regions:existing).map(r=>r.key));
      const flush=async()=>{
        mark(key);
        // Keep unrelated current regions through the public incremental contract.
        const command={type:'reviewRegions',review:{observationId:o.id,source:observedUI?'explorer-program':source,evidence:observedUI?[`observation:${o.id}`]:batch.flatMap(entry=>entry.decision?evidence(entry.decision):[]),...(incremental?{update:{baseReviewId:region.review!.id}}:{}),regions:[...(incremental?[]:existing),...batch.map(({candidate,controlIds,decision},index)=>({key:`explorer:${candidate.id}`,label:candidate.label,candidateIds:[candidate.id],controlIds,pageTraversal:!focused&&index===0&&!boundary&&region.unassignedPageTraversal,
          ...(decision&&reusableScene&&candidate.reuseBinding&&bindingCounts.get(digest(candidate.reuseBinding))===1?{reuse:{binding:'same-url-context' as const,businessScope}}:{})}))],rejectedCandidateIds:region.review?.rejectedCandidateIds||[]}};
        if(observedUI)await c.programApply!(command,'observed_region_partition');
        else await c.apply(batch.flatMap(entry=>entry.decision?[entry.decision]:[]),command);
        return true;
      };
      for(const candidate of candidates) {
        const controlIds=candidate.controlIds.filter(id=>region.unassignedControlIds.includes(id)&&!reserved.has(id));
        if(!controlIds.some(id=>relevantIds.has(id)))continue;
        const regionKey=`explorer:${candidate.id}`;
        if(!partitionKeys.has(regionKey)&&partitionKeys.size>=500){
            // A capacity limit is unresolved coverage, never permission to drop
            // existing decisions, sample members, or silently widen a region.
            for(const id of controlIds)if(relevantIds.has(id))overCapacity.add(id);
          continue;
        }
        partitionKeys.add(regionKey);
        if(observedUI){batch.push({candidate,controlIds});controlIds.forEach(id=>reserved.add(id));continue;}
        const d=await c.choose('region-review','Should this observed region be an exploration scope for the task? This is grouping, not action permission. Exact structural bindings remain with the host for fresh validation.',{observationId:o.id,goal:task.goal||'Explore all discovered interactions within the current page boundary and preserve unresolved gaps',candidate:regionEvidence(candidate),controls:region.controls.filter(x=>controlIds.includes(x.localId)),assignedElsewhere:candidate.controlIds.length-controlIds.length},{include:'Recognized coherent exploration region',uncertain:'Cannot decide its role'});
        // A refresh invalidates all prepared region bindings. Submit clear entries
        // first, then ask about this uncertain candidate against the new capture.
        if(d.value==='uncertain'&&batch.length){c.defer(d.decision,'region_batch_recapture');return flush();}
        if(d.value==='uncertain'){
          if(await c.refresh(d.decision,`region:${o.instanceScope}:${candidate.id}`))return true;
          mark(key);c.gap('region_unresolved',{url:o.url,region:candidate.label});break;
        }
        batch.push({candidate,controlIds,decision:d.decision});controlIds.forEach(id=>reserved.add(id));
        if(batch.length>=5)return flush();
      }
      for(const control of o.controls)if(overCapacity.has(control.localId)&&!reserved.has(control.localId))c.gap('region_partition_capacity',scopeForControl(control,o));
      if(batch.length)return flush();
      if((observedUI||overCapacity.size)&&candidates.length)mark(key);
      if(!candidates.length){mark(key);c.gap('region_partition_unavailable',{url:o.url});}
    }
  }
  const material=readExploration(),scopes=focused?[]:pendingScopes(false);
  const retained=retainGroups(scopes);if(retained){await retained;return true;}
  if(observedUI){
    const hypothesis=host.list<IdentityHypothesis>(sid,'hypothesis').find(h=>h.status==='pending'&&!done(`identity:${h.id}`)&&o.controls.some(x=>x.hypothesisId===h.id&&relevantIds.has(x.localId)));
    if(hypothesis){mark(`identity:${hypothesis.id}`);await c.programApply!({type:'resolveIdentity',hypothesisId:hypothesis.id,identityId:hypothesis.provisionalIdentityId,source:'explorer-program',evidence:[`observation:${o.id}`,'Keep current occurrence independent'],guard:{observationId:o.id,revision:hypothesis.revisions.length}},'independent_current_occurrence');return true;}
    // Exhaust bounded observation supplied by the SDK before asking a model to
    // interpret a weak candidate. This never dispatches an interaction.
    if(!focused&&!boundary){
      const discovery=host.discoveryScanMaterial(sid).discovery;
      if(discovery&&(discovery.signal.omitted>0||discovery.structural.omittedLocations>0)){
        const target=discovery.targets.find(t=>!done(`scan-target:${discovery.topologyKey}:${t.id}`));
        if(target){mark(`scan-target:${discovery.topologyKey}:${target.id}`);mark(`scan:${discovery.topologyKey}:${discovery.supplement?.targetId||''}`);await c.programApply!({type:'supplementDiscovery',scan:{observationId:o.id,targetId:target.id,source:'explorer-program',evidence:[`observation:${o.id}`],budget:{elements:1000}}},'bounded_discovery_target');return true;}
      }
    }
  }
  const classifications=readClassification();
  if(c.programApply){
    const [reuse]=reusableClassifications(host,task,o,classifications.controls.filter(i=>i.needsClassification&&relevantIds.has(i.control.localId)).map(i=>i.control));
    if(reuse){await c.programApply({type:'classifyControls',classification:{observationId:o.id,source:'explorer-program',classifications:reuse.classifications}},'classification_reused',{proofs:reuse.proofs,sourceDecisionIds:reuse.sourceDecisionIds,currentExecution:false,executionAuthorized:false});return true;}
  }
  const classificationBatch:{key:string;localId:string;value:string;decision:Decision}[]=[];
  const flushClassifications=async()=>{
    for(const entry of classificationBatch)mark(entry.key);
    await c.apply(classificationBatch.map(entry=>entry.decision),{type:'classifyControls',classification:{observationId:o.id,source,classifications:classificationBatch.map(entry=>({localId:entry.localId,classification:entry.value,reason:`Selected ${entry.value}`,evidence:evidence(entry.decision)}))}});
    return true;
  };
  for(const item of classifications.controls.filter(i=>i.needsClassification&&relevantIds.has(i.control.localId))) {
    const key=digest({type:'classification',instance:o.instanceScope,control:item.control,reviews:item.classifications.map(r=>[r.id,r.status])});if(done(key))continue;
    const positiveBasis=item.control.editable||Object.entries(item.control.actionBasis||{}).some(([kind,basis])=>['click','fill','select','check','press','hover'].includes(kind)&&basis.status==='supported');
    const blockedOptions=positiveBasis||!item.control.classificationBinding||item.control.classificationBinding.truncated?['display','container']:[];
    let d=await c.choose('control-classification','Classify this observed element using its own action basis, interaction hints and bounded subtree. Interactive descendants do not make a dialog or section itself an interaction; focusability alone does not establish its own operation. Do not classify as display/container if the subtree is truncated or there is positive interaction evidence. Classification never grants operation permission.',{observationId:o.id,control:item.control,actions:item.actions},
      {interaction:'Evidence of an interactive control',display:'Read-only information with complete evidence and no interaction basis',container:'Structural grouping with complete evidence and no own interaction basis',probe_required:'A bounded hover/focus observation is needed',uncertain:'Insufficient evidence'},{blockedOptions});
    // A refresh would invalidate the prepared entries. Commit only their clear
    // classifications, then revisit this uncertain target with the new capture.
    if(d.value==='uncertain'&&classificationBatch.length){c.defer(d.decision,'classification_batch_recapture');return flushClassifications();}
    if(d.value==='uncertain'&&await c.refresh(d.decision,`classification:${o.instanceScope}:${item.control.instanceId}`))return true;
    if(d.value==='uncertain'&&item.control.classificationBinding&&!item.control.classificationBinding.truncated) {
      const options=Object.fromEntries(Object.entries({interaction:'Possible interaction; still requires operation review',display:'Read-only information',container:'Structural grouping',probe_required:'Needs bounded observation',uncertain:'Insufficient evidence'}).filter(([key])=>!blockedOptions.includes(key)));
      d=await c.clarify({key:`classification:${item.control.instanceId}`,purpose:'classification-clarification',parent:d.decision,instructions:'Resolve the remaining element classification ambiguity. Interactive descendants do not make their container actionable. No classification grants operation permission.',options,evidence:{current:item.control,actions:semanticActions(item.actions)},requiredEvidence:Object.fromEntries(Object.keys(options).filter(k=>k!=='uncertain').map(k=>[k,['current','actions']]))});
    }
    classificationBatch.push({key,localId:item.control.localId,value:d.value==='uncertain'?'unresolved':d.value,decision:d.decision});
    if(d.value==='uncertain'){await flushClassifications();c.gap('classification_unresolved',scopeForControl(item.control,o));return true;}
    if(classificationBatch.length>=5)return flushClassifications();
  }
  if(classificationBatch.length)return flushClassifications();
  for(const h of host.list<IdentityHypothesis>(sid,'hypothesis').filter(h=>h.status==='pending'&&o.controls.some(x=>x.hypothesisId===h.id&&relevantIds.has(x.localId)))) {
    const key=`identity:${h.id}`;if(done(key))continue;
    if(o.coveragePolicy==='finite-ui-v1'&&c.programApply){
      const targets=o.controls.filter(x=>x.hypothesisId===h.id);
      if(targets.length===1&&targets[0].instanceId&&o.controls.filter(x=>x.instanceId===targets[0].instanceId).length===1){
        await c.programApply({type:'resolveIdentity',hypothesisId:h.id,identityId:h.provisionalIdentityId,source:'finite-ui-current-instance',
          evidence:[`observation:${o.id}`,`instance:${targets[0].instanceId}`,'Keep current occurrence independent; no historical identity or coverage inherited'],guard:{observationId:o.id,revision:h.revisions.length}},'independent_current_target',{hypothesisId:h.id});return true;
      }
    }
    const identities=host.list<ControlIdentity>(sid,'identity');
    const candidates=h.candidateIds.map(id=>{const identity=identities.find(x=>x.id===id);const occurrence=identity?.occurrences.at(-1);let historical:unknown;try{if(occurrence)historical=host.observation(sid,occurrence.observationId).controls.find(x=>x.localId===occurrence.localId);}catch{}return {id,occurrence,historical};});
    const options:Record<string,unknown>={independent:'Keep this occurrence independent',uncertain:'Insufficient historical evidence'};
    for(const candidate of candidates)if(candidate.historical)options[candidate.id]={decision:'same identity',historical:candidate.historical};
    const current=o.controls.filter(x=>x.hypothesisId===h.id);
    const blockedOptions=candidates.filter(candidate=>{const historical=candidate.historical as Observation['controls'][number]|undefined;return !historical||current.length!==1||!current[0].stableKey||historical.tag!==current[0].tag||historical.role!==current[0].role||historical.stableKey!==current[0].stableKey;}).map(c=>c.id);
    let d=await c.choose('identity-review','Judge identity using historical occurrences and current evidence. Equal labels alone do not prove identity. Keep this occurrence independent unless both structural identity and semantic continuity are established.',{observationId:o.id,hypothesis:h,candidates,current},options,{blockedOptions});
    const compatible=candidates.filter(candidate=>!blockedOptions.includes(candidate.id));
    // An explicit independent result already permits fresh testing. Spend LLM only on an unresolved viable match.
    if(d.decision.resolution?.source==='program'&&d.decision.answer?.value!=='independent'&&compatible.length) {
      if(await c.refresh(d.decision,`identity:${o.instanceScope}:${h.id}`))return true;
      const allowed=Object.fromEntries(Object.entries(options).filter(([id])=>!blockedOptions.includes(id)));
      d=await c.clarify({key:`identity:${h.id}`,purpose:'identity-clarification',parent:d.decision,instructions:'Compare the current occurrence with compatible historical occurrences. Merge only with positive structural identity AND semantic continuity. Equal names or historical execution success do not prove identity or current coverage. Prefer independent if no match is established.',options:allowed,evidence:{current,...Object.fromEntries(compatible.map(candidate=>[`historical:${candidate.id}`,candidate]))},requiredEvidence:{independent:['current'],...Object.fromEntries(compatible.map(candidate=>[candidate.id,['current',`historical:${candidate.id}`]]))}});
      // An uncertain interpretation must not prevent testing an independently bound current occurrence.
      if(d.value==='uncertain'){for(const control of current)c.gap('identity_unresolved',scopeForControl(control,o));d={value:'independent',decision:d.decision};}
    }
    mark(key);
    if(d.value==='uncertain'){for(const control of current)c.gap('identity_unresolved',scopeForControl(control,o));continue;}
    await c.apply(d.decision,{type:'resolveIdentity',hypothesisId:h.id,identityId:d.value==='independent'?h.provisionalIdentityId:d.value,source,evidence:evidence(d.decision),guard:{observationId:o.id,revision:h.revisions.length}});return true;
  }
  // Missing input content is separate from operation permission. Native supported
  // fields can need samples even when no operation review is pending.
  const sampleCandidates=available.filter(a=>a.kind==='fill'&&a.localId&&relevantIds.has(a.localId)&&a.basis?.status==='supported'&&a.risk!=='submission');
  const readiness=sampleCandidates.length?host.actionAvailability?.(sid,o.id):undefined;
  for(const action of sampleCandidates){
    if(action.exclusionReason!=='input_sample_required'&&!readiness?.actions.find(a=>a.actionId===action.id)?.blockers.some(b=>b.code==='INPUT_REQUIRED'))continue;
    const target=o.controls.find(control=>control.localId===action.localId)!;
    const key=`input-samples:${digest({revision:task.revision,instance:o.instanceScope,target:target.instanceId,constraints:target.constraints,basis:target.actionBasis?.fill,context:o.context})}`;
    if(done(key))continue;
    const generated=await c.generate('input-samples','Supply a small bounded set of synthetic input strings matching the captured field constraints. This only supplies content for an already supported fill operation; it does not approve risk, authorize submission, predict behavior or claim execution. Do not supply credentials, personal data or payment information. Return an empty list if no appropriate sample can be supplied.',{observationId:o.id,goal:task.goal,control:target,kind:'fill',constraints:target.constraints,missing:'input_sample_required'},z.object({samples:z.array(z.string()).max(5)}).strict());
    mark(key);
    if(!generated.value.samples.length){c.gap('input_samples_unavailable',scopeForControl(target,o));continue;}
    await c.apply(generated.decision,{type:'reviewControls',review:{observationId:o.id,source:'explorer-input-samples',reviews:[{localId:target.localId,kind:'fill',risk:action.risk,replayable:false,samples:[...new Set(generated.value.samples)],reason:'Supply content for an already supported fill; retain its existing risk and validate constraints at dispatch',evidence:[`observation:${o.id}`,`action:${action.id}`,...evidence(generated.decision)]}]}});return true;
  }
  const control=readOperations();
  for(const item of control.controls.filter(i=>i.needsReview&&relevantIds.has(i.control.localId))) {
    if(observedUI){
      const key=`operation-description:${unresolvedPurposeKey(o,item,task.revision)}`;if(done(key))continue;
      // Only describe operations already suggested by captured own-node evidence.
      // Names or descendant controls cannot invent an operation type or target.
      const offered=Object.fromEntries(Object.entries(item.control.actionBasis||{}).filter(([kind,basis])=>
        ['click','fill','select','check','press','hover'].includes(kind)&&basis.status!=='supported'&&basis.evidence.length>0
        &&!basis.evidence.some(e=>e.facts.submitsForm===true)&&!item.actions.some(a=>a.kind===kind&&a.risk==='submission')));
      if(!Object.keys(offered).length){mark(key);c.gap('operation_basis_unconfirmed',scopeForControl(item.control,o));continue;}
      const surroundings=item.surroundings?.complete?item.surroundings:undefined;
      const options={...Object.fromEntries(Object.entries(offered).map(([kind,basis])=>[kind,{operation:kind,capturedBasis:basis}])),uncertain:'Current evidence does not identify an operation on this occurrence'};
      let selected=await c.choose('control-operation','Identify which offered operation applies to this current occurrence so exploration can continue. Use captured operation evidence, semantic role and local structure; handlers on containers may only delegate to children. Select only an offered kind on this target. Do not infer a new input capability, business permission or functional outcome from its name. This describes an operation, not whether its implementation is interface-only or behaves correctly. Use uncertain when the target or operation remains ambiguous.',{observationId:o.id,control:item.control,offeredOperations:offered,...(surroundings?{surroundings}:{})},options);
      if(selected.value==='uncertain'){
        const complete=surroundings||item.control.classificationBinding&&!item.control.classificationBinding.truncated;
        if(!complete&&await c.refresh(selected.decision,`operation:${o.instanceScope}:${item.control.instanceId}`))return true;
        if(complete)selected=await c.clarify({key:`operation-description:${item.control.instanceId}`,purpose:'operation-description',parent:selected.decision,operation:false,options,evidence:{current:item.control,offeredOperations:offered,...(surroundings?{surroundings}:{})},requiredEvidence:Object.fromEntries(Object.keys(offered).map(kind=>[kind,['current','offeredOperations',...(surroundings?['surroundings']:[])]])),instructions:'Resolve the remaining operation/target ambiguity using the captured own-node basis and complete structure. Select only an offered operation on the current target; do not promote a container because its descendants are interactive. This is a description for bounded exploration, not a pure-UI risk certificate or a prediction of correct behavior. Do not infer business authorization, invent input capabilities or claim execution occurred. Return uncertain if the evidence still does not distinguish the target operation.'});
      }
      if(!Object.hasOwn(offered,selected.value)){mark(key);c.gap('operation_basis_unconfirmed',scopeForControl(item.control,o));continue;}
      let samples:(string|boolean)[]|undefined;const decisions=[selected.decision];
      if(['fill','select','press','check'].includes(selected.value)){
        samples=[...new Set(item.actions.filter(a=>a.kind===selected.value&&a.risk!=='submission'&&typeof a.value===(selected.value==='check'?'boolean':'string')).map(a=>a.value as string|boolean))];
        if(!samples.length&&['fill','press'].includes(selected.value)){
          const generated=await c.generate('input-samples','Supply a small bounded set of input values compatible with the captured field constraints and exploration task. Do not supply credentials, personal data, authentication, payment or submission commands. Samples are proposed input content, not claims of expected functional outcomes.',{observationId:o.id,goal:task.goal,control:item.control,kind:selected.value},z.object({samples:z.array(z.string()).min(1).max(5)}).strict());samples=generated.value.samples;decisions.push(generated.decision);
        }
        if(!samples.length){mark(key);c.gap('input_samples_unavailable',scopeForControl(item.control,o));continue;}
      }
      mark(key);await c.apply(decisions,{type:'reviewControls',review:{observationId:o.id,source,reviews:[{localId:item.control.localId,kind:selected.value,risk:'unknown',replayable:false,...(samples?{samples}:{}),...(surroundings?{surroundingContextKey:surroundings.key}:{}),reason:'Describe a captured operation on the current instance; effects remain unassessed',evidence:decisions.flatMap(evidence)}]}});return true;
    }
    const unresolvedKey=unresolvedPurposeKey(o,item,task.revision),key=digest({type:'control',unresolvedKey,x:item.control.rect.x,y:item.control.rect.y});if(done(key))continue;
    const previous=round.unresolvedPurposeReviews?.[unresolvedKey];
    if(previous){mark(key);c.unchanged?.({sourceDecisionId:previous.decisionId,sourceObservationId:previous.observationId,scope:scopeForControl(item.control,o)});continue;}
    // Never turn an explicitly submitting action into an interface action.
    const supported=item.actions.filter(a=>a.risk!=='submission');
    const kinds=[...new Set([...supported.map(a=>a.kind),...Object.keys(item.control.actionBasis||{})])].filter(k=>['click','fill','select','check','press','hover'].includes(k)&&!item.actions.some(a=>a.kind===k&&a.risk==='submission')&&!item.reviews.some(r=>r.status==='active'&&r.kind===k));
    if(!kinds.length){mark(key);c.gap('operation_basis_unconfirmed',scopeForControl(item.control,o));continue;}
    const checks:NonNullable<ModelRequest['checks']>={};
    for(const kind of kinds){
      checks[`interface_${kind}`]={instructions:`Does the captured evidence in material.control, material.actions and material.surroundings positively establish that ${kind} changes only interface state (for example a local tab, expansion or input value)? A label or native element type alone is insufficient.`};
      checks[`external_${kind}`]={instructions:`Is there evidence that ${kind} submits business data, sends a message, purchases, deletes, authenticates, or performs another external/business write? Judge this effect independently of interface changes; an action can do both.`};
    }
    const surroundings=item.surroundings;
    // Incomplete neighbor facts cannot be bound at dispatch, so do not offer them
    // as evidence for a judgment. Preserve only why the material is unavailable.
    const contextMaterial=surroundings?.complete?surroundings:surroundings?{complete:false,truncated:surroundings.truncated,reasons:surroundings.reasons}:undefined;
    const judged=await c.assess('control-risk',{control:item.control,actions:item.actions,...(contextMaterial?{surroundings:contextMaterial}:{})},checks);
    let kind=kinds.find(k=>judged.values[`interface_${k}`]===true&&judged.values[`external_${k}`]===false);
    let decision=judged.decision;
    if(!kind){
      // A negative answer to 'is an interface effect established?' is not positive
      // evidence of an external write. Complete local relationships may still need
      // semantic interpretation; label-only negatives do not warrant another model.
      const uncertain=kinds.filter(k=>judged.values[`external_${k}`]!==true&&(judged.values[`interface_${k}`]!==false||surroundings?.complete));
      // Refresh missing evidence once, not a confident veto. Rejection retains the
      // coverage gap; repeating the same question cannot supply an operation grant.
      if(!surroundings?.complete&&uncertain.length&&await c.refresh(judged.decision,`risk:${o.instanceScope}:${item.control.instanceId}`))return true;
      // External-write evidence vetoes interpretation. Missing structural evidence cannot
      // be invented by another model, and an uncertain semantic answer stays unresolved.
      const observed=o.controls.find(control=>control.localId===item.control.localId);
      const controlledIds=(observed?.controls||'').split(/\s+/).filter(Boolean);
      const controlled=o.controls.filter(control=>controlledIds.includes(control.reviewAttributes?.id||''));
      const effects=Object.fromEntries(uncertain.flatMap(k=>{
        const structure=item.control.actionBasis?.[k]?.evidence.filter(e=>e.source==='dom-structure')||[];
        return structure.length||(k==='click'&&(controlled.length||surroundings?.complete))?[[k,{structure,controlled,...(surroundings?.complete?{surroundings}:{})}]]:[];
      }));
      if(Object.keys(effects).length) {
        const clarified=await c.clarify({key:`risk:${item.control.instanceId}`,purpose:'operation-clarification',parent:judged.decision,operation:true,instructions:'Resolve the remaining purpose ambiguity for one offered operation. Establish its interface effect from the captured relationship or controlled content, and separately rule out an external/business write. A popup or shared-container relationship is evidence to interpret, not automatic permission. Neighboring inputs do not imply a clear operation; establish the specific effect from all facts and do not infer safety from a label. Return uncertain if either effect remains unclear.',options:{...Object.fromEntries(Object.keys(effects).map(k=>[k,`Review ${k} as interface-only if evidenced`])),uncertain:'Cannot establish a safe interface-only purpose'},evidence:{current:item.control,actions:semanticActions(item.actions),...Object.fromEntries(Object.entries(effects).map(([k,v])=>[`effect:${k}`,v]))},requiredEvidence:Object.fromEntries(Object.keys(effects).map(k=>[k,['current','actions',`effect:${k}`]]))});
        if(clarified.value!=='uncertain'){kind=clarified.value;decision=clarified.decision;}
      }
      if(!kind){mark(key);(round.unresolvedPurposeReviews??={})[unresolvedKey]={decisionId:decision.id,observationId:o.id};c.gap('operation_risk_unresolved',scopeForControl(item.control,o));c.unresolvedReview?.({localId:item.control.localId,decisionId:decision.id,kind:'purpose'});continue;}
    }
    const d={value:kind,decision};mark(key);
    const contextBinding=surroundings?.complete?{surroundingContextKey:surroundings.key}:{};
    let samples:(string|boolean)[]|undefined;
    if(['fill','press'].includes(d.value)) {
      const generated=await c.generate('input-samples','Generate a small set of harmless representative input samples compatible with the observed constraints. Do not invent credentials, personal data or submission commands.',{observationId:o.id,goal:task.goal||'Explore all discovered interactions within the current page boundary and preserve unresolved gaps',control:item.control,kind:d.value},z.object({samples:z.array(z.string()).min(1).max(5)}).strict());
      samples=generated.value.samples;
      await c.apply(generated.decision,{type:'reviewControls',review:{observationId:o.id,source,reviews:[{localId:item.control.localId,...contextBinding,kind:d.value,risk:'interface',replayable:false,samples,reason:'Generated bounded input samples',evidence:[...evidence(d.decision),...evidence(generated.decision)]}]}});return true;
    }
    await c.apply(d.decision,{type:'reviewControls',review:{observationId:o.id,source,reviews:[{localId:item.control.localId,...contextBinding,kind:d.value,risk:'interface',replayable:false,reason:'Reviewed interface operation',evidence:evidence(d.decision)}]}});return true;
  }
  if(scopes.length)return reviewGroup(scopes[0]);
  // Purpose evidence is reviewed proactively, even if DFS would never pause here.
  for(const group of material.groups.filter(g=>!observedUI&&(!focused||g.members.some(m=>priorityIds.has(m.actionId)))&&g.kind==='similar-list'&&g.members.some(m=>available.some(a=>a.id===m.actionId&&inCurrentBoundary(a)&&includesScope(pendingPlan,a,o))))) {
    const p=host.purposeReviewMaterial(sid,group.id);
    const active=host.list<PurposeReview>(sid,'purpose-review').filter(r=>r.status==='active');
    for(const condition of p.conditions) {
      const key=`purpose:${condition.key}`;if(done(key)||active.some(r=>r.conditionKey===condition.key))continue;
      const d=await c.choose('list-purpose','Can one interface-only business purpose be established for these members? If not, keep per-control review.',{observationId:o.id,goal:task.goal||'Explore all discovered interactions within the current page boundary and preserve unresolved gaps',condition},{approve:'Shared interface-only purpose established',uncertain:'No shared purpose established'});mark(key);
      if(d.value==='approve') {
        const generated=await c.generate('purpose-description','Describe only the evidenced list purpose and business scope.',{observationId:o.id,condition},z.object({purpose:z.string().min(1),businessScope:z.string().min(1)}).strict());
        await c.apply(generated.decision,{type:'reviewListPurpose',review:{...generated.value,groupId:group.id,revision:group.revision,observationId:o.id,conditionKey:condition.key,source,evidence:[...evidence(d.decision),...evidence(generated.decision)],risk:'interface',reuse:'matching-list-members'}});return true;
      }
    }
  }
  // An interactive classification does not resolve purpose. A bounded probe has
  // its own evidence gate, independent of classification and click permission.
  const classified=readClassification();
  for(const item of readOperations().controls)if(item.needsReview||classified.controls.some(x=>x.control.localId===item.control.localId&&x.classifications.some(r=>r.status==='active'&&r.classification==='probe_required'))) {
    if(!relevantIds.has(item.control.localId))continue;
    if(observedUI){
      const key=`probe:${o.instanceScope}:${item.control.instanceId}`;if(done(key))continue;
      if(!host.probeAvailability||!c.programProbe){c.gap('missing_capability:bounded_observation',scopeForControl(item.control,o));continue;}
      const availability=(['hover','focus'] as const).map(kind=>host.probeAvailability!(sid,o.id,item.control.localId,kind));
      const ready=availability.find(a=>a.executable);
      if(!ready){for(const reason of new Set(availability.flatMap(a=>a.blockers.map(b=>b.reason))))c.gap(`probe_blocked:${reason}`,scopeForControl(item.control,o));continue;}
      mark(key);await c.programProbe(item.control.localId,ready.kind as 'hover'|'focus','sdk_bounded_observation');return true;
    }
    const key=`probe:${o.instanceScope}:${item.control.instanceId}`;if(done(key))continue;
    const checks:NonNullable<ModelRequest['checks']>={};
    for(const kind of ['hover','focus']) {
      checks[`interface_${kind}`]={instructions:`Does the captured evidence positively support one bounded ${kind} on this current element to reveal interface state useful for resolving its purpose? A classification, label, pointer cursor or native element type alone is insufficient. Do not infer the effects of clicking from a hover/focus result.`};
      checks[`external_${kind}`]={instructions:`Is there evidence that ${kind} itself submits business data, authenticates, sends a message, purchases, deletes or writes external/business state? Judge this separately from any interface change; absence of a warning is not proof of safety.`};
    }
    const d=await c.assess('probe-risk',{observationId:o.id,control:item.control,actions:semanticActions(item.actions),limit:'One explicit observation probe per current element in this document and round. No automatic replay or click authorization.'},checks);mark(key);
    const kind=(['hover','focus'] as const).find(k=>d.values[`interface_${k}`]===true&&d.values[`external_${k}`]===false);
    if(!kind){c.gap('probe_unresolved',scopeForControl(item.control,o));c.unresolvedReview?.({localId:item.control.localId,decisionId:d.decision.id,kind:'probe'});continue;}
    await c.probe(d.decision,item.control.localId,kind);return true;
  }
  if(focused)continue;
  // Page-wide discovery can wait; it must not starve an already observed modal's work/exit.
  if(boundary) {
    if(c.hasPendingAction())return false;
    // Ordinary supported exits are dispatched by the SDK candidate loop. An
    // outside point is not a supported operation that a model can manufacture.
    if(observedUI){c.gap('boundary_exit_unresolved',{url:o.url,region:boundary.name});return false;}
    if(!host.boundaryExitMaterial){c.gap('missing_capability:boundaryExitReview',{url:o.url});return false;}
    const exits=host.boundaryExitMaterial(sid);
    // Preserve parent inputs/selections. A geometric outside point is not itself
    // an approval, and a successful click is not a verified cancellation.
    // Every browser control has checked:null and selected:[] defaults. Their presence
    // does not make a link/button stateful; retain actual fields, including empty,
    // unchecked and read-only fields, as well as observed selections.
    const preserved=o.controls.filter(control=>control.visible&&!boundaryIds?.has(control.localId)&&(
      control.editable||['input','textarea','select'].includes(control.tag)||typeof control.checked==='boolean'||control.selected?.length>0||
      ['textbox','combobox','listbox','slider','spinbutton','checkbox','radio','switch'].includes(control.role)));
    if(preserved.length>100){c.gap('boundary_preservation_limit',{url:o.url});return false;}
    for(const candidate of exits.candidates.filter(x=>!x.attempted)) {
      const key=`boundary-exit:${exits.episodeId}:${digest(candidate)}`;if(done(key))continue;
      const judgment=await c.assess('boundary-exit-risk',{observationId:o.id,boundary:exits.boundary,candidate,preserved:preserved.map(control=>({localId:control.localId,name:control.name,value:control.value,checked:control.checked,selected:control.selected})),attempts:exits.attempts,limitation:exits.limitation},{
        interface_exit:{instructions:'Does the captured boundary and candidate evidence support a bounded attempt at interface-only cancellation by clicking this outside surface? Geometry alone does not establish the click effect; do not infer a successful closure or approve any business operation.'},
        external_exit:{instructions:'Is there evidence that this candidate click submits, purchases, deletes, authenticates, or otherwise writes external/business state? Judge independently of whether it might also close the popup.'},
      });
      if(judgment.values.interface_exit!==true||judgment.values.external_exit!==false){mark(key);continue;}
      mark(key);await c.apply(judgment.decision,{type:'reviewBoundaryExit',review:{observationId:o.id,boundaryKey:boundary.key,source,evidence:evidence(judgment.decision),decision:{mode:'attempt',candidateId:candidate.id,preserveControlIds:preserved.map(control=>control.localId)}}});return true;
    }
    c.gap('boundary_exit_unresolved',{url:o.url,region:exits.boundary?.name});return false;
  }
  const scan=host.discoveryScanMaterial(sid);
  if(scan.discovery && (scan.discovery.signal.omitted>0 || scan.discovery.structural.omittedLocations>0)) {
    const key=`scan:${scan.discovery.topologyKey}:${scan.discovery.supplement?.targetId||''}`;
    if(!done(key)) {
      const options:Record<string,unknown>={uncertain:'Cannot target the missing evidence'};
      for(const t of scan.discovery.targets)options[t.id]=t;
      if(Object.keys(options).length===1){mark(key);c.gap('discovery_incomplete',{url:o.url});return false;}
      if(observedUI){
        const target=scan.discovery.targets.find(t=>!done(`scan-target:${scan.discovery!.topologyKey}:${t.id}`));
        if(!target){mark(key);c.gap('discovery_incomplete',{url:o.url});return false;}
        mark(key);mark(`scan-target:${scan.discovery.topologyKey}:${target.id}`);
        await c.programApply!({type:'supplementDiscovery',scan:{observationId:o.id,targetId:target.id,source:'explorer-program',evidence:[`observation:${o.id}`],budget:{elements:1000}}},'bounded_discovery_target');return true;
      }
      const d=await c.choose('discovery-scan','Select an observed bounded target to investigate omitted discovery evidence. The full discovery material is evidence; choose only an option offered in this batch.',{observationId:o.id,discovery:scan.discovery},options);mark(key);
      if(d.value!=='uncertain'){await c.apply(d.decision,{type:'supplementDiscovery',scan:{observationId:o.id,targetId:d.value,source,evidence:evidence(d.decision),budget:{elements:1000}}});return true;}
      c.gap('discovery_incomplete',{url:o.url});
    }
  }
  }
  return false;
}
