import type { ControlClassificationRecord, Observation } from '@interaction/browser';
import type { ExplorerHost, Task } from './types.js';

/** Only select retained task evidence; the SDK owns correspondence and applicability.
 * No result survives this synchronous observation-bound read or grants execution.
 */
export function reusableClassifications(host:ExplorerHost,task:Task,o:Observation,controls:Observation['controls']) {
  if(!host.classificationCorrespondences||!controls.length)return [];
  const records=[...new Set(task.rounds.map(r=>r.sessionId))].flatMap(sid=>host.list<ControlClassificationRecord>(sid,'control-classification'))
    .filter(r=>['display','container'].includes(r.classification)&&!['revoked','superseded'].includes(r.status)&&!r.reuseFrom&&r.conditions.target.url===o.url)
    .sort((a,b)=>b.at.localeCompare(a.at));
  const selected=new Map<string,{localId:string;classification:'display'|'container';reason:string;evidence:string[];reuseFrom:{sessionId:string;observationId:string;classificationId:string;classification:'display'|'container'}}>();
  const proofs:unknown[]=[],sourceDecisionIds=new Set<string>();
  const requests=controls.flatMap(control=>records.filter(r=>{
    const prior=r.conditions.target.target;
    // Cheap conservative prefilter only; never establishes correspondence.
    return prior.tag===control.tag&&prior.role===control.role&&prior.name===control.name&&prior.label===control.label;
  }).map(record=>({record,localId:control.localId,source:{sessionId:record.sessionId,observationId:record.observationId,classificationId:record.id,classification:record.classification as 'display'|'container'}})));
  for(let offset=0;offset<requests.length;offset+=200){
    const batch=requests.slice(offset,offset+200).filter(r=>!selected.has(r.localId));if(!batch.length)continue;
    const result=host.classificationCorrespondences(o.sessionId,{observationId:o.id,requests:batch.map(({localId,source})=>({localId,source}))});
    if(result.sessionId!==o.sessionId||result.observationId!==o.id)return [];
    for(const [index,proof] of result.results.entries()){
      const request=batch[index];if(!request||selected.has(request.localId)||!proof.applicable||proof.target.localId!==request.localId||proof.target.observationId!==o.id||proof.target.sessionId!==o.sessionId
        ||proof.source.classificationId!==request.source.classificationId||proof.source.sessionId!==request.source.sessionId||proof.source.observationId!==request.source.observationId||proof.classification!==request.source.classification)continue;
      selected.set(request.localId,{localId:request.localId,classification:request.source.classification,reason:'SDK verified retained classification against current control and evidence',evidence:[`classification-source:${request.source.classificationId}`,`observation:${o.id}`,...request.record.evidence.slice(0,98)],reuseFrom:request.source});
      proofs.push(proof);for(const entry of request.record.evidence)if(entry.startsWith('explorer-decision:'))sourceDecisionIds.add(entry.slice('explorer-decision:'.length));
    }
  }
  return selected.size?[{classifications:[...selected.values()],proofs,sourceDecisionIds:[...sourceDecisionIds]}]:[];
}
