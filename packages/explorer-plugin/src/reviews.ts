import { z } from 'zod';
import type { ActionCandidate, IdentityHypothesis, ControlIdentity, Observation, ExplorationGroup, PurposeReview } from '@interaction/browser';
import type { ExplorerHost, Task, ModelRequest, Decision, Scope } from './types.js';
import { jsonSchema } from './schema.js';
import { digest, matches } from './policy.js';

export interface ReviewContext {
  host:ExplorerHost;task:Task;observation:Observation;
  choose(purpose:string,instructions:string,state:unknown,options:Record<string,unknown>):Promise<{value:string;decision:Decision}>;
  generate<T>(purpose:string,instructions:string,state:unknown,schema:z.ZodType<T>):Promise<{value:T;decision:Decision}>;
  apply(decision:Decision,command:unknown):Promise<void>;
  gap(reason:string,scope:Scope,required?:boolean):void;
}
const evidence=(d:Decision)=>[`explorer-decision:${d.id}`];
const source='explorer-plugin';
/** Drain one guarded review at a time; reviews may recapture and invalidate all other material. */
export async function reviewNext(c:ReviewContext):Promise<boolean> {
  const {host,task,observation:o}=c;const sid=o.sessionId;const round=task.rounds.at(-1)!;
  const done=(key:string)=>round.reviewed.includes(key);const mark=(key:string)=>round.reviewed.push(key);
  const region=host.regionReviewMaterial(sid);
  if(region.enabled&&(region.unassignedControlIds.length||region.unassignedPageTraversal)) {
    const key=digest({type:'regions',instance:o.instanceScope,candidates:region.candidates,unassigned:region.unassignedControlIds,review:region.review&&{id:region.review.id,regions:region.review.regions.map(r=>r.status)}});
    if(!done(key)) {
      const candidate=region.candidates.find(r=>r.controlIds.some(id=>region.unassignedControlIds.includes(id)));
      if(candidate) {
        const d=await c.choose('region-review','Should this observed region be an exploration scope for the task? This is grouping, not action permission.',{observationId:o.id,goal:task.goal,candidate,controls:region.controls.filter(x=>candidate.controlIds.includes(x.localId))},{include:'Recognized coherent exploration region',uncertain:'Cannot decide its role'});
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
  for(const item of classifications.controls.filter(i=>i.needsClassification)) {
    const key=digest({type:'classification',instance:o.instanceScope,control:item.control,reviews:item.classifications.map(r=>[r.id,r.status])});if(done(key))continue;
    const d=await c.choose('control-classification','Classify this observed element. Classification never grants operation permission.',{observationId:o.id,goal:task.goal,item},
      {interaction:'Evidence of an interactive control',display:'Read-only information',container:'Structural grouping',probe_required:'A bounded hover/focus observation is needed',uncertain:'Insufficient evidence'});
    mark(key);
    await c.apply(d.decision,{type:'classifyControls',classification:{observationId:o.id,source,classifications:[{localId:item.control.localId,classification:d.value==='uncertain'?'unresolved':d.value,reason:`Selected ${d.value}`,evidence:evidence(d.decision)}]}});
    if(d.value==='uncertain')c.gap('classification_unresolved',{url:o.url,label:item.control.label,role:item.control.role});
    return true;
  }
  for(const h of host.list<IdentityHypothesis>(sid,'hypothesis').filter(h=>h.status==='pending'&&o.controls.some(x=>x.hypothesisId===h.id))) {
    const key=`identity:${h.id}`;if(done(key))continue;
    const identities=host.list<ControlIdentity>(sid,'identity');
    const candidates=h.candidateIds.map(id=>{const identity=identities.find(x=>x.id===id);const occurrence=identity?.occurrences.at(-1);let historical:unknown;try{if(occurrence)historical=host.observation(sid,occurrence.observationId).controls.find(x=>x.localId===occurrence.localId);}catch{}return {id,occurrence,historical};});
    const options:Record<string,unknown>={independent:'Keep this occurrence independent',uncertain:'Insufficient historical evidence'};
    for(const candidate of candidates)if(candidate.historical)options[candidate.id]={decision:'same identity',historical:candidate.historical};
    const d=await c.choose('identity-review','Judge identity using historical occurrences and current evidence. Equal labels alone do not prove identity.',{observationId:o.id,hypothesis:h,candidates,current:o.controls.filter(x=>x.hypothesisId===h.id)},options);mark(key);
    if(d.value==='uncertain'){c.gap('identity_unresolved',{url:o.url,label:o.controls.find(x=>x.hypothesisId===h.id)?.label});continue;}
    await c.apply(d.decision,{type:'resolveIdentity',hypothesisId:h.id,identityId:d.value==='independent'?h.provisionalIdentityId:d.value,source,evidence:evidence(d.decision),guard:{observationId:o.id,revision:h.revisions.length}});return true;
  }
  const control=host.controlReviewMaterial(sid);
  for(const item of control.controls.filter(i=>i.needsReview)) {
    const key=digest({type:'control',instance:o.instanceScope,control:item.control,reviews:item.reviews.map(r=>[r.id,r.status]),actions:item.actions.map(a=>({kind:a.kind,risk:a.risk,value:a.value,basis:a.basis}))});if(done(key))continue;
    // Never turn an explicitly submitting action into an interface action.
    const supported=item.actions.filter(a=>a.risk!=='submission');
    const kinds=[...new Set([...supported.map(a=>a.kind),...Object.keys(item.control.actionBasis||{})])].filter(k=>['click','fill','select','check','press','hover'].includes(k));
    if(!kinds.length){mark(key);c.gap('operation_basis_unconfirmed',{url:o.url,label:item.control.label,role:item.control.role});continue;}
    const options:Record<string,unknown>={uncertain:'Risk/purpose cannot be established'};
    for(const kind of kinds)options[kind]=`Approve ${kind} only if evidence shows an interface-only operation; never submission or external effects`;
    const d=await c.choose('control-risk','Choose an evidenced interface-only operation, or uncertain. A native button alone does not prove business safety.',{observationId:o.id,goal:task.goal,item},options);mark(key);
    if(d.value==='uncertain'){c.gap('operation_risk_unresolved',{url:o.url,label:item.control.label});continue;}
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
    const d=await c.choose('scope-review','Choose exhaustive traversal of these observed members, representative sampling, defer, or exclude. Follow the task; sampled-out members stay untested.',{observationId:o.id,goal:task.goal,plan:task.plan,group},
      {all:'All observed members are required',sample:'Representative observed members suffice',defer:'Cannot proceed yet',skip:'Outside the task',uncertain:'Unable to decide'});
    const mode=d.value==='uncertain'?'defer':d.value;let memberKeys:string[]=[];
    if(mode==='sample') {
      // Deterministic batching avoids silently discarding candidates above JEV's option limit.
      for(let offset=0;offset<group.members.length;offset+=200) {
        const options:Record<string,unknown>=Object.fromEntries(group.members.slice(offset,offset+200).map(m=>[m.key,{label:m.label,kind:m.kind,value:m.value}]));
        options.none='No representative needed from this batch';options.uncertain='Cannot choose';
        const sample=await c.choose('sample-selection','Select one representative from this batch, or none. Each batch is reviewed; no omitted member counts as covered.',{observationId:o.id,goal:task.goal,groupLabel:group.label,batch:offset/200},options);
        if(!['none','uncertain'].includes(sample.value))memberKeys.push(sample.value);
      }
    }
    mark(key);
    const finalMode=mode==='sample'&&!memberKeys.length?'defer':mode;
    await c.apply(d.decision,{type:'decideExplorationGroup',groupId:group.id,revision:group.revision,decision:{mode:finalMode,...(finalMode==='sample'?{memberKeys}:{}),source,evidence:evidence(d.decision)}});
    for(const member of group.members)if(finalMode==='skip'||(finalMode==='sample'&&!memberKeys.includes(member.key))) {
      const action=host.actions(sid).find(a=>a.id===member.actionId);
      if(action){const s={url:o.url,label:action.label,kind:action.kind,...(action.value===undefined?{}:{value:action.value as string|boolean|number})};c.gap(finalMode==='skip'?'scope_excluded':'sample_unselected',s,false);}
    }
    if(finalMode==='defer')c.gap('scope_deferred',{url:o.url,region:group.label});
    return true;
  }
  // Purpose evidence is reviewed proactively, even if DFS would never pause here.
  for(const group of material.groups.filter(g=>g.kind==='similar-list')) {
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
    const region=o.regions.find(r=>r.key===item.control.region)?.label;
    const actual={url:o.url,label:item.control.label,role:item.control.role,stableKey:item.control.stableKey,region};
    if(!task.plan.some(p=>p.required&&[p.scope,...p.prerequisites].some(scope=>Object.entries(scope).filter(([key])=>!['kind','value'].includes(key)).every(([key,value])=>actual[key as keyof typeof actual]===value))))continue;
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
      const d=await c.choose('discovery-scan','Select an observed bounded target to investigate omitted discovery evidence. The full discovery material is evidence; choose only an option offered in this batch.',{observationId:o.id,discovery:scan.discovery},options);mark(key);
      if(d.value!=='uncertain'){await c.apply(d.decision,{type:'supplementDiscovery',scan:{observationId:o.id,targetId:d.value,source,evidence:evidence(d.decision),budget:{elements:1000}}});return true;}
      c.gap('discovery_incomplete',{url:o.url});
    }
  }
  return false;
}
