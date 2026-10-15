import { describe,it,expect,vi } from 'vitest';
import { ExplorerStore,ExplorerError,jevProvider,llmProvider,providersFromEnv,type ModelRequest,type Provider,type Task } from '@interaction/explorer-plugin';
import { DecisionRouter } from '../packages/explorer-plugin/src/router.js';
const req:Omit<ModelRequest,'id'>={purpose:'next-action',kind:'choice',instructions:'Select the best option',state:{observationId:'o'},options:{a:'A',b:'B',uncertain:'Unsure'}};
const task=()=>({id:'t',revision:1,rounds:[],usage:{modelRequests:0}} as unknown as Task);
function fixture(jev?:Provider,llm?:Provider,timeoutMs=100){const store=new ExplorerStore(':memory:');const router=new DecisionRouter(store,{jev,llm,timeoutMs},t=>t.usage.modelRequests++);return {store,router};}
const provider=(name:string,value:unknown,confidence?:number):Provider=>({name,model:name,decide:vi.fn(async()=>({value,model:name,confidence}))});
describe('explorer provider routing',()=>{
 it('uses confident JEV alone, and forwards uncertainty to LLM with durable references',async()=>{
   const j=provider('j','a',.95),l=provider('l','b');const f=fixture(j,l);
   expect((await f.router.decide(task(),req,new AbortController().signal,()=>true)).answer.value).toBe('a');expect(l.decide).not.toHaveBeenCalled();
   j.decide=vi.fn(async()=>({value:'uncertain',model:'j',confidence:1}));
   expect((await f.router.decide(task(),req,new AbortController().signal,()=>true)).answer.value).toBe('b');
   const decisions=f.store.decisions('t');expect(decisions.at(-1)?.fallbackFrom).toBe(decisions.at(-2)?.id);expect(f.store.events('t').some(e=>e.type==='decision.fallback')).toBe(true);f.store.close();
 });
 it('falls back on unavailable or invalid JEV; generation skips JEV',async()=>{
   const j=provider('j','outside',1),l=provider('l','a');const f=fixture(j,l);
   await f.router.decide(task(),req,new AbortController().signal,()=>true);expect(l.decide).toHaveBeenCalledTimes(1);
   j.decide=vi.fn(async()=>{throw new Error('secret-key')});await f.router.decide(task(),req,new AbortController().signal,()=>true);
   l.decide=vi.fn(async()=>({value:{text:'plan'},model:'l'}));await f.router.decide(task(),{...req,kind:'generate'},new AbortController().signal,()=>true);expect(j.decide).not.toHaveBeenCalled();expect(JSON.stringify(f.store.events('t'))).not.toContain('secret-key');f.store.close();
   const unavailable=fixture(j,provider('l','a'));await unavailable.router.decide(task(),req,new AbortController().signal,()=>true);expect(j.decide).toHaveBeenCalledTimes(1);expect(JSON.stringify(unavailable.store.events('t'))).not.toContain('secret-key');unavailable.store.close();
 });
 it('records stale and cancelled responses without permitting application',async()=>{
   let finish!:(v:any)=>void;const j:Provider={name:'j',model:'j',decide:()=>new Promise(r=>finish=r)};const f=fixture(j,provider('l','b'));
   let current=true;const pending=f.router.decide(task(),req,new AbortController().signal,()=>current);current=false;finish({value:'a',model:'j',confidence:1});await expect(pending).rejects.toMatchObject({code:'STALE_DECISION'});expect(f.store.decisions('t')[0].status).toBe('stale');
   current=true;const controller=new AbortController();const p=f.router.decide(task(),req,controller.signal,()=>current);controller.abort();await expect(p).rejects.toMatchObject({code:'CANCELLED'});finish({value:'a',model:'j',confidence:1});expect(f.store.decisions('t').at(-1)?.status).toBe('cancelled');f.store.close();
 });
 it('bounds providers that ignore AbortSignal and requires an LLM for text',async()=>{
   const f=fixture({name:'j',model:'j',decide:()=>new Promise(()=>{})},provider('l','a'),5);
   expect((await f.router.decide(task(),req,new AbortController().signal,()=>true)).answer.value).toBe('a');f.store.close();
   const no=fixture(provider('j','a',1));await expect(no.router.decide(task(),{...req,kind:'generate'},new AbortController().signal,()=>true)).rejects.toMatchObject({code:'CONFIGURATION_REQUIRED'});no.store.close();
 });
 it('treats noul as probability, not confidence',async()=>{
   const j:Provider={name:'j',model:'j',decide:vi.fn(async()=>({value:true,model:'j',probability:.95}))};const l=provider('l',false);const f=fixture(j,l);const r={...req,kind:'noul' as const};
   expect((await f.router.decide(task(),r,new AbortController().signal,()=>true)).answer.value).toBe(true);expect(l.decide).not.toHaveBeenCalled();j.decide=async()=>({value:true,model:'j',probability:.5});expect((await f.router.decide(task(),r,new AbortController().signal,()=>true)).answer.value).toBe(false);f.store.close();
 });
 it('keeps ranking ties and missing operation evidence away from LLM without rewriting the model answer',async()=>{
   const j=provider('j','uncertain',.4),l=provider('l','b'),f=fixture(j,l);
   const ranked=await f.router.decide(task(),{...req,policy:'ranking',fallbackOption:'a'},new AbortController().signal,()=>true);
   expect(ranked.answer.value).toBe('a');expect(ranked.decision.answer?.value).toBe('uncertain');expect(ranked.decision.resolution).toMatchObject({source:'program',value:'a',reason:'stable_candidate_order'});
   const gate=await f.router.decide(task(),{...req,purpose:'control-risk',policy:'evidence-gate'},new AbortController().signal,()=>true);
   expect(gate.answer.value).toBe('uncertain');expect(l.decide).not.toHaveBeenCalled();expect(f.store.events('t').some(e=>e.actor==='program'&&e.type==='decision.resolved')).toBe(true);
   await expect(f.router.decide(task(),{...req,policy:'ranking',fallbackOption:'not-an-option'},new AbortController().signal,()=>true)).rejects.toMatchObject({code:'INVALID_ROUTING_POLICY'});expect(l.decide).not.toHaveBeenCalled();f.store.close();
 });
 it('retains discovery but defers uncertain evidence and keeps identity independent without LLM',async()=>{
   const j=provider('j','include',.2),l=provider('l','b'),f=fixture(j,l),signal=new AbortController().signal;
   expect((await f.router.decide(task(),{...req,policy:'discovery',options:{include:'Region',uncertain:'Unknown'}},signal,()=>true)).answer.value).toBe('include');
   j.decide=async()=>({value:'approve',confidence:.76,model:'j'});
   expect((await f.router.decide(task(),{...req,policy:'evidence-gate',options:{approve:'Interface',uncertain:'Unknown'}},signal,()=>true)).answer.value).toBe('uncertain');
   j.decide=async()=>({value:'same',confidence:.76,model:'j'});
   expect((await f.router.decide(task(),{...req,policy:'identity',options:{same:'Historical identity',independent:'Separate target',uncertain:'Unknown'}},signal,()=>true)).answer.value).toBe('independent');
   expect(l.decide).not.toHaveBeenCalled();f.store.close();
 });
 it('cannot use any confidence to shrink scope without explicit permission',async()=>{
   const j=provider('j','sample',1),l=provider('l','skip'),f=fixture(j,l),signal=new AbortController().signal;
   const request={...req,policy:'coverage' as const,options:{all:'All',sample:'Sample',skip:'Exclude',uncertain:'Unknown'}};
   for(const value of ['sample','skip','uncertain']){j.decide=async()=>({value,confidence:1,model:'j'});const result=await f.router.decide(task(),request,signal,()=>true);expect(result.answer.value).toBe('all');expect(result.decision.answer?.value).toBe(value);}
   j.decide=async()=>({value:'sample',confidence:.4,model:'j'});
   expect((await f.router.decide(task(),{...request,allowedReductions:['sample']},signal,()=>true)).answer.value).toBe('sample');
   expect(l.decide).not.toHaveBeenCalled();f.store.close();
 });
 it('uses calibrated overrides only for the relevant judgment and rejects contradicting evidence',async()=>{
   const j=provider('j','display',.85),l=provider('l','display'),f=fixture(j,l),signal=new AbortController().signal;
   f.router.providers.thresholds={classification:.9,identity:.7};
   const request={...req,policy:'classification' as const,options:{display:'Read-only',interaction:'Possible action',uncertain:'Unknown'}};
   expect((await f.router.decide(task(),request,signal,()=>true)).answer.value).toBe('uncertain');
   j.decide=async()=>({value:'display',confidence:1,model:'j'});
   expect((await f.router.decide(task(),{...request,blockedOptions:['display']},signal,()=>true)).answer.value).toBe('uncertain');
   j.decide=async()=>({value:'interaction',confidence:.2,model:'j'});
   expect((await f.router.decide(task(),request,signal,()=>true)).answer.value).toBe('interaction');
   expect(l.decide).not.toHaveBeenCalled();f.store.close();
 });
 it('keeps atomic risk probabilities separate and leaves ambiguous evidence unresolved',async()=>{
   const j=provider('j',{interface_click:.96,external_click:.4}),l=provider('l','click'),f=fixture(j,l);
   const request={...req,kind:'checklist' as const,policy:'evidence-gate' as const,checks:{interface_click:{instructions:'Interface only?'},external_click:{instructions:'External effect?'}}};
   const result=await f.router.decide(task(),request,new AbortController().signal,()=>true);
   expect(result.answer.value).toEqual({interface_click:true,external_click:null});expect(result.decision.answer?.value).toEqual({interface_click:.96,external_click:.4});expect(result.decision.resolution?.bounds).toEqual({low:.1,high:.9});expect(l.decide).not.toHaveBeenCalled();f.store.close();
 });
 it('halts built-in judgments on a JEV outage instead of cascading into paid LLM calls',async()=>{
   const j=provider('j','a',1),l=provider('l','a'),f=fixture(j,l);j.decide=async()=>{throw new ExplorerError('PROVIDER_HTTP_503');};
   await expect(f.router.decide(task(),{...req,policy:'ranking',fallbackOption:'a'},new AbortController().signal,()=>true)).rejects.toMatchObject({code:'PROVIDER_HTTP_503'});
   await expect(f.router.decide(task(),{...req,policy:'ranking',fallbackOption:'a'},new AbortController().signal,()=>true)).rejects.toMatchObject({code:'JEV_TEMPORARILY_UNAVAILABLE'});
   expect(l.decide).not.toHaveBeenCalled();expect(f.store.events('t').some(e=>e.type==='decision.deferred')).toBe(true);f.store.close();
 });
 it('keeps recorded gaps unless JEV confidently requests new planning',async()=>{
   const j=provider('j','replan',.6),l=provider('l','replan'),f=fixture(j,l);const r={...req,policy:'planning-gate' as const,options:{retain:'Keep recorded gaps',replan:'Generate missing route',uncertain:'No evidence'}};
   expect((await f.router.decide(task(),r,new AbortController().signal,()=>true)).answer.value).toBe('retain');
   j.decide=async()=>({value:'replan',confidence:.95,model:'j'});expect((await f.router.decide(task(),r,new AbortController().signal,()=>true)).answer.value).toBe('replan');expect(l.decide).not.toHaveBeenCalled();f.store.close();
 });
});
it('matches documented JEV wire formats for both endpoints and validates distributions',async()=>{
 for(const vendor of ['typesafe','openrouter'] as const){let body:any,auth='';const f=vi.fn(async(_url:any,init:any)=>{body=JSON.parse(init.body);auth=init.headers.authorization;return Response.json({model:'jev-version',answers:{decision:{type:'choice',choice:'a',confidence:.9,probabilities:{a:.9,b:.05,uncertain:.05}}},usage:{input_tokens:15,output_tokens:3}});});
 const p=jevProvider({provider:vendor,endpoint:'https://test.invalid/decisions',model:'alias',apiKey:'test-secret',fetch:f as typeof fetch});const answer=await p.decide({...req,id:'id'},new AbortController().signal);expect(body.questions.decision.criteria).toEqual(req.options);expect(auth).toBe('Bearer test-secret');expect(answer.model).toBe('jev-version');expect(answer.usage?.input_tokens).toBe(15);}
});
it('sends structured generation through LLM and keeps configuration secrets server-side',async()=>{
 let sent:any;const p=llmProvider({endpoint:'https://test.invalid/chat/completions',model:'test',fetch:(async(_u,init)=>{sent=JSON.parse(init!.body as string);return Response.json({model:'actual',choices:[{message:{content:'{"items":[]}'}}],usage:{prompt_tokens:20,completion_tokens:4}});}) as typeof fetch});
 const result=await p.decide({...req,id:'id',kind:'generate',schema:{type:'object'}},new AbortController().signal);expect(result.value).toEqual({items:[]});expect(sent.messages[0].content).toContain('untrusted');
 expect(providersFromEnv({EXPLORER_JEV_API_KEY:'j'}).jev?.name).toBe('typesafe');expect(()=>providersFromEnv({EXPLORER_NOUL_LOW:'.9',EXPLORER_NOUL_HIGH:'.1'})).toThrow();
});
it('rejects model-invented operation kinds instead of persisting unmatchable plans',async()=>{
 const {planSchema}=await import('../packages/explorer-plugin/src/schema.js');
 const plan=(kind:string)=>({items:[{title:'Alpha',scope:{label:'Alpha',kind},prerequisites:[],completion:'Observe result',required:true,reason:'Goal'}]});
 for(const kind of ['button','state','enabled','clicked-once'])expect(planSchema.safeParse(plan(kind)).success).toBe(false);
 expect(planSchema.safeParse(plan('click')).success).toBe(true);
});
it('pins OpenRouter parameters and preserves safe input/output diagnostics on truncation',async()=>{
 let sent:any;const response={id:'response-id',provider:'Alibaba',model:'actual',choices:[{finish_reason:'length',message:{content:'{"items":[',reasoning:'private reasoning'}}],usage:{completion_tokens:8192}};
 const p=llmProvider({endpoint:'https://test.invalid/completions',model:'alias',provider:'openrouter',upstreamProvider:'Alibaba',maxOutputTokens:8192,reasoningEffort:'low',apiKey:'test-secret',fetch:(async(_u,init)=>{sent=JSON.parse(init!.body as string);return Response.json(response);}) as typeof fetch});
 const f=fixture(undefined,p);await expect(f.router.decide(task(),{...req,kind:'generate'},new AbortController().signal,()=>true)).rejects.toMatchObject({code:'MODEL_OUTPUT_TRUNCATED'});
 expect(sent.provider).toEqual({only:['Alibaba'],allow_fallbacks:false,require_parameters:true});expect(sent.reasoning).toEqual({effort:'low'});expect(sent.max_tokens).toBe(8192);
 const decision=f.store.decisions('t')[0];expect(decision.input).toEqual(sent);expect(decision.output).toMatchObject({id:'response-id',provider:'Alibaba',content:'{"items":[',finishReason:'length'});expect(JSON.stringify(decision)).not.toContain('test-secret');expect(JSON.stringify(decision)).not.toContain('private reasoning');f.store.close();
});

it('sends independent risk questions in one JEV request and rejects incomplete batches',async()=>{
 let body:any;let incomplete=false;
 const p=jevProvider({endpoint:'https://test.invalid/decisions',model:'j',fetch:(async(_url,init)=>{body=JSON.parse(init!.body as string);return Response.json({model:'j',answers:{interface_click:{type:'noul',noul:.96},...(!incomplete?{external_click:{type:'noul',noul:.02}}:{})}});}) as typeof fetch});
 const request={...req,id:'batch',kind:'checklist' as const,checks:{interface_click:{instructions:'Only interface state?'},external_click:{instructions:'Business write?'}}};
 expect((await p.decide(request,new AbortController().signal)).value).toEqual({interface_click:.96,external_click:.02});
 expect(Object.keys(body.questions)).toEqual(['interface_click','external_click']);expect(body.questions.interface_click.type).toBe('noul');expect(body.questions.external_click.instructions).toContain('Business write?');
 incomplete=true;await expect(p.decide(request,new AbortController().signal)).rejects.toMatchObject({code:'INVALID_CHECKLIST'});
});
it.each(['context_limit','unspecified'])('records only a safe HTTP diagnostic for %s failures',async(category)=>{
 const fetcher=vi.fn(async()=>Response.json({error:{message:category==='context_limit'?'HTTP 400: {"detail":{"error_type":"max_tokens_exceeded"}} test-secret':'test-secret',metadata:{authorization:'Bearer test-secret'}}},{status:400}));
 const p=jevProvider({endpoint:'https://test.invalid/decisions',model:'j',apiKey:'test-secret',fetch:fetcher as typeof fetch}),llm=provider('l','a'),f=fixture(p,llm);
 try {await expect(f.router.decide(task(),{...req,policy:'ranking',fallbackOption:'a'},new AbortController().signal,()=>true)).rejects.toMatchObject({code:'PROVIDER_HTTP_400'});
  expect(f.store.decisions('t')[0].output).toEqual({httpStatus:400,category,responseBodyRecorded:false});expect(JSON.stringify(f.store.decisions('t'))).not.toContain('test-secret');expect(JSON.stringify(f.store.events('t'))).not.toContain('test-secret');expect(fetcher).toHaveBeenCalledTimes(1);expect(llm.decide).not.toHaveBeenCalled();
 }finally{f.store.close();}
});
it('configures per-purpose thresholds and ignores the retired grouping floor',()=>{
 const p=providersFromEnv({EXPLORER_GROUPING_THRESHOLD:'0.01',EXPLORER_CLASSIFICATION_THRESHOLD:'.91',EXPLORER_IDENTITY_THRESHOLD:'.94',EXPLORER_OPERATION_NOUL_LOW:'.05',EXPLORER_OPERATION_NOUL_HIGH:'.95'});
 expect(p.thresholds).toMatchObject({classification:.91,identity:.94});expect(p.operationProbability).toEqual({low:.05,high:.95});expect(p.groupingThreshold).toBeUndefined();
 expect(()=>providersFromEnv({EXPLORER_OPERATION_NOUL_LOW:'.7'})).toThrow();
});
