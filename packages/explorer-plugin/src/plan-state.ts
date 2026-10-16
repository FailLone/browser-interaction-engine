import type { PlanItem, EvidenceRef } from './types.js';

/** A replaced historical range remains in the ledger; it is neither tested nor excluded. */
export const isSuperseded = (item: PlanItem) => item.status === 'superseded';
export const isUnfinished = (item: PlanItem) => !['succeeded', 'excluded', 'superseded'].includes(item.status);
/** A split parent and an unverified residual are records, never dispatch targets. */
export const schedulableObligation = (item: PlanItem) => !isSuperseded(item)
  && item.conditionMigration?.status !== 'split'
  && !(item.dispatchScope === false && item.conditionMigration?.status === 'invalidated');

/** Explicitly selecting a split child cannot erase its retained source condition. */
export const boundOperationCondition=(item:PlanItem)=>item.operationConditionKey&&(item.dispatchScope===false||item.conditionLineage?.kind==='condition')?item.operationConditionKey:undefined;

const sourceRefKey=(ref:EvidenceRef)=>JSON.stringify([ref.sessionId,ref.observationId,ref.attemptId||'']);
/** Validate the persisted transfer as one lightweight pass, without reading captures.
 * The whole plan is saved atomically; a damaged/missing child makes its parent a gap. */
function splitIntegrity(item:PlanItem,byId:Map<string,PlanItem>):string|undefined {
  const audit=item.conditionMigration!,children=audit.children||[];
  if(item.dispatchScope!==false)return 'parent_authority_mismatch';
  if(!children.length)return 'missing_children';
  const expected=new Set(item.evidence.map(sourceRefKey)),assigned=new Set<string>(),ids=new Set<string>();
  const proven=new Set(audit.sources.map(sourceRefKey)),gaps=new Set(audit.unverifiedSources?.map(x=>sourceRefKey(x.source)));
  for(const link of children){
    if(ids.has(link.itemId)||link.itemId===item.id)return 'invalid_child_id';ids.add(link.itemId);
    const child=byId.get(link.itemId);if(!child)return 'missing_child';
    const lineage=child.conditionLineage;
    if(lineage?.parentItemId!==item.id||lineage.policy!=='operation-condition-split-v1'||lineage.kind!==link.kind||lineage.fromKey!==audit.fromKey)return 'child_lineage_mismatch';
    if(child.required!==link.required||child.dispatchScope!==link.dispatchScope)return 'child_authority_mismatch';
    if(!link.scope||Object.keys({...link.scope,...child.scope}).some(key=>JSON.stringify(child.scope[key as keyof typeof child.scope])!==JSON.stringify(link.scope[key as keyof typeof link.scope])))return 'child_scope_mismatch';
    if(child.status==='excluded'&&child.required)return 'child_exclusion_mismatch';
    if(child.status==='superseded'||child.conditionMigration?.status==='split')return 'nested_split_not_supported';
    if(!link.sources.length)return 'missing_child_sources';
    const childRefs=new Set(child.evidence.map(sourceRefKey));
    for(const ref of link.sources){const key=sourceRefKey(ref);if(!expected.has(key)||assigned.has(key)||!childRefs.has(key))return 'child_source_mismatch';assigned.add(key);}
    if(link.kind==='condition'){
      if(!link.operationConditionKey||child.operationConditionKey!==link.operationConditionKey||child.operationConditionPolicy!=='browser-operation-key-v2')return 'child_condition_mismatch';
      if(link.sources.some(ref=>!proven.has(sourceRefKey(ref))))return 'missing_condition_proof';
    }else{
      if(child.conditionMigration?.status!=='invalidated'||child.operationConditionKey!==audit.fromKey)return 'residual_gap_mismatch';
      if(link.sources.some(ref=>!gaps.has(sourceRefKey(ref))))return 'missing_residual_source';
    }
  }
  if(assigned.size!==expected.size)return 'source_not_transferred';
}

/** Build once per synchronous read; no captured documents or persistent cache. */
export function conditionSplitIssues(plan:PlanItem[]):Map<string,string> {
  const byId=new Map(plan.map(item=>[item.id,item])),issues=new Map<string,string>();
  for(const item of plan){
    if(item.status==='superseded'&&item.conditionMigration?.status!=='split'){issues.set(item.id,'missing_split_audit');continue;}
    if(item.conditionMigration?.status!=='split')continue;
    const reason=splitIntegrity(item,byId);if(reason)issues.set(item.id,reason);
  }
  return issues;
}
