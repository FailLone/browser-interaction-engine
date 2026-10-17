// Pure recorded-evidence check. Run from the worktree with Node 24,
// --conditions=development --import tsx; arguments: --cache decoded.json output.json
// or --database /absolute/path/to/owned/engine.sqlite output.json (read-only).
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { performance } from 'node:perf_hooks';
import assert from 'node:assert/strict';
import { decodeStoredEntity } from '../../../../../packages/storage-sqlite/src/entity-codec.ts';
import { modeStructureReader } from '../../../../../packages/adapter-playwright/src/mode-structure.ts';
import { assessBrowserReviewBranchConditions } from '../../../../../packages/adapter-playwright/src/branch-conditions.ts';
import { createBrowserControlReviewTargetCorrespondenceReader } from '../../../../../packages/adapter-playwright/src/review-target.ts';
const [kind,input,output]=process.argv.slice(2);
assert.ok(['--cache','--database'].includes(kind)&&input&&output,'Explicit input and new output paths required');
const ids=['d7da102e-f331-47c6-bec5-96a33ce9cb20','da11249a-1e18-41cc-b9ff-f1d2d6ca6323'];
const digest=(value:any)=>createHash('sha256').update(typeof value==='string'||Buffer.isBuffer(value)?value:JSON.stringify(value)).digest('hex');
const counts={entities:0,objects:0,packs:0};
async function observations(){
  if(kind==='--cache')return JSON.parse(readFileSync(input,'utf8'));
  const {DatabaseSync}=await import('node:sqlite'),db=new DatabaseSync(input,{readOnly:true});
  try{
    const resolve=(keys:readonly number[],sid:string)=>{
      const objects=db.prepare('SELECT * FROM observation_objects WHERE session_id=? AND id IN (SELECT value FROM json_each(?))').all(sid,JSON.stringify(keys)) as any[];
      const packs=db.prepare('SELECT * FROM observation_packs WHERE session_id=? AND id IN (SELECT value FROM json_each(?))').all(sid,JSON.stringify([...new Set(objects.map(o=>o.pack_id))])) as any[];
      counts.objects+=objects.length;counts.packs+=packs.length;
      const unpacked=new Map(packs.map(p=>{const data=p.codec==='gzip'?gunzipSync(p.data,{maxOutputLength:p.bytes}):Buffer.from(p.data);assert.equal(data.length,p.bytes);assert.equal(digest(data),Buffer.from(p.sha256).toString('hex'));return[p.id,data];}));
      return new Map(objects.map(o=>{const data=unpacked.get(o.pack_id)!.subarray(o.byte_offset,o.byte_offset+o.bytes);assert.equal(data.length,o.bytes);assert.equal(digest(data),Buffer.from(o.sha256).toString('hex'));return[o.id,data];}));
    };
    const load=(id:string)=>{counts.entities++;return decodeStoredEntity<any>(db.prepare('SELECT kind,id,session_id,json,compressed_json FROM entities WHERE id=? AND kind=?').get(id,'observation') as any,resolve);};
    return {source:load(ids[0]),current:load(ids[1])};
  }finally{db.close();}
}
const started=performance.now(),{source,current}=await observations(),loaded=performance.now();
assert.deepEqual([source.id,current.id],ids);
const original=[digest(source),digest(current)];
const target=(o:any)=>o.controls.find((c:any)=>c.stableKey==='testid:okd-dialog-window');
const menus=(o:any)=>o.controls.filter((c:any)=>c.name==='Open sub-menu');
const project=(o:any)=>{
  const read=modeStructureReader(o),branch=assessBrowserReviewBranchConditions(target(o),o);
  return {id:o.id,controls:o.controls.length,modeCount:branch.conditions?.conditions.length,policy:branch.conditions?.policy,key:branch.conditions?.key,
    menus:menus(o).map((c:any)=>({localId:c.localId,reference:read(c),identityStillUnresolved:!!c.hypothesisId}))};
};
const projected=[project(source),project(current)],projectedAt=performance.now();
for(const p of projected){
  assert.equal(p.modeCount,27);assert.equal(p.policy,'browser-branch-conditions-v3');assert.equal(p.menus.length,2);
  assert.ok(p.menus.every((m:any)=>m.reference&&m.identityStillUnresolved));
  assert.notEqual(p.menus[0].reference.key,p.menus[1].reference.key);
}
assert.deepEqual(projected[0].menus.map((m:any)=>m.reference.key),projected[1].menus.map((m:any)=>m.reference.key));
assert.equal(projected[0].key,projected[1].key);
const compare=(after:any)=>createBrowserControlReviewTargetCorrespondenceReader(source,after)(target(source),target(after));
const proof=compare(current),provedAt=performance.now();
const baselinePath='docs/experiments/storage-tiering-2026-10-17/evidence/real-okx-15/offline-source-audit/diagnosis.json';
const baseline=JSON.parse(readFileSync(baselinePath,'utf8')).proof;
assert.equal(baseline.sourceEquivalent,'unknown');assert.equal(proof.sourceEquivalent,'equivalent');
assert.equal(proof.currentMaterialKey,baseline.currentMaterialKey);assert.equal(proof.targetMatched,true);assert.equal(proof.reviewable,true);
const changed=structuredClone(current),changedMode=menus(changed)[0];changedMode.expanded=!changedMode.expanded;
for(const c of changed.controls)for(const n of c.classificationBinding?.nodes||[])if(n.instanceId===changedMode.instanceId)n.attributes['aria-expanded']=String(changedMode.expanded);
assert.equal(compare(changed).sourceEquivalent,'different');
const incomplete=structuredClone(current),modeId=menus(incomplete)[0].instanceId;
for(const c of incomplete.controls)if(c.classificationBinding?.nodes.some((n:any)=>n.instanceId===modeId))c.classificationBinding.truncated=true;
assert.equal(compare(incomplete).sourceEquivalent,'unknown');
const passive=structuredClone(current);
for(const c of passive.controls)if(c.classificationBinding?.nodes.some((n:any)=>n.instanceId===modeId))c.classificationBinding.text+=' $99999.99';
assert.equal(compare(passive).sourceEquivalent,'equivalent');
assert.deepEqual([digest(source),digest(current)],original);
const negativeAt=performance.now();
const result={baseline:baselinePath,input:{kind,sourceObservationIds:ids,sha256:original,databaseRowsRead:counts},observations:projected,
  before:{sourceEquivalent:baseline.sourceEquivalent},after:proof,
  assertions:{distinctHiddenModes:true,portableAcrossRecordedDocuments:true,all27ModeStatesRetained:true,
    changedHiddenModeRejected:true,incompleteContainingTreesUnknown:true,passiveOwnerTextDoesNotRenameMode:true,
    originalMaterialKeyUnchanged:true,identityHypothesesRetained:true,sourceSnapshotsUnmodified:true},
  milliseconds:{load:loaded-started,projectTwoObservations:projectedAt-loaded,correspondence:provedAt-projectedAt,negativeChecks:negativeAt-provedAt},
  scope:'Same saved OKX observations plus explicit counterexamples; no browser or live arrival, no scheduler/provider calls, no writable database. Timings are diagnostic only; no live performance or recovery-rate claim.'};
writeFileSync(output,JSON.stringify(result,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({assertions:result.assertions,milliseconds:result.milliseconds,databaseRowsRead:counts}));
