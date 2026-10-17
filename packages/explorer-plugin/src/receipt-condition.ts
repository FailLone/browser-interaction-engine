import {canonical,hash} from '@interaction/core';
import type {ActionAttempt,OperationReceiptCondition} from '@interaction/browser';
import type {ExplorerHost} from './types.js';

/** One synchronous completion/audit only. An execution receipt consumes budget;
 * it does not itself prove that its retained operation conditions held. */
export function receiptConditionReader(host:ExplorerHost) {
  const results=new Map<string,{facts:string;proof:OperationReceiptCondition}>();
  return (attempt:ActionAttempt):OperationReceiptCondition=>{
    const key=JSON.stringify([attempt.sessionId,attempt.id]),facts=canonical(attempt),cached=results.get(key);
    if(cached?.facts===facts)return cached.proof;
    let proof:OperationReceiptCondition={actualSuccess:attempt.status==='succeeded',conditionVerified:false,status:'unavailable',reason:'receipt_condition_capability_unavailable',
      source:{sessionId:attempt.sessionId,attemptId:attempt.id,beforeId:attempt.beforeId,afterId:attempt.afterId,actionId:attempt.action.id,actionKey:hash(attempt.action)},
      evidence:[],identityAuthorized:false,replayAuthorized:false,currentExecution:false,arrivalVerified:false};
    try {
      const result=host.operationReceiptCondition?.(attempt.sessionId,{attemptId:attempt.id});
      if(result){
        const source=result.source;
        const owned=source.sessionId===attempt.sessionId&&source.attemptId===attempt.id&&source.beforeId===attempt.beforeId&&source.afterId===attempt.afterId
          &&source.actionId===attempt.action.id&&source.actionKey===hash(attempt.action);
        proof={...proof,actualSuccess:owned?proof.actualSuccess&&result.actualSuccess:proof.actualSuccess,reason:owned?result.reason:'receipt_condition_ownership_mismatch',
          ...(owned?{evidence:result.evidence}:{}),
          ...(owned&&attempt.status==='succeeded'&&!!attempt.afterId&&result.actualSuccess&&result.conditionVerified
            &&['portable','document'].includes(result.status)&&result.policy&&result.conditionKey
            &&result.identityAuthorized===false&&result.replayAuthorized===false&&result.currentExecution===false&&result.arrivalVerified===false
            ?{conditionVerified:true,status:result.status,policy:result.policy,conditionKey:result.conditionKey}:{} )};
      }
    }catch{proof.reason='receipt_condition_evidence_unavailable';}
    results.set(key,{facts,proof});return proof;
  };
}
