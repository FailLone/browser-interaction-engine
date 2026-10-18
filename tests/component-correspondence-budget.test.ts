import {execFileSync} from 'node:child_process';
import {writeFileSync,mkdirSync} from 'node:fs';
import {resolve} from 'node:path';
import {FragmentSession} from '../packages/explorer-plugin/src/fragment-session.js';
import {expect,it,vi} from 'vitest';
import {fragmentFixture} from './fragment-storage-helpers.js';
import {ComponentJudgments,type ComponentJudgmentContext} from '../packages/explorer-plugin/src/component-correspondence.js';
import type {ComponentCorrespondenceMaterial} from '@interaction/core';
import {llmProvider} from '../packages/explorer-plugin/src/providers.js';
import {ExplorerError,type Decision} from '../packages/explorer-plugin/src/types.js';
const material=(text='A'):ComponentCorrespondenceMaterial=>({policy:'fixture',status:'uncertain',reason:'local-content-change',sourceMaterial:JSON.stringify({text}),targetMaterial:JSON.stringify({text:'B'}),conditionKey:'condition',evidence:['offline-fixture']});
function setup(probability=.99,llm='yes',path=':memory:'){
 const f=fragmentFixture(path),calls:string[]=[],events:any[]=[],service=new ComponentJudgments();
 const context:ComponentJudgmentContext={fragments:f.session,providers:{jev:{name:'offline',model:'judge-v1',decide:async()=>{throw Error('unused');}},llm:{name:'offline',model:'explain-v1',decide:async()=>{throw Error('unused');}}},task:f.task,persist:()=>f.writer.flush(),signal:new AbortController().signal,stillValuable:()=>true,event:(type,data)=>events.push({type,data}),decide:async request=>{
  calls.push(request.kind);f.task.usage.modelRequests++;
  const answer={value:request.kind==='noul'?probability>=.5:{verdict:llm},probability:request.kind==='noul'?probability:undefined,model:'offline',usage:{input_tokens:31,output_tokens:2}};
  return {answer,decision:{id:'decision-'+calls.length,answer} as unknown as Decision};
 }};return {...f,context,calls,events,service};
}
it.each([[.99,'yes',1],[.01,'no',1],[.5,'yes',2]] as const)('keeps probability %s and uses the bounded three-way result',async(p,verdict,n)=>{
 const f=setup(p);try{const q=await f.service.judge(material(),f.context);expect(q).toMatchObject({status:verdict,probability:p});expect(f.calls).toHaveLength(n);
  const again=await f.service.judge(material(),f.context);expect(again?.status).toBe(verdict);expect(f.calls).toHaveLength(n);expect(f.store.fragmentRecords.verify(f.task.id).componentQuestions).toBe(1);f.store.fragmentRecords.compact();expect(f.session.raw(q!.sourceMaterial,'component')).toBe(material().sourceMaterial);
 }finally{f.close();}
});
it('deduplicates concurrent requests and a cold reader, while changed evidence/model invalidates',async()=>{
 const f=setup(.5,'undecided');try{
  const [a,b]=await Promise.all([f.service.judge(material(),f.context),f.service.judge(material(),f.context)]);expect(a).toEqual(b);expect(f.calls).toHaveLength(2);
  const cold=new FragmentSession(f.store.fragmentRecords,f.task.id,f.session.root);
  const restored=await new ComponentJudgments().judge(material(),{...f.context,fragments:cold});expect(restored?.status).toBe('undecided');expect(f.calls).toHaveLength(2);
  await f.service.judge(material('changed'),f.context);expect(f.calls).toHaveLength(3); // LLM window is already spent.
  f.context.providers.jev!.model='judge-v2';await f.service.judge(material(),f.context);expect(f.calls).toHaveLength(4);
 }finally{f.close();}
});
it('preserves interrupted reservations and service failures without LLM retry',async()=>{
 const f=setup();try{
  f.context.decide=async()=>{f.calls.push('failure');throw new ExplorerError('PROVIDER_TIMEOUT');};
  const q=await f.service.judge(material(),f.context);expect(q?.status).toBe('unavailable');expect(f.calls).toEqual(['failure']);
  await new ComponentJudgments().judge(material(),f.context);expect(f.calls).toHaveLength(1);
  q!.status='reserved';delete q!.calls[0].elapsedMs;f.session.put('componentQuestions',q!);f.writer.flush();
  expect(await f.service.judge(material('new'),f.context)).toBeUndefined();expect(f.calls).toHaveLength(1);
 }finally{f.close();}
});
it('caps the optional channel and leaves program work eligible',async()=>{
 const f=setup();try{for(let i=0;i<7;i++)await f.service.judge(material(String(i)),f.context);
  expect(f.calls).toHaveLength(4);expect(f.events.some(e=>e.type==='component.channel_exhausted'&&e.data.programWorkContinues)).toBe(true);
  expect(f.task.status).toBe('paused');expect(f.task.usage.modelRequests).toBe(4);
 }finally{f.close();}
});
it('does not ask for established, conflicting, missing or valueless material',async()=>{
 const f=setup();try{
  for(const status of ['same','conflict','unavailable'] as const)await f.service.judge({...material(),status},f.context);
  await f.service.judge(material(),{...f.context,stillValuable:()=>false});expect(f.calls).toEqual([]);
 }finally{f.close();}
});
it('does not replenish lifetime calls when the 240 second window changes',async()=>{
 const f=setup(.5);let now=Date.now();const clock=vi.spyOn(Date,'now').mockImplementation(()=>now);
 try{for(let window=0;window<3;window++){for(let i=0;i<5;i++)await f.service.judge(material(`${window}-${i}`),f.context);now+=240001;}
  expect(f.calls.filter(c=>c==='noul')).toHaveLength(8);expect(f.calls.filter(c=>c==='generate')).toHaveLength(2);
 }finally{clock.mockRestore();f.close();}
});
it('spends elapsed wait once and retains an undecided answer when clarification has no time',async()=>{
 const f=setup(.5);let now=Date.now();const clock=vi.spyOn(Date,'now').mockImplementation(()=>now),decide=f.context.decide;
 f.context.decide=async request=>{const response=await decide(request);now+=12000;return response;};
 try{expect((await f.service.judge(material(),f.context))?.status).toBe('undecided');expect(await f.service.judge(material('later'),f.context)).toBeUndefined();expect(f.calls).toEqual(['noul']);}
 finally{clock.mockRestore();f.close();}
});

it('preserves negative answers and spent calls through the full interchange export',async()=>{
 const f=setup(.01);let imported:ReturnType<typeof fragmentFixture>|undefined;
 try{await f.service.judge(material(),f.context);const audit=f.session.exportLegacy();imported=fragmentFixture(':memory:',audit);
  expect(imported.session.exportLegacy()).toEqual(audit);
  expect((await new ComponentJudgments().judge(material(),{...f.context,fragments:imported.session}))?.status).toBe('no');expect(f.calls).toHaveLength(1);
 }finally{imported?.close();f.close();}
});

it('reuses a durable negative answer in a genuinely new process',async()=>{
 const directory=resolve(`.data/component-correspondence/cold-question-${Date.now()}`);mkdirSync(directory,{recursive:true});const path=directory+'/explorer.sqlite',f=setup(.01,'yes',path);
 await f.service.judge(material(),f.context);f.close();writeFileSync(directory+'/material.json',JSON.stringify(material()));
 const cold=JSON.parse(execFileSync(process.execPath,['--import','tsx','--conditions=development','docs/experiments/component-correspondence-2026-10-18/cold-question.ts',path,directory+'/material.json'],{encoding:'utf8'}));expect(cold.status).toBe('no');expect(cold.calls).toBe(1);expect(cold.pid).not.toBe(process.pid);
});

it('bounds clarification output and disables optional reasoning without changing other requests',()=>{
 const provider=llmProvider({endpoint:'https://test.invalid',model:'example',provider:'openrouter',maxOutputTokens:4096,reasoningEffort:'low'});
 const request={id:'x',kind:'generate' as const,purpose:'component-correspondence-clarification',instructions:'one verdict',state:{},maxOutputTokens:256,reasoningEffort:'none' as const};
 expect(provider.requestBody!(request)).toMatchObject({max_tokens:256,reasoning:{enabled:false}});
 expect(provider.requestBody!({...request,reasoningEffort:undefined})).toMatchObject({reasoning:{effort:'low'}});
});
