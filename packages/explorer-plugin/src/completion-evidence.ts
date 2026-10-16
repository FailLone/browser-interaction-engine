import type { ActionCandidate, Observation } from '@interaction/browser';
import type { ExplorerHost, Task } from './types.js';
import { scopeFor } from './policy.js';

/** A synchronous scheduling read, never current execution coverage or permission.
 * Rebuild after every await, observation/review change or completion-ledger change.
 * Only the host interprets whether the retained operation evidence still applies.
 */
export function completedOperations(host:ExplorerHost,task:Task,o:Observation,actions:ActionCandidate[]):ReadonlySet<ActionCandidate> {
  const completed=new Set<ActionCandidate>();
  const proofs=task.plan.filter(i=>i.required&&i.status==='succeeded'&&i.resolvedBy?.attemptId&&i.scope.kind&&i.scope.label);
  if(!proofs.length||!actions.length)return completed;
  const requests:Parameters<ExplorerHost['operationCorrespondences']>[1]['requests']=[],requestIndex=new Map<string,number>(),indices=new Map<ActionCandidate,number[]>();
  for(const action of new Set(actions)) {
    const actual=scopeFor(action,o),matches:number[]=[];
    for(const item of proofs) {
      if(!Object.entries(item.scope).every(([key,value])=>JSON.stringify(actual[key as keyof typeof actual])===JSON.stringify(value)))continue;
      const ref=item.resolvedBy!,source={sessionId:ref.sessionId,attemptId:ref.attemptId!};
      const key=JSON.stringify([action.id,source.sessionId,source.attemptId]);
      let index=requestIndex.get(key);
      if(index===undefined){index=requests.length;requestIndex.set(key,index);requests.push({actionId:action.id,source});}
      matches.push(index);
    }
    if(matches.length)indices.set(action,matches);
  }
  if(!requests.length)return completed;
  try {
    const batch=host.operationCorrespondences(o.sessionId,{observationId:o.id,requests});
    if(batch.sessionId!==o.sessionId||batch.observationId!==o.id)return completed;
    for(const [action,positions] of indices)if(positions.some(index=>{
      const proof=batch.results[index],request=requests[index];
      return proof?.equivalent&&proof.target.observationId===o.id&&proof.target.sessionId===o.sessionId&&proof.target.actionId===action.id
        &&proof.source.sessionId===request.source.sessionId&&proof.source.attemptId===request.source.attemptId;
    }))completed.add(action);
  }catch{/* Missing retained evidence leaves the task obligation unresolved. */}
  return completed;
}
