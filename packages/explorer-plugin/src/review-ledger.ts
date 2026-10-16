import type { Observation } from '@interaction/browser';
import type { ExplorerHost, PlanItem, Task } from './types.js';
import { controlScopeMatcher } from './policy.js';

export const controlReviewGapReasons=new Set(['classification_unresolved','operation_basis_unconfirmed','operation_risk_unresolved','probe_unresolved','identity_unresolved']);
export type ReviewGapChange={itemId:string;proof?:NonNullable<PlanItem['reviewResolvedBy']>;reason?:string};

/** Read current public material. A model answer or a historical classification is not enough. */
export function reviewGapChanges(task:Task,o:Observation,host:ExplorerHost):ReviewGapChange[] {
  const items=task.plan.filter(i=>i.required&&i.status!=='excluded'&&controlReviewGapReasons.has(i.reason)&&!i.scope.kind&&i.scope.value===undefined);
  if(!items.length||o.gaps.some(g=>g.critical))return [];
  const snapshot=host.controlInterpretationSnapshot(o.sessionId,o.id,{retainedClassifications:items.flatMap(i=>i.reviewResolvedBy?[i.reviewResolvedBy]:[])}),actions=snapshot.actions;
  const inScope=controlScopeMatcher(o,actions);
  const changes:ReviewGapChange[]=[];
  for(const item of items) {
    const targets=o.controls.filter(c=>c.visible&&inScope(item.scope,c));
    // Hidden/absent targets retain their earlier evidence, not permission for a later occurrence.
    if(!targets.length){
      if(item.reviewResolvedBy){
        const ref=item.reviewResolvedBy,proof=snapshot.retainedClassifications.find(p=>p.source.classificationId===ref.classificationId&&p.source.sessionId===ref.sessionId&&p.source.observationId===ref.observationId&&p.source.classification===ref.classification);
        if(!proof?.retained)changes.push({itemId:item.id,reason:proof?.reason||'classification_evidence_unavailable'});
      }
      continue;
    }
    const target=targets.length===1?targets[0]:undefined;
    const negative=target&&snapshot.nonInteractive.find(c=>c.localId===target.localId);
    const valid=!!negative;
    if(!valid){if(item.reviewResolvedBy)changes.push({itemId:item.id});continue;}
    if(item.reviewResolvedBy?.classificationId===negative!.classificationId||item.status==='succeeded'&&!item.reviewResolvedBy)continue;
    changes.push({itemId:item.id,proof:{sessionId:o.sessionId,observationId:o.id,classificationId:negative!.classificationId,classification:negative!.classification as 'display'|'container'}});
  }
  return changes;
}
