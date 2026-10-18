import type {ActionAttempt,ActionCandidate,Observation} from '@interaction/browser';
import type {ExplorerHost,Task,Scope} from './types.js';
import {controlInScope,digest,scopeForControl} from './policy.js';

export interface ProgramModelGap {
  key:string;kind:'classification'|'operation'|'component-correspondence';question:string;scope:Scope;
  source:{sessionId:string;observationId:string;localId:string};
  checks:{capture:{observationId:string;stable:boolean;criticalGaps:string[]};
    attempts:{id:string;kind:string;status:string;beforeId:string;afterId?:string;reason?:string;
      transition?:{verified:boolean;navigated:boolean;revealed:number;entered:number;exited:number}}[];
    probeChecks:{kind:string;executable:boolean;blockers:unknown[]}[];
    actionBlockers:{kind:string;blockers:unknown[]}[];
    readyProgramActions:string[];verifiedReentries:string[];selectedRecovery?:string};
  status:'prepared'|'reviewed'|'unavailable'|'timed_out'|'rejected'|'no_call';
  calls:number;maxCalls:2;maxDurationMs:12000;decisionIds:string[];elapsedMs?:number;
  probeChecked?:boolean;probeAttemptId?:string;initialExecutable:string[];newlyExecutable:string[];
  validations:{accepted:boolean;command:string;beforeId:string;afterId?:string;reason?:string}[];
  gains:{attemptId:string;status:string;conditionVerified:boolean}[];
}
export const operationToken=(a:Pick<ActionCandidate,'kind'|'value'>)=>digest({kind:a.kind,value:a.value});

/** Negative question deduplication, never identity, permission or coverage.
 * Keep own captured semantics, relationships and business data. Exclude capture
 * IDs, position, review bookkeeping and presentation-only class/style changes. */
function materialKey(o:Observation,c:Observation['controls'][number],kind:ProgramModelGap['kind']) {
  const attrs=(a:Record<string,string>|undefined)=>Object.fromEntries(Object.entries(a||{}).filter(([k])=>k!=='class'&&k!=='style'));
  return digest({policy:'program-model-gap/v1',kind,url:o.url,context:o.context,
    boundaries:o.boundaries?.map(b=>({name:b.name,kind:o.overlays?.find(x=>x.key===b.key)?.kind})),
    target:{tag:c.tag,role:c.role,name:c.label||c.name,attributes:attrs(c.reviewBinding?.attributes),
      context:c.identityContext&&{scope:c.identityContext.scope,binding:c.identityContext.binding},constraints:c.constraints,
      basis:c.actionBasis,hints:c.interactionHints,options:c.options,checked:c.checked,pressed:c.pressed,expanded:c.expanded,
      structure:c.classificationBinding&&{truncated:c.classificationBinding.truncated,text:c.classificationBinding.text,
        nodes:c.classificationBinding.nodes.map(n=>({tag:n.tag,attributes:attrs(n.attributes)}))}},
    modes:o.controls.filter(x=>x.checked!=null||x.pressed!=null||x.expanded!=null||x.selected?.length).map(x=>({tag:x.tag,role:x.role,name:x.label||x.name,checked:x.checked,pressed:x.pressed,expanded:x.expanded,selected:x.selected}))});
}

export function programModelGapCandidates(host:ExplorerHost,task:Task,o:Observation) {
  if(!task.coverageContract?.programNavigation||!o.stable||o.gaps.some(g=>g.critical))return [];
  const snapshot=host.controlInterpretationSnapshot(o.sessionId,o.id),actions=host.actions(o.sessionId,o.id),availability=host.actionAvailability(o.sessionId,o.id);
  const boundary=o.boundaries?.at(-1),overlay=boundary&&o.overlays?.find(x=>x.key===boundary.key);
  const attempts=host.list<ActionAttempt>(o.sessionId,'attempt');
  return o.controls.flatMap(c=>{
    if(!c.visible||!c.enabled||c.readiness||c.hypothesisId||boundary&&(!overlay||!overlay.controlIds.includes(c.localId)))return [];
    if(!task.plan.some(i=>i.required&&i.dispatchScope===true&&i.status!=='excluded'&&controlInScope(i.scope,c,o,actions))
      ||task.coverageContract!.exclusions.some(e=>controlInScope(e.scope,c,o,actions)))return [];
    // Own operation evidence supplies a concrete interpretation gap. An unknown
    // ancestor, name or focusable container alone cannot trigger a model call.
    const own=Object.entries(c.actionBasis||{}).filter(([kind,basis])=>task.coverageContract!.allowedOperations.includes(kind)
      &&(!['hover','focus','press'].includes(kind)||c.interactionHints?.some(h=>h.source==='runtime-metadata'&&h.facts.binding==='own-data-property'))
      &&basis.evidence.length&&!basis.evidence.some(e=>e.facts.submitsForm===true)
      &&!actions.some(a=>a.localId===c.localId&&a.kind===kind&&a.risk==='submission'));
    if(!own.length)return [];
    const kind=snapshot.classifications.controls.some(x=>x.control.localId===c.localId&&x.needsClassification)?'classification'
      :snapshot.operations.controls.some(x=>x.control.localId===c.localId&&x.needsReview)?'operation':undefined;
    if(!kind)return [];
    const key=materialKey(o,c,kind),existing=task.programModelGaps?.[key];
    if(existing&&existing.status!=='prepared')return [];
    const selected=actions.filter(a=>a.localId===c.localId),facts=availability.actions.filter(x=>selected.some(a=>a.id===x.actionId));
    const related=attempts.filter(a=>a.action.localId===c.localId);
    const probes=(['hover','focus'] as const).filter(k=>task.coverageContract!.allowedOperations.includes(k)).map(kind=>{
      const p=host.probeAvailability?.(o.sessionId,o.id,c.localId,kind);
      return {kind,executable:p?.executable===true,blockers:p?.blockers||[{reason:'probe_availability_unavailable'}]};
    });
    const gap:ProgramModelGap=existing||{key,kind,question:kind==='classification'
      ?'Own captured interaction evidence remains ambiguous after program capture and bounded probe checks. Which offered classification is supported? Classification does not establish effects.'
      :'Captured operations remain unexecutable after program capture and bounded probe checks. Does the supplied local evidence establish an offered interface operation and rule out an external write?',
      scope:scopeForControl(c,o),source:{sessionId:o.sessionId,observationId:o.id,localId:c.localId},
      checks:{capture:{observationId:o.id,stable:o.stable,criticalGaps:o.gaps.filter(g=>g.critical).map(g=>g.code)},attempts:[],probeChecks:[],actionBlockers:[],readyProgramActions:[],verifiedReentries:[]},
      status:'prepared',calls:0,maxCalls:2,maxDurationMs:12000,decisionIds:[],initialExecutable:selected.filter(a=>facts.find(x=>x.actionId===a.id)?.executable).map(operationToken),newlyExecutable:[],validations:[],gains:[]};
    gap.checks.capture={observationId:o.id,stable:o.stable,criticalGaps:[]};
    gap.checks.attempts=related.map(a=>{
      let transition:ProgramModelGap['checks']['attempts'][number]['transition'];
      if(a.afterId)try{const t=host.interactionTransition(o.sessionId,a.beforeId,a.afterId);transition={verified:t.verified,navigated:t.navigated,revealed:t.revealedControlIds.length,entered:t.entered.length,exited:t.exited.length};}catch{/* Missing transition remains missing evidence. */}
      return {id:a.id,kind:a.action.kind,status:a.status,beforeId:a.beforeId,afterId:a.afterId,reason:a.reason,transition};
    });
    gap.checks.probeChecks=probes;
    gap.checks.actionBlockers=facts.map(x=>({kind:selected.find(a=>a.id===x.actionId)!.kind,blockers:x.blockers}));
    return [{gap,control:c,priorProbe:related.find(a=>['hover','focus'].includes(a.action.kind)),readyProbe:probes.find(p=>p.executable)}];
  });
}
