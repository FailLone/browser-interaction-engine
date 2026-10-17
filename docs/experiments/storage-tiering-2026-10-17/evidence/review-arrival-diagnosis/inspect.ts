// Bounded offline read of a private byte copy. Never constructs an engine/store,
// opens the frozen SQLite database, launches a driver, or rewrites task records.
import { readFileSync, writeFileSync, copyFileSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { decodeStoredEntity } from '../../../../../packages/storage-sqlite/src/entity-codec.js';
import { ObservationObjectStore } from '../../../../../packages/storage-sqlite/src/observation-store.js';
import { observableCanonical } from '../../../../../packages/adapter-playwright/src/model.js';
import { classificationCorrespondenceConditions } from '../../../../../packages/adapter-playwright/src/classification-correspondence.js';
import { browserBranchConditions } from '../../../../../packages/adapter-playwright/src/branch-conditions.js';
import { controlScopeMatcher } from '../../../../../packages/explorer-plugin/src/policy.js';

const here=fileURLToPath(new URL('.',import.meta.url)),root=resolve(here,'../../../../..');
const require=createRequire(join(root,'packages/storage-sqlite/package.json')),Database=require('better-sqlite3');
const closure=JSON.parse(readFileSync(join(here,'../real-okx-14/closed-evidence.json'),'utf8'));
const source=join(closure.source,'engine/engine.sqlite'),hash=(data:any)=>createHash('sha256').update(data).digest('hex');
const fileHash=(path:string)=>hash(readFileSync(path)),originalHash=fileHash(source);
if(originalHash!==closure.sourceDatabase.sha256)throw Error('Frozen source changed');
const directory=mkdtempSync(join(tmpdir(),'bie-run14-replay-diagnosis-')),copy=join(directory,'engine.sqlite');
copyFileSync(source,copy);
if(statSync(source).ino===statSync(copy).ino||fileHash(copy)!==originalHash)throw Error('Copy is not independent');
let db:any;const report:any={source,sourceSha256:originalHash,engineConstructed:false,driverCalls:0,queries:0};
const equal=(a:any,b:any)=>JSON.stringify(a)===JSON.stringify(b);
const small=(value:any)=>JSON.stringify(value)?.length>1200?{sha256:hash(JSON.stringify(value)),bytes:JSON.stringify(value).length}:value;
const describe=(o:any)=>({id:o.id,url:o.url,capturedAt:o.capturedAt,ruleVersion:o.ruleVersion,stable:o.stable,context:o.context,boundaries:o.boundaries,
  controls:o.controls.length,canonicalSha256:hash(o.canonical),currentNormalizerMatches:o.canonical===observableCanonical(o),gaps:o.gaps});
function difference(before:any,after:any){
  const left=JSON.parse(before.canonical),right=JSON.parse(after.canonical);
  const fields=[...new Set([...Object.keys(left),...Object.keys(right)])].filter(k=>!equal(left[k],right[k]));
  const delta:any={before:describe(before),after:describe(after),differentRootFields:fields,rootChanges:{},controlFields:{},controls:[],unmatchedBefore:[],unmatchedAfter:[]};
  for(const key of fields.filter(k=>k!=='controls'))delta.rootChanges[key]={before:small(left[key]),after:small(right[key])};
  // Diagnostic alignment only; never used as identity/coverage/arrival evidence.
  const key=(c:any)=>JSON.stringify([c.stableKey,c.signature]);
  const group=(items:any[])=>{const map=new Map<string,any[]>();items.forEach((c,index)=>{const k=key(c);map.set(k,[...(map.get(k)||[]),{c,index}]);});return map;};
  const l=group(left.controls),r=group(right.controls);let matched=0;
  for(const [k,rows] of l){const others=r.get(k)||[];
    if(rows.length!==1||others.length!==1){delta.unmatchedBefore.push({key:k,count:rows.length,otherCount:others.length,indices:rows.map(v=>v.index)});continue;}
    matched++;const x=rows[0],y=others[0],changed=[...new Set([...Object.keys(x.c),...Object.keys(y.c)])].filter(f=>!equal(x.c[f],y.c[f]));
    for(const f of changed)delta.controlFields[f]=(delta.controlFields[f]||0)+1;
    if(changed.length||x.index!==y.index)delta.controls.push({key:k,beforeIndex:x.index,afterIndex:y.index,changes:Object.fromEntries(changed.map(f=>[f,{before:small(x.c[f]),after:small(y.c[f])}]))});
  }
  for(const [k,rows] of r)if(l.get(k)?.length!==1||rows.length!==1)delta.unmatchedAfter.push({key:k,count:rows.length,otherCount:l.get(k)?.length||0,indices:rows.map(v=>v.index)});
  delta.uniquePairs=matched;delta.beforeCount=left.controls.length;delta.afterCount=right.controls.length;
  return delta;
}
try{
  db=new Database(copy,{readonly:true,fileMustExist:true});db.pragma('query_only = ON');
  const objects=new ObservationObjectStore(db,()=>{throw Error('Unexpected write');});
  const query=db.prepare('SELECT kind,id,session_id,json,compressed_json FROM entities WHERE kind=? AND id=?');
  const cache=new Map<string,any>();
  const get=(kind:string,id:string)=>{const k=kind+':'+id;if(cache.has(k))return cache.get(k);if(++report.queries>32)throw Error('Read budget exceeded');const row=query.get(kind,id);if(!row)throw Error('Missing selected row '+k);const value=decodeStoredEntity<any>(row,objects.resolve);cache.set(k,value);return value;};
  db.transaction(()=>{objects.begin(false);
    try{
      const cp=get('checkpoint','b06556a8-969d-433a-a85e-69e5d1be0d94');report.checkpoint=cp;
      const current=get('observation','9bfa2b3d-54b6-41a8-bdad-6027f0677fdb');
      const expectedSource=get('observation','b0381d61-11e9-451a-9d0c-7859f4dcc8cc');
      const attempts=['296989a0-3a37-4ea3-9ffe-a057b6f31081','2ce5afcf-24a5-460e-8e30-f0974cdc77b8','3a4f30c3-c6b5-4e0c-b06a-a2b8b1c8f76e'].map(id=>get('attempt',id));
      const last=attempts.at(-1),old=get('attempt',last.recoverySegment.recordedAttemptId);
      const concise=(a:any)=>({id:a.id,status:a.status,purpose:a.purpose,beforeId:a.beforeId,afterId:a.afterId,action:{kind:a.action.kind,label:a.action.label,value:a.action.value,controlId:a.action.controlId,localId:a.action.localId,replayable:a.action.replayable,preconditions:a.action.preconditions},recoverySegment:a.recoverySegment});
      report.attempts=attempts.map(concise);report.recordedAttempt=concise(old);
      const expected=get('observation',old.afterId),actual=get('observation',last.afterId),beforeOld=get('observation',old.beforeId),beforeActual=get('observation',last.beforeId);
      report.strictComparedStates=difference(expected,actual);
      report.checkOperation={oldBefore:beforeOld.controls.filter((c:any)=>c.localId===old.action.localId),oldAfter:expected.controls.filter((c:any)=>c.identityId===old.action.controlId),newBefore:beforeActual.controls.filter((c:any)=>c.localId===last.action.localId),newAfter:actual.controls.filter((c:any)=>c.identityId===last.action.controlId)};
      report.checkOperation=Object.fromEntries(Object.entries(report.checkOperation).map(([k,controls]:any)=>[k,controls.map((c:any)=>({localId:c.localId,instanceId:c.instanceId,identityId:c.identityId,tag:c.tag,role:c.role,name:c.name,value:c.value,checked:c.checked,visible:c.visible,enabled:c.enabled}))]));
      const task=JSON.parse(readFileSync(join(closure.runDirectory,'task-before.json'),'utf8')),item=task.plan.find((i:any)=>i.id==='92e78cad-25e8-495e-a317-6194ec309298');report.targetScope=item.scope;
      report.reviewTargetSamples=[expectedSource,current,...attempts.map(a=>get('observation',a.afterId))].map(o=>{
        const exact=controlScopeMatcher(o,[]),controls=o.controls.filter((c:any)=>exact(item.scope,c));
        const summary=(c:any)=>{const classification=classificationCorrespondenceConditions(c,o),branches=browserBranchConditions({localId:c.localId,kind:'click'},o);return {localId:c.localId,instanceId:c.instanceId,identityId:c.identityId,hypothesisId:c.hypothesisId,tag:c.tag,role:c.role,name:c.name,stableKey:c.stableKey,visible:c.visible,enabled:c.enabled,readiness:c.readiness,active:!o.boundaries?.length||!!o.overlays?.find((b:any)=>b.key===o.boundaries.at(-1).key)?.controlIds.includes(c.localId),classification,branches,classificationBindingComplete:c.classificationBinding?.truncated===false};};
        return {observation:describe(o),exactScopeCandidates:controls.map(summary),sameNameCandidates:o.controls.filter((c:any)=>c.name==='USD').map(summary)};
      });
      report.sourceVersusPostClose=difference(expectedSource,get('observation',attempts[0].afterId));
      report.sqlChanges=db.prepare('SELECT total_changes() AS n').get().n;
    }finally{objects.end(false);}
  })();
  db.close();db=undefined;
  report.copyUnchanged=fileHash(copy)===originalHash;report.sourceUnchanged=fileHash(source)===originalHash;
  if(!report.copyUnchanged||!report.sourceUnchanged||report.sqlChanges!==0)throw Error('Read-only audit invariant failed');
}finally{db?.close();rmSync(directory,{recursive:true,force:true});report.temporaryCopyRemoved=true;}
report.passed=true;
writeFileSync(join(here,'frozen-state-differences.json'),JSON.stringify(report,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({passed:report.passed,queries:report.queries,copyUnchanged:report.copyUnchanged,sourceUnchanged:report.sourceUnchanged,temporaryCopyRemoved:report.temporaryCopyRemoved,
  checkpoint:{observationId:report.checkpoint.observationId,path:report.checkpoint.path},recordedAttempt:report.recordedAttempt,
  comparison:{rootFields:report.strictComparedStates.differentRootFields,beforeControls:report.strictComparedStates.beforeCount,afterControls:report.strictComparedStates.afterCount,matched:report.strictComparedStates.uniquePairs,fields:report.strictComparedStates.controlFields,unmatchedBefore:report.strictComparedStates.unmatchedBefore.length,unmatchedAfter:report.strictComparedStates.unmatchedAfter.length},
  targets:report.reviewTargetSamples.map((r:any)=>({observationId:r.observation.id,boundaries:r.observation.boundaries,exact:r.exactScopeCandidates.map((c:any)=>({localId:c.localId,visible:c.visible,active:c.active,classification:c.classification,branchesAvailable:!!c.branches})),sameNames:r.sameNameCandidates.length}))}));
