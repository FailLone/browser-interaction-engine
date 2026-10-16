export interface ExecutionBlocker {
  code: string; reason: string; evidence: string[];
  /** The current scope decision, not a fact inferred from a frontier reason string. */
  selection?: {
    state: 'pending' | 'invalidated' | 'skipped' | 'deferred' | 'unselected';
    groupId: string; revision?: number; memberKey?: string;
  };
}
export interface ExecutionGuard {
  observationId: string;
  /** Conservative autonomous interaction; ordinary external execution keeps its existing policy. */
  profile: 'interface-exploration';
}
export interface ActionAvailability {
  sessionId: string; observationId: string; revision: string;
  profile: ExecutionGuard['profile'];
  actions: { actionId: string; executable: boolean; blockers: ExecutionBlocker[] }[];
  /** A read is not a reservation. The queued dispatch checks again, then performs live preflight. */
  dispatchRevalidationRequired: true;
}
