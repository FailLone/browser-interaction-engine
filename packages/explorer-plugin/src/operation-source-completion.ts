import type { ActionAttempt, ActionCandidate, Observation, ExplorationTargetCorrespondence } from '@interaction/browser';
import type { ExplorerHost, PlanItem, Task } from './types.js';
import { controlInScope, digest, keyFor, matches, schedulingKeyFor } from './policy.js';
import { boundOperationCondition, validOperationSchedulingNormalization } from './plan-state.js';
import {receiptConditionReader} from './receipt-condition.js';

export interface DispatchSourceAssociation { actionKey:string; proof:ExplorationTargetCorrespondence }

/** A retry budget is not coverage. Only a retained receipt checked against the
 * host ledger can exempt the exact observed candidate from another audit gap.
 * This does not extend coverage to a rebuilt document or another observation. */
export function exactSourceExecution(host:ExplorerHost,task:Task,o:Observation) {
  const condition=receiptConditionReader(host);
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
      &&JSON.stringify(attempt.action.value)===JSON.stringify(action.value)&&condition(attempt).conditionVerified);
  };
}

/** A scheduling key groups work; it never proves completion of its retained
 * sources. Exact execution receipts cover their own observed candidates only.
 * Every other source requires the SDK's operation-correspondence proof.
 * The bounded cache belongs to this synchronous outcome, not a browser state. */
export function operationSourceCompletion(host:ExplorerHost,current?:ActionAttempt,condition=receiptConditionReader(host)) {
  const observations=new Map<string,{observation:Observation;actions:ActionCandidate[]}>();
  const attempts=new Map<string,ActionAttempt>(current?[[`${current.sessionId}:${current.id}`,current]]:[]);
  const loadedSessions=new Set<string>();
  const readAttempt=(sessionId:string,id:string)=>{
    const key=`${sessionId}:${id}`;if(attempts.has(key))return attempts.get(key);
    if(!loadedSessions.has(sessionId)){
      loadedSessions.add(sessionId);
      for(const attempt of host.list<ActionAttempt>(sessionId,'attempt'))if(attempt.sessionId===sessionId)attempts.set(`${sessionId}:${attempt.id}`,attempt);
    }
    return attempts.get(key);
  };
  // Collect only receipts referenced by this already-selected obligation. A
  // missing/unknown ref invalidates the whole item before a batch proof read.
  const collect=(item:PlanItem,accept?:(attempt:ActionAttempt)=>boolean)=>{
    const sources=new Map<string,{sessionId:string;observationId:string}>(),receipts=new Map<string,ActionAttempt>();
    const addSource=(sessionId:string,observationId:string)=>sources.set(`${sessionId}:${observationId}`,{sessionId,observationId});
    const refs=[...item.evidence,...item.attempts.flatMap(a=>a.evidence?[a.evidence]:[]),...(item.resolvedBy?[item.resolvedBy]:[])];
    if(item.attempts.some(a=>['unknown','executing'].includes(a.outcome)&&!a.evidence?.attemptId))return;
    for(const ref of refs)if(!ref.attemptId)addSource(ref.sessionId,ref.observationId);
    const hasDiscoverySources=sources.size>0;
    for(const ref of refs){
      if(!ref.attemptId)continue;
      const attempt=readAttempt(ref.sessionId,ref.attemptId);
      if(!attempt||attempt.sessionId!==ref.sessionId||![attempt.beforeId,attempt.afterId].includes(ref.observationId)||['unknown','executing'].includes(attempt.status))return;
      // A receipt proves execution; its rebuilt before-frame is not another
      // discovery under the original literal scope. Receipt-only legacy items
      // retain their old exact-before interpretation, never an invented source.
      if(!hasDiscoverySources)addSource(attempt.sessionId,attempt.beforeId);
      if(attempt.status==='succeeded'&&attempt.afterId&&(!accept||accept(attempt)))receipts.set(`${attempt.sessionId}:${attempt.id}`,attempt);
    }
    return {sources,receipts};
  };
  const readSource=(sessionId:string,observationId:string)=>{
    const key=`${sessionId}:${observationId}`;let facts=observations.get(key);
    if(!facts){
      const observation=host.observation(sessionId,observationId);
      if(observation.sessionId!==sessionId||observation.id!==observationId)throw Error('Source observation ownership mismatch');
      facts={observation,actions:host.operationCoverageCandidates(sessionId,observationId)};
      if(observations.size>=8)observations.delete(observations.keys().next().value!);
      observations.set(key,facts);
    }
    return facts;
  };
  /** Attribution of one actual attempt to a program-derived child, not success
   * or permission. Original scope/condition apply to the retained source only;
   * SDK correspondence must freshly bind its uniquely mapped current action. */
  const bind=(item:PlanItem,attempt:Pick<ActionAttempt,'sessionId'|'beforeId'|'action'>,saved?:DispatchSourceAssociation):DispatchSourceAssociation|undefined=>{
    try{
      const condition=boundOperationCondition(item),query=host.explorationTargetCorrespondences;
      if(!query||!condition||!item.scope.kind||!item.required
        ||item.dispatchScope!==false&&item.conditionLineage?.kind!=='condition'
        ||['succeeded','excluded','superseded'].includes(item.status)||['split','invalidated'].includes(item.conditionMigration?.status||'')
        ||!['browser-operation-key-v2','browser-operation-key-v3'].includes(item.operationConditionPolicy||''))return undefined;
      const collected=collect(item);if(!collected||!collected.sources.size)return undefined;
      const before=readSource(attempt.sessionId,attempt.beforeId),actual=attempt.action;
      const candidates=before.actions.filter(a=>a.id===actual.id&&a.sessionId===attempt.sessionId&&a.observationId===attempt.beforeId);
      if(actual.sessionId!==attempt.sessionId||actual.observationId!==attempt.beforeId||candidates.length!==1)return undefined;
      const target=candidates[0];
      if(target.localId!==actual.localId||target.controlId!==actual.controlId||target.kind!==actual.kind||target.risk!==actual.risk
        ||JSON.stringify(target.value)!==JSON.stringify(actual.value))return undefined;
      const legacy=item.operationConditionPolicy==='browser-operation-key-v2'&&!validOperationSchedulingNormalization(item);
      let associated:DispatchSourceAssociation|undefined;
      for(const ref of collected.sources.values()){
        const {observation,actions}=readSource(ref.sessionId,ref.observationId);
        const originals=actions.filter(a=>a.sessionId===ref.sessionId&&a.observationId===ref.observationId&&matches(item.scope,a,observation)
          &&(legacy?keyFor(a,observation):schedulingKeyFor(a,observation))===condition);
        if(originals.length!==1)continue;
        const source={...ref,actionId:originals[0].id};
        if(saved&&saved.actionKey!==digest(actual))return;
        const result=saved?{sessionId:saved.proof.target.sessionId,observationId:saved.proof.target.observationId,results:[saved.proof]}
          :query.call(host,attempt.sessionId,{observationId:attempt.beforeId,requests:[{actionId:actual.id,source}]});
        const proof=result?.results?.[0];
        if(result?.sessionId===attempt.sessionId&&result.observationId===attempt.beforeId&&result.results.length===1
          &&proof?.equivalent&&proof.identityAuthorized===false&&proof.replayAuthorized===false&&proof.currentExecution===false
          &&proof.target.sessionId===attempt.sessionId&&proof.target.observationId===attempt.beforeId&&proof.target.actionId===actual.id
          &&proof.source.sessionId===source.sessionId&&proof.source.observationId===source.observationId&&proof.source.actionId===source.actionId)associated={actionKey:digest(actual),proof:structuredClone(proof)};
      }
      return associated;
    }catch{return undefined;}
  };
  // A current-only SDK query must run before dispatch. Its immutable source
  // binding can attribute the later receipt, including after process restart;
  // completion below still revalidates every source against the actual receipt.
  const prepareAssociation=(item:PlanItem,action:ActionCandidate)=>bind(item,{sessionId:action.sessionId,beforeId:action.observationId,action});
  const associate=(item:PlanItem,attempt:ActionAttempt,saved?:DispatchSourceAssociation)=>!!bind(item,attempt,saved);
  // An explicit pre-dispatch binding may settle only its selected original
  // source after that exact command has a verified receipt. Re-read the SDK
  // relation against the receipt's before-frame; never distribute this receipt
  // to sibling items, new children, other observations or transitive relations.
  const executedBoundSource=(item:PlanItem,source:{sessionId:string;observationId:string},action:ActionCandidate,attempt:ActionAttempt)=>{
    const saved=item.attempts.find(row=>row.evidence?.sessionId===attempt.sessionId&&row.evidence.attemptId===attempt.id)?.sourceAssociation;
    const proof=saved?.proof;
    if(!saved||!proof||saved.actionKey!==digest(attempt.action)||proof.policy!=='captured-component-pair/v1'
      ||!proof.equivalent||proof.source.sessionId!==source.sessionId||proof.source.observationId!==source.observationId||proof.source.actionId!==action.id
      ||proof.target.sessionId!==attempt.sessionId||proof.target.observationId!==attempt.beforeId||proof.target.actionId!==attempt.action.id)return false;
    const fresh=host.explorationTargetCorrespondences?.(attempt.sessionId,{observationId:attempt.beforeId,requests:[{actionId:attempt.action.id,source:proof.source}]}).results[0];
    return !!fresh?.equivalent&&fresh.policy===proof.policy&&fresh.identityAuthorized===false&&fresh.replayAuthorized===false&&fresh.currentExecution===false
      &&digest(fresh.source)===digest(proof.source)&&digest(fresh.target)===digest(proof.target)
      &&fresh.evidence.includes(`recorded-target-dispatch:${attempt.id}`);
  };
  const complete=(item:PlanItem):boolean=>{
    try {
      // Old hosts retain their original per-reference lazy single-query path.
      const collected=collect(item,host.operationReceiptConditions?undefined:attempt=>condition(attempt).conditionVerified);
      if(!collected)return false;
      const {sources,receipts}=collected;
      if(host.operationReceiptConditions){
        const candidates=[...receipts.values()],proofs=condition.many(candidates);
        candidates.forEach((attempt,index)=>{if(!proofs[index].conditionVerified)receipts.delete(`${attempt.sessionId}:${attempt.id}`);});
      }
      if(!sources.size||!receipts.size)return false;
      for(const ref of sources.values()){
        const {observation,actions}=readSource(ref.sessionId,ref.observationId);
        const members=actions.filter(action=>action.sessionId===ref.sessionId&&action.observationId===ref.observationId&&matches(item.scope,action,observation));
        if(!members.length||observation.controls.some(control=>control.visible&&controlInScope(item.scope,control,observation,actions)&&!members.some(action=>action.localId===control.localId)))return false;
        const remaining=members.filter(action=>![...receipts.values()].some(attempt=>attempt.sessionId===ref.sessionId&&attempt.beforeId===ref.observationId
          &&attempt.action.id===action.id&&attempt.action.localId===action.localId&&attempt.action.kind===action.kind&&JSON.stringify(attempt.action.value)===JSON.stringify(action.value)
          ||executedBoundSource(item,ref,action,attempt)));
        if(!remaining.length)continue;
        const requests=remaining.flatMap(action=>[...receipts.values()].map(attempt=>({actionId:action.id,source:{sessionId:attempt.sessionId,attemptId:attempt.id}})));
        const result=host.operationCorrespondences(ref.sessionId,{observationId:ref.observationId,requests});
        if(result.sessionId!==ref.sessionId||result.observationId!==ref.observationId)return false;
        for(const action of remaining)if(!requests.some((request,index)=>{
          const proof=result.results[index];
          return request.actionId===action.id&&proof?.equivalent&&proof.target.sessionId===ref.sessionId&&proof.target.observationId===ref.observationId&&proof.target.actionId===action.id
            &&proof.identityAuthorized===false&&proof.replayAuthorized===false&&proof.currentExecution===false
            &&proof.source.sessionId===request.source.sessionId&&proof.source.attemptId===request.source.attemptId;
        }))return false;
      }
      return true;
    }catch{return false;}
  };
  const prepare=(items:readonly PlanItem[],directAttempts:readonly ActionAttempt[]=[])=>{
    if(!host.operationReceiptConditions)return;
    const candidates=[...directAttempts];
    for(const item of items){try{const collected=collect(item);if(collected)candidates.push(...collected.receipts.values());}catch{/* The item retains its normal evidence-unavailable result. */}}
    try{condition.many(candidates);}catch{/* Per-item reads retain the original fail-closed boundary. */}
  };
  return Object.assign(complete,{prepare,associate,prepareAssociation});
}
