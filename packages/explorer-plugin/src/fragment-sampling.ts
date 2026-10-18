/** Separate local correspondence from a revocable sampling decision. Inputs
 * are direct receipt origins connected to THIS target by explicit live edges.
 * Never feed inherited counts back here or infer missing/revoked edges. */
export interface SamplingOrigin {id:string;candidateId:string;context:string;effect?:string}
export interface FragmentSamplingDecision {
 status:'fresh'|'direct'|'same-context'|'context-recheck-required'|'observed-effect-conflict'|'context-sample';
 sourceAttemptIds:string[];validationAttemptIds:string[];recheckBudget:1;coverageGranted:false;
 assumption?:'unverified-external-context'|'observed-context-only';
 conflictAttemptIds?:string[];
}
export function decideFragmentSampling(candidateId:string,context:string,origins:readonly SamplingOrigin[]):FragmentSamplingDecision {
 const result=(status:FragmentSamplingDecision['status'],sourceAttemptIds:string[]=[],validationAttemptIds:string[]=[]):FragmentSamplingDecision=>({status,sourceAttemptIds,validationAttemptIds,recheckBudget:1,coverageGranted:false,...status==='context-sample'?{assumption:'unverified-external-context' as const}:status==='same-context'?{assumption:'observed-context-only' as const}:{}});
 const direct=origins.filter(o=>o.candidateId===candidateId);
 const effects=new Set(origins.flatMap(o=>o.effect===undefined?[]:[o.effect]));
 if(direct.length)return {...result('direct',direct.map(o=>o.id)),...effects.size>1?{conflictAttemptIds:origins.filter(o=>o.effect!==undefined).map(o=>o.id)}:{}};
 if(effects.size>1)return result('observed-effect-conflict',[],origins.filter(o=>o.effect!==undefined).map(o=>o.id));
 const same=origins.filter(o=>o.context===context);
 if(same.length)return result('same-context',same.map(o=>o.id));
 if(!origins.length)return result('fresh');
 // One additional successful context sample suffices for the sampling
 // hypothesis. Missing results grant nothing and never schedule extra probes:
 // ordinary work remains eligible under the existing action/retry budget.
 const witnessed=origins.filter(o=>o.effect!==undefined),contexts=new Set(witnessed.map(o=>o.context));
 if(contexts.size<2)return result('context-recheck-required',[],origins.map(o=>o.id));
 return result('context-sample',witnessed.map(o=>o.id),witnessed.map(o=>o.id));
}
