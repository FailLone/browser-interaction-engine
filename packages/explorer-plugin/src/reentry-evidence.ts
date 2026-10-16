import type {Observation} from '@interaction/browser';
import type {EntryRoute,Scope,Task} from './types.js';
import {digest,scopeForControl} from './policy.js';

// Review-assigned region labels may change without moving an occurrence. This
// projection is route evidence only, never scope permission or identity approval.
export function routeControl(scope:Scope):Scope {
  const {url,label,role,stableKey}=scope;
  return {url,...label?{label}:{},...role?{role}:{},...stableKey?{stableKey}:{}};
}
export function routeMatches(expected:Scope,actual:Scope) {
  const target=routeControl(expected),candidate=routeControl(actual);
  return !!(target.label||target.stableKey)&&Object.entries(target).every(([k,v])=>candidate[k as keyof Scope]===v);
}
export function capturedRoute(entry:Scope,before:Observation,after:Observation,revealedIds:string[]):EntryRoute|undefined {
  if(before.sessionId!==after.sessionId||before.gaps.some(g=>g.critical)||after.gaps.some(g=>g.critical)||digest(before.context)!==digest(after.context)
    ||Object.values(before.context).some(c=>c.status!=='known')||Object.values(after.context).some(c=>c.status!=='known'))return;
  if(before.controls.filter(c=>routeMatches(entry,scopeForControl(c,before))).length!==1)return;
  const revealed=new Set(revealedIds),targets=after.controls.filter(c=>revealed.has(c.localId)&&c.visible).flatMap(c=>{
    const scope=routeControl(scopeForControl(c,after));
    if(!(scope.label||scope.stableKey)||after.controls.filter(other=>routeMatches(scope,scopeForControl(other,after))).length!==1)return [];
    return [scope];
  });
  if(!targets.length)return;
  return {entry,targets,context:digest(after.context),evidence:{sessionId:after.sessionId,beforeId:before.id,observationId:after.id}};
}
/** Prove a chain of actually observed reveals. Stored prerequisite prose alone
 * cannot justify replay; repeated cycles cannot manufacture a route. */
export function routeFinder(task:Task,entry:Scope,o:Pick<Observation,'context'>) {
  const context=digest(o.context),routes=task.rounds.flatMap(r=>r.entryRoutes||[]).filter(r=>r.context===context);
  let reachable:{scope:Scope;proof:EntryRoute[]}[]|undefined;
  return (target:Scope):EntryRoute[]|undefined=>{
    if(!(target.label||target.stableKey))return;
    if(!reachable){
      reachable=[];
      const queue:{scope:Scope;proof:EntryRoute[]}[]=[{scope:entry,proof:[]}],seen=new Set<string>();
      for(let index=0;index<queue.length;index++){
        const node=queue[index],key=digest(node.scope);if(seen.has(key))continue;seen.add(key);
        for(const route of routes.filter(r=>routeMatches(r.entry,node.scope)&&(!node.scope.kind||r.entry.region===node.scope.region)&&(!node.scope.kind||r.entry.kind===node.scope.kind)&&(node.scope.value===undefined||r.entry.value===node.scope.value))){
          const proof=[...node.proof,route];
          for(const child of route.targets){const next={scope:child,proof};reachable.push(next);queue.push(next);}
        }
      }
    }
    return reachable.find(r=>routeMatches(target,r.scope))?.proof;
  };
}
export function routeToTarget(task:Task,entry:Scope,target:Scope,o:Pick<Observation,'context'>):EntryRoute[]|undefined {
  return routeFinder(task,entry,o)(target);
}
