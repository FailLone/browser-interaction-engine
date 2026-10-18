import {expect,it} from 'vitest';
import {writeFileSync} from 'node:fs';
import {ExplorerPlugin,ExplorerStore,type ModelRequest,type Provider} from '@interaction/explorer-plugin';
import {explorerFixture} from './explorer-plugin-helpers.js';
import {programModelGapCandidates} from '../packages/explorer-plugin/src/program-model-gap.js';

const html=`<nav><button role="tab" onclick="this.disabled=true">Ready tab</button>
<button id="detail" type="button" aria-controls="panel" onclick="document.querySelector('#panel').hidden=false;this.disabled=true">Show details</button>
<div id="panel" hidden>Local details</div></nav><canvas></canvas><div tabindex="0" aria-label="Unresolved structure">Unknown grouping</div>
<script>window.hoverCount=0;const b=document.querySelector('#detail');b.onmouseenter=()=>window.hoverCount++;b.__reactProps$fixture={onMouseEnter:b.onmouseenter};</script>`;
const contract=(url:string)=>({version:1 as const,mode:'exhaustive' as const,programNavigation:'public-navigation-v1' as const,roots:[{url}],exclusions:[],allowedOperations:['click','hover','focus','history']});

it.each(['useful','uncertain','offline','timeout','gap-deadline'] as const)('uses one concrete bounded model gap after independent program work: %s',async mode=>{
 const f=await explorerFixture(html),store=new ExplorerStore(':memory:'),calls:ModelRequest[]=[];
 const provider:Provider={name:'controlled-gap-test',model:'fixture',decide:async request=>{
  calls.push(request);
  if(mode==='offline')throw Error('offline fixture');
  if(mode==='timeout'||mode==='gap-deadline')return new Promise(()=>{});
  if(request.kind==='checklist')return {model:'fixture',value:Object.fromEntries(Object.keys(request.checks!).map(k=>[k,mode==='uncertain'?.5:k.startsWith('interface_')?.99:.01]))};
  if(request.kind==='choice')return {model:'fixture',value:mode==='uncertain'?'uncertain':'interaction',confidence:1};
  return {model:'fixture',value:{choice:'uncertain',evidenceRefs:[],reason:'No supported conclusion',interfaceOnly:null,externalWrite:null}};
 }};
 const plugin=new ExplorerPlugin(f.host,store,{jev:provider,llm:provider,timeoutMs:mode==='timeout'?40:mode==='gap-deadline'?20000:1000});
 try{
  const task=plugin.create({url:f.url,coverageContract:contract(f.url),sessionOptions:{coveragePolicy:'finite-ui-v1',executionPolicy:'observed-ui',headless:true,settleMs:0,observeTimeoutMs:500},budget:{rounds:2,actions:12,durationMs:20000,modelRequests:30}});
  plugin.start(task.id);await plugin.waitForIdle(task.id);const final=store.task(task.id),events=store.events(task.id),attempts=final.rounds.flatMap(r=>f.host.list<any>(r.sessionId,'attempt'));
  writeFileSync(`.data/program-first/model-gap-${mode}.json`,JSON.stringify({task:final,events,attempts,decisions:store.decisions(task.id)}));
  expect(calls.length,JSON.stringify({reason:final.reason,gaps:final.programModelGaps})).toBeGreaterThan(0);
  const firstRequest=events.findIndex(e=>e.type==='decision.requested'),ready=events.findIndex(e=>e.type==='action.verified'&&(e.data as any).attemptId===attempts.find(a=>a.action.label==='Ready tab')?.id);
  expect(ready).toBeGreaterThanOrEqual(0);expect(ready).toBeLessThan(firstRequest);
  expect(attempts.filter(a=>a.action.label==='Show details'&&a.action.kind==='hover')).toHaveLength(1);
  for(const call of calls){const gap=(call.state as any).programGap;expect(gap).toMatchObject({kind:'operation',maxCalls:2,maxDurationMs:12000});expect(gap.checks.attempts.some((a:any)=>a.kind==='hover'&&a.status==='succeeded')).toBe(true);expect(gap.checks.actionBlockers.length).toBeGreaterThan(0);expect(gap.checks.readyProgramActions).toEqual([]);expect(call.purpose).not.toBe('next-action');}
  const gaps=Object.values(final.programModelGaps||{});expect(gaps.length).toBeGreaterThan(0);expect(gaps.every(g=>g.calls<=2&&(!g.elapsedMs||g.elapsedMs<12500))).toBe(true);
  if(mode==='gap-deadline')expect(gaps.some(g=>g.status==='timed_out'&&g.calls===1&&g.elapsedMs!>=11900)).toBe(true);
  expect(events.some(e=>e.type==='model.gap_program_checks')).toBe(true);expect(events.some(e=>e.type==='model.gap_question')).toBe(true);expect(events.some(e=>e.type==='model.gap_finished')).toBe(true);
  if(mode==='useful'){
   expect(attempts.some(a=>a.action.label==='Show details'&&a.action.kind==='click'&&a.status==='succeeded')).toBe(true);
   expect(gaps.some(g=>g.validations.some(v=>v.accepted)&&g.gains.some(a=>a.status==='succeeded'&&a.conditionVerified))).toBe(true);
  }else{
   expect(attempts.some(a=>a.action.label==='Show details'&&a.action.kind==='click')).toBe(false);
   expect(gaps.flatMap(g=>g.gains)).toEqual([]);expect(final.plan.some(i=>i.required&&i.status!=='succeeded')).toBe(true);
   expect(calls.length).toBeLessThanOrEqual(2);
   const refreshed=await f.host.observe(final.rounds.at(-1)!.sessionId);
   expect(programModelGapCandidates(f.host,JSON.parse(JSON.stringify(final)),refreshed)).toEqual([]);
  }
  expect(final.status).not.toBe('configuration_required');expect(final.status).not.toBe('completed');
 }finally{await plugin.close();await f.close();}
});

it('retains a pure structural unknown without asking a model to interpret a new region or rank actions',async()=>{
 const f=await explorerFixture('<nav><div tabindex="0" aria-label="Unresolved grouping">Read-only children<span>Information</span></div></nav><canvas></canvas>'),store=new ExplorerStore(':memory:');
 const calls:ModelRequest[]=[],provider:Provider={name:'unexpected',model:'fixture',decide:async request=>{calls.push(request);throw Error('not expected');}};
 const plugin=new ExplorerPlugin(f.host,store,{jev:provider,llm:provider});
 try{const task=plugin.create({url:f.url,coverageContract:contract(f.url),sessionOptions:{coveragePolicy:'finite-ui-v1',executionPolicy:'observed-ui',headless:true},budget:{rounds:1,actions:4,durationMs:10000}});
  plugin.start(task.id);await plugin.waitForIdle(task.id);const final=store.task(task.id);
  expect(calls).toEqual([]);expect(final.plan.some(i=>i.required&&i.status!=='succeeded')).toBe(true);expect(final.status).not.toBe('completed');
 }finally{await plugin.close();await f.close();}
});
