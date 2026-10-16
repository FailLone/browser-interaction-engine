import type {Observation} from '@interaction/browser';
import type {RouteFailureCondition} from './obligation-lifecycle.js';

/** Negative scheduling evidence only; absence never resolves an obligation.
 * A solely unstable/incomplete result must not prevent a later complete retry.
 * A separately reported failed replay match is usable despite passive motion,
 * provided the captured control/context evidence has no critical omission.
 */
export function recoveryFailureCondition(o:Observation,conditionVersion:string,reason:string):RouteFailureCondition|undefined {
  if(o.gaps.some(gap=>gap.critical)||Object.values(o.context).some(value=>value.status!=='known'))return;
  const basis=o.stable?'complete-observation':reason==='replay_target_not_unique_or_missing'&&o.gaps.some(gap=>gap.code==='INTERACTION_STABLE')?'replay-target-unavailable':undefined;
  if(!basis)return;
  return {conditionVersion,evidence:{sessionId:o.sessionId,observationId:o.id},basis};
}
