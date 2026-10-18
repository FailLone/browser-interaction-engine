import {expect,it,vi} from 'vitest';
import {ExplorerPlugin,ExplorerStore,type PlanItem,type Round} from '@interaction/explorer-plugin';
import type {ActionCandidate,Observation} from '@interaction/browser';
import {hasRetainedReviewInterpretation} from '../packages/explorer-plugin/src/review-recovery.js';
import {digest} from '../packages/explorer-plugin/src/policy.js';
import {explorerFixture} from './explorer-plugin-helpers.js';
it('verifies a necessary repeated exit from an actual prerequisite receipt even without a completed leaf row',async()=>{
 const f=await explorerFixture(`<button type="button" onclick="document.querySelector('dialog').showModal()">Open</button><dialog aria-label="Settings"><button type="button" onclick="this.closest('dialog').close()">Done</button></dialog>`);
 const plugin=new ExplorerPlugin(f.host,new ExplorerStore(':memory:'));
 try{
  const session=await f.host.createSession({url:f.url,coveragePolicy:'finite-ui-v1',executionPolicy:'observed-ui',headless:true,settleMs:0,observeTimeoutMs:1000});
  const execute=async(label:string)=>{const o=f.host.observation(session.id),a=f.host.actions(session.id).find(a=>a.kind==='click'&&a.label===label)!;return f.host.execute(session.id,a.id,crypto.randomUUID(),undefined,{observationId:o.id,profile:'observed-ui-exploration'});};
  await execute('Open');const first=await execute('Done');expect(first.status).toBe('succeeded');await execute('Open');
  const o=f.host.observation(session.id),a=f.host.actions(session.id).find(a=>a.label==='Done'&&a.kind==='click')!;
  const task=plugin.create({url:f.url}),round:Round={id:'round',number:1,sessionId:session.id,startedAt:new Date().toISOString(),status:'running',actions:3,stack:[],entryPath:[],reentries:[],tried:[],reviewed:[],noProgress:0};task.rounds=[round];task.plan=[];
  const runtime=plugin as unknown as {exitRepetitionPermission(t:typeof task,a:ActionCandidate,o:Observation):ReturnType<typeof f.host.repetitionAssessment>|undefined;freshAction(t:typeof task,r:Round,a:ActionCandidate,o:Observation,completed:boolean):boolean};
  const proof=runtime.exitRepetitionPermission(task,a,o);expect(proof).toMatchObject({repeatable:true,source:{sessionId:session.id,attemptId:first.id},dispatchRevalidationRequired:true});
  expect(runtime.freshAction(task,round,a,o,false)).toBe(true);
  const denied=vi.spyOn(f.host,'repetitionAssessment').mockReturnValue({...proof!,repeatable:false,reason:'source_not_replayable'});
  expect(runtime.freshAction(task,round,a,o,false)).toBe(false);denied.mockRestore();
  const repeat=await f.host.execute(session.id,a.id,'necessary-exit',undefined,{observationId:o.id,profile:'observed-ui-exploration',repetitionSource:proof!.source});
  expect(repeat).toMatchObject({status:'succeeded',repetitionSource:{attemptId:first.id}});expect(task.plan).toEqual([]);
 }finally{await plugin.close();await f.close();}
});
it('uses a retained classification only to require the old source, and never schedules that already interpreted occurrence again',()=>{
 const source={sessionId:'s',observationId:'old',localId:'target'},proof={...source,classificationId:'classification',classification:'container' as const};
 const item={scope:{url:'https://fixture/',label:'Settings'},reviewSourceProofs:{policy:'review-source-completion-v1',scopeKey:'',bindings:[{source,proof}]},status:'unresolved',reason:'classification_unresolved'} as PlanItem;
 item.reviewSourceProofs!.scopeKey=digest(item.scope);
 const snapshot={retainedClassifications:[{source:proof,localId:source.localId,retained:true}]} as unknown as Parameters<typeof hasRetainedReviewInterpretation>[1];
 const saved=structuredClone(item);expect(hasRetainedReviewInterpretation(item,snapshot)).toBe(true);
 expect(hasRetainedReviewInterpretation(item,snapshot,source)).toBe(true);expect(hasRetainedReviewInterpretation(item,snapshot,{sessionId:'s',observationId:'unproved'})).toBe(false);
 snapshot!.retainedClassifications[0].retained=false;expect(hasRetainedReviewInterpretation(item,snapshot)).toBe(false);expect(item).toEqual(saved);
});
