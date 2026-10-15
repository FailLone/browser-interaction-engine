import { z } from 'zod';
import type { ActionCandidate, IdentityHypothesis, ControlIdentity, Observation, ExplorationGroup, PurposeReview, RegionCandidate } from '@interaction/browser';
import type { ExplorerHost, Task, ModelRequest, Decision, Scope } from './types.js';
import { jsonSchema } from './schema.js';
import { digest, matches, includesScope, broadScope, controlInScope, decisionPlan } from './policy.js';
import type { SemanticReview } from './semantic-review.js';

export interface ReviewContext {
  host:ExplorerHost;task:Task;observation:Observation;
  choose(purpose:string,instructions:string,state:unknown,options:Record<string,unknown>,constraints?:ChoiceConstraints):Promise<{value:string;decision:Decision}>;
  assess(purpose:string,state:unknown,checks:NonNullable<ModelRequest['checks']>):Promise<{values:Record<string,boolean|null>;decision:Decision}>;
  refresh(decision:Decision,key:string):Promise<boolean>;
  clarify(request:SemanticReview):Promise<{value:string;decision:Decision}>;
  generate<T>(purpose:string,instructions:string,state:unknown,schema:z.ZodType<T>):Promise<{value:T;decision:Decision}>;
  apply(decision:Decision,command:unknown):Promise<void>;
  retain(groups:RetainedScope[]):Promise<void>;
  gap(reason:string,scope:Scope,required?:boolean):void;
  hasPendingAction():boolean;
}
export type ChoiceConstraints=Pick<ModelRequest,'allowedReductions'|'blockedOptions'>;
export interface RetainedScope {id:string;revision:number;label:string;memberKeys:string[];actionIds:string[];historicalMemberCount:number}
const evidence=(d:Decision)=>[`explorer-decision:${d.id}`];
const source='explorer-plugin';
// Execution IDs change on recapture; model evidence describes the operation, not a dispatch grant.
const semanticActions=(actions:ActionCandidate[])=>actions.map(({kind,label,value,basis,risk})=>({kind,label,value,basis,risk}));
/** The host retains exact bindings for validation; grouping needs semantic evidence, not repeated dispatch fingerprints. */
function regionEvidence(candidate:RegionCandidate) {
  const {binding,reuseBinding,controlIds,...description}=candidate;
  const facts=binding as Record<string,unknown>;
  return {...description,memberCount:controlIds.length,structure:Object.fromEntries(['tag','role','heading','label','layout','border','semantic','root'].filter(k=>facts[k]!==undefined).map(k=>[k,facts[k]]))};
}
/** Drain one guarded review at a time; reviews may recapture and invalidate all other material. */
export async function reviewNext(c:ReviewContext):Promise<boolean> {
  const {host,task,observation:o}=c;const sid=o.sessionId;const round=task.rounds.at(-1)!;
  const done=(key:string)=>round.reviewed.includes(key);const mark=(key:string)=>round.reviewed.push(key);
  const available=host.actions(sid);
  const boundary=o.boundaries?.at(-1),overlay=o.overlays?.find(b=>b.key===boundary?.key);
  const boundaryIds=overlay?new Set(overlay.controlIds):undefined;
  const inCurrentBoundary=(action:ActionCandidate)=>!boundary||action.boundary?.key===boundary.key;
  const pendingPlan=task.plan.filter(i=>i.status!=='succeeded');
  const relevant=(control:Observation['controls'][number])=>{
    // Background obligations remain in the plan. Review them after the active boundary exits.
    if(boundaryIds&&!boundaryIds.has(control.localId))return false;
    if(available.some(a=>a.localId===control.localId&&includesScope(pendingPlan,a,o)))return true;
    if(task.plan.some(i=>!i.required&&i.reason==='user_excluded'&&controlInScope(i.scope,control,o,available)))return false;
    return pendingPlan.some(i=>i.required&&i.dispatchScope===true&&[i.scope,...i.prerequisites].some(scope=>controlInScope(scope,control,o,available)));
  };
  const relevantIds=new Set(o.controls.filter(relevant).map(c=>c.localId));
  const region=host.regionReviewMaterial(sid);
  const broad=pendingPlan.some(i=>i.required&&i.dispatchScope===true&&broadScope(i.scope)&&(!i.scope.url||i.scope.url===o.url));
  if(region.enabled&&(region.unassignedControlIds.some(id=>relevantIds.has(id))||(!boundary&&region.unassignedPageTraversal&&broad))) {
    const key=digest({type:'regions',instance:o.instanceScope,candidates:region.candidates,unassigned:region.unassignedControlIds,review:region.review&&{id:region.review.id,regions:region.review.regions.map(r=>r.status)}});
    if(!done(key)) {
      const boundaryInstance=o.regions.find(r=>r.key===boundary?.key)?.instanceId;
      const candidates=region.candidates.filter(r=>r.controlIds.some(id=>relevantIds.has(id)&&region.unassignedControlIds.includes(id)));
      const strength={heading:3,semantic:2,layout:1,document:0};
      const candidate=candidates.sort((a,b)=>Number(b.id===boundaryInstance)-Number(a.id===boundaryInstance)
        ||(boundaryIds?a.controlIds.filter(id=>!boundaryIds.has(id)).length-b.controlIds.filter(id=>!boundaryIds.has(id)).length:0)
        ||strength[b.basis]-strength[a.basis]||b.controlIds.length-a.controlIds.length)[0];
      if(candidate) {
        const d=await c.choose('region-review','Should this observed region be an exploration scope for the task? This is grouping, not action permission. Exact structural bindings remain with the host for fresh validation.',{observationId:o.id,goal:task.goal||'Explore all discovered interactions within the current page boundary and preserve unresolved gaps',candidate:regionEvidence(candidate),controls:region.controls.filter(x=>candidate.controlIds.includes(x.localId))},{include:'Recognized coherent exploration region',uncertain:'Cannot decide its role'});
        if(d.value==='uncertain'&&await c.refresh(d.decision,`region:${o.instanceScope}:${candidate.id}`))return true;
        mark(key);
        if(d.value==='include') {
          // Prefer the public incremental contract so unrelated region decisions remain valid.
          const incremental=region.review&&region.delta?.canUpdate;
          const existing=region.review?.regions.filter(r=>r.status==='active').map(r=>({key:r.key,label:r.label,candidateIds:r.anchors.map(a=>a.id),controlIds:r.controlIds,pageTraversal:r.pageTraversal})) || [];
          await c.apply(d.decision,{type:'reviewRegions',review:{observationId:o.id,source,evidence:evidence(d.decision),...(incremental?{update:{baseReviewId:region.review!.id}}:{}),regions:[...(incremental?[]:existing),{key:`explorer:${candidate.id}`,label:candidate.label,candidateIds:[candidate.id],controlIds:candidate.controlIds.filter(id=>region.unassignedControlIds.includes(id)),pageTraversal:!boundary&&region.unassignedPageTraversal}],rejectedCandidateIds:region.review?.rejectedCandidateIds||[]}});return true;
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
    let d=await c.choose('control-classification','Classify this observed element using its own action basis, interaction hints and bounded subtree. Interactive descendants do not make a dialog or section itself an interaction; focusability alone does not establish its own operation. Do not classify as display/container if the subtree is truncated or there is positive interaction evidence. Classification never grants operation permission.',{observationId:o.id,control:item.control,actions:item.actions},
      {interaction:'Evidence of an interactive control',display:'Read-only information with complete evidence and no interaction basis',container:'Structural grouping with complete evidence and no own interaction basis',probe_required:'A bounded hover/focus observation is needed',uncertain:'Insufficient evidence'},{blockedOptions});
    if(d.value==='uncertain'&&await c.refresh(d.decision,`classification:${o.instanceScope}:${item.control.instanceId}`))return true;
    if(d.value==='uncertain'&&item.control.classificationBinding&&!item.control.classificationBinding.truncated) {
      const options=Object.fromEntries(Object.entries({interaction:'Possible interaction; still requires operation review',display:'Read-only information',container:'Structural grouping',probe_required:'Needs bounded observation',uncertain:'Insufficient evidence'}).filter(([key])=>!blockedOptions.includes(key)));
      d=await c.clarify({key:`classification:${item.control.instanceId}`,purpose:'classification-clarification',parent:d.decision,instructions:'Resolve the remaining element classification ambiguity. Interactive descendants do not make their container actionable. No classification grants operation permission.',options,evidence:{current:item.control,actions:semanticActions(item.actions)},requiredEvidence:Object.fromEntries(Object.keys(options).filter(k=>k!=='uncertain').map(k=>[k,['current','actions']]))});
    }
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
    const blockedOptions=candidates.filter(candidate=>{const historical=candidate.historical as Observation['controls'][number]|undefined;return !historical||current.length!==1||!current[0].stableKey||historical.tag!==current[0].tag||historical.role!==current[0].role||historical.stableKey!==current[0].stableKey;}).map(c=>c.id);
    let d=await c.choose('identity-review','Judge identity using historical occurrences and current evidence. Equal labels alone do not prove identity. Keep this occurrence independent unless both structural identity and semantic continuity are established.',{observationId:o.id,hypothesis:h,candidates,current},options,{blockedOptions});
    const compatible=candidates.filter(candidate=>!blockedOptions.includes(candidate.id));
    // An explicit independent result already permits fresh testing. Spend LLM only on an unresolved viable match.
    if(d.decision.resolution?.source==='program'&&d.decision.answer?.value!=='independent'&&compatible.length) {
      if(await c.refresh(d.decision,`identity:${o.instanceScope}:${h.id}`))return true;
      const allowed=Object.fromEntries(Object.entries(options).filter(([id])=>!blockedOptions.includes(id)));
      d=await c.clarify({key:`identity:${h.id}`,purpose:'identity-clarification',parent:d.decision,instructions:'Compare the current occurrence with compatible historical occurrences. Merge only with positive structural identity AND semantic continuity. Equal names or historical execution success do not prove identity or current coverage. Prefer independent if no match is established.',options:allowed,evidence:{current,...Object.fromEntries(compatible.map(candidate=>[`historical:${candidate.id}`,candidate]))},requiredEvidence:{independent:['current'],...Object.fromEntries(compatible.map(candidate=>[candidate.id,['current',`historical:${candidate.id}`]]))}});
      // An uncertain interpretation must not prevent testing an independently bound current occurrence.
      if(d.value==='uncertain'){c.gap('identity_unresolved',{url:o.url,label:current[0]?.label});d={value:'independent',decision:d.decision};}
    }
    mark(key);
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
    let kind=kinds.find(k=>judged.values[`interface_${k}`]===true&&judged.values[`external_${k}`]===false);
    let decision=judged.decision;
    if(!kind){
      const uncertain=kinds.filter(k=>judged.values[`interface_${k}`]!==false&&judged.values[`external_${k}`]!==true);
      // Refresh missing evidence once, not a confident veto. Rejection retains the
      // coverage gap; repeating the same question cannot supply an operation grant.
      if(uncertain.length&&await c.refresh(judged.decision,`risk:${o.instanceScope}:${item.control.instanceId}`))return true;
      // Missing semantics can be interpreted; a confident veto or missing structural evidence cannot.
      const observed=o.controls.find(control=>control.localId===item.control.localId);
      const controlledIds=(observed?.controls||'').split(/\s+/).filter(Boolean);
      const controlled=o.controls.filter(control=>controlledIds.includes(control.reviewAttributes?.id||''));
      const effects=Object.fromEntries(uncertain.flatMap(k=>{
        const structure=item.control.actionBasis?.[k]?.evidence.filter(e=>e.source==='dom-structure')||[];
        return structure.length||(k==='click'&&controlled.length)?[[k,{structure,controlled}]]:[];
      }));
      if(Object.keys(effects).length) {
        const clarified=await c.clarify({key:`risk:${item.control.instanceId}`,purpose:'operation-clarification',parent:judged.decision,operation:true,instructions:'Resolve the remaining purpose ambiguity for one offered operation. Establish its interface effect from the captured relationship or controlled content, and separately rule out an external/business write. A popup relationship is evidence to interpret, not automatic permission. Return uncertain if either effect remains unclear.',options:{...Object.fromEntries(Object.keys(effects).map(k=>[k,`Review ${k} as interface-only if evidenced`])),uncertain:'Cannot establish a safe interface-only purpose'},evidence:{current:item.control,actions:semanticActions(item.actions),...Object.fromEntries(Object.entries(effects).map(([k,v])=>[`effect:${k}`,v]))},requiredEvidence:Object.fromEntries(Object.keys(effects).map(k=>[k,['current','actions',`effect:${k}`]]))});
        if(clarified.value!=='uncertain'){kind=clarified.value;decision=clarified.decision;}
      }
      if(!kind){mark(key);c.gap('operation_risk_unresolved',{url:o.url,label:item.control.label});continue;}
    }
    const d={value:kind,decision};mark(key);
    let samples:(string|boolean)[]|undefined;
    if(['fill','press'].includes(d.value)) {
      const generated=await c.generate('input-samples','Generate a small set of harmless representative input samples compatible with the observed constraints. Do not invent credentials, personal data or submission commands.',{observationId:o.id,goal:task.goal||'Explore all discovered interactions within the current page boundary and preserve unresolved gaps',control:item.control,kind:d.value},z.object({samples:z.array(z.string()).min(1).max(5)}).strict());
      samples=generated.value.samples;
      await c.apply(generated.decision,{type:'reviewControls',review:{observationId:o.id,source,reviews:[{localId:item.control.localId,kind:d.value,risk:'interface',replayable:false,samples,reason:'Generated bounded input samples',evidence:[...evidence(d.decision),...evidence(generated.decision)]}]}});return true;
    }
    await c.apply(d.decision,{type:'reviewControls',review:{observationId:o.id,source,reviews:[{localId:item.control.localId,kind:d.value,risk:'interface',replayable:false,reason:'Reviewed interface operation',evidence:evidence(d.decision)}]}});return true;
  }
  const material=host.explorationReviewMaterial(sid);
  // Keeping every observed member is a fixed program rule unless the user
  // permits sampling. It needs neither a model call nor the historical ledger.
  const scopes=material.groups.filter(g=>g.status==='pending'||!g.decisions.length).flatMap(group=>{
    const key=`group:${group.id}:${group.revision}`;if(done(key))return [];
    const members=group.members.filter(m=>available.some(a=>a.id===m.actionId));
    if(!members.some(m=>{const action=available.find(a=>a.id===m.actionId)!;return inCurrentBoundary(action)&&includesScope(pendingPlan,action,o);}))return [];
    const explicit=members.some(m=>{const action=available.find(a=>a.id===m.actionId)!;return task.plan.some(i=>i.required&&i.scope.label&&i.scope.kind&&matches(i.scope,action,o));});
    return [{group,key,members,allowedReductions:task.coverageMode==='representative'&&!explicit?['sample']:[]}];
  });
  const retained=scopes.filter(s=>!s.allowedReductions.length).slice(0,50);
  if(retained.length){
    for(const s of retained)mark(s.key);
    await c.retain(retained.map(({group,members})=>({id:group.id,revision:group.revision,label:group.label,memberKeys:members.map(m=>m.key),actionIds:members.map(m=>m.actionId),historicalMemberCount:group.members.length-members.length})));
    return true;
  }
  for(const {group,key,members,allowedReductions} of scopes) {
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
  }
  // Purpose evidence is reviewed proactively, even if DFS would never pause here.
  for(const group of material.groups.filter(g=>g.kind==='similar-list'&&g.members.some(m=>available.some(a=>a.id===m.actionId&&inCurrentBoundary(a)&&includesScope(pendingPlan,a,o))))) {
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
  // Probe only classified targets; each probe remains subject to host preflight.
  const classified=host.controlClassificationMaterial(sid);
  for(const item of classified.controls)if(item.classifications.some(r=>r.status==='active'&&r.classification==='probe_required')) {
    if(!relevant(item.control))continue;
    const key=`probe:${o.instanceScope}:${item.control.instanceId}`;if(done(key))continue;
    const d=await c.choose('probe-selection','Choose a bounded observation probe if it can reveal interaction evidence.',{observationId:o.id,control:item.control},{hover:'Observe hover effect',focus:'Observe focus effect',uncertain:'Cannot select a useful probe'});mark(key);
    if(d.value==='uncertain'){c.gap('probe_unresolved',{url:o.url,label:item.control.label});continue;}
    await c.apply(d.decision,{type:'probe',observationId:o.id,localId:item.control.localId,kind:d.value,requestId:crypto.randomUUID()});return true;
  }
  // Page-wide discovery can wait; it must not starve an already observed modal's work/exit.
  if(boundary) {
    if(c.hasPendingAction())return false;
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
      const d=await c.choose('discovery-scan','Select an observed bounded target to investigate omitted discovery evidence. The full discovery material is evidence; choose only an option offered in this batch.',{observationId:o.id,discovery:scan.discovery},options);mark(key);
      if(d.value!=='uncertain'){await c.apply(d.decision,{type:'supplementDiscovery',scan:{observationId:o.id,targetId:d.value,source,evidence:evidence(d.decision),budget:{elements:1000}}});return true;}
      c.gap('discovery_incomplete',{url:o.url});
    }
  }
  return false;
}
