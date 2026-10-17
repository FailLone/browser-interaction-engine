import type { ExplorationCase } from './ports.js';
import type { ActionCandidate, IdentityHypothesis, Observation } from './types.js';

/** Validate an adapter's completed condition-proof references. Structural mode
 * references remain instance references; only the operation target needs a
 * logical identity. This grants no identity, arrival or replay authority. */
export function receiptIdentityConflict(scope: NonNullable<ExplorationCase['identityConflictScope']>, action: ActionCandidate,
  before: Observation, hypotheses: IdentityHypothesis[]): string | undefined {
  if(scope.policy!=='captured-operation-controls-v1'||!Array.isArray(scope.localIds)||!scope.localIds.length
    ||new Set(scope.localIds).size!==scope.localIds.length||!action.localId||!scope.localIds.includes(action.localId))return 'source_identity_scope_unverified';
  const aliases=new Map(hypotheses.filter(h=>h.status==='resolved'&&h.revisions?.length)
    .map(h=>[h.provisionalIdentityId,h.revisions.at(-1)!.identityId]));
  const resolve=(identity:string|undefined)=>{
    const seen=new Set<string>();
    while(identity&&aliases.has(identity)&&aliases.get(identity)!==identity){
      if(seen.has(identity))return;seen.add(identity);identity=aliases.get(identity);
    }
    return identity;
  };
  const relevant=new Set<string>(),locals=new Set(scope.localIds);
  for(const localId of locals){
    const matches=before.controls.filter(c=>c.localId===localId),c=matches[0];
    if(matches.length!==1||!c.instanceId||before.controls.filter(other=>other.instanceId===c.instanceId).length!==1)return 'source_identity_scope_unverified';
    if(c.hypothesisId){
      const hypothesis=hypotheses.find(h=>h.id===c.hypothesisId);
      if(!hypothesis||hypothesis.status!=='resolved')return hypothesis?.status==='pending'?'identity_pending':'source_identity_unverified';
    }
    const identity=resolve(c.identityId);if(!identity)return 'source_identity_unverified';
    if(localId===action.localId&&c.identityScope==='instance'
      ||c.identityScope!=='instance'&&before.controls.filter(other=>resolve(other.identityId)===identity).length!==1)return 'source_identity_unverified';
    relevant.add(identity);
  }
  for(const h of hypotheses.filter(h=>h.status==='pending')){
    // Incomplete legacy hypotheses cannot prove their disjointness.
    if(!h.provisionalIdentityId||!Array.isArray(h.candidateIds)||h.candidateIds.some(id=>typeof id!=='string'||!id))return 'identity_pending';
    if(h.observationId===before.id&&locals.has(h.localId))return 'identity_pending';
    const references=[h.provisionalIdentityId,...h.candidateIds].map(resolve);
    if(references.some(id=>!id||relevant.has(id)))return 'identity_pending';
  }
}
