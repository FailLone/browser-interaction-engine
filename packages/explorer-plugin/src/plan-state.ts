import type { PlanItem, EvidenceRef } from './types.js';
import { isSuperseded, operationSchedulingRefKey } from './plan-state-shared.js';
export { isSuperseded, isUnfinished, conditionSplitIssues, operationSchedulingRefKey } from './plan-state-shared.js';
import {canonical} from '@interaction/core';
import {createHash} from 'node:crypto';

/** Same canonical SHA-256 as core.hash; this Node-only plugin can use native hashing. */
export const operationSchedulingDigest=(value:unknown)=>createHash('sha256').update(typeof value==='string'?value:canonical(value)).digest('hex');

/** A split parent and an unverified residual are records, never dispatch targets. */
export const schedulableObligation = (item: PlanItem) => !isSuperseded(item)
  && item.conditionMigration?.status !== 'split'
  && !(item.dispatchScope === false && item.conditionMigration?.status === 'invalidated');

/** Explicitly selecting a split child cannot erase its retained source condition. */
export const boundOperationCondition=(item:PlanItem)=>item.operationConditionKey&&(item.dispatchScope===false||item.conditionLineage?.kind==='condition')?schedulingOperationCondition(item):undefined;

const sourceRefKey=operationSchedulingRefKey;
export function operationSchedulingReferences(item:PlanItem):EvidenceRef[] {
  return [...new Map([...item.evidence,...item.attempts.flatMap(a=>a.evidence?[a.evidence]:[]),...item.resolvedBy?[item.resolvedBy]:[]].map(ref=>[sourceRefKey(ref),ref])).values()];
}
export function operationSchedulingProofHash(audit:NonNullable<PlanItem['operationSchedulingNormalization']>):string {
  const {proofHash:_proof,...facts}=audit;return operationSchedulingDigest(facts);
}
/** Integrity of cached source projections, not evidence of target equivalence.
 * An appended source may reuse the earlier immutable projections only while
 * every earlier source and the exact original meaning remain present. */
export function validOperationSchedulingNormalization(item:PlanItem,allowAdditionalSources=false):boolean {
  const a=item.operationSchedulingNormalization;if(!a||a.policy!=='browser-operation-key-v3'||a.fromPolicy!=='browser-operation-key-v2'
    ||typeof a.toKey!=='string'||!a.toKey||item.operationConditionPolicy!==a.fromPolicy||item.operationConditionKey!==a.fromKey||a.scopeKey!==operationSchedulingDigest(item.scope)||a.fromKey===a.toKey
    ||!Array.isArray(a.sources)||!a.sources.length||!Array.isArray(a.legacyKeys)||!a.legacyKeys.includes(a.fromKey)
    ||a.legacyKeys.some(key=>typeof key!=='string'||!key)||new Set(a.legacyKeys).size!==a.legacyKeys.length||a.proofHash!==operationSchedulingProofHash(a)
    ||item.conditionMigration?.status==='invalidated'||item.conditionMigration?.status==='split'||item.status==='superseded'
    ||item.attempts.some(x=>['unknown','executing'].includes(x.outcome)))return false;
  const refs=new Set(operationSchedulingReferences(item).map(sourceRefKey)),seen=new Set<string>();
  for(const key of a.sources){if(typeof key!=='string'||!refs.has(key)||seen.has(key))return false;seen.add(key);}
  return allowAdditionalSources||seen.size===refs.size;
}
export function schedulingOperationCondition(item:PlanItem):string|undefined {
  return validOperationSchedulingNormalization(item)?item.operationSchedulingNormalization!.toKey:item.operationConditionKey;
}
/** All verified historical encodings remain consumed if any was already tried. */
export function operationSchedulingAliases(item:PlanItem):string[] {
  return [...new Set([item.operationConditionKey,...validOperationSchedulingNormalization(item)?[item.operationSchedulingNormalization!.toKey,...item.operationSchedulingNormalization!.legacyKeys]:[]].filter((x):x is string=>!!x))];
}
