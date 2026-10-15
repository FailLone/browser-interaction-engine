import type { Observation, ActionAttempt } from '@interaction/browser';
import type { EvidenceRef, ExplorerHost, Scope, Task } from './types.js';
import { scopeControlKey, scopeForControl, digest } from './policy.js';
import { controlReviewGapReasons } from './review-ledger.js';

/** An old empty-label gap can be narrowed only if every original source names one identical target. */
export function remapStoredReviewScopes(task:Task,host:ExplorerHost) {
  const changes:{itemId:string;before:Scope;after:Scope;evidence:EvidenceRef[]}[]=[];
  const cache=new Map<string,Observation|undefined>();
  for(const item of task.plan.filter(i=>i.dispatchScope===false&&controlReviewGapReasons.has(i.reason)&&i.scope.label===''&&!i.scope.stableKey&&!i.scope.kind&&i.scope.value===undefined&&i.evidence.length)) {
    const mapped:Scope[]=[];
    for(const ref of item.evidence) {
      const key=`${ref.sessionId}:${ref.observationId}`;
      if(!cache.has(key)){try{cache.set(key,host.observation(ref.sessionId,ref.observationId));}catch{cache.set(key,undefined);}}
      const o=cache.get(key);if(!o){mapped.length=0;break;}
      const candidates=o.controls.filter(c=>c.visible&&Object.entries(item.scope).every(([k,v])=>({url:o.url,region:o.regions.find(r=>r.key===c.region)?.label,label:c.label,role:c.role})[k as 'url'|'region'|'label'|'role']===v));
      if(candidates.length!==1){mapped.length=0;break;}
      const scope=scopeForControl(candidates[0],o);if(!scope.stableKey){mapped.length=0;break;}mapped.push(scope);
    }
    if(!mapped.length||new Set(mapped.map(digest)).size!==1)continue;
    const before={...item.scope};item.scope=mapped[0];changes.push({itemId:item.id,before,after:{...item.scope},evidence:item.evidence});
  }
  return changes;
}

/** Upgrade saved matching hints only when the original public evidence proves their source. */
export function remapStoredScopes(task:Task,host:ExplorerHost) {
  const scopes=[...task.plan.flatMap(i=>[i.scope,...i.prerequisites]),...task.rounds.flatMap(r=>[...r.entryPath,...r.stack.flatMap(f=>[...f.path,...f.remaining])]),...(task.intent?.mode==='exhaustive'?task.intent.exclusions.map(e=>e.scope):[])];
  const wanted=new Set(scopes.flatMap(s=>s.stableKey&&!s.stableKey.startsWith('explorer:record:v1:')?[s.stableKey]:[]));
  if(!wanted.size)return [];
  const refs:EvidenceRef[]=[...task.plan.flatMap(i=>[...i.evidence,...(i.resolvedBy?[i.resolvedBy]:[]),...i.attempts.flatMap(a=>a.evidence?[a.evidence]:[])]),...task.rounds.flatMap(r=>r.stack.map(f=>({sessionId:r.sessionId,observationId:f.observationId})))];
  // An attempt's after-observation may no longer contain the source control.
  for(const round of task.rounds) {
    try {refs.push({sessionId:round.sessionId,observationId:host.observation(round.sessionId).id});}catch{/* Missing evidence cannot authorize a migration. */}
    try {for(const a of host.list<ActionAttempt>(round.sessionId,'attempt'))refs.push({sessionId:round.sessionId,observationId:a.beforeId,attemptId:a.id});}catch{/* Retain unresolved scopes. */}
  }
  const seen=new Set<string>(),index=new Map<string,{scope:Scope;key:string;ref:EvidenceRef}[]>();
  for(const ref of refs) {
    const id=`${ref.sessionId}:${ref.observationId}`;if(seen.has(id))continue;seen.add(id);
    let o:Observation;try{o=host.observation(ref.sessionId,ref.observationId);}catch{continue;}
    for(const c of o.controls) {
      if(!c.stableKey||!wanted.has(c.stableKey)||!c.structuralItem?.recordKey)continue;
      const key=scopeControlKey(c)!;
      const entries=index.get(c.stableKey)||[];
      for(const label of new Set([c.name,c.label]))entries.push({scope:{url:o.url,region:o.regions.find(r=>r.key===c.region)?.label,label,role:c.role},key,ref});
      index.set(c.stableKey,entries);
    }
  }
  const changes:{before:Scope;after:Scope;evidence:EvidenceRef}[]=[];
  for(const scope of scopes) {
    if(!scope.stableKey)continue;
    const candidates=(index.get(scope.stableKey)||[]).filter(c=>Object.entries(scope).filter(([k])=>!['stableKey','kind','value'].includes(k)).every(([k,v])=>c.scope[k as keyof Scope]===v));
    if(new Set(candidates.map(c=>c.key)).size!==1)continue;
    const before={...scope};scope.stableKey=candidates[0].key;changes.push({before,after:{...scope},evidence:candidates[0].ref});
  }
  return changes;
}
