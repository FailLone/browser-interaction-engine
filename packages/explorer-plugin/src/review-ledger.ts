import type { Observation, ControlClassificationRecord } from '@interaction/browser';
import type { ExplorerHost, PlanItem, Task } from './types.js';
import { controlInScope } from './policy.js';

export const controlReviewGapReasons=new Set(['classification_unresolved','operation_basis_unconfirmed','operation_risk_unresolved','probe_unresolved']);
export type ReviewGapChange={itemId:string;proof?:NonNullable<PlanItem['reviewResolvedBy']>;reason?:string};

/** Read current public material. A model answer or a historical classification is not enough. */
export function reviewGapChanges(task:Task,o:Observation,host:ExplorerHost):ReviewGapChange[] {
  const items=task.plan.filter(i=>i.required&&i.status!=='excluded'&&controlReviewGapReasons.has(i.reason)&&!i.scope.kind&&i.scope.value===undefined);
  if(!items.length||o.gaps.some(g=>g.critical))return [];
  const snapshot=host.explorationSnapshot(o.sessionId,o.id),actions=snapshot.actions;
  const changes:ReviewGapChange[]=[];
  for(const item of items) {
    const targets=o.controls.filter(c=>c.visible&&controlInScope(item.scope,c,o,actions));
    // Hidden/absent targets retain their earlier evidence, not permission for a later occurrence.
    if(!targets.length){
      if(item.reviewResolvedBy){
        let record:ControlClassificationRecord|undefined;try{record=host.list<ControlClassificationRecord>(item.reviewResolvedBy.sessionId,'control-classification').find(r=>r.id===item.reviewResolvedBy!.classificationId);}catch{}
        if(!record||['revoked','superseded'].includes(record.status))changes.push({itemId:item.id,reason:record?'classification_revoked_or_replaced':'classification_evidence_unavailable'});
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
