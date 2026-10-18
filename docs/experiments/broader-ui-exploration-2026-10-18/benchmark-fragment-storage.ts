/** Offline production-store experiment. Inputs are exported JSON. All writes
 * target a new experiment directory; never open original evidence databases. */
import {readFileSync,writeFileSync,mkdirSync,statSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {spawnSync} from 'node:child_process';
import assert from 'node:assert/strict';
import {fragmentFixture,fragmentTask} from '../../../tests/fragment-storage-helpers.js';
import {TaskWriter} from '../../../packages/explorer-plugin/src/task-writer.js';
import {taskDigest} from '../../../packages/explorer-plugin/src/task-codec.js';
import {encodeFragmentMaterial,decodeFragmentMaterial} from '../../../packages/explorer-plugin/src/fragment-material.js';
import {emptyFragmentAccess,mapFragmentCandidates,transferFragmentAccess,recordFragmentAccess,fragmentAccessCounters,fragmentCandidateInfluence,fragmentWasExplored,bestFragmentCandidate,fragmentDuplicationFactor} from '../../../packages/explorer-plugin/src/fragment-traversal-core.js';
import type {FragmentTraversalLedger} from '../../../packages/explorer-plugin/src/fragment-records.js';
const [mode,inputPath,outputPath,baselinePath,variant,copiesArg]=process.argv.slice(2),json=JSON.stringify;
const input=JSON.parse(readFileSync(inputPath,'utf8')).fragmentTraversal as FragmentTraversalLedger;
const timing=<T>(fn:()=>T)=>{const start=performance.now(),value=fn();return {ms:performance.now()-start,value};};
function fixture(copies:number):FragmentTraversalLedger {
 const l:FragmentTraversalLedger={...structuredClone(input),fragments:[],mappings:[],states:[],events:[],obligations:{},revokedCandidates:{}};
 for(let k=0;k<copies;k++){
  const ids=new Map<string,string>();
  for(const old of input.fragments){const f={...structuredClone(old),id:taskDigest(`${k}/${old.id}`),url:old.url+(copies>1?`?__offline_copy=${k}`:''),candidates:old.candidates.map(c=>{const id=taskDigest(`${k}/${c.id}`);ids.set(c.id,id);return {...c,id,access:emptyFragmentAccess()};})};l.fragments.push(f);
   if(copies>1&&k<2)for(let i=0;i<f.candidates.length;i+=4)l.events.push({id:taskDigest(`event/${k}/${f.candidates[i].id}`),fragmentId:f.id,candidateId:f.candidates[i].id,sessionId:f.source.sessionId,observationId:`synthetic/${k}`,afterId:`synthetic/${k}/after`,actionId:`synthetic/${i}`});
  }
  for(const state of input.states)l.states.push({...state,id:taskDigest(`${k}/${state.id}`),candidateIds:state.candidateIds.map(id=>ids.get(id)!).filter(Boolean)});
 }
 for(let i=0;i<l.fragments.length;i++)for(let j=i+1;j<l.fragments.length;j++)l.mappings.push(...mapFragmentCandidates(l.fragments[i],l.fragments[j]),...mapFragmentCandidates(l.fragments[j],l.fragments[i]));
 propagate(l);return l;
}
function propagate(l:FragmentTraversalLedger){
 const all=new Map(l.fragments.flatMap(f=>f.candidates).map(c=>[c.id,c]));for(const c of all.values())c.access=emptyFragmentAccess();for(const e of l.events){const c=all.get(e.candidateId)!;c.access=recordFragmentAccess(c.access,e.id);}
 for(let pass=0;pass<=l.fragments.length;pass++){let changed=false;for(const edge of l.mappings){if(edge.revoked||l.revokedCandidates[edge.sourceCandidateId]||l.revokedCandidates[edge.targetCandidateId])continue;const a=all.get(edge.sourceCandidateId)!,b=all.get(edge.targetCandidateId)!;const next=transferFragmentAccess(a.access,b.access,edge.kind);if(json(next)!==json(b.access)){b.access=next;changed=true;}}if(!changed)break;}
}
const size=(path:string)=>{try{return statSync(path).size;}catch{return 0;}};
function storage(db:any){
 const pages=db.pragma('page_count',{simple:true})*db.pragma('page_size',{simple:true});let layout:unknown;
 try{layout=db.prepare('SELECT name,sum(pgsize) bytes FROM dbstat GROUP BY name').all();}catch{layout='dbstat unavailable';}
 return {pages,layout};
}
async function worker(){
 const copies=Number(copiesArg),l=fixture(copies),path=join(outputPath,`${variant}-${copies}.sqlite`);let result:Record<string,unknown>;
 if(variant==='shared'){
  const f=fragmentFixture(path),{store,session,writer}=f,db=store.fragmentRecords.db,ids=new Map<string,string>(),frags=new Map<string,string>(),reverse=new Map<string,string>(),registerMs:number[]=[],commitMs:number[]=[];
  for(const [index,old] of l.fragments.entries()){
   const t=timing(()=>session.register(old.url,{...old,owner:decodeFragmentMaterial(old.owner),candidates:old.candidates.map(c=>({...c,guard:decodeFragmentMaterial(c.guard)}))},old.source,old.parentRegionId));registerMs.push(t.ms);frags.set(old.id,t.value.fragment.id);reverse.set(t.value.fragment.id,old.id);old.candidates.forEach((c,i)=>{ids.set(c.id,t.value.candidates[i].id);reverse.set(t.value.candidates[i].id,c.id);});
   if(index%18===17)commitMs.push(timing(()=>writer.flush()).ms);
  }
  for(const state of l.states)session.put('states',{...state,candidateIds:state.candidateIds.map(id=>ids.get(id)!)});
  for(const e of l.events)session.put('events',{...e,fragmentId:frags.get(e.fragmentId)!,candidateId:ids.get(e.candidateId)!});writer.flush();
  const parity=timing(()=>{
   const exported=store.exportFragments('task')!;
   for(const old of l.fragments){const f=exported.fragments.find(f=>f.id===frags.get(old.id))!;assert.equal(f.structure,old.structure);assert.equal(f.owner,decodeFragmentMaterial(old.owner));old.candidates.forEach((c,i)=>{assert.equal(f.candidates[i].guard,decodeFragmentMaterial(c.guard));assert.equal(f.candidates[i].operation,c.operation);});}
   const pairs=exported.mappings.map(e=>({...e,sourceFragmentId:reverse.get(e.sourceFragmentId),targetFragmentId:reverse.get(e.targetFragmentId),sourceCandidateId:reverse.get(e.sourceCandidateId),targetCandidateId:reverse.get(e.targetCandidateId)})).map(json).sort();assert.deepEqual(pairs,l.mappings.map(json).sort());
   const oldValues=l.fragments.flatMap(f=>{const peers=new Set(l.mappings.filter(e=>e.sourceFragmentId===f.id).map(e=>e.targetFragmentId)).size;return f.candidates.map(c=>({id:c.id,access:fragmentAccessCounters(c.access),factor:fragmentDuplicationFactor(0,peers)}));});
   const newValues=l.fragments.flatMap(f=>f.candidates.map(c=>({id:c.id,access:session.counts(ids.get(c.id)!),factor:fragmentDuplicationFactor(0,session.peers(frags.get(f.id)!))})));
   assert.deepEqual(newValues,oldValues);assert.equal(bestFragmentCandidate(newValues)?.id,bestFragmentCandidate(oldValues)?.id);
   assert.deepEqual(newValues.map(c=>[fragmentWasExplored(c.access),fragmentCandidateInfluence(c.access)]),oldValues.map(c=>[fragmentWasExplored(c.access),fragmentCandidateInfluence(c.access)]));
  });
  const initial=storage(db),rootBytes=Buffer.byteLength(json(store.taskHeader('task').header.fragmentTraversal));db.pragma('wal_checkpoint(TRUNCATE)');
  const first=l.fragments[0],e={id:'one-extra-origin',fragmentId:frags.get(first.id)!,candidateId:ids.get(first.candidates[0].id)!,sessionId:'synthetic',observationId:'before',afterId:'after',actionId:'synthetic'};
  const eventStep=timing(()=>{session.put('events',e);const bytes=Buffer.byteLength(json(session.delta()));writer.flush();return bytes;}),eventWalBytes=size(path+'-wal');db.pragma('wal_checkpoint(TRUNCATE)');
  const ordinary=timing(()=>{f.task.usage.actions++;writer.flush();}),ordinaryWalBytes=size(path+'-wal');
  store.fragmentRecords.invalidate();const reload=timing(()=>{const fresh=new TaskWriter(store,store.taskState('task')).fragments();return fresh.counts(e.candidateId);});
  const objects=db.prepare('SELECT kind,count(*) n FROM fg_objects GROUP BY kind').all(),packs=db.prepare('SELECT count(*) n,sum(raw_size) rawBytes,sum(length(data)) packBytes FROM fg_packs').get();
  result={variant,copies,fragments:l.fragments.length,candidates:ids.size,parity:true,parityMs:parity.ms,registerMs,commitMs,initial,rootBytes,objects,packs,eventDeltaBytes:eventStep.value,eventCommitMs:eventStep.ms,eventWalBytes,ordinaryCommitMs:ordinary.ms,ordinaryWalBytes,reloadMs:reload.ms,cache:store.fragmentRecords.cacheStats(),stats:store.fragmentRecords.stats('task')};f.close();
 }else{
  const {ExplorerStore:OldStore}=await import(pathToFileURL(join(baselinePath,'store.ts')).href),{TaskWriter:OldWriter}=await import(pathToFileURL(join(baselinePath,'task-writer.ts')).href);
  for(const f of l.fragments){f.owner=encodeFragmentMaterial(decodeFragmentMaterial(f.owner));for(const c of f.candidates)c.guard=encodeFragmentMaterial(decodeFragmentMaterial(c.guard));}
  const task=fragmentTask();task.fragmentTraversal=l;const old=new OldStore(path),initialWrite=timing(()=>old.save(task)),writer=new OldWriter(old,old.taskState(task.id)),db=old.db,initial=storage(db);db.pragma('wal_checkpoint(TRUNCATE)');
  const ledger=writer.task.fragmentTraversal,first=ledger.fragments[0];const eventStep=timing(()=>{ledger.events.push({id:'one-extra-origin',fragmentId:first.id,candidateId:first.candidates[0].id,sessionId:'synthetic',observationId:'before',afterId:'after',actionId:'synthetic'});ledger.epoch++;propagate(ledger);const bytes=Buffer.byteLength(json(ledger));writer.flush();return bytes;});
  const eventWalBytes=size(path+'-wal');db.pragma('wal_checkpoint(TRUNCATE)');const ordinary=timing(()=>{writer.task.usage.actions++;writer.flush();}),ordinaryWalBytes=size(path+'-wal');
  result={variant,copies,fragments:l.fragments.length,candidates:l.fragments.flatMap(f=>f.candidates).length,initial,initialWriteMs:initialWrite.ms,eventSerializedBytes:eventStep.value,eventCommitMs:eventStep.ms,eventWalBytes,ordinaryCommitMs:ordinary.ms,ordinaryWalBytes};old.close();
 }
 return {...result,closedDbBytes:size(path),maxRssKiB:process.resourceUsage().maxRSS};
}
if(mode==='worker')console.log(json(await worker()));
else {
 mkdirSync(outputPath,{recursive:true});const rows=[];
 for(const copies of [1,2,4,8,16])for(const variant of ['compressed','shared']){
  const run=spawnSync(process.execPath,[...process.execArgv,process.argv[1],'worker',inputPath,outputPath,baselinePath,variant,String(copies)],{encoding:'utf8',maxBuffer:8*1024*1024});
  writeFileSync(join(outputPath,`${variant}-${copies}.log`),run.stdout+run.stderr);if(run.status!==0)throw Error(`${variant}/${copies} failed: ${run.stderr}`);
  const row=JSON.parse(run.stdout.trim());rows.push(row);writeFileSync(join(outputPath,'results.json'),json({inputPath,inputSha256:taskDigest(readFileSync(inputPath)),baselinePath,node:process.version,rows}));console.log(json({variant,copies,parity:row.parity,eventWalBytes:row.eventWalBytes,eventCommitMs:row.eventCommitMs,closedDbBytes:row.closedDbBytes}));
 }
}
