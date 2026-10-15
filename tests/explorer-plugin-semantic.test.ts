import { join } from 'node:path';
import { it,expect,vi } from 'vitest';
import { ExplorerPlugin,ExplorerStore,type Decision } from '@interaction/explorer-plugin';
import { semanticRejection,type SemanticReview } from '../packages/explorer-plugin/src/semantic-review.js';
import { reviewNext,type ReviewContext } from '../packages/explorer-plugin/src/reviews.js';
import { explorerFixture,fakeProviders,semanticPopupHtml } from './explorer-plugin-helpers.js';

const grounded={choice:'click',evidenceRefs:['current','actions','effect:click'],reason:'Captured child choice panel supports a local expansion.',interfaceOnly:true,externalWrite:false};

it('counts identity resolutions as progress so several pending identities do not end the round early',async()=>{
 const f=await explorerFixture(['A','B','C','D','E'].map(name=>`<button type="button" id="${name}" onclick="this.disabled=true">${name}</button>`).join('')),resolved=new Set<string>();
 const hypotheses=(sid:string)=>f.host.observation(sid).controls.filter(c=>c.tag==='button').map(c=>({id:`pending:${c.stableKey}`,localId:c.localId,status:resolved.has(`pending:${c.stableKey}`)?'resolved':'pending',candidateIds:[],provisionalIdentityId:c.identityId,revisions:[]}));
 const host=new Proxy(f.host,{get(target,key){
  if(key==='observation')return (...args:Parameters<typeof target.observation>)=>{const o=target.observation(...args);return {...o,controls:o.controls.map(c=>c.tag==='button'&&!resolved.has(`pending:${c.stableKey}`)?{...c,hypothesisId:`pending:${c.stableKey}`}:c)};};
  if(key==='list')return (sid:string,kind:string)=>kind==='hypothesis'?hypotheses(sid):target.list(sid,kind);
  if(key==='command')return async(sid:string,command:any)=>{if(command.type==='resolveIdentity'&&command.hypothesisId.startsWith('pending:')){resolved.add(command.hypothesisId);return;}return target.command(sid,command);};
  const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;
 }});
 const plugin=new ExplorerPlugin(host,new ExplorerStore(':memory:'),fakeProviders(f.url));
 try{const task=plugin.create({url:f.url,sessionOptions:{settleMs:0,observeTimeoutMs:100},budget:{rounds:1}});plugin.start(task.id);await plugin.waitForIdle();const view=plugin.view(task.id);expect(resolved.size).toBe(5);expect(view.task.status).toBe('completed');expect(view.task.usage.actions).toBe(5);expect(view.decisions.filter(d=>d.actor==='llm')).toHaveLength(0);}
 finally{await plugin.close();await f.close();}
});

it.each(['grounded','invented-reference','uncertain','veto'] as const)('uses a bounded semantic fallback with %s evidence on a real popup control',async(mode)=>{
 const f=await explorerFixture(semanticPopupHtml),p=fakeProviders(f.url,{url:f.url,label:'Picker',kind:'click'}),original=p.jev.decide;
 p.jev.decide=async(r,s)=>{
  if(r.purpose==='control-classification')return {value:'interaction',confidence:1,model:'mock'};
  if(r.purpose==='control-risk')return {value:Object.fromEntries(Object.keys(r.checks!).map(k=>[k,mode==='veto'&&k.startsWith('external_')?.99:.5])),model:'mock'};
  return original(r,s);
 };
 p.llm.decide=async(r,s)=>r.purpose==='operation-clarification'?{model:'mock',value:mode==='invented-reference'?{...grounded,evidenceRefs:['invented']}:mode==='uncertain'?{...grounded,choice:'uncertain',interfaceOnly:null,externalWrite:null}:grounded}:original(r,s);
 const path=join(f.dir,'semantic.sqlite');let plugin=new ExplorerPlugin(f.host,new ExplorerStore(path),p);
 try {const task=plugin.create({url:f.url,goal:'Open Picker',sessionOptions:{settleMs:0,observeTimeoutMs:300},budget:{rounds:1}});plugin.start(task.id);await plugin.waitForIdle();const view=plugin.view(task.id);
  const calls=view.decisions.filter(d=>d.purpose==='operation-clarification');expect(calls).toHaveLength(mode==='veto'?0:1);
  expect(view.task.usage.actions,JSON.stringify({reason:view.task.reason,plan:view.task.plan})).toBe(mode==='grounded'?1:0);
  if(mode==='grounded'){
   expect(view.task.status).toBe('completed');expect(calls[0].status).toBe('applied');
   expect(view.decisions.find(d=>d.id===calls[0].triggeredBy)?.purpose).toBe('control-risk');
   expect(view.events.some(e=>e.decisionId===calls[0].id&&e.type==='decision.effect'&&(e.data as any).kind==='review')).toBe(true);
  } else if(mode!=='veto'){
   expect(calls[0].status).toBe('rejected');expect(view.task.plan.some(i=>i.reason==='operation_risk_unresolved')).toBe(true);
   // Simulate interruption after saving a result but before marking the review drained.
   const saved=plugin.store.task(task.id);saved.status='running';saved.rounds[0].status='running';saved.rounds[0].reviewed=[];plugin.store.save(saved);await plugin.close();
   plugin=new ExplorerPlugin(f.host,new ExplorerStore(path),p);expect(plugin.view(task.id).task.status).toBe('paused');
   plugin.start(task.id);await plugin.waitForIdle();const resumed=plugin.view(task.id);expect(resumed.task.rounds).toHaveLength(1);expect(resumed.decisions.filter(d=>d.purpose==='operation-clarification')).toHaveLength(1);expect(resumed.task.usage.actions).toBe(0);expect(resumed.task.usage.modelRequests).toBeGreaterThan(view.task.usage.modelRequests);
  }
 } finally {await plugin.close();await f.close();}
});

it('pauses an ambiguous purpose for missing LLM configuration and resumes with fresh evidence',async()=>{
 const f=await explorerFixture(semanticPopupHtml),p=fakeProviders(f.url,{url:f.url,label:'Picker',kind:'click'}),original=p.jev.decide;
 p.jev.decide=async(r,s)=>r.purpose==='control-classification'?{value:'interaction',confidence:1,model:'mock'}:r.kind==='checklist'?{value:Object.fromEntries(Object.keys(r.checks!).map(k=>[k,.5])),model:'mock'}:original(r,s);
 const plugin=new ExplorerPlugin(f.host,new ExplorerStore(':memory:'),{jev:p.jev});
 try {const task=plugin.create({url:f.url,sessionOptions:{settleMs:0,observeTimeoutMs:300},budget:{rounds:1,actions:1}});plugin.start(task.id);await plugin.waitForIdle();const before=plugin.view(task.id);
  expect(before.task.status).toBe('configuration_required');expect(before.task.usage.actions).toBe(0);
  plugin.router.providers.llm={name:'mock',model:'mock',decide:async()=>({model:'mock',value:grounded})};
  plugin.start(task.id);await plugin.waitForIdle();const after=plugin.view(task.id);expect(after.task.usage.actions).toBe(1);expect(after.task.usage.modelRequests).toBeGreaterThan(before.task.usage.modelRequests);
 }finally{await plugin.close();await f.close();}
});

it('cancels a pending semantic clarification on takeover and never applies its late answer',async()=>{
 const f=await explorerFixture(semanticPopupHtml),p=fakeProviders(f.url,{url:f.url,label:'Picker',kind:'click'}),original=p.jev.decide;
 let began!:()=>void,finish!:(value:any)=>void;const waiting=new Promise<void>(resolve=>began=resolve);
 p.jev.decide=async(r,s)=>r.purpose==='control-classification'?{value:'interaction',confidence:1,model:'mock'}:r.kind==='checklist'?{value:Object.fromEntries(Object.keys(r.checks!).map(k=>[k,.5])),model:'mock'}:original(r,s);
 p.llm.decide=async(r,s)=>r.purpose==='operation-clarification'?new Promise(resolve=>{finish=resolve;began();}):original(r,s);
 const plugin=new ExplorerPlugin(f.host,new ExplorerStore(':memory:'),p);
 try {const task=plugin.create({url:f.url,goal:'Open Picker',sessionOptions:{settleMs:0,observeTimeoutMs:300},budget:{rounds:1}});plugin.start(task.id);await waiting;await plugin.pause(task.id);finish({model:'mock',value:grounded});await plugin.waitForIdle();const view=plugin.view(task.id);
  expect(view.task.status).toBe('paused');expect(view.task.usage.actions).toBe(0);const decision=view.decisions.find(d=>d.purpose==='operation-clarification')!;expect(decision.status).toBe('cancelled');expect(view.events.some(e=>e.decisionId===decision.id&&e.type==='decision.effect')).toBe(false);
 }finally{await plugin.close();await f.close();}
});

it.each(['veto','missing-reference','missing-effect','wrong-choice'] as const)('rejects %s in structured semantic answers',mode=>{
 const request={options:{click:'Allowed',uncertain:'Unknown'},evidence:{current:{},actions:{},'effect:click':{}},requiredEvidence:{click:['current','actions','effect:click']},operation:true} as unknown as SemanticReview;
 const answer=mode==='veto'?{...grounded,externalWrite:true}:mode==='missing-reference'?{...grounded,evidenceRefs:['current']}:mode==='missing-effect'?{...grounded,interfaceOnly:null}:{...grounded,choice:'delete'};
 expect(semanticRejection(request,answer)).toBeDefined();
});

it.each(['ambiguous','independent','incompatible','uncertain'] as const)('handles %s identities without using historical success as current coverage',async(mode)=>{
 const control={localId:'current',instanceId:'current',hypothesisId:'h',tag:'button',role:'button',label:'Same',stableKey:'stable',region:'main'};
 const history={...control,localId:'old',instanceId:'old',stableKey:mode==='incompatible'?'other':'stable'};
 const hypothesis={id:'h',status:'pending',provisionalIdentityId:'fresh',candidateIds:['prior'],revisions:[]};
 const o={id:'now',sessionId:'s',instanceScope:'doc',url:'http://fixture/',controls:[control],regions:[]};
 const chosen={id:'jev',actor:'jev',answer:{value:mode==='independent'?'independent':'uncertain'},resolution:{source:mode==='independent'?'jev':'program',value:'independent'}} as Decision;
 const apply=vi.fn(async(_d:Decision,_cmd:unknown)=>{}),clarify=vi.fn(async(request:SemanticReview)=>{
  expect(request.requiredEvidence.prior).toEqual(['current','historical:prior']);
  return {value:mode==='uncertain'?'uncertain':'prior',decision:chosen};
 });
 const c={observation:o,task:{plan:[{required:true,dispatchScope:true,scope:{url:o.url},prerequisites:[]}],rounds:[{reviewed:[]}]},host:{actions:()=>[],regionReviewMaterial:()=>({enabled:false}),controlClassificationMaterial:()=>({controls:[]}),list:(_sid:string,kind:string)=>kind==='hypothesis'?[hypothesis]:[{id:'prior',occurrences:[{observationId:'before',localId:'old'}]}],observation:()=>({controls:[history]})},choose:async()=>({value:'independent',decision:chosen}),refresh:async()=>false,clarify,apply,gap:vi.fn()} as unknown as ReviewContext;
 expect(await reviewNext(c)).toBe(true);expect(clarify).toHaveBeenCalledTimes(['ambiguous','uncertain'].includes(mode)?1:0);
 expect(apply.mock.calls[0][1]).toMatchObject({type:'resolveIdentity',identityId:mode==='ambiguous'?'prior':'fresh',guard:{observationId:'now',revision:0}});
 expect(c.task.plan[0].status).not.toBe('succeeded');
});
