export { InteractionEngine } from './engine.js';
export * from './types.js';
export * from './ports.js';
export { sessionSchema, contextSchema, evidenceRetentionSchema, componentDescriptionSchema, explorationGroupDecisionSchema, explorationGroupProposalSchema, explorationGroupResolutionsSchema } from './schema.js';
export { canonical, hash, hashBytes, contextKey, id, now, clone, timeout } from './util.js';
export { matchIdentities, assignState, sameObservedState } from './identity.js';
export { recoverStore } from './recovery.js';
export * from './diff-details.js';
export * from './exploration-audit.js';
export * from './coverage-reconciliation.js';
export * from './execution-readiness.js';
export { BoundedEntityChanges } from './entity-changes.js';

export { currentExplorationDecision } from './exploration-groups.js';
