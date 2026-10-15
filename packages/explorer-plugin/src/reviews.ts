import { z } from 'zod';
import type { ActionCandidate, IdentityHypothesis, ControlIdentity, Observation, ExplorationGroup, PurposeReview } from '@interaction/browser';
import type { ExplorerHost, Task, ModelRequest, Decision, Scope } from './types.js';
import { jsonSchema } from './schema.js';
import { digest, matches, includesScope, broadScope, controlInScope } from './policy.js';

export interface ReviewContext {
  host:ExplorerHost;task:Task;observation:Observation;
  choose(purpose:string,instructions:string,state:unknown,options:Record<string,unknown>,constraints?:ChoiceConstraints):Promise<{value:string;decision:Decision}>;
  assess(purpose:string,state:unknown,checks:NonNullable<ModelRequest['checks']>):Promise<{values:Record<string,boolean|null>;decision:Decision}>;
  refresh(decision:Decision,key:string):Promise<boolean>;
  generate<T>(purpose:string,instructions:string,state:unknown,schema:z.ZodType<T>):Promise<{value:T;decision:Decision}>;
  apply(decision:Decision,command:unknown):Promise<void>;
  gap(reason:string,scope:Scope,required?:boolean):void;
}
export type ChoiceConstraints=Pick<ModelRequest,'allowedReductions'|'blockedOptions'>;
const evidence=(d:Decision)=>[`explorer-decision:${d.id}`];
const source='explorer-plugin';
/** Drain one guarded review at a time; reviews may recapture and invalidate all other material. */
export async function reviewNext(c:ReviewContext):Promise<boolean> {
  const {host,task,observation:o}=c;const sid=o.sessionId;const round=task.rounds.at(-1)!;
  const done=(key:string)=>round.reviewed.includes(key);const mark=(key:string)=>round.reviewed.push(key);
  const available=host.actions(sid);
  const pendingPlan=task.plan.filter(i=>i.status!=='succeeded');
  const relevant=(control:Observation['controls'][number])=>{
    if(available.some(a=>a.localId===control.localId&&includesScope(pendingPlan,a,o)))return true;
    return pendingPlan.some(i=>i.required&&i.dispatchScope===true&&[i.scope,...i.prerequisites].some(scope=>controlInScope(scope,control,o,available)));
  };
  const relevantIds=new Set(o.controls.filter(relevant).map(c=>c.localId));
  const region=host.regionReviewMaterial(sid);
  const broad=pendingPlan.some(i=>i.required&&i.dispatchScope===true&&broadScope(i.scope)&&(!i.scope.url||i.scope.url===o.url));
  if(region.enabled&&(region.unassignedControlIds.some(id=>relevantIds.has(id))||(region.unassignedPageTraversal&&broad))) {
    const key=digest({type:'regions',instance:o.instanceScope,candidates:region.candidates,unassigned:region.unassignedControlIds,review:region.review&&{id:region.review.id,regions:region.review.regions.map(r=>r.status)}});
    if(!done(key)) {
      const candidate=region.candidates.find(r=>r.controlIds.some(id=>relevantIds.has(id)&&region.unassignedControlIds.includes(id)));
      if(candidate) {
        const d=await c.choose('region-review','Should this observed region be an exploration scope for the task? This is grouping, not action permission.',{observationId:o.id,goal:task.goal,candidate,controls:region.controls.filter(x=>candidate.controlIds.includes(x.localId))},{include:'Recognized coherent exploration region',uncertain:'Cannot decide its role'});
        if(d.value==='uncertain'&&await c.refresh(d.decision,`region:${o.instanceScope}:${candidate.id}`))return true;
        mark(key);
        if(d.value==='include') {
          // Preserve active reviewed regions; the existing contract replaces the partition.
          const existing=region.review?.regions.filter(r=>r.status==='active').map(r=>({key:r.key,label:r.label,candidateIds:r.anchors.map(a=>a.id),controlIds:r.controlIds,pageTraversal:r.pageTraversal})) || [];
          await c.apply(d.decision,{type:'reviewRegions',review:{observationId:o.id,source,evidence:evidence(d.decision),regions:[...existing,{key:`explorer:${candidate.id}`,label:candidate.label,candidateIds:[candidate.id],controlIds:candidate.controlIds.filter(id=>region.unassignedControlIds.includes(id)),pageTraversal:region.unassignedPageTraversal}],rejectedCandidateIds:region.review?.rejectedCandidateIds||[]}});return true;
        }
        c.gap('region_unresolved',{url:o.url,region:candidate.label});
      } else {mark(key);c.gap('region_partition_unavailable',{url:o.url});}
    }
  }
  const classifications=host.controlClassificationMaterial(sid);
  for(const item of classifications.controls.filter(i=>i.needsClassification&&relevantIds.has(i.control.localId))) {
    const key=digest({type:'classification',instance:o.instanceScope,control:item.control,reviews:item.classifications.map(r=>[r.id,r.status])});if(done(key))continue;
    const positiveBasis=item.control.editable||Object.entries(item.control.actionBasis||{}).some(([kind,basis])=>['click','fill','select','check','press','hover'].includes(kind)&&basis.status==='supported');
    const blockedOptions=positiveBasis||!item.control.classificationBinding||item.control.classificationBinding.truncated?['display','container']:[];
    const d=await c.choose('control-classification','Classify this observed element using its own action basis, interaction hints and bounded subtree. Do not classify as display/container if the subtree is truncated or there is positive interaction evidence. Classification never grants operation permission.',{observationId:o.id,control:item.control,actions:item.actions},
      {interaction:'Evidence of an interactive control',display:'Read-only information with complete evidence and no interaction basis',container:'Structural grouping with complete evidence and no own interaction basis',probe_required:'A bounded hover/focus observation is needed',uncertain:'Insufficient evidence'},{blockedOptions});
    if(d.value==='uncertain'&&await c.refresh(d.decision,`classification:${o.instanceScope}:${item.control.instanceId}`))return true;
    mark(key);
    await c.apply(d.decision,{type:'classifyControls',classification:{observationId:o.id,source,classifications:[{localId:item.control.localId,classification:d.value==='uncertain'?'unresolved':d.value,reason:`Selected ${d.value}`,evidence:evidence(d.decision)}]}});
    if(d.value==='uncertain')c.gap('classification_unresolved',{url:o.url,label:item.control.label,role:item.control.role});
    return true;
  }
  for(const h of host.list<IdentityHypothesis>(sid,'hypothesis').filter(h=>h.status==='pending'&&o.controls.some(x=>x.hypothesisId===h.id&&relevantIds.has(x.localId)))) {
    const key=`identity:${h.id}`;if(done(key))continue;
    const identities=host.list<ControlIdentity>(sid,'identity');
    const candidates=h.candidateIds.map(id=>{const identity=identities.find(x=>x.id===id);const occurrence=identity?.occurrences.at(-1);let historical:unknown;try{if(occurrence)historical=host.observation(sid,occurrence.observationId).controls.find(x=>x.localId===occurrence.localId);}catch{}return {id,occurrence,historical};});
    const options:Record<string,unknown>={independent:'Keep this occurrence independent',uncertain:'Insufficient historical evidence'};
    for(const candidate of candidates)if(candidate.historical)options[candidate.id]={decision:'same identity',historical:candidate.historical};
    const current=o.controls.filter(x=>x.hypothesisId===h.id);
    const blockedOptions=candidates.filter(candidate=>{const historical=candidate.historical as Observation['controls'][number]|undefined;return !historical||current.length!==1||historical.tag!==current[0].tag||historical.role!==current[0].role||historical.stableKey!==current[0].stableKey;}).map(c=>c.id);
    const d=await c.choose('identity-review','Judge identity using historical occurrences and current evidence. Equal labels alone do not prove identity. Keep this occurrence independent unless both structural identity and semantic continuity are established.',{observationId:o.id,hypothesis:h,candidates,current},options,{blockedOptions});mark(key);
    if(d.value==='uncertain'){c.gap('identity_unresolved',{url:o.url,label:o.controls.find(x=>x.hypothesisId===h.id)?.label});continue;}
    await c.apply(d.decision,{type:'resolveIdentity',hypothesisId:h.id,identityId:d.value==='independent'?h.provisionalIdentityId:d.value,source,evidence:evidence(d.decision),guard:{observationId:o.id,revision:h.revisions.length}});return true;
  }
  const control=host.controlReviewMaterial(sid);
  for(const item of control.controls.filter(i=>i.needsReview&&relevantIds.has(i.control.localId))) {
    const key=digest({type:'control',instance:o.instanceScope,control:item.control,reviews:item.reviews.map(r=>[r.id,r.status]),actions:item.actions.map(a=>({kind:a.kind,risk:a.risk,value:a.value,basis:a.basis}))});if(done(key))continue;
    // Never turn an explicitly submitting action into an interface action.
    const supported=item.actions.filter(a=>a.risk!=='submission');
    const kinds=[...new Set([...supported.map(a=>a.kind),...Object.keys(item.control.actionBasis||{})])].filter(k=>['click','fill','select','check','press','hover'].includes(k)&&!item.actions.some(a=>a.kind===k&&a.risk==='submission')&&!item.reviews.some(r=>r.status==='active'&&r.kind===k));
    if(!kinds.length){mark(key);c.gap('operation_basis_unconfirmed',{url:o.url,label:item.control.label,role:item.control.role});continue;}
    const checks:NonNullable<ModelRequest['checks']>={};
    for(const kind of kinds){
      checks[`interface_${kind}`]={instructions:`Does the captured evidence in material.control and material.actions positively establish that ${kind} changes only interface state (for example a local tab, expansion or input value)? A label or native element type alone is insufficient.`};
      checks[`external_${kind}`]={instructions:`Is there evidence that ${kind} submits business data, sends a message, purchases, deletes, authenticates, or performs another external/business write? Judge this effect independently of interface changes; an action can do both.`};
    }
    const judged=await c.assess('control-risk',{control:item.control,actions:item.actions},checks);
    const kind=kinds.find(k=>judged.values[`interface_${k}`]===true&&judged.values[`external_${k}`]===false);
    if(!kind){
      if(await c.refresh(judged.decision,`risk:${o.instanceScope}:${item.control.instanceId}`))return true;
      mark(key);c.gap('operation_risk_unresolved',{url:o.url,label:item.control.label});continue;
    }
    const d={value:kind,decision:judged.decision};mark(key);
    let samples:(string|boolean)[]|undefined;
    if(['fill','press'].includes(d.value)) {
      const generated=await c.generate('input-samples','Generate a small set of harmless representative input samples compatible with the observed constraints. Do not invent credentials, personal data or submission commands.',{observationId:o.id,goal:task.goal,control:item.control,kind:d.value},z.object({samples:z.array(z.string()).min(1).max(5)}).strict());
      samples=generated.value.samples;
      await c.apply(generated.decision,{type:'reviewControls',review:{observationId:o.id,source,reviews:[{localId:item.control.localId,kind:d.value,risk:'interface',replayable:false,samples,reason:'Generated bounded input samples',evidence:[...evidence(d.decision),...evidence(generated.decision)]}]}});return true;
    }
    await c.apply(d.decision,{type:'reviewControls',review:{observationId:o.id,source,reviews:[{localId:item.control.localId,kind:d.value,risk:'interface',replayable:false,reason:'Reviewed interface operation',evidence:evidence(d.decision)}]}});return true;
  }
  const material=host.explorationReviewMaterial(sid);
  for(const group of material.groups.filter(g=>g.status==='pending' || !g.decisions.length)) {
    const key=`group:${group.id}:${group.revision}`;if(done(key))continue;
    // Groups retain prior observations and pre-review action cases. Only current candidates can be selected.
    const actions=host.actions(sid);const members=group.members.filter(m=>actions.some(a=>a.id===m.actionId));
    if(!members.length||!members.some(m=>includesScope(pendingPlan,actions.find(a=>a.id===m.actionId)!,o))){mark(key);continue;}
    const explicit=members.some(m=>{const action=actions.find(a=>a.id===m.actionId)!;return task.plan.some(i=>i.required&&i.scope.label&&i.scope.kind&&matches(i.scope,action,o));});
    const allowedReductions=task.coverageMode==='representative'&&!explicit?['sample']:[];
    const d=await c.choose('scope-review','Choose exhaustive traversal or representative sampling of current observed members. Sampling requires the supplied user permission; every omitted member remains untested. Never skip a group based only on confidence. Program scope matching still limits execution to the selected task.',{observationId:o.id,goal:task.goal,coverageMode:task.coverageMode||'all',allowedReductions,plan:task.plan,group:{...group,members,historicalMemberCount:group.members.length-members.length}},
      {all:'Keep all observed members available for in-scope traversal',sample:'User explicitly permits representative sampling',defer:'Cannot proceed yet',skip:'Outside the task',uncertain:'Unable to decide'},{allowedReductions});
    const mode=d.value==='uncertain'?'defer':d.value;let memberKeys:string[]=[];
    if(mode==='sample') {
      // Deterministic batching avoids silently discarding candidates above JEV's option limit.
      for(let offset=0;offset<members.length;offset+=200) {
        const options:Record<string,unknown>=Object.fromEntries(members.slice(offset,offset+200).map(m=>[m.key,{label:m.label,kind:m.kind,value:m.value,risk:m.risk}]));
        options.none='No representative needed from this batch';options.uncertain='Cannot choose';
        const sample=await c.choose('sample-selection','Select one representative from this batch, or none. Each batch is reviewed; no omitted member counts as covered.',{observationId:o.id,goal:task.goal,groupLabel:group.label,batch:offset/200},options);
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
  }
  // Purpose evidence is reviewed proactively, even if DFS would never pause here.
  for(const group of material.groups.filter(g=>g.kind==='similar-list'&&g.members.some(m=>available.some(a=>a.id===m.actionId&&includesScope(pendingPlan,a,o))))) {
    const p=host.purposeReviewMaterial(sid,group.id);
    const active=host.list<PurposeReview>(sid,'purpose-review').filter(r=>r.status==='active');
    for(const condition of p.conditions) {
      const key=`purpose:${condition.key}`;if(done(key)||active.some(r=>r.conditionKey===condition.key))continue;
      const d=await c.choose('list-purpose','Can one interface-only business purpose be established for these members? If not, keep per-control review.',{observationId:o.id,goal:task.goal,condition},{approve:'Shared interface-only purpose established',uncertain:'No shared purpose established'});mark(key);
      if(d.value==='approve') {
        const generated=await c.generate('purpose-description','Describe only the evidenced list purpose and business scope.',{observationId:o.id,condition},z.object({purpose:z.string().min(1),businessScope:z.string().min(1)}).strict());
        await c.apply(generated.decision,{type:'reviewListPurpose',review:{...generated.value,groupId:group.id,revision:group.revision,observationId:o.id,conditionKey:condition.key,source,evidence:[...evidence(d.decision),...evidence(generated.decision)],risk:'interface',reuse:'matching-list-members'}});return true;
      }
    }
  }
  // Probe only classified targets; each probe remains subject to host preflight.
  const classified=host.controlClassificationMaterial(sid);
  for(const item of classified.controls)if(item.classifications.some(r=>r.status==='active'&&r.classification==='probe_required')) {
    if(!relevant(item.control))continue;
    const key=`probe:${o.instanceScope}:${item.control.instanceId}`;if(done(key))continue;
    const d=await c.choose('probe-selection','Choose a bounded observation probe if it can reveal interaction evidence.',{observationId:o.id,control:item.control},{hover:'Observe hover effect',focus:'Observe focus effect',uncertain:'Cannot select a useful probe'});mark(key);
    if(d.value==='uncertain'){c.gap('probe_unresolved',{url:o.url,label:item.control.label});continue;}
    await c.apply(d.decision,{type:'probe',observationId:o.id,localId:item.control.localId,kind:d.value,requestId:crypto.randomUUID()});return true;
  }
  const scan=host.discoveryScanMaterial(sid);
  if(scan.discovery && (scan.discovery.signal.omitted>0 || scan.discovery.structural.omittedLocations>0)) {
    const key=`scan:${scan.discovery.topologyKey}:${scan.discovery.supplement?.targetId||''}`;
    if(!done(key)) {
      const options:Record<string,unknown>={uncertain:'Cannot target the missing evidence'};
      for(const t of scan.discovery.targets)options[t.id]=t;
      if(Object.keys(options).length===1){mark(key);c.gap('discovery_incomplete',{url:o.url});return false;}
      const d=await c.choose('discovery-scan','Select an observed bounded target to investigate omitted discovery evidence. The full discovery material is evidence; choose only an option offered in this batch.',{observationId:o.id,discovery:scan.discovery},options);mark(key);
      if(d.value!=='uncertain'){await c.apply(d.decision,{type:'supplementDiscovery',scan:{observationId:o.id,targetId:d.value,source,evidence:evidence(d.decision),budget:{elements:1000}}});return true;}
      c.gap('discovery_incomplete',{url:o.url});
    }
  }
  return false;
}
