import { createHash } from 'node:crypto';
import { browserControlCorrespondence, browserOperationKey, navigationIntent, type ActionAvailability, type ActionCandidate, type Observation } from '@interaction/browser';
import type { Scope, PlanItem } from './types.js';
const ordered=(value:unknown):unknown=>Array.isArray(value)?value.map(ordered):value&&typeof value==='object'?Object.fromEntries(Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>[k,ordered(v)])):value;
export const digest=(value:unknown)=>createHash('sha256').update(JSON.stringify(ordered(value))).digest('hex');
/** Task policy consumes host semantics; these opaque keys retain old task compatibility. */
export const navigationTarget=(a:ActionCandidate,o:Observation)=>navigationIntent(a,o)?.targetUrl;
export const scopeControlKey=(c:Observation['controls'][number])=>browserControlCorrespondence(c)?.key;
function actionScope(action:ActionCandidate,o:Observation):Scope {
  const c=o.controls.find(c=>c.localId===action.localId),r=o.regions.find(r=>r.key===c?.region);
  const key=c&&scopeControlKey(c);
  return {url:o.url,...(r?{region:r.label}:{}),label:action.label,...(c?{role:c.role, ...(key?{stableKey:key}:{})}:{}),kind:action.kind,...(['string','boolean','number'].includes(typeof action.value)?{value:action.value as string|boolean|number}:{})};
}
export function scopeFor(action:ActionCandidate,o:Observation):Scope {return actionScope(action,o);}
/** Review gaps bind to the observed control, including controls without an explicit label or an action yet. */
export function scopeForControl(c:Observation['controls'][number],o:Observation):Scope {
  const label=c.name||c.label,region=o.regions.find(r=>r.key===c.region)?.label,stableKey=scopeControlKey(c);
  return {url:o.url,...(region?{region}:{}),...(label?{label}:{}),...(c.role?{role:c.role}:{}),...(stableKey?{stableKey}:{})};
}
/** Model-only view: retain equality hints without repeated document/DOM fingerprints. */
export function decisionScope(scope:Scope):Scope {return {...scope,...(scope.stableKey?{stableKey:`sha256:${digest(scope.stableKey)}`}:{})};}
/** Accepted authority and exclusions are relevant to selection; the growing evidence ledger is not. */
export function decisionPlan(plan:PlanItem[]) {
  return plan.filter(i=>(i.required&&i.dispatchScope===true)||i.reason==='user_excluded').map(i=>({title:i.title,scope:decisionScope(i.scope),prerequisites:i.prerequisites.map(decisionScope),required:i.required}));
}
export function matches(scope:Scope,action:ActionCandidate,o:Observation) {
  const actual=scopeFor(action,o);
  return Object.entries(scope).every(([key,value])=>JSON.stringify(actual[key as keyof Scope])===JSON.stringify(value));
}
/** Only page/region scopes imply discovery navigation; an unnamed operation is still bounded. */
export const broadScope=(scope:Scope)=>!scope.label&&!scope.role&&!scope.stableKey&&!scope.kind&&scope.value===undefined;
export function controlInScope(scope:Scope,control:Observation['controls'][number],o:Observation,actions:ActionCandidate[]) {
  if(actions.some(a=>a.localId===control.localId&&matches(scope,a,o)))return true;
  // A named target may need classification before candidates exist. An operation-only
  // target must bind to a real candidate; dropping kind/value would match the entire page.
  if((scope.kind||scope.value!==undefined)&&!scope.label&&!scope.stableKey)return false;
  const actual:Scope={url:o.url,region:o.regions.find(r=>r.key===control.region)?.label,label:control.name||control.label,role:control.role,stableKey:scopeControlKey(control)};
  return Object.entries(scope).filter(([key])=>!['kind','value'].includes(key)).every(([key,value])=>actual[key as keyof Scope]===value);
}
export const keyFor=browserOperationKey;
export function permitted(action:ActionCandidate,o:Observation,availability:ActionAvailability) {
  return availability.observationId===o.id&&action.observationId===o.id&&availability.actions.some(a=>a.actionId===action.id&&a.executable);
}
export function includesScope(plan:PlanItem[],action:ActionCandidate,o:Observation):'target'|'prerequisite'|undefined {
  if(plan.some(i=>!i.required&&i.reason==='user_excluded'&&matches(i.scope,action,o)))return;
  const allowed=plan.filter(i=>i.required&&i.dispatchScope===true&&i.status!=='excluded');
  if(action.kind==='scroll'&&!allowed.some(i=>i.scope.kind==='scroll'&&matches(i.scope,action,o))&&allowed.some(i=>broadScope(i.scope)&&(!i.scope.url||i.scope.url===o.url)))return 'prerequisite';
  if(o.boundaries?.length&&action.boundary?.intent==='exit'&&!allowed.some(i=>i.scope.label&&i.scope.kind&&matches(i.scope,action,o)))return 'prerequisite';
  const explicit=allowed.some(i=>i.scope.label&&i.scope.kind&&matches(i.scope,action,o));
  if(!explicit&&plan.some(i=>!i.required&&['untested','excluded'].includes(i.status)&&matches(i.scope,action,o)))return;
  if(allowed.some(i=>matches(i.scope,action,o)))return 'target';
  if(allowed.some(i=>i.status!=='succeeded'&&i.prerequisites.some(p=>matches(p,action,o))))return 'prerequisite';
  if(o.boundaries?.length&&action.boundary?.intent==='exit')return 'prerequisite';
}
