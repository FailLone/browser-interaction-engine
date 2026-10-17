import type {ActionCandidate,Observation} from '@interaction/browser';
import type {PlanItem} from './types.js';
import {isUnfinished,schedulableObligation} from './plan-state.js';
import {projectObligations,type ObligationEntry} from './obligation-lifecycle.js';

/** Reuse the SDK-backed ledger projection for one selected child. A persisted
 * selection is only a hint: each read derives its current target afresh, with
 * no scope rewrite, historical grant or cross-observation positive cache. */
export function currentObligationTarget(host:Parameters<typeof projectObligations>[0],item:PlanItem|undefined,o:Observation,actions:ActionCandidate[]):ObligationEntry|undefined {
  if(!item?.required||!isUnfinished(item)||!schedulableObligation(item)||!item.scope.kind
    ||item.attempts.some(a=>['unknown','executing'].includes(a.outcome)))return;
  const entry=projectObligations(host,{plan:[item]},o,actions).projection.entries[0];
  if(entry?.state!=='active'||!entry.currentActionId||actions.filter(a=>a.id===entry.currentActionId&&a.sessionId===o.sessionId&&a.observationId===o.id).length!==1)return;
  return entry;
}
