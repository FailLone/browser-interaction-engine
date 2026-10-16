import type { ActionAttempt, ActionCandidate, Observation } from '@interaction/browser';
import type { ExplorerHost, PlanItem, Task } from './types.js';
import { controlInScope, matches } from './policy.js';

/** A retry budget is not coverage. Only a retained receipt checked against the
 * host ledger can exempt the exact observed candidate from another audit gap.
 * This does not extend coverage to a rebuilt document or another observation. */
export function exactSourceExecution(host:ExplorerHost,task:Task,o:Observation) {
  const refs=task.plan.flatMap(item=>[...(item.resolvedBy?[item.resolvedBy]:[]),...item.attempts.flatMap(attempt=>attempt.outcome==='succeeded'&&attempt.evidence?[attempt.evidence]:[])])
    .filter(ref=>ref.sessionId===o.sessionId&&ref.attemptId);
  let receipts:ActionAttempt[]|undefined;
  return (action:ActionCandidate):boolean=>{
    if(!refs.length||action.sessionId!==o.sessionId||action.observationId!==o.id)return false;
    if(!receipts){
      try {
        const attempts=new Map(host.list<ActionAttempt>(o.sessionId,'attempt').map(attempt=>[attempt.id,attempt]));
        receipts=[...new Set(refs.map(ref=>{
          const attempt=attempts.get(ref.attemptId!);
          return attempt?.sessionId===o.sessionId&&attempt.status==='succeeded'&&attempt.afterId&&attempt.beforeId===o.id
            &&[attempt.beforeId,attempt.afterId].includes(ref.observationId)?attempt:undefined;
        }).filter((attempt):attempt is ActionAttempt=>!!attempt))];
      }catch{receipts=[];}
    }
    return receipts.some(attempt=>attempt.action.sessionId===o.sessionId&&attempt.action.observationId===o.id
      &&attempt.action.id===action.id&&attempt.action.localId===action.localId&&attempt.action.kind===action.kind
      &&JSON.stringify(attempt.action.value)===JSON.stringify(action.value));
  };
}

/** A scheduling key groups work; it never proves completion of its retained
 * sources. Exact execution receipts cover their own observed candidates only.
 * Every other source requires the SDK's operation-correspondence proof.
 * The bounded cache belongs to this synchronous outcome, not a browser state. */
export function operationSourceCompletion(host:ExplorerHost,current:ActionAttempt) {
  const observations=new Map<string,{observation:Observation;actions:ActionCandidate[]}>();
  const attempts=new Map<string,ActionAttempt>([[`${current.sessionId}:${current.id}`,current]]);
  const loadedSessions=new Set<string>();
  const readAttempt=(sessionId:string,id:string)=>{
    const key=`${sessionId}:${id}`;if(attempts.has(key))return attempts.get(key);
    if(!loadedSessions.has(sessionId)){
      loadedSessions.add(sessionId);
      for(const attempt of host.list<ActionAttempt>(sessionId,'attempt'))if(attempt.sessionId===sessionId)attempts.set(`${sessionId}:${attempt.id}`,attempt);
    }
    return attempts.get(key);
  };
  return (item:PlanItem):boolean=>{
    try {
      const sources=new Map<string,{sessionId:string;observationId:string}>();
      const receipts=new Map<string,ActionAttempt>();
      const addSource=(sessionId:string,observationId:string)=>sources.set(`${sessionId}:${observationId}`,{sessionId,observationId});
      // The current successful attempt is evidence even if an old source keeps
      // the aggregate item unresolved. A prior unknown outcome stays a blocker.
      const refs=[...item.evidence,...item.attempts.flatMap(a=>a.evidence?[a.evidence]:[])];
      for(const ref of refs){
        if(!ref.attemptId){addSource(ref.sessionId,ref.observationId);continue;}
        const attempt=readAttempt(ref.sessionId,ref.attemptId);
        if(!attempt||attempt.sessionId!==ref.sessionId||![attempt.beforeId,attempt.afterId].includes(ref.observationId)||['unknown','executing'].includes(attempt.status))return false;
        addSource(attempt.sessionId,attempt.beforeId);
        if(attempt.status==='succeeded'&&attempt.afterId)receipts.set(`${attempt.sessionId}:${attempt.id}`,attempt);
      }
      if(!sources.size||!receipts.size)return false;
      for(const [sourceKey,ref] of sources){
        let facts=observations.get(sourceKey);
        if(!facts){
          const observation=host.observation(ref.sessionId,ref.observationId);
          if(observation.sessionId!==ref.sessionId||observation.id!==ref.observationId)return false;
          facts={observation,actions:host.operationCoverageCandidates(ref.sessionId,ref.observationId)};
          if(observations.size>=8)observations.delete(observations.keys().next().value!);
          observations.set(sourceKey,facts);
        }
        const {observation,actions}=facts;
        const members=actions.filter(action=>action.sessionId===ref.sessionId&&action.observationId===ref.observationId&&matches(item.scope,action,observation));
        if(!members.length||observation.controls.some(control=>control.visible&&controlInScope(item.scope,control,observation,actions)&&!members.some(action=>action.localId===control.localId)))return false;
        const remaining=members.filter(action=>![...receipts.values()].some(attempt=>attempt.sessionId===ref.sessionId&&attempt.beforeId===ref.observationId
          &&attempt.action.id===action.id&&attempt.action.localId===action.localId&&attempt.action.kind===action.kind&&JSON.stringify(attempt.action.value)===JSON.stringify(action.value)));
        if(!remaining.length)continue;
        const requests=remaining.flatMap(action=>[...receipts.values()].map(attempt=>({actionId:action.id,source:{sessionId:attempt.sessionId,attemptId:attempt.id}})));
        const result=host.operationCorrespondences(ref.sessionId,{observationId:ref.observationId,requests});
        if(result.sessionId!==ref.sessionId||result.observationId!==ref.observationId)return false;
        for(const action of remaining)if(!requests.some((request,index)=>{
          const proof=result.results[index];
          return request.actionId===action.id&&proof?.equivalent&&proof.target.sessionId===ref.sessionId&&proof.target.observationId===ref.observationId&&proof.target.actionId===action.id
            &&proof.source.sessionId===request.source.sessionId&&proof.source.attemptId===request.source.attemptId;
        }))return false;
      }
      return true;
    }catch{return false;}
  };
}
