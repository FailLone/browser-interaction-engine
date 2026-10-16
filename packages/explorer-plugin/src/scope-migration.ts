import type { Observation, ActionAttempt } from '@interaction/browser';
import type { EvidenceRef, ExplorerHost, Scope, Task } from './types.js';
import { scopeControlKey, scopeForControl, scopeFor, digest } from './policy.js';
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
  const wanted=new Set(scopes.flatMap(s=>s.stableKey&&!s.stableKey.startsWith('explorer:')?[s.stableKey]:[]));
  if(!wanted.size)return [];
  const refs:EvidenceRef[]=[...task.plan.flatMap(i=>[...i.evidence,...(i.resolvedBy?[i.resolvedBy]:[]),...i.attempts.flatMap(a=>a.evidence?[a.evidence]:[])]),...task.rounds.flatMap(r=>r.stack.map(f=>({sessionId:r.sessionId,observationId:f.observationId})))];
  // Session metadata identifies the current immutable observation without reading
  // the large document once here and again in the source pass below.
  for(const round of task.rounds) {
    try {const oid=host.session(round.sessionId).currentObservationId;if(oid)refs.push({sessionId:round.sessionId,observationId:oid});}catch{/* Missing evidence cannot authorize a migration. */}
    try {for(const a of host.list<ActionAttempt>(round.sessionId,'attempt'))refs.push({sessionId:round.sessionId,observationId:a.beforeId,attemptId:a.id});}catch{/* Retain unresolved scopes. */}
  }
  // Capture policy version + append-only wanted keys. A newly introduced key
  // rescans retained sources; a new source is always examined. Review decisions
  // do not modify these immutable captured control facts and confer no authority.
  let cache=task.scopeMigrationIndex;
  if(!cache||cache.version!==2)cache={version:2,keys:[],sources:{}};
  const known=new Set(cache.keys);
  for(const key of wanted)if(!known.has(key)){cache.keys.push(key);known.add(key);}
  const seen=new Set<string>(),index=new Map<string,{scope:Scope;key:string;ref:EvidenceRef}[]>();
  for(const ref of refs) {
    const id=`${ref.sessionId}:${ref.observationId}`;if(seen.has(id))continue;seen.add(id);
    let entry=cache.sources[id];
    if(!entry||entry.examinedKeys<cache.keys.length) {
      let o:Observation;try{o=host.observation(ref.sessionId,ref.observationId);}catch{continue;}
      if(o.id!==ref.observationId||o.sessionId!==ref.sessionId)continue;
      const newKeys=new Set(cache.keys.slice(entry?.examinedKeys||0)),matches=entry?.matches?[...entry.matches]:[];
      for(const c of o.controls) {
        if(!c.stableKey||!newKeys.has(c.stableKey)||!c.structuralItem?.recordKey)continue;
        const key=scopeControlKey(c)!,targetBinding=scopeForControl(c,o).targetBinding;
        for(const label of new Set([c.name,c.label]))matches.push({stableKey:c.stableKey,scope:{url:o.url,region:o.regions.find(r=>r.key===c.region)?.label,label,role:c.role,...targetBinding?{targetBinding}:{}},key});
      }
      entry={sessionId:o.sessionId,observationId:o.id,examinedKeys:cache.keys.length,matches};cache.sources[id]=entry;
    }
    // Keep every positive candidate, including contradictory ones. Incremental
    // migration must never turn formerly ambiguous evidence into a unique match.
    for(const match of entry.matches)if(wanted.has(match.stableKey)) {
      const entries=index.get(match.stableKey)||[];entries.push({scope:match.scope,key:match.key,ref});index.set(match.stableKey,entries);
    }
  }
  const changes:{before:Scope;after:Scope;evidence:EvidenceRef}[]=[];
  for(const scope of scopes) {
    if(!scope.stableKey)continue;
    const candidates=(index.get(scope.stableKey)||[]).filter(c=>Object.entries(scope).filter(([k])=>!['stableKey','kind','value'].includes(k)).every(([k,v])=>c.scope[k as keyof Scope]===v));
    if(new Set(candidates.map(c=>c.key)).size!==1)continue;
    const before={...scope};scope.stableKey=candidates[0].key;changes.push({before,after:{...scope},evidence:candidates[0].ref});
  }
  // Bound persisted metadata. Eviction costs a future read, never a missing
  // current candidate: the complete index above was used before trimming.
  for(const key of Object.keys(cache.sources).slice(0,Math.max(0,Object.keys(cache.sources).length-1024)))delete cache.sources[key];
  if(cache.keys.length<=512&&JSON.stringify(cache).length<=2*1024*1024)task.scopeMigrationIndex=cache;
  else delete task.scopeMigrationIndex;
  return changes;
}


/** Recover an observed source, never the unknown creation time, from exact peer
 * obligations. No full history scan and no name-only matching: a complete retained
 * observation must contain exactly one candidate with the entire recorded scope.
 */
export function recoverStoredScopeSources(task:Task,host:ExplorerHost) {
  const missing=new Map<string,Task['plan']>();
  for(const item of task.plan)if(item.dispatchScope===false&&item.reason==='observed_in_scope'&&!item.evidence.length&&item.scope.kind) {
    const key=digest(item.scope),items=missing.get(key)||[];items.push(item);missing.set(key,items);
  }
  if(!missing.size)return [];
  const observations=new Map<string,{ref:EvidenceRef;keys:Set<string>}>();
  for(const item of task.plan) {
    const key=digest(item.scope);if(!missing.has(key))continue;
    for(const ref of item.evidence) {
      const id=`${ref.sessionId}:${ref.observationId}`,entry=observations.get(id)||{ref:{sessionId:ref.sessionId,observationId:ref.observationId},keys:new Set<string>()};
      entry.keys.add(key);observations.set(id,entry);
    }
  }
  const changes:{itemId:string;evidence:EvidenceRef}[]=[];
  for(const {ref,keys} of observations.values()) {
    if(![...keys].some(key=>missing.has(key)))continue;
    try {
      const o=host.observation(ref.sessionId,ref.observationId);
      if(o.sessionId!==ref.sessionId||o.id!==ref.observationId||o.gaps.some(g=>g.critical))continue;
      const counts=new Map<string,number>();
      for(const action of host.actions(o.sessionId,o.id)) {
        if(action.sessionId!==o.sessionId||action.observationId!==o.id)continue;
        const key=digest(scopeFor(action,o));if(keys.has(key))counts.set(key,(counts.get(key)||0)+1);
      }
      for(const [key,count] of counts)if(count===1&&missing.has(key)) {
        for(const item of missing.get(key)!){item.evidence.push({...ref});changes.push({itemId:item.id,evidence:{...ref}});}
        missing.delete(key);
      }
    }catch{/* A missing retained observation cannot supply evidence. */}
  }
  return changes;
}
