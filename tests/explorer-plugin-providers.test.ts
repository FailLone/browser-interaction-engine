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
