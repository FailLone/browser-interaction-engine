import { afterEach,beforeEach,expect,it,vi } from 'vitest';
import { DecisionRouter } from '../packages/explorer-plugin/src/router.js';
import { ExplorerStore,ExplorerError,type ModelRequest,type ModelAnswer,type Provider,type Task } from '@interaction/explorer-plugin';
const req:Omit<ModelRequest,'id'>={purpose:'test-budget',kind:'choice',instructions:'Choose',state:{},options:{a:'A',uncertain:'Unknown'}};
const task=(used=75):Task=>({id:'t',revision:1,rounds:[],activeSince:Date.now(),budget:{durationMs:100,modelRequests:20,rounds:3,actions:20},usage:{durationMs:used,modelRequests:4,rounds:1,actions:2}} as unknown as Task);
const provider=(decide:Provider['decide']):Provider=>({name:'fixture',model:'fixture',decide});
beforeEach(()=>{vi.useFakeTimers();vi.setSystemTime(new Date('2026-10-16T08:00:00Z'));});
afterEach(()=>vi.useRealTimers());

it('cancels at the cumulative task deadline even when a provider ignores abort, without fallback or accepting its late result',async()=>{
 const store=new ExplorerStore(':memory:');let resolve!:(v:any)=>void,received:AbortSignal|undefined;
 const jev=provider(vi.fn((_r,s)=>{received=s;return new Promise<ModelAnswer>(r=>resolve=r);})),llm=provider(vi.fn(async()=>({value:'a',model:'llm'})));
 const router=new DecisionRouter(store,{jev,llm,timeoutMs:1000},t=>t.usage.modelRequests++),t=task();
 try{
  const pending=router.decide(t,req,new AbortController().signal,()=>true),rejected=expect(pending).rejects.toMatchObject({code:'BUDGET_EXHAUSTED'});
  await vi.advanceTimersByTimeAsync(24);expect(received?.aborted).toBe(false);
  await vi.advanceTimersByTimeAsync(1);await rejected;expect(received?.aborted).toBe(true);expect(llm.decide).not.toHaveBeenCalled();
  expect(t.usage).toEqual({durationMs:75,modelRequests:5,rounds:1,actions:2});
  expect(store.decisions('t')[0]).toMatchObject({status:'cancelled',reason:'BUDGET_EXHAUSTED',elapsedMs:25});
  const events=store.events('t').length;resolve({value:'a',model:'late',confidence:1});await Promise.resolve();
  expect(store.events('t')).toHaveLength(events);expect(store.decisions('t')[0].answer).toBeUndefined();expect(store.events('t').some(e=>e.type==='decision.fallback'||e.type==='decision.returned')).toBe(false);
 }finally{store.close();}
});

it('keeps budget exhaustion ahead of a provider AbortError when abort is honored',async()=>{
 const store=new ExplorerStore(':memory:'),llm=provider(vi.fn(async()=>({value:'a',model:'llm'})));
 const jev=provider((_r,s)=>new Promise((_resolve,reject)=>s.addEventListener('abort',()=>reject(new DOMException('Aborted','AbortError')),{once:true})));
 const router=new DecisionRouter(store,{jev,llm,timeoutMs:1000},t=>t.usage.modelRequests++);
 try{const pending=router.decide(task(),req,new AbortController().signal,()=>true),rejected=expect(pending).rejects.toMatchObject({code:'BUDGET_EXHAUSTED'});await vi.advanceTimersByTimeAsync(25);await rejected;expect(llm.decide).not.toHaveBeenCalled();expect(store.decisions('t')[0].reason).toBe('BUDGET_EXHAUSTED');}finally{store.close();}
});

it.each(['service-error','successful-answer'] as const)('rejects %s delivered after the task deadline even before timers can run',async(mode)=>{
 const store=new ExplorerStore(':memory:'),llm=provider(vi.fn(async()=>({value:'a',model:'llm'})));
 const jev=provider(async()=>{vi.setSystemTime(Date.now()+26);if(mode==='service-error')throw new ExplorerError('MODEL_OUTPUT_TRUNCATED');return {value:'a',confidence:1,model:'jev'};});
 const router=new DecisionRouter(store,{jev,llm,timeoutMs:1000},t=>t.usage.modelRequests++);
 try{await expect(router.decide(task(),req,new AbortController().signal,()=>true)).rejects.toMatchObject({code:'BUDGET_EXHAUSTED'});expect(llm.decide).not.toHaveBeenCalled();expect(store.decisions('t')[0]).toMatchObject({status:'cancelled',reason:'BUDGET_EXHAUSTED'});expect(store.events('t').some(e=>e.type==='decision.returned')).toBe(false);}finally{store.close();}
});

it.each([true,false])('gives a fallback only the remaining aggregate time rather than a fresh provider timeout (active clock: %s)',async(activeClock)=>{
 const store=new ExplorerStore(':memory:');let llmSignal:AbortSignal|undefined;
 const jev=provider(()=>new Promise(resolve=>setTimeout(()=>resolve({value:'uncertain',model:'jev',confidence:1}),15))),llm=provider(vi.fn((_r,s)=>{llmSignal=s;return new Promise<never>(()=>{});}));
 const router=new DecisionRouter(store,{jev,llm,timeoutMs:1000},t=>t.usage.modelRequests++),t=task();if(!activeClock)delete t.activeSince;
 try{const pending=router.decide(t,req,new AbortController().signal,()=>true),rejected=expect(pending).rejects.toMatchObject({code:'BUDGET_EXHAUSTED'});await vi.advanceTimersByTimeAsync(15);expect(llm.decide).toHaveBeenCalledOnce();await vi.advanceTimersByTimeAsync(10);await rejected;expect(llmSignal?.aborted).toBe(true);expect(t.usage.modelRequests).toBe(6);expect(store.decisions('t').at(-1)).toMatchObject({status:'cancelled',reason:'BUDGET_EXHAUSTED',elapsedMs:10});}finally{store.close();}
});

it('preserves elapsed usage across a paused task reload and does not charge the paused interval',async()=>{
 const store=new ExplorerStore(':memory:'),t=task(80);delete t.activeSince;const restored=JSON.parse(JSON.stringify(t)) as Task;vi.setSystemTime(Date.now()+10_000);restored.activeSince=Date.now();
 const llm=provider(()=>new Promise(()=>{})),router=new DecisionRouter(store,{llm,timeoutMs:1000},t=>t.usage.modelRequests++);
 try{const pending=router.decide(restored,{...req,kind:'generate'},new AbortController().signal,()=>true),rejected=expect(pending).rejects.toMatchObject({code:'BUDGET_EXHAUSTED'});await vi.advanceTimersByTimeAsync(19);expect(store.decisions('t')[0].status).toBe('requested');await vi.advanceTimersByTimeAsync(1);await rejected;expect(restored.usage.durationMs).toBe(80);expect(restored.usage.modelRequests).toBe(5);}finally{store.close();}
});

it('does not reserve or dispatch a model request when persisted usage has already exhausted the budget',async()=>{
 const store=new ExplorerStore(':memory:'),jev=provider(vi.fn(async()=>({value:'a',confidence:1,model:'jev'}))),reserve=vi.fn((t:Task)=>t.usage.modelRequests++),router=new DecisionRouter(store,{jev},reserve),t=task(101);
 try{await expect(router.decide(t,req,new AbortController().signal,()=>true)).rejects.toMatchObject({code:'BUDGET_EXHAUSTED'});expect(reserve).not.toHaveBeenCalled();expect(jev.decide).not.toHaveBeenCalled();expect(store.decisions('t')).toEqual([]);expect(t.usage.durationMs).toBe(101);}finally{store.close();}
});


it('does not return a decision whose structured validation overruns the remaining task time',async()=>{
 const store=new ExplorerStore(':memory:'),llm=provider(vi.fn(async()=>({value:{plan:'fixture'},model:'llm'}))),router=new DecisionRouter(store,{llm,timeoutMs:1000},t=>t.usage.modelRequests++);
 try{await expect(router.decide(task(),{...req,kind:'generate'},new AbortController().signal,()=>true,()=>{vi.setSystemTime(Date.now()+26);})).rejects.toMatchObject({code:'BUDGET_EXHAUSTED'});expect(store.decisions('t')[0]).toMatchObject({status:'cancelled',reason:'BUDGET_EXHAUSTED'});expect(store.events('t').some(e=>e.type==='decision.returned')).toBe(false);}finally{store.close();}
});
