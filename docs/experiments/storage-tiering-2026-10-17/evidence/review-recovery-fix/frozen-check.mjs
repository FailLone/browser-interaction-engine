import { readFileSync, writeFileSync, readdirSync, copyFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { SqliteStore } from '/Users/xietian/.codex/worktrees/exploration-layered-refactor/browser-interaction-engine/packages/storage-sqlite/src/index.ts';
import { BrowserEngine, BrowserAdapter } from '/Users/xietian/.codex/worktrees/exploration-layered-refactor/browser-interaction-engine/packages/browser/src/index.ts';
import { reviewRecoveryChanges, validReviewRecoveryWait, prioritizeReviewAnchors } from '/Users/xietian/.codex/worktrees/exploration-layered-refactor/browser-interaction-engine/packages/explorer-plugin/src/review-recovery.ts';
const root='/Users/xietian/.codex/worktrees/exploration-layered-refactor/browser-interaction-engine';
const frozen=join(root,'.data/okx-storage-acceptance-20261017-v1-frozen-2/engine');
const files=readdirSync(frozen).filter(name=>/^engine\.sqlite(?:-wal|-shm)?$/.test(name));
const digest=file=>createHash('sha256').update(readFileSync(file)).digest('hex');
const before=Object.fromEntries(files.map(name=>[name,digest(join(frozen,name))]));
const directory=mkdtempSync(join(tmpdir(),'okx-review-recovery-offline-'));
for(const name of files)copyFileSync(join(frozen,name),join(directory,name));
let browserStarts=0;BrowserAdapter.prototype.start=async function(){browserStarts++;throw Error('Offline check must never start a browser');};
const host=new BrowserEngine({persistence:new SqliteStore(directory)}),sid='412937f3-c4f5-4799-b86c-74adf480f329';
try {
 const originalTask=JSON.parse(readFileSync(join(root,'docs/experiments/storage-tiering-2026-10-17/evidence/real-okx-2/task-after.json'),'utf8'));
 const task=structuredClone(originalTask),o=host.observation(sid,'a1cba85a-3fa3-46d1-b2eb-1f668b62631b'),session=host.session(sid);
 host.store.put('session',{...session,currentObservationId:o.id});
 const control=o.controls.find(c=>c.localId.endsWith(':1552'));
 const rejected=[{localId:control.localId,decisionId:'3f546fab-889a-42d2-9b33-da92adda76ff',kind:'probe'}];
 const changes=reviewRecoveryChanges(task,o,host,{rejected});
 const chosen=changes.find(c=>c.itemId==='d6890f2b-f098-4e20-8a71-d31f862ef0bb');assert(chosen?.wait);
 for(const change of changes){const item=task.plan.find(i=>i.id===change.itemId);if(change.source)item.evidence.push(change.source);if(change.wait)item.reviewRecoveryWait=change.wait;}
 const generic=task.plan.find(i=>i.id===chosen.itemId),checkboxes=task.plan.filter(i=>i.scope.label==='Don’t show for 7 days'&&i.scope.kind==='check');
 assert(checkboxes.length>0);assert(checkboxes.every(i=>!i.reviewRecoveryWait));assert.equal(generic.status,'unresolved');assert.equal(generic.attempts.length,0);assert.deepEqual(task.routeRetries,originalTask.routeRetries);
 const help=host.observation(sid,'fbc54d28-a3e8-402f-92e7-513a953e059b');assert(validReviewRecoveryWait(task,generic,help,id=>host.observation(sid,id)));
 const checkpoints=host.list(sid,'checkpoint').filter(cp=>['8e894178-1943-4a1f-b75d-1ce665aa01cc',o.id].includes(cp.observationId));
 const ranked=prioritizeReviewAnchors(checkpoints,help,id=>host.observation(sid,id));assert.equal(ranked[0].observationId,o.id);
 assert.equal(browserStarts,0);assert.deepEqual(Object.fromEntries(files.map(name=>[name,digest(join(frozen,name))])),before);
 const report={directory,frozenFilesUnchanged:true,browserStarts,providerCalls:0,generic:{itemId:generic.id,status:generic.status,attempts:generic.attempts,sourceAppended:chosen.source,proof:chosen.proof,wait:chosen.wait,validWhileAway:true},checkboxes:checkboxes.map(i=>({itemId:i.id,kind:i.scope.kind,value:i.scope.value,status:i.status,wait:!!i.reviewRecoveryWait})),routeDebtUnchanged:true,rankedCheckpoints:ranked.map(cp=>({id:cp.id,observationId:cp.observationId})),scope:'Offline retained evidence and scheduler projections only; no real return or exploration executed'};
 writeFileSync('/tmp/okx-review-recovery-frozen-check.json',JSON.stringify(report,null,2));console.log(JSON.stringify({report:'/tmp/okx-review-recovery-frozen-check.json',genericWaiting:true,checkboxesUnaffected:checkboxes.length,preferredCheckpoint:ranked[0].id,browserStarts,frozenFilesUnchanged:true}));
}finally{await host.close();}
