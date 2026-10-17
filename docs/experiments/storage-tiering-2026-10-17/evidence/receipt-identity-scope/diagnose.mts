import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { BrowserEngine, type ActionAttempt, type IdentityHypothesis } from '@interaction/browser';
import { SqliteStore } from '@interaction/storage-sqlite';
import { browserPortableBranchConditions } from '../../../../../packages/adapter-playwright/src/branch-conditions.js';
import { controlCase } from '../../../../../packages/adapter-playwright/src/exploration.js';
import { modeStructureReader } from '../../../../../packages/adapter-playwright/src/mode-structure.js';
const out=new URL('.',import.meta.url),owner=JSON.parse(readFileSync(new URL('ownership.json',out),'utf8'));
const store=new SqliteStore(owner.diagnosticDirectory+'/engine'),engine=new BrowserEngine({persistence:store});
(engine as any).adapter.createDriver=()=>{throw Error('Offline diagnosis forbids browser creation');};
const sid='412937f3-c4f5-4799-b86c-74adf480f329',hypotheses=store.list<IdentityHypothesis>('hypothesis',sid),pending=hypotheses.filter(h=>h.status==='pending');
const results=[];
for(const name of ['local','global']){
 const saved=JSON.parse(readFileSync(new URL('../real-okx-20/'+name+'-continuation.json',out),'utf8'));
 const attempt=store.require<ActionAttempt>('attempt',saved.receipt.id);assert.deepEqual(attempt,saved.receipt);
 const before=engine.observation(sid,attempt.beforeId),after=engine.observation(sid,attempt.afterId!),target=before.controls.find(c=>c.localId===attempt.action.localId)!;
 const structure=modeStructureReader(before),modes=before.controls.filter(c=>c.checked!=null||c.pressed!=null||c.expanded!=null||c.tag==='select'||['checkbox','radio','switch','tab','option','treeitem'].includes(c.role));
 const bindings=(c:typeof target)=>pending.filter(h=>h.id===c.hypothesisId||h.provisionalIdentityId===c.identityId||h.candidateIds.includes(c.identityId!)).map(h=>({id:h.id,observationId:h.observationId,localId:h.localId,provisionalIdentityId:h.provisionalIdentityId,candidateIds:h.candidateIds,evidence:h.evidence,conflicts:h.conflicts}));
 const brief=(c:typeof target)=>({localId:c.localId,instanceId:c.instanceId,identityId:c.identityId,hypothesisId:c.hypothesisId,identityScope:c.identityScope,role:c.role,name:c.name,tag:c.tag,stableKey:c.stableKey,visible:c.visible,checked:c.checked,pressed:c.pressed,expanded:c.expanded,selected:c.selected,pendingReferences:bindings(c)});
 const portable=controlCase(attempt.action,before,true),conditions=browserPortableBranchConditions(attempt.action,before);
 results.push({name,attemptId:attempt.id,beforeId:before.id,afterId:after.id,proof:engine.operationReceiptCondition(sid,{attemptId:attempt.id}),target:brief(target),targetIdentityMultiplicity:before.controls.filter(c=>c.identityId===target.identityId).length,modes:modes.map(c=>({...brief(c),structure:structure(c)})),portable,conditions,ownerInventoryComplete:before.ownerDependencies?.inventoryComplete,hasDispatchWitness:!!after.ownerDependencyDispatch});
}
writeFileSync(new URL('diagnosis.json',out),JSON.stringify({pendingHypotheses:pending.length,totalHypotheses:hypotheses.length,results,browserStarted:false,taskDatabaseOpened:false},null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({pending:pending.length,results:results.map(r=>({name:r.name,target:r.target,modes:r.modes.map(m=>({name:m.name,hypothesisId:m.hypothesisId,pending:m.pendingReferences.length,structure:!!m.structure})),portable:!!r.portable,branchPolicy:r.conditions?.policy,hasDispatchWitness:r.hasDispatchWitness}))},null,2));
await engine.close();
