import type { ActionAttempt, Observation } from '@interaction/browser';
import type { EntryRoute, ExplorerHost, Round, Scope } from './types.js';
import { digest, scopeFor } from './policy.js';

/** Browser position is observed, never inferred from a planned return path. */
export interface NavigationPosition {
  sessionId: string;
  observationId: string;
  instanceScope: string;
  url: string;
  contextKey: string;
  boundaryKeys: string[];
}

export function observedPosition(o: Observation): NavigationPosition {
  return {sessionId:o.sessionId,observationId:o.id,instanceScope:o.instanceScope,url:o.url,
    contextKey:digest(o.context),boundaryKeys:o.boundaries?.map(b=>b.key)||[]};
}

/** A failed recovery may have moved the browser, even without changing its URL.
 * Preserve all frames/obligations, but discard the unverified cursor path. The
 * next iteration can reconstruct it from retained occurrences and route proof.
 */
export function reconcileRecoveryPosition(round: Round, before: Observation, after: Observation,
  result: {status:string;attemptIds:string[]}, verifiedPath?: Scope[]) {
  const previous=round.entryPath;
  round.position=observedPosition(after);
  const moved=result.attemptIds.length>0||before.instanceScope!==after.instanceScope||before.url!==after.url
    ||digest(before.context)!==digest(after.context)||digest(before.boundaries?.map(b=>b.key))!==digest(after.boundaries?.map(b=>b.key));
  if(verifiedPath)round.entryPath=[...verifiedPath];
  else if(moved)round.entryPath=[];
  return {previous,path:[...round.entryPath],position:round.position,pathVerified:!!verifiedPath,
    reason:verifiedPath?'verified_checkpoint_path':moved?'recovery_moved_browser':'observation_refreshed',checkpointVerified:result.status==='REACHED_VERIFIED'||result.status==='REACHED_ACCEPTABLE'};
}

/** Legacy route records may lack an attempt ID. Reconstruct only a unique,
 * successful recorded transition; never infer repetition permission from prose.
 */
export function routeAttempt(host: ExplorerHost, route: EntryRoute) {
  try {
    const attempts=host.list<ActionAttempt>(route.evidence.sessionId,'attempt').filter(a=>a.status==='succeeded'
      &&a.beforeId===route.evidence.beforeId&&a.afterId===route.evidence.observationId
      &&(!route.evidence.attemptId||a.id===route.evidence.attemptId));
    const matching=attempts.filter(a=>digest(scopeFor(a.action,host.observation(a.sessionId,a.beforeId)))===digest(route.entry));
    return matching.length===1?{sessionId:matching[0].sessionId,attemptId:matching[0].id}:undefined;
  } catch { return; }
}
