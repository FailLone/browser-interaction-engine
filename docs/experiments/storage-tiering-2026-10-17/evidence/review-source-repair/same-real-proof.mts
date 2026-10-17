import { DatabaseSync } from 'node:sqlite';
import { gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { writeFileSync, readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { decodeStoredEntity } from '/Users/xietian/.codex/worktrees/exploration-layered-refactor/browser-interaction-engine/packages/storage-sqlite/src/entity-codec.ts';
import { browserControlReviewTargetCorrespondence } from '/Users/xietian/.codex/worktrees/exploration-layered-refactor/browser-interaction-engine/packages/adapter-playwright/src/review-target.ts';
const root='/Users/xietian/.codex/worktrees/exploration-layered-refactor/browser-interaction-engine';
const path=root+'/.data/okx-storage-acceptance-20261017-v8/engine/engine.sqlite';
const db=new DatabaseSync(path,{readOnly:true});const counts={entities:0,objects:0,packs:0};
const digest=(b:any)=>createHash('sha256').update(b).digest('hex');
const resolve=(ids:readonly number[],sid:string)=>{
 const objects=db.prepare('SELECT * FROM observation_objects WHERE session_id=? AND id IN (SELECT value FROM json_each(?))').all(sid,JSON.stringify(ids));
 const packs=db.prepare('SELECT * FROM observation_packs WHERE session_id=? AND id IN (SELECT value FROM json_each(?))').all(sid,JSON.stringify([...new Set(objects.map((o:any)=>o.pack_id))]));counts.objects+=objects.length;counts.packs+=packs.length;
 const map=new Map(packs.map((p:any)=>{const data=p.codec==='gzip'?gunzipSync(p.data,{maxOutputLength:p.bytes}):p.data;if(data.length!==p.bytes||digest(data)!==Buffer.from(p.sha256).toString('hex'))throw Error('bad pack');return [p.id,data]}));
 return new Map(objects.map((o:any)=>{const part=map.get(o.pack_id)!.subarray(o.byte_offset,o.byte_offset+o.bytes);if(part.length!==o.bytes||digest(part)!==Buffer.from(o.sha256).toString('hex'))throw Error('bad object');return[o.id,part]}));
};
const load=(id:string)=>{const row=db.prepare('SELECT kind,id,session_id,json,compressed_json FROM entities WHERE id=? AND kind=?').get(id,'observation');counts.entities++;return decodeStoredEntity<any>(row as any,resolve as any)};
const source=load('d7da102e-f331-47c6-bec5-96a33ce9cb20'),current=load('da11249a-1e18-41cc-b9ff-f1d2d6ca6323');
const target=(o:any)=>o.controls.find((c:any)=>c.stableKey==='testid:okd-dialog-window');
// Reuse the two immutable observations; no browser, engine or writable store.
const oldEvidence='docs/experiments/storage-tiering-2026-10-17/evidence/real-okx-15/offline-source-audit/diagnosis.json';
const old=JSON.parse(readFileSync(root+'/'+oldEvidence,'utf8'));
const proof=browserControlReviewTargetCorrespondence(target(source),source,target(current),current);
const sourceSelf=browserControlReviewTargetCorrespondence(target(source),source,target(source),source);
const currentSelf=browserControlReviewTargetCorrespondence(target(current),current,target(current),current);
const {sourceConditionAssessment,currentConditionAssessment,...unchanged}=proof;
assert.deepEqual(unchanged,old.proof);
for(const [observation,self] of [[source,sourceSelf],[current,currentSelf]] as const){
 assert.equal(self.targetMatched,true);assert.equal(self.reviewable,true);assert.equal(self.sourceEquivalent,'equivalent');assert.equal(self.conditionKey,undefined);
 assert.equal(self.sourceConditionAssessment?.status,'unavailable');assert.equal(self.sourceConditionAssessment?.reason,'selector_identity_hypothesis');
 assert.ok(self.sourceConditionAssessment?.localId?.endsWith(':1469'));
 assert.equal(self.sourceConditionAssessment?.localId,old.observations.find((o:any)=>o.id===observation.id).firstRejection.localId);
}
assert.equal(proof.sourceEquivalent,'unknown');
const result={sourceEvidence:oldEvidence,database:path,readOnly:true,rowsRead:counts,
 assertions:{oldCrossObservationProofUnchanged:true,sourceSelfExplicitlyUnassessable:true,currentSelfExplicitlyUnassessable:true,firstRejectedControlMatchesPriorAudit:true},
 observations:[{id:source.id,localId:target(source).localId,self:sourceSelf},{id:current.id,localId:target(current).localId,self:currentSelf}],proof,
 scope:'Pure adapter proof over the same saved real observations. No scheduling, browser operations, provider calls or writable task store. Does not establish successful live recovery or performance improvement.'};
db.close();writeFileSync('/tmp/review-source-repair-real-proof.json',JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify({assertions:result.assertions,rowsRead:counts,sourceConditionAssessment,currentConditionAssessment},null,2));
