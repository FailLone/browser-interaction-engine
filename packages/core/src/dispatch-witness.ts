import {hash} from './util.js';
import type {ActionAttempt,Observation} from './types.js';
/** A returned driver call is necessary evidence, never sufficient completion.
 * Unknown outcomes, post-observation checks and authority are checked separately. */
export function dispatchWitnessMatches(attempt:ActionAttempt,before:Observation,after?:Observation):boolean {
 const w=attempt.dispatchWitness,a=attempt.action,c=before.controls.filter(c=>c.localId===a.localId);
 return !!w&&w.version==='driver-return-v1'&&w.beforeId===before.id&&w.actionKey===hash(a)
   &&w.instanceScope===before.instanceScope&&w.instanceId===(c.length===1?c[0].instanceId:undefined)
   &&(!a.localId||c.length===1)&&Number.isFinite(Date.parse(w.returnedAt))&&Date.parse(w.returnedAt)>=Date.parse(attempt.startedAt)&&(!after||Date.parse(w.returnedAt)<=Date.parse(after.capturedAt));
}
