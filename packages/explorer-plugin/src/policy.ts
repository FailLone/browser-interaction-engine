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
  if(action.kind==='scroll'&&!plan.some(i=>i.required&&i.scope.kind==='scroll'&&matches(i.scope,action,o))&&plan.some(i=>i.required&&!i.scope.label&&(!i.scope.url||i.scope.url===o.url)))return 'prerequisite';
  if(o.boundaries?.length&&action.boundary?.intent==='exit'&&!plan.some(i=>i.required&&i.scope.label&&i.scope.kind&&matches(i.scope,action,o)))return 'prerequisite';
  const explicit=plan.some(i=>i.required&&i.scope.label&&i.scope.kind&&i.status!=='excluded'&&matches(i.scope,action,o));
  if(!explicit&&plan.some(i=>!i.required&&['untested','excluded'].includes(i.status)&&matches(i.scope,action,o)))return;
  if(plan.some(i=>i.required&&i.status!=='excluded'&&matches(i.scope,action,o)))return 'target';
  if(plan.some(i=>i.required&&!['succeeded','excluded'].includes(i.status)&&i.prerequisites.some(p=>matches(p,action,o))))return 'prerequisite';
  if(o.boundaries?.length&&action.boundary?.intent==='exit')return 'prerequisite';
}
