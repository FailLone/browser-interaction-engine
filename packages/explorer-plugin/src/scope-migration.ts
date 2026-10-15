import type { Observation, ActionAttempt } from '@interaction/browser';
import type { EvidenceRef, ExplorerHost, Scope, Task } from './types.js';
import { scopeControlKey } from './policy.js';

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
