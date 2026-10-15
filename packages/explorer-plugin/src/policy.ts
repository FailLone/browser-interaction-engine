import { createHash } from 'node:crypto';
import type { ActionCandidate, Observation, ExplorationGroup, FrontierItemView } from '@interaction/browser';
import type { Scope, PlanItem } from './types.js';
const ordered=(value:unknown):unknown=>Array.isArray(value)?value.map(ordered):value&&typeof value==='object'?Object.fromEntries(Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>[k,ordered(v)])):value;
export const digest=(value:unknown)=>createHash('sha256').update(JSON.stringify(ordered(value))).digest('hex');
export function scopeFor(action:ActionCandidate,o:Observation):Scope {
  const c=o.controls.find(c=>c.localId===action.localId),r=o.regions.find(r=>r.key===c?.region);
  return {url:o.url,...(r?{region:r.label}:{}),label:action.label,...(c?{role:c.role, ...(c.stableKey?{stableKey:c.stableKey}:{})}:{}),kind:action.kind,...(['string','boolean','number'].includes(typeof action.value)?{value:action.value as string|boolean|number}:{})};
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
  const actual:Scope={url:o.url,region:o.regions.find(r=>r.key===control.region)?.label,label:control.name||control.label,role:control.role,stableKey:control.stableKey};
  return Object.entries(scope).filter(([key])=>!['kind','value'].includes(key)).every(([key,value])=>actual[key as keyof Scope]===value);
}
export function keyFor(action:ActionCandidate,o:Observation){return digest({scope:scopeFor(action,o),context:o.context,...(action.kind==='scroll'?{position:action.value}:{})});}
export function permitted(action:ActionCandidate,o:Observation,groups:ExplorationGroup[],frontier:FrontierItemView[]) {
  if(o.gaps.some(g=>g.critical))return false;
  if(action.excluded || action.basis?.status!=='supported' || action.risk!=='interface' || action.preconditions.blockers?.length || !action.preconditions.visible || !action.preconditions.enabled || !(action.preconditions.targetResolved??action.preconditions.identityResolved))return false;
  const boundary=o.boundaries?.at(-1);if(boundary&&action.boundary?.key!==boundary.key)return false;
  const f=frontier.find(f=>f.action.id===action.id);
  if(f && ['unknown','executing','blocked','deferred','skipped','needs_revalidation'].includes(f.status))return false;
  for(const ref of f?.explorationGroups || []) {
    const g=groups.find(g=>g.id===ref.groupId && g.status!=='invalidated');const d=g?.decisions.at(-1);
    if(!g || !d || g.status!=='decided' || ['defer','skip'].includes(d.decision.mode))return false;
    if(d.decision.mode==='sample' && ref.memberKey && !d.decision.memberKeys.includes(ref.memberKey))return false;
  }
  return true;
}
export function includesScope(plan:PlanItem[],action:ActionCandidate,o:Observation):'target'|'prerequisite'|undefined {
  const allowed=plan.filter(i=>i.required&&i.dispatchScope===true&&i.status!=='excluded');
  if(action.kind==='scroll'&&!allowed.some(i=>i.scope.kind==='scroll'&&matches(i.scope,action,o))&&allowed.some(i=>broadScope(i.scope)&&(!i.scope.url||i.scope.url===o.url)))return 'prerequisite';
  if(o.boundaries?.length&&action.boundary?.intent==='exit'&&!allowed.some(i=>i.scope.label&&i.scope.kind&&matches(i.scope,action,o)))return 'prerequisite';
  const explicit=allowed.some(i=>i.scope.label&&i.scope.kind&&matches(i.scope,action,o));
  if(!explicit&&plan.some(i=>!i.required&&['untested','excluded'].includes(i.status)&&matches(i.scope,action,o)))return;
  if(allowed.some(i=>matches(i.scope,action,o)))return 'target';
  if(allowed.some(i=>i.status!=='succeeded'&&i.prerequisites.some(p=>matches(p,action,o))))return 'prerequisite';
  if(o.boundaries?.length&&action.boundary?.intent==='exit')return 'prerequisite';
}
