// Node 24 --conditions=development --import tsx <this file>
// --cache pair.json before.json prior-pair.json output.json
// --database /absolute/owned/engine.sqlite prior-pair.json output.json
// Only retained observations/one successful attempt. No browser or task store.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { performance } from 'node:perf_hooks';
import { decodeStoredEntity } from '../../../../../packages/storage-sqlite/src/entity-codec.ts';
import { modeStructureReader } from '../../../../../packages/adapter-playwright/src/mode-structure.ts';
import { assessBrowserReviewBranchConditions, browserBranchConditions, browserPortableBranchConditions } from '../../../../../packages/adapter-playwright/src/branch-conditions.ts';
import { browserControlReviewTargetCorrespondence } from '../../../../../packages/adapter-playwright/src/review-target.ts';
import { browserTargetConditions } from '../../../../../packages/adapter-playwright/src/target-arrival.ts';
import { controlCase } from '../../../../../packages/adapter-playwright/src/exploration.ts';
const digest=(v:any)=>createHash('sha256').update(Buffer.isBuffer(v)?v:JSON.stringify(v)).digest('hex');
const json=(path:string)=>JSON.parse(readFileSync(path,'utf8'));
const ids=['b0381d61-11e9-451a-9d0c-7859f4dcc8cc','f156ab06-f2e7-4188-bd38-e456f0da1d76','ba4f54b4-e386-4b61-b194-abf9a5436812'];
const [kind,input,...args]=process.argv.slice(2),counts={entities:0,objects:0,packs:0};
assert.ok(kind==='--cache'||kind==='--database');
const started=performance.now();
let source:any,current:any,tradeBefore:any,tradeAttempt:any,prior:any,output:string;
if(kind==='--cache'){
  ({source,current}=json(input));({tradeBefore,tradeAttempt}=json(args[0]));prior=json(args[1]);output=args[2];
}else{
  const {DatabaseSync}=await import('node:sqlite'),db=new DatabaseSync(input,{readOnly:true});
  try{
    const resolve=(keys:readonly number[],sid:string)=>{
      const objects=db.prepare('SELECT * FROM observation_objects WHERE session_id=? AND id IN (SELECT value FROM json_each(?))').all(sid,JSON.stringify(keys)) as any[];
      const packs=db.prepare('SELECT * FROM observation_packs WHERE session_id=? AND id IN (SELECT value FROM json_each(?))').all(sid,JSON.stringify([...new Set(objects.map(o=>o.pack_id))])) as any[];
      counts.objects+=objects.length;counts.packs+=packs.length;
      const decoded=new Map(packs.map(p=>{const data=p.codec==='gzip'?gunzipSync(p.data,{maxOutputLength:p.bytes}):Buffer.from(p.data);assert.equal(data.length,p.bytes);assert.equal(digest(data),Buffer.from(p.sha256).toString('hex'));return[p.id,data];}));
      return new Map(objects.map(o=>{const data=decoded.get(o.pack_id)!.subarray(o.byte_offset,o.byte_offset+o.bytes);assert.equal(data.length,o.bytes);assert.equal(digest(data),Buffer.from(o.sha256).toString('hex'));return[o.id,data];}));
    };
    const load=(id:string,entityKind='observation')=>{counts.entities++;return decodeStoredEntity<any>(db.prepare('SELECT kind,id,session_id,json,compressed_json FROM entities WHERE id=? AND kind=?').get(id,entityKind) as any,resolve);};
    [source,current,tradeBefore]=ids.map(id=>load(id));tradeAttempt=load('42002819-a04d-432a-8f27-f7e8ce94c3a1','attempt');
  }finally{db.close();}
  prior=json(args[0]);output=args[1];
}
assert.ok(output);assert.deepEqual([source.id,current.id,tradeBefore.id],ids);
const snapshots=[source,current,tradeBefore,tradeAttempt,prior],hashes=snapshots.map(digest),loaded=performance.now();
const target=(o:any)=>o.controls.find((c:any)=>c.localId.endsWith(':1810'));
const modes=(o:any)=>o.controls.filter((c:any)=>/:1466$|:1469$|:1475$/.test(c.localId));
const compare=(after:any)=>browserControlReviewTargetCorrespondence(target(source),source,target(after),after);
const baseline=json('docs/experiments/storage-tiering-2026-10-17/evidence/real-okx-17/local-recovery.json').result.proof;
assert.equal(baseline.sourceEquivalent,'unknown');
assert.equal(baseline.sourceConditionAssessment.reason,'selector_instance_bound');
const proof=compare(current),projected=[source,current].map(o=>{
  const reader=modeStructureReader(o),branch=assessBrowserReviewBranchConditions(target(o),o);
  assert.equal(branch.assessment.status,'available');assert.equal(branch.conditions!.conditions.length,28);
  const references=modes(o).map((c:any)=>({localId:c.localId,instanceBound:c.identityScope==='instance',reference:reader(c)}));
  assert.equal(references.length,3);assert.ok(references.every((r:any)=>r.reference));
  assert.equal(new Set(references.map((r:any)=>r.reference.key)).size,3);
  return {id:o.id,modeCount:28,policy:branch.conditions!.policy,key:branch.conditions!.key,references};
});
assert.equal(proof.sourceEquivalent,'different');assert.equal(proof.sourceConditionAssessment!.status,'available');
assert.equal(proof.currentConditionAssessment!.status,'available');assert.equal(proof.currentMaterialKey,baseline.currentMaterialKey);
assert.equal(source.controls.find((c:any)=>c.name==='Trade'&&c.role==='button').expanded,true);
assert.equal(current.controls.find((c:any)=>c.name==='Trade'&&c.role==='button').expanded,false);
const projectedAt=performance.now();
const trade=current.controls.find((c:any)=>c.name==='Trade'&&c.role==='button');
const currentAction={...tradeAttempt.action,observationId:current.id,stateId:current.stateId,controlId:trade.identityId,localId:trade.localId};
const operation=[{o:tradeBefore,a:tradeAttempt.action},{o:current,a:currentAction}].map(({o,a})=>({
  observationId:o.id,legacyUnavailable:!browserBranchConditions(a,o),branch:browserPortableBranchConditions(a,o)?.key,
  operation:controlCase(a,o,true)?.key,target:browserTargetConditions(a,o)?.key,
}));
assert.equal(tradeAttempt.status,'succeeded');assert.equal(tradeAttempt.action.replayable,true);
assert.ok(operation.every(row=>row.legacyUnavailable&&row.branch&&row.operation&&row.target));
for(const key of ['branch','operation','target'] as const)assert.equal(operation[0][key],operation[1][key]);
const operationAt=performance.now();
// Explicit counterexamples, not fabricated live restoration evidence.
const rebuilt=JSON.parse(JSON.stringify(source).replaceAll(source.documentId,'rebuilt-document'));rebuilt.id='counterexample-rebuilt';
for(const c of modes(rebuilt)){delete c.identityScope;delete c.stableKey;c.hypothesisId='still-unresolved';}
rebuilt.controls.find((c:any)=>c.localId.endsWith(':1382')).name='Trade';
assert.equal(compare(rebuilt).sourceEquivalent,'equivalent');
const changed=structuredClone(rebuilt),mode=modes(changed)[0];mode.expanded=true;
for(const c of changed.controls)for(const node of c.classificationBinding?.nodes||[])if(node.instanceId===mode.instanceId)node.attributes['aria-expanded']='true';
assert.equal(compare(changed).sourceEquivalent,'different');
const missing=structuredClone(source),modeId=modes(missing)[0].instanceId;
for(const c of missing.controls)if(c.classificationBinding?.nodes.some((n:any)=>n.instanceId===modeId))c.classificationBinding.truncated=true;
assert.equal(compare(missing).sourceEquivalent,'unknown');
const passive=structuredClone(rebuilt);
for(const c of passive.controls)if(c.classificationBinding?.nodes.some((n:any)=>/:1466$/.test(n.instanceId)))c.classificationBinding.text+=' $99999.99';
assert.equal(compare(passive).sourceEquivalent,'equivalent');
const dialog=(o:any)=>o.controls.find((c:any)=>c.stableKey==='testid:okd-dialog-window');
const priorProof=browserControlReviewTargetCorrespondence(dialog(prior.source),prior.source,dialog(prior.current),prior.current);
assert.equal(priorProof.sourceEquivalent,'equivalent');
assert.deepEqual(snapshots.map(digest),hashes);const finished=performance.now();
const result={baseCommit:'4968bc063bc70814b1c684c4fdfc67b52a953088',input:{kind,ids,sha256:hashes,databaseRowsRead:counts},
  before:{sourceEquivalent:baseline.sourceEquivalent,sourceConditionAssessment:baseline.sourceConditionAssessment},after:proof,projected,operation,
  assertions:{all28ModeConditionsRetained:true,threeDistinctNavigationReferences:true,actualOpenClosedDifferenceRetained:true,
    sameHistoricalTradePrerequisitesNowComparable:true,instanceMetadataDoesNotRenameNavigationModes:true,
    changedHiddenModeRejected:true,missingTreeRemainsUnknown:true,passiveOwnerTextDoesNotRenameModes:true,
    prior27ModeDialogPairStillEquivalent:true,negativeMaterialKeyUnchanged:true,inputsUnmodified:true},
  milliseconds:{load:loaded-started,reviewProofAndReferences:projectedAt-loaded,operationPrerequisites:operationAt-projectedAt,counterexamples:finished-operationAt},
  scope:'Retained real OKX observations plus explicitly transformed counterexamples. No browser, actual Trade replay, live preflight, task database or model invocation. Single-run timings are diagnostic, not a performance claim.'};
writeFileSync(output,JSON.stringify(result,null,2)+'\n',{flag:'wx'});console.log(JSON.stringify({assertions:result.assertions,milliseconds:result.milliseconds}));
