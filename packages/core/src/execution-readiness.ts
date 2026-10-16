export interface ExecutionBlocker {
  code: string; reason: string; evidence: string[];
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
