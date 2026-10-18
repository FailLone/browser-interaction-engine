import {afterEach,expect,it} from 'vitest';
import {fragmentFixture,emptyLegacy} from './fragment-storage-helpers.js';
const fixtures:ReturnType<typeof fragmentFixture>[]=[];
afterEach(()=>{for(const f of fixtures.splice(0))f.close();});
const ledger=(legacy?:Parameters<typeof fragmentFixture>[1])=>{const f=fragmentFixture(':memory:',legacy);fixtures.push(f);return f.session;};
import {createServer} from 'node:http';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdtempSync,rmSync,mkdirSync,writeFileSync,readFileSync} from 'node:fs';
import {gunzipSync,gzipSync} from 'node:zlib';
import {tmpdir} from 'node:os';import {join,resolve} from 'node:path';
import {BrowserEngine,browserTraversalFragments,type Observation,type ActionCandidate} from '@interaction/browser';
import {SqliteStore} from '@interaction/storage-sqlite';
import {ExplorerStore,type Task} from '@interaction/explorer-plugin';
import {registerFragmentObservation,recordFragmentOutcome,fragmentActionEvidence,fragmentSamplingDecision} from '../packages/explorer-plugin/src/fragment-traversal.js';
import {emptyFragmentAccess,mapFragmentCandidates} from '../packages/explorer-plugin/src/fragment-traversal-core.js';
import {decideFragmentSampling} from '../packages/explorer-plugin/src/fragment-sampling.js';

const rows=JSON.parse(gunzipSync(readFileSync(new URL('./fixtures/fraggen-matching/okx-public-captures.json.gz',import.meta.url))).toString()) as {index:number;observation:Observation;actions:ActionCandidate[]}[];
const pair=()=>[0,4].map(index=>structuredClone(rows.find(r=>r.index===index)!));
it('establishes the frozen real 59-node OKX correspondence while retaining different external contexts',()=>{
 const [a,b]=pair();const projected=[a,b].map(r=>browserTraversalFragments(r.observation,r.actions,'authority'));
 const menus=projected.map((fs,i)=>{const t=[a,b][i].observation.controls.find(c=>c.tag==='button'&&c.name==='交易')!;const action=[a,b][i].actions.find(a=>a.localId===t.localId&&a.kind==='click')!;const fragment=fs.find(f=>f.candidates.some(c=>c.actionId===action.id))!;return {...fragment,id:'fragment-'+i,candidates:fragment.candidates.map(c=>({...c,id:c.actionId,access:emptyFragmentAccess()})),action};});
 expect(JSON.parse(menus[0].structure)).toHaveLength(59);expect(menus[0].structure).toBe(menus[1].structure);expect(menus[0].owner).toBe(menus[1].owner);
 const source=menus[0].candidates.find(c=>c.id===menus[0].action.id)!,target=menus[1].candidates.find(c=>c.id===menus[1].action.id)!;
 expect(source.guard).toBe(target.guard);expect(source.context).not.toBe(target.context);
 expect(JSON.parse(source.guard).modes).toHaveLength(4);
 expect(mapFragmentCandidates(menus[0],menus[1])).toContainEqual(expect.objectContaining({sourceCandidateId:source.id,targetCandidateId:target.id}));
 const d=decideFragmentSampling(target.id,target.context!,[{id:'example-origin',candidateId:source.id,context:source.context!,effect:'captured-effect'}]);
 expect(d.status).toBe('context-recheck-required');expect(d.coverageGranted).toBe(false);
 mkdirSync('.data/fraggen-sampling',{recursive:true});writeFileSync('.data/fraggen-sampling/frozen-pair.json',JSON.stringify({sourceObservation:a.observation.id,targetObservation:b.observation.id,localModeCount:4,externalEvidence:[source.context,target.context],mappings:mapFragmentCandidates(menus[0],menus[1]),firstNovelContext:d},null,2));
});
it('requires a directly observed agreeing context pair; unknown results or disagreement grant no speculative pruning',()=>{
 const a={id:'a',candidateId:'A',context:'ctx-a',effect:'same'},b={id:'b',candidateId:'B',context:'ctx-b',effect:'same'};
 expect(decideFragmentSampling('C','ctx-c',[a]).status).toBe('context-recheck-required');
 expect(decideFragmentSampling('C','ctx-c',[a,{...b,effect:undefined}]).status).toBe('context-recheck-required');
 expect(decideFragmentSampling('C','ctx-c',[a,b])).toMatchObject({status:'context-sample',assumption:'unverified-external-context',recheckBudget:1,sourceAttemptIds:['a','b'],coverageGranted:false});
 expect(decideFragmentSampling('C','ctx-a',[a,{...b,effect:'different'}]).status).toBe('observed-effect-conflict');
});
it('never lends inherited access along a missing or one-sided revoked edge',()=>{
 const l=emptyLegacy();for(const id of ['A','B','C'])l.fragments.push({id,structure:'s',owner:'o',revision:id,url:'https://fixture/'+id,source:{sessionId:'s',observationId:'o',regionId:id},candidates:[{id,path:'.',operation:'click',guard:'g',context:'ctx',access:emptyFragmentAccess()}]});
 l.mappings=[['A','B'],['B','C']].map(([sourceCandidateId,targetCandidateId])=>({sourceFragmentId:sourceCandidateId,targetFragmentId:targetCandidateId,sourceCandidateId,targetCandidateId,kind:'equivalent'}));
 l.events.push({id:'actual-A',fragmentId:'A',candidateId:'A',sessionId:'s',observationId:'o',afterId:'after',actionId:'a',effect:'same'});
 expect(fragmentSamplingDecision(ledger(l),'B')?.status).toBe('same-context');expect(fragmentSamplingDecision(ledger(l),'C')?.status).toBe('fresh');
 l.mappings[0].revoked={reason:'one-sided'};expect(fragmentSamplingDecision(ledger(l),'B')?.status).toBe('fresh');
 expect(l.events[0].id).toBe('actual-A');
});

it('bounds real context rechecks, skips a repeat, preserves unique work, then revokes on a real external dependency result',async()=>{
 // Fixed independent validation budget: 60 seconds / 40 browser commands.
 // Session startups and every execute count; no existing profile or DB is used.
 const start=Date.now();let commands=0;const count=()=>{commands++;if(commands>40||Date.now()-start>60000)throw Error('VALIDATION_BUDGET_EXCEEDED');};
 const server=createServer((req,res)=>{const page=(req.url||'/A').slice(1),newChild=page==='N'?'<a href="/new-child">New child</a>':'';res.setHeader('Content-Type','text/html');res.end(`<!doctype html><title>Sampling</title><aside><select id="mode" aria-label="External mode">${['A','B','C','D','N'].map(v=>`<option value="${v}" ${v===page?'selected':''}>${v}</option>`).join('')}</select></aside><nav aria-label="Public"><details id="menu" ontoggle="if(this.open)document.querySelector('output').textContent=document.querySelector('select').value==='D'?'different result':'same result'"><summary>Menu</summary><a href="/detail">Original child</a>${newChild}</details></nav><output></output><main><a href="/unique-${page}">Unique ${page}</a></main>`);});
 await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const root=`http://127.0.0.1:${(server.address() as any).port}`;
 const dir=mkdtempSync(join(tmpdir(),'sampling-v3-')),host=new BrowserEngine({persistence:new SqliteStore(join(dir,'engine'))});
 const l=ledger(),evidence:any[]=[];const options=(page:string)=>({url:root+'/'+page,coveragePolicy:'finite-ui-v1' as const,executionPolicy:'observed-ui' as const,headless:true,settleMs:60,observeTimeoutMs:1200,
 executionBoundary:{version:1 as const,programNavigation:'public-navigation-v1' as const,allowedOperations:['click','hover','focus','history'],urls:[{origin:root,pathnamePattern:'^/.*$',match:'route' as const}],exclusions:[]}});
 let activeSession:string|undefined;
 const open=async(page:string)=>{if(activeSession){count();await host.stop(activeSession);}count();const session=await host.createSession(options(page));activeSession=session.id;const before=host.observation(session.id),actions=host.actions(session.id),menu=actions.find(a=>a.label==='Menu'&&a.kind==='click')!;
  const frontier=registerFragmentObservation(l,before,actions,'authority',new Set(actions.map(a=>a.id)));expect(frontier.byAction.has(menu.id)).toBe(true);return {session,before,actions,menu,frontier};};
 const run=async(r:Awaited<ReturnType<typeof open>>,action=r.menu)=>{count();const receipt=await host.execute(r.session.id,action.id,'sample-'+commands,undefined,{observationId:r.before.id,profile:'observed-ui-exploration'});expect(receipt.status).toBe('succeeded');const after=host.observation(r.session.id);recordFragmentOutcome(l,r.frontier,receipt,{before:r.before,after});evidence.push({before:r.before,receipt,after});return receipt;};
 try{
  const a=await open('A');expect(fragmentActionEvidence(l,a.frontier,a.menu.id)?.sampling?.status).toBe('fresh');await run(a);
  const b=await open('B');expect(fragmentActionEvidence(l,b.frontier,b.menu.id)?.sampling?.status).toBe('context-recheck-required');await run(b);
  const c=await open('C'),sample=fragmentActionEvidence(l,c.frontier,c.menu.id);expect(sample,JSON.stringify([...l.rows('events')])).toMatchObject({pruned:true,coverageGranted:false,sampling:{status:'context-sample'}});
  expect([...l.rows('events')]).toHaveLength(2);const unique=c.actions.find(a=>a.label==='Unique C'&&a.kind==='click')!;expect(fragmentActionEvidence(l,c.frontier,unique.id)?.pruned).not.toBe(true);await run(c,unique);
  const beforeConflict=l.exportLegacy(),d=await open('D');expect(fragmentActionEvidence(l,d.frontier,d.menu.id)?.pruned).toBe(true);
  // A caller-authorized actual execution remains possible despite sampling;
  // required restore dispatch uses this same independent SDK execution path.
  await run(d);const reopened=fragmentActionEvidence(l,c.frontier,c.menu.id);expect(reopened).toMatchObject({pruned:false,sampling:{status:'observed-effect-conflict'}});
  const cold=ledger(JSON.parse(JSON.stringify(l.exportLegacy())));expect(fragmentActionEvidence(cold,c.frontier,c.menu.id)).toEqual(reopened);
  // Save both sampling states through the real store, close it, and read in a
  // new Node process. The worker never launches a browser or touches a live DB.
  const journal=join(dir,'sampling.sqlite'),store=new ExplorerStore(journal);
  for(const [id,ledger] of [['before',beforeConflict],['after',l.exportLegacy()]] as const)store.save({id,goal:'Sampling restart evidence',url:root,
   createdAt:'2026-10-18',updatedAt:'2026-10-18',revision:1,status:'paused',budget:{rounds:1,actions:40,durationMs:60000,modelRequests:0},
   usage:{rounds:1,actions:commands,durationMs:Date.now()-start,modelRequests:0},sessionOptions:{},sampleExcluded:[],exhaustive:false,
   plan:[],rounds:[],fragmentTraversal:ledger} as Task);
  store.close();
  const childCode=`import {createHash} from 'node:crypto';import {ExplorerStore} from '@interaction/explorer-plugin';import {fragmentSamplingDecision} from './packages/explorer-plugin/src/fragment-traversal.ts';import {TaskWriter} from './packages/explorer-plugin/src/task-writer.ts';
   const store=new ExplorerStore(process.argv[1]);console.log(JSON.stringify({pid:process.pid,states:['before','after'].map(id=>{const l=new TaskWriter(store,store.taskState(id)).fragments();return {id,hash:createHash('sha256').update(JSON.stringify(l.exportLegacy())).digest('hex'),decision:fragmentSamplingDecision(l,process.argv[2])};})}));store.close();`;
  const restarted=spawnSync(process.execPath,['--conditions=development','--import','tsx','--input-type=module','-e',childCode,journal,sample!.candidateId],{cwd:resolve('.'),encoding:'utf8',timeout:10000});
  expect(restarted.status,restarted.stderr).toBe(0);const restart=JSON.parse(restarted.stdout);expect(restart.pid).not.toBe(process.pid);
  expect(restart.states).toEqual([beforeConflict,l.exportLegacy()].map((saved,i)=>{const id=i?'after':'before',decision=fragmentSamplingDecision(ledger(saved),sample!.candidateId)!;return {id,hash:createHash('sha256').update(JSON.stringify(saved)).digest('hex'),decision:{...decision,evidenceRef:{...decision.evidenceRef,rootKey:id}}};}));
  const n=await open('N'),prior=ledger(beforeConflict);const fresh=registerFragmentObservation(prior,n.before,n.actions,'authority',new Set(n.actions.map(a=>a.id)));expect(fragmentActionEvidence(prior,fresh,n.menu.id)?.pruned).toBe(false);
  await run(n);const after=host.observation(n.session.id),newAction=host.actions(n.session.id).find(a=>a.label==='New child'&&a.kind==='click')!;expect(newAction).toBeDefined();count();const child=await host.execute(n.session.id,newAction.id,'new-child-real',undefined,{observationId:after.id,profile:'observed-ui-exploration'});expect(child.status).toBe('succeeded');
  count(); // Reserve and count the final browser close in finally.
  mkdirSync('.data/fraggen-sampling',{recursive:true});writeFileSync('.data/fraggen-sampling/browser-proof.json.gz',gzipSync(JSON.stringify({budget:{durationMs:60000,commands:40},elapsedMs:Date.now()-start,commands,opportunitiesBeforeConflict:3,menuDispatchesBeforeConflict:2,skippedRepeat:sample,uniqueActionId:unique.id,reopened,restart,ledger:l.exportLegacy(),evidence,newChildReceipt:child})));
 }finally{await host.close();await new Promise<void>(r=>server.close(()=>r()));rmSync(dir,{recursive:true,force:true});}
});

it('keeps a captured external IDREF dependency in the strict mode guard',()=>{
 const [a]=pair(),b=structuredClone(a);
 for(const r of [a,b]){
  const target=r.observation.controls.find(c=>c.tag==='button'&&c.name==='交易')!,mode=r.observation.controls.find(c=>c.expanded!==null&&c.expanded!==undefined&&c.name.includes('语言'))!;
  const references=target.classificationBinding?.references||[];
  target.classificationBinding={...target.classificationBinding!,nodes:target.classificationBinding?.nodes||[],text:'',truncated:false,references:[...references,{id:'external-mode',targetInstanceId:mode.instanceId,target:{nodes:[{instanceId:mode.instanceId,parentInstanceId:mode.reviewBinding!.parentInstanceId,tag:mode.tag,attributes:mode.reviewBinding!.attributes}],text:mode.name,truncated:false}}]};
 }
 b.observation.controls.find(c=>c.expanded!==null&&c.expanded!==undefined&&c.name.includes('语言'))!.expanded=true;
 const find=(r:typeof a)=>{const c=r.observation.controls.find(c=>c.tag==='button'&&c.name==='交易')!,action=r.actions.find(a=>a.localId===c.localId&&a.kind==='click')!;return browserTraversalFragments(r.observation,r.actions,'authority').flatMap(f=>f.candidates).find(c=>c.actionId===action.id);};
 expect(find(a)).toBeDefined();expect(find(b)).toBeDefined();expect(find(a)!.guard).not.toBe(find(b)!.guard);
});

it('declines incomplete references on a related external component member',()=>{
 const [r]=pair(),o=r.observation,target=o.controls.find(c=>c.tag==='button'&&c.name==='交易')!,mode=o.controls.find(c=>c.name.includes('语言'))!;
 o.components=[...o.components||[],{id:'related-component',basis:{status:'supported'},members:[{localId:target.localId},{localId:mode.localId}]}] as Observation['components'];
 mode.classificationBinding={nodes:[],text:'',truncated:false,references:[{id:'missing-mode',missing:true}]};
 const action=r.actions.find(a=>a.localId===target.localId&&a.kind==='click')!,diagnostics=new Map<string,string>();
 browserTraversalFragments(o,r.actions,'authority',diagnostics);
 expect(diagnostics.get(action.id)).toBe('mode:related_reference_incomplete');
});
