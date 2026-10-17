import {canonical,hash} from '@interaction/core';
import type {ActionAttempt,OperationReceiptCondition} from '@interaction/browser';
import type {ExplorerHost} from './types.js';

/** One synchronous completion/audit only. An execution receipt consumes budget;
 * it does not itself prove that its retained operation conditions held. */
export function receiptConditionReader(host:ExplorerHost) {
  const results=new Map<string,{facts:string;proof:OperationReceiptCondition}>();
  const unavailable=(attempt:ActionAttempt,reason='receipt_condition_capability_unavailable'):OperationReceiptCondition=>({actualSuccess:attempt.status==='succeeded',conditionVerified:false,status:'unavailable',reason,
    source:{sessionId:attempt.sessionId,attemptId:attempt.id,beforeId:attempt.beforeId,afterId:attempt.afterId,actionId:attempt.action.id,actionKey:hash(attempt.action)},
    evidence:[],identityAuthorized:false,replayAuthorized:false,currentExecution:false,arrivalVerified:false});
  const verify=(attempt:ActionAttempt,result:OperationReceiptCondition|undefined):OperationReceiptCondition=>{
    let proof=unavailable(attempt);
    if(result){
      const source=result.source;
      const owned=source?.sessionId===attempt.sessionId&&source.attemptId===attempt.id&&source.beforeId===attempt.beforeId&&source.afterId===attempt.afterId
        &&source.actionId===attempt.action.id&&source.actionKey===hash(attempt.action);
      proof={...proof,actualSuccess:owned?proof.actualSuccess&&result.actualSuccess:proof.actualSuccess,reason:owned?result.reason:'receipt_condition_ownership_mismatch',
        ...(owned?{evidence:result.evidence}:{}),
        ...(owned&&attempt.status==='succeeded'&&!!attempt.afterId&&result.actualSuccess&&result.conditionVerified
          &&['portable','document'].includes(result.status)&&result.policy&&result.conditionKey
          &&result.identityAuthorized===false&&result.replayAuthorized===false&&result.currentExecution===false&&result.arrivalVerified===false
          ?{conditionVerified:true,status:result.status,policy:result.policy,conditionKey:result.conditionKey}:{} )};
    }
    return proof;
  };
  const many=(attempts:readonly ActionAttempt[]):OperationReceiptCondition[]=>{
    const entries=attempts.map(attempt=>({attempt,key:JSON.stringify([attempt.sessionId,attempt.id]),facts:canonical(attempt)}));
    const pending=new Map<string,typeof entries[number]>(),seen=new Map<string,string>(),conflicts=new Set<string>();
    for(const entry of entries){
      const prior=seen.get(entry.key);
      if(prior!==undefined&&prior!==entry.facts)conflicts.add(entry.key);
      seen.set(entry.key,entry.facts);
      if(results.get(entry.key)?.facts!==entry.facts)pending.set(entry.key,entry);
    }
    const groups=new Map<string,typeof entries>();
    for(const entry of pending.values()){
      if(conflicts.has(entry.key))continue;
      const values=groups.get(entry.attempt.sessionId)||[];values.push(entry);groups.set(entry.attempt.sessionId,values);
    }
    for(const [sessionId,group] of groups){
      let proofs:OperationReceiptCondition[];
      if(host.operationReceiptConditions){
        try {
          const batch=host.operationReceiptConditions(sessionId,{attemptIds:group.map(({attempt})=>attempt.id)});
          const aligned=batch?.sessionId===sessionId&&Array.isArray(batch.results)&&batch.results.length===group.length
            &&group.every(({attempt},index)=>batch.results[index]?.source?.sessionId===sessionId&&batch.results[index]?.source?.attemptId===attempt.id);
          proofs=group.map(({attempt},index)=>aligned?verify(attempt,batch.results[index]):unavailable(attempt,'receipt_condition_batch_invalid'));
        }catch{proofs=group.map(({attempt})=>unavailable(attempt,'receipt_condition_evidence_unavailable'));}
      }else proofs=group.map(({attempt})=>{try{return verify(attempt,host.operationReceiptCondition?.(sessionId,{attemptId:attempt.id}));}catch{return unavailable(attempt,'receipt_condition_evidence_unavailable');}});
      group.forEach(({attempt,key,facts},index)=>results.set(key,{facts,proof:canonical(attempt)===facts?proofs[index]:unavailable(attempt,'receipt_condition_ownership_mismatch')}));
    }
    return entries.map(({attempt,key,facts})=>conflicts.has(key)?unavailable(attempt,'receipt_condition_ownership_mismatch'):
      results.get(key)?.facts===facts?results.get(key)!.proof:unavailable(attempt,'receipt_condition_ownership_mismatch'));
  };
  const read=(attempt:ActionAttempt):OperationReceiptCondition=>{
    const key=JSON.stringify([attempt.sessionId,attempt.id]),facts=canonical(attempt),cached=results.get(key);
    if(cached?.facts===facts)return cached.proof;
    let proof:OperationReceiptCondition;
    try{proof=verify(attempt,host.operationReceiptCondition?.(attempt.sessionId,{attemptId:attempt.id}));}
    catch{proof=unavailable(attempt,'receipt_condition_evidence_unavailable');}
    if(canonical(attempt)!==facts)proof=unavailable(attempt,'receipt_condition_ownership_mismatch');
    results.set(key,{facts,proof});return proof;
  };
  return Object.assign(read,{many});
}
