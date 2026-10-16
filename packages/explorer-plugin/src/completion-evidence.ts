import { browserOperationCorrespondenceHint, type ActionCandidate, type Observation } from '@interaction/browser';
import type { ExplorerHost, Task } from './types.js';
import { actionScopeReader } from './policy.js';

/** A synchronous scheduling read, never current execution coverage or permission.
 * Rebuild after every await, observation/review change or completion-ledger change.
 * Only the host interprets whether the retained operation evidence still applies.
 */
export function completedOperations(host:ExplorerHost,task:Task,o:Observation,actions:ActionCandidate[]):ReadonlySet<ActionCandidate> {
  const completed=new Set<ActionCandidate>();
  const proofs=task.plan.filter(i=>i.required&&i.status==='succeeded'&&i.resolvedBy?.attemptId&&i.scope.kind&&i.scope.label)
    .flatMap(item=>[...new Map([item.resolvedBy!,...item.attempts.filter(a=>a.outcome==='succeeded'&&a.evidence?.attemptId).map(a=>a.evidence!)].map(ref=>[`${ref.sessionId}:${ref.attemptId}`,ref])).values()].map(ref=>({item,ref,fields:Object.entries(item.scope).filter(([key])=>item.dispatchScope!==false||['url','label','role','kind','value'].includes(key))})));
  if(!proofs.length||!actions.length)return completed;
  // Necessary literal conditions form an index, not an equivalence judgment.
  // Native record links alone may relax a derived label; keep a separate bucket
  // for that existing SDK rule, preserving every historical A/B source.
  type Proof=typeof proofs[number];
  const exact=new Map<string,Proof[]>(),literal=new Map<string,Proof[]>(),native=new Map<string,Proof[]>();
  const add=(map:Map<string,Proof[]>,key:string,proof:Proof)=>{let values=map.get(key);if(!values){values=[];map.set(key,values);}values.push(proof);};
  for(const proof of proofs){const key=JSON.stringify([proof.item.scope.kind,proof.item.scope.label]);add(exact,key,proof);if(proof.item.dispatchScope===false)add(native,proof.item.scope.kind!,proof);else add(literal,key,proof);}
  const readScope=actionScopeReader(o),controls=new Map<string,Observation['controls'][number]>();
  for(const c of o.controls)if(!controls.has(c.localId))controls.set(c.localId,c);
  const requests:Parameters<ExplorerHost['operationCorrespondences']>[1]['requests']=[],requestIndex=new Map<string,number>(),indices=new Map<ActionCandidate,number[]>();
  for(const action of new Set(actions)) {
    const actual=readScope(action),matches:number[]=[];
    const control=action.localId?controls.get(action.localId):undefined,nativeLink=control&&browserOperationCorrespondenceHint(control,action.kind,o);
    const key=JSON.stringify([actual.kind,actual.label]);
    const candidates=nativeLink?[...(literal.get(key)||[]),...(native.get(action.kind)||[])]:exact.get(key)||[];
    for(const {item,ref,fields} of candidates) {
      // Accepted user scopes retain their literal meaning. Program-derived rows
      // are immutable discovery records, not a second identity implementation:
      // legacy key encodings/review region names must not prevent the host from examining
      // their retained successful attempt. This filter only bounds the batch;
      // the host still proves target uniqueness, operation and context equality.
      // Native record links may change their displayed name. Only that SDK hint
      // relaxes the derived name prefilter; the batch still verifies both sides'
      // destination, unique record, context and operation conditions.
      if(!fields.every(([key,value])=>key==='label'&&item.dispatchScope===false&&nativeLink||JSON.stringify(actual[key as keyof typeof actual])===JSON.stringify(value)))continue;
      const source={sessionId:ref.sessionId,attemptId:ref.attemptId!};
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
