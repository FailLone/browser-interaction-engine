// Single-use, three-observation diagnosis. No driver, plugin, frontier or cursor write.
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonical } from '@interaction/core';
import { BrowserEngine, browserTargetConditions } from '@interaction/browser';
import { PlaywrightAdapter, browserOperationCorrespondenceHint, classificationCorrespondenceConditions, type Control, type Observation } from '@interaction/adapter-playwright';
import { SqliteStore } from '@interaction/storage-sqlite';
import { assessBrowserReviewBranchConditions, browserPortableBranchConditions } from '../../../../../packages/adapter-playwright/src/branch-conditions.js';

const out=fileURLToPath(new URL('.',import.meta.url)),root=resolve(out,'../../../../..'),output=join(out,'real-query-result.json');
const auditPath=join(out,'../plugin-loop-3/audit.json'),priorPath=join(out,'../plugin-loop-target-review/query-result.json');
const audit=JSON.parse(readFileSync(auditPath,'utf8')),prior=JSON.parse(readFileSync(priorPath,'utf8'));
const sid='412937f3-c4f5-4799-b86c-74adf480f329',afterId='ac63485c-0195-4321-9395-ffdbe6ce01fa',currentId='d6863bdc-eb8f-4a93-b74b-bf630afb1d7a';
const sourceRef=audit.guardedReentry[0].data.source,currentLocalId='4f28b07f-6c6e-4782-b0ef-c255515e5ed0:1463';
const source=join(root,'.data/okx-plugin-loop-20261018-v3/engine'),hash=(value:string|Buffer)=>createHash('sha256').update(value).digest('hex'),sha=(path:string)=>hash(readFileSync(path));
const names=['engine.sqlite','engine.sqlite-wal','engine.sqlite-shm'].filter(name=>existsSync(join(source,name)));
const hashes=()=>Object.fromEntries(names.map(name=>[name,sha(join(source,name))]));
if(existsSync(output)||audit.ownedGroupRemaining.length||audit.sourceUnchanged!==true||!prior.sourceUnchanged
  ||sourceRef.observationId!=='fb945d9c-9b51-4a7c-a1ed-2e966944ffc1'||sourceRef.actionId!=='46c85a1e-37f8-4332-ad9a-909134b75964')throw Error('FROZEN_INPUT_GATE_FAILED');
const sourceBefore=hashes();if(canonical(sourceBefore)!==canonical(prior.sourceAfter))throw Error('SOURCE_HASH_CHANGED');
const owned=mkdtempSync(join(tmpdir(),'bie-native-navigation-')),directory=join(owned,'engine'),owner='native-navigation-operation-reference';
mkdirSync(directory);writeFileSync(join(owned,'owner.txt'),owner);for(const name of names)copyFileSync(join(source,name),join(directory,name));
const record:any={scope:'Recorded navigation operation/target facts only; constructor-idempotent private copy. No frontier, permission change, historic current cursor, dispatch or arrival.',
  startedAt:new Date().toISOString(),scriptSha256:sha(fileURLToPath(import.meta.url)),source,sourceBefore,sourceReference:sourceRef,
  inputs:[{path:auditPath,sha256:sha(auditPath)},{path:priorPath,sha256:sha(priorPath)}],temporaryDirectory:owned,constructorWrites:[],writeAttempts:{},observations:[]};
let store:SqliteStore|undefined,engine:BrowserEngine|undefined,phase='constructor',driverCalls=0;
const createDriver=PlaywrightAdapter.prototype.createDriver;PlaywrightAdapter.prototype.createDriver=()=>{driverCalls++;throw Error('OFFLINE_DRIVER_FORBIDDEN');};
const ownerFacts=(o:Observation,c:Control)=>o.controls.filter(owner=>owner!==c&&owner.classificationBinding?.nodes.some(n=>n.instanceId===c.instanceId)).map(owner=>{
  const tree=owner.classificationBinding!,nodes=new Map(tree.nodes.map(n=>[n.instanceId,n])),target=nodes.get(c.instanceId)!;
  const parents:{tag:string;attributes:string[];attributesSha256:string}[]=[];const seen=new Set<string>();let n=nodes.get(target.parentInstanceId);
  while(n&&!seen.has(n.instanceId)){seen.add(n.instanceId);parents.push({tag:n.tag,attributes:Object.keys(n.attributes),attributesSha256:hash(canonical(n.attributes))});n=nodes.get(n.parentInstanceId);}
  const references=(tree.references||[]).map(r=>({id:r.id,missing:!!r.missing,ambiguous:!!r.ambiguous,targetInstanceId:r.targetInstanceId,
    external:!!r.target,externalTruncated:r.target?.truncated,externalNodes:r.target?.nodes.length,externalTextPresent:!!r.target?.text.trim()}));
  const preconditions=[!owner.reviewReuseBinding&&'owner_ancestry_missing',!!owner.hypothesisId&&'owner_hypothesis',owner.identityScope==='instance'&&'owner_instance_bound',
    !!owner.structuralItem&&'owner_structural_item',tree.truncated&&'owner_tree_truncated',tree.nodes.length>200&&'owner_tree_limit',
    references.some(r=>r.missing||r.ambiguous||r.externalTruncated)&&'owner_idref_incomplete'].filter(Boolean);
  const projection=classificationCorrespondenceConditions(owner,o);
  return {localId:owner.localId,tag:owner.tag,role:owner.role,name:owner.name,label:owner.label,identityScope:owner.identityScope,hypothesisId:owner.hypothesisId,
    nodes:tree.nodes.length,truncated:tree.truncated,ancestry:owner.reviewReuseBinding?.ancestors.map(a=>({tag:a.tag,label:a.label,attributes:Object.keys(a.attributes),attributesSha256:hash(canonical(a.attributes))})),
    references,parents,recordedPreconditionFailures:preconditions,firstRecordedPreconditionFailure:preconditions[0]||null,
    classificationProjectionAvailable:!!projection,classificationConditionKey:projection?.conditionKey};
});
try{
  store=new SqliteStore(directory);const total=()=>(store!.db.prepare('SELECT total_changes() AS n').get() as {n:number}).n;record.storeConstructorSqlChanges=total();
  for(const method of ['put','event','recordRequest'] as const){const original=(store as any)[method].bind(store);(store as any)[method]=(...args:any[])=>{
    const key=`${phase}.${method}`;record.writeAttempts[key]=(record.writeAttempts[key]||0)+1;
    if(phase!=='constructor'||method!=='put')throw Error(`OFFLINE_WRITE_FORBIDDEN:${method}`);
    const before=store!.get<any>(args[0],args[1].id),same=canonical(before??null)===canonical(args[1]);
    record.constructorWrites.push({kind:args[0],id:args[1].id,beforeSha256:hash(JSON.stringify(before??null)),afterSha256:hash(JSON.stringify(args[1])),byteEquivalent:same});
    if(!same)throw Error('NON_IDEMPOTENT_CONSTRUCTOR_WRITE');return original(...args);
  };}
  const initial=total();engine=new BrowserEngine({persistence:store});record.engineConstructorSqlChanges=total()-initial;
  phase='query';store.db.pragma('query_only=ON');const initialQuery=total();
  if(engine.session(sid).currentObservationId!==currentId)throw Error('CURRENT_OBSERVATION_CHANGED');
  const sourceAction=store.require<any>('action',sourceRef.actionId);
  if(sourceAction.observationId!==sourceRef.observationId||sourceAction.sessionId!==sourceRef.sessionId)throw Error('SOURCE_ACTION_BINDING_CHANGED');
  const frames=[{kind:'source',sid:sourceRef.sessionId,id:sourceRef.observationId,localId:sourceAction.localId},
    {kind:'trade-after',sid,id:afterId,localId:currentLocalId},{kind:'current',sid,id:currentId,localId:currentLocalId}];
  let currentActionId:string|undefined;
  for(const frame of frames){
    const o=engine.observation(frame.sid,frame.id),targets=o.controls.filter(c=>c.localId===frame.localId);
    if(targets.length!==1)throw Error(`TARGET_NOT_UNIQUE:${frame.kind}`);
    const c=targets[0],actions=frame.kind==='source'?[sourceAction]:engine.actions(frame.sid,frame.id).filter(a=>a.localId===c.localId&&a.kind==='click');
    if(actions.length!==1)throw Error(`ACTION_NOT_UNIQUE:${frame.kind}`);const action=actions[0];if(frame.kind==='current')currentActionId=action.id;
    const reference=browserOperationCorrespondenceHint(c,action.kind,o),branch=browserPortableBranchConditions(action,o),assessment=assessBrowserReviewBranchConditions(c,o),target=browserTargetConditions(action,o);
    record.observations.push({kind:frame.kind,id:o.id,sessionId:o.sessionId,logicalSha256:hash(JSON.stringify(o)),actionId:action.id,
      control:{localId:c.localId,instanceId:c.instanceId,tag:c.tag,role:c.role,name:c.name,identityScope:c.identityScope,hypothesisId:c.hypothesisId,
        stableKeySha256:hash(c.stableKey||''),replayable:action.replayable,nativeBasis:action.basis?.status,readiness:c.readiness},
      reference:reference||null,branch:branch?{policy:branch.policy,key:branch.key,conditions:branch.conditions.length}:null,
      branchAssessment:assessment.assessment,portableTargetConditions:target||null,
      firstProjectionRejection:!reference?'native_operation_reference_unavailable':!branch?assessment.assessment.status==='unavailable'?assessment.assessment.reason:'portable_target_branch_unavailable':!target?'target_conditions_unavailable':null,
      owners:ownerFacts(o,c),historicalCurrentOnlyQuerySkipped:frame.kind==='trade-after'});
  }
  // The public SDK requires the actual current observation. Do not rewrite the
  // cursor to make the historical Trade-after frame look current.
  record.sdk=engine.explorationTargetCorrespondences(sid,{observationId:currentId,requests:[{actionId:currentActionId!,source:sourceRef}]});
  record.querySqlChanges=total()-initialQuery;record.queryCompleted=true;
}catch(error){record.error=String(error);process.exitCode=1;}
finally{
  phase='close';try{if(engine)await engine.close();else store?.close();record.closed=true;}catch(error){record.closeError=String(error);process.exitCode=1;}
  PlaywrightAdapter.prototype.createDriver=createDriver;record.driverCalls=driverCalls;record.sourceAfter=hashes();record.sourceUnchanged=canonical(sourceBefore)===canonical(record.sourceAfter);
  if(readFileSync(join(owned,'owner.txt'),'utf8')!==owner)throw Error('OWNERSHIP_LOST');rmSync(owned,{recursive:true});record.temporaryCopyRemoved=!existsSync(owned);record.finishedAt=new Date().toISOString();
  writeFileSync(output,JSON.stringify(record,null,2)+'\n',{flag:'wx'});
}
console.log(JSON.stringify({output,error:record.error,queryCompleted:record.queryCompleted,sdk:record.sdk?.results.map((r:any)=>({equivalent:r.equivalent,reason:r.reason})),sourceUnchanged:record.sourceUnchanged,driverCalls,querySqlChanges:record.querySqlChanges,closed:record.closed,temporaryCopyRemoved:record.temporaryCopyRemoved}));
