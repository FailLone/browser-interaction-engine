import type {ActionAttempt} from '@interaction/core';
import {browserOperationKey,browserOperationSchedulingKey,type ActionCandidate,type Observation} from '@interaction/browser';
import type {ExplorerHost,PlanItem,Task} from './types.js';
import {scopeFor,actionScopeReader} from './policy.js';
import {operationSchedulingReferences,operationSchedulingProofHash,operationSchedulingRefKey as refKey,operationSchedulingDigest as hash,validOperationSchedulingNormalization} from './plan-state.js';

type Audit=NonNullable<PlanItem['operationSchedulingNormalization']>;
type Change={itemId:string;normalization?:Audit;reason:'normalized'|'source_proof_unavailable'};
type SourceRecord={o:Observation;scopes:Map<string,ActionCandidate[]>;keys:Map<ActionCandidate,{legacyKey:string;key:string}>};
/** Normalize only scheduling encodings. All source/attempt rows and original
 * condition/split fields stay intact. Missing or ambiguous evidence cannot
 * produce an alias, and unavailable branches remain unavailable to the SDK.
 * Pass changedItems for a local append; caches live only within this call. */
export function normalizeOperationScheduling(task:Pick<Task,'plan'>,host:Pick<ExplorerHost,'observation'|'actions'|'list'>,changedItems:readonly PlanItem[]=task.plan):Change[] {
  const changes:Change[]=[],records=new Map<string,SourceRecord|undefined>(),attempts=new Map<string,Map<string,ActionAttempt>>();
  const read=(sid:string,id:string)=>{
    const k=JSON.stringify([sid,id]);if(records.has(k)){const v=records.get(k);records.delete(k);records.set(k,v);return v;}
    let record:SourceRecord|undefined;
    try{const o=host.observation(sid,id);if(o.id===id&&o.sessionId===sid){
      const readScope=actionScopeReader(o),scopes=new Map<string,ActionCandidate[]>();
      for(const a of host.actions(sid,id)){if(a.sessionId!==sid||a.observationId!==id)continue;
        const key=hash(a.localId?readScope(a):scopeFor(a,o)),values=scopes.get(key)||[];values.push(a);scopes.set(key,values);
      }
      record={o,scopes,keys:new Map()};
    }}catch{}
    records.set(k,record);while(records.size>8)records.delete(records.keys().next().value!);return record;
  };
  const attempt=(sid:string,id:string)=>{
    if(!attempts.has(sid)){let rows:ActionAttempt[]=[];try{rows=host.list<ActionAttempt>(sid,'attempt');}catch{}attempts.set(sid,new Map(rows.filter(a=>a.sessionId===sid).map(a=>[a.id,a])));}
    return attempts.get(sid)!.get(id);
  };
  for(const item of changedItems){
    if(item.operationConditionPolicy!=='browser-operation-key-v2'||!item.operationConditionKey||!item.scope.kind||(item.dispatchScope!==false&&item.conditionLineage?.kind!=='condition')
      ||item.status==='superseded'||['split','invalidated'].includes(item.conditionMigration?.status||'')||item.attempts.some(a=>['unknown','executing'].includes(a.outcome)))continue;
    if(validOperationSchedulingNormalization(item))continue;
    const previous=validOperationSchedulingNormalization(item,true)?item.operationSchedulingNormalization:undefined;
    const sources:Audit['sources']=previous?[...previous.sources]:[],verified=new Set(sources),legacyKeys=new Set(previous?.legacyKeys||[]),scopeKey=hash(item.scope);
    let toKey=previous?.toKey,valid=true;
    const refs=operationSchedulingReferences(item);if(!refs.length)valid=false;
    for(const ref of refs){
      if(verified.has(refKey(ref)))continue;
      let sourceId=ref.observationId,attemptAction:ActionCandidate|undefined;
      if(ref.attemptId){const a=attempt(ref.sessionId,ref.attemptId);
        if(!a||['executing','unknown'].includes(a.status)||![a.beforeId,a.afterId].includes(ref.observationId)||a.action.sessionId!==ref.sessionId||a.action.observationId!==a.beforeId){valid=false;break;}
        sourceId=a.beforeId;attemptAction=a.action;
      }
      const record=read(ref.sessionId,sourceId);
      if(!record||record.o.gaps.some(g=>g.critical)||Object.values(record.o.context).some(c=>c.status!=='known')){valid=false;break;}
      const candidates=record.scopes.get(scopeKey)||[];
      if(candidates.length!==1||attemptAction&&candidates[0].id!==attemptAction.id){valid=false;break;}
      const a=candidates[0];if(!record.keys.has(a))record.keys.set(a,{legacyKey:browserOperationKey(a,record.o),key:browserOperationSchedulingKey(a,record.o)});
      const {legacyKey,key}=record.keys.get(a)!;
      if(attemptAction&&(hash(scopeFor(attemptAction,record.o))!==hash(item.scope)||browserOperationKey(attemptAction,record.o)!==legacyKey)){valid=false;break;}
      // Initial migration validates every historical source against the original
      // v2 encoding. Later appends must match the already verified v3 meaning;
      // their distinct v2 encodings remain explicit provenance and retry aliases.
      if(!previous&&legacyKey!==item.operationConditionKey||toKey&&toKey!==key){valid=false;break;}
      toKey=key;sources.push(refKey(ref));legacyKeys.add(legacyKey);verified.add(refKey(ref));
    }
    if(!valid||!toKey){if(item.operationSchedulingNormalization){delete item.operationSchedulingNormalization;changes.push({itemId:item.id,reason:'source_proof_unavailable'});}continue;}
    // Identical encodings need no alias or additional persisted source audit.
    if(toKey===item.operationConditionKey){if(item.operationSchedulingNormalization){delete item.operationSchedulingNormalization;changes.push({itemId:item.id,reason:'source_proof_unavailable'});}continue;}
    const audit:Audit={policy:'browser-operation-key-v3',fromPolicy:'browser-operation-key-v2',fromKey:item.operationConditionKey,toKey,scopeKey,sources,legacyKeys:[...legacyKeys],proofHash:''};
    audit.proofHash=operationSchedulingProofHash(audit);item.operationSchedulingNormalization=audit;changes.push({itemId:item.id,normalization:audit,reason:'normalized'});
  }
  return changes;
}
