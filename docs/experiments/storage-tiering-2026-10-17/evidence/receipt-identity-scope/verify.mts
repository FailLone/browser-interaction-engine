import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { BrowserEngine, type ActionAttempt } from '@interaction/browser';
import { SqliteStore } from '@interaction/storage-sqlite';
import { controlCase } from '../../../../../packages/adapter-playwright/src/exploration.js';
const out=new URL('.',import.meta.url),owner=JSON.parse(readFileSync(new URL('ownership.json',out),'utf8'));
const original=JSON.parse(readFileSync(new URL('diagnosis.json',out),'utf8'));
const store=new SqliteStore(owner.diagnosticDirectory+'/engine'),engine=new BrowserEngine({persistence:store});
(engine as any).adapter.createDriver=()=>{throw Error('Offline verification forbids browser creation');};
const changes=()=>store.db.prepare('SELECT total_changes() AS n').get() as {n:number};
const initial=changes(),results=[];
for(const old of original.results){
 const attempt=store.require<ActionAttempt>('attempt',old.attemptId),before=engine.observation(attempt.sessionId,attempt.beforeId);
 const sample=controlCase(attempt.action,before,true)!;
 assert.equal(sample.key,old.portable.key);assert.equal(sample.policy,old.portable.policy);
 assert.deepEqual([...sample.identityConflictScope!.localIds].sort(),[...new Set([old.target.localId,...old.modes.map((m:any)=>m.localId)])].sort());
 const proof=engine.operationReceiptCondition(attempt.sessionId,{attemptId:attempt.id});
 assert.equal(proof.actualSuccess,true);assert.equal(proof.conditionVerified,true);assert.equal(proof.status,'portable');
 assert.ok(!proof.identityAuthorized&&!proof.replayAuthorized&&!proof.arrivalVerified&&!proof.currentExecution);
 results.push({name:old.name,priorProof:old.proof,proof,portableKeyUnchanged:true,scope:sample.identityConflictScope});
}
assert.deepEqual(changes(),initial);
assert.equal(createHash('sha256').update(readFileSync(owner.sourceDatabase)).digest('hex'),owner.sourceSha256);
if(process.argv.includes('--final')){
 const prior=JSON.parse(readFileSync(new URL('verification.json',out),'utf8'));assert.deepEqual(results,prior.results);
 writeFileSync(new URL('final-checkpoint.json',out),JSON.stringify({matchesSavedVerification:true,sourceUnchanged:true,recordWrites:0,browserStarted:false,
  reason:'After limiting conflict scoping to existing identity rejections and adding dependency uniqueness, both real receipt proofs remain exactly equal to the saved positive verification.'},null,2)+'\n',{flag:'wx'});
}else writeFileSync(new URL('verification.json',out),JSON.stringify({results,sourceUnchanged:true,recordWrites:0,browserStarted:false,taskDatabaseOpened:false},null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify(results.map(r=>({name:r.name,from:r.priorProof.reason,to:r.proof.reason,conditionVerified:r.proof.conditionVerified,controls:r.scope!.localIds.length})),null,2));
await engine.close();
