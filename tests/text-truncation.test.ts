import { afterAll, beforeAll, expect, it } from 'vitest';
import { BrowserEngine } from '@interaction/browser';
import { MemoryStore } from '@interaction/storage-memory';
import { RuleRunner, TextTruncationTracker, textTruncationRule, textRequirementProposalSchema, toInspectionResults, type RuleReport } from '@interaction/rules';
import { fixtureServer, pageOf } from './helpers.js';

let fixture: Awaited<ReturnType<typeof fixtureServer>>;
beforeAll(async()=>{ fixture=await fixtureServer(); });
afterAll(async()=>{ await fixture.server.close(); });
const latest=(e:BrowserEngine,sid:string)=>e.listInspections(sid,{limit:500}).items.at(-1)!;
const runner=new RuleRunner([textTruncationRule]);
const plan=[{ruleId:'text-truncation',ruleVersion:'1.0.0'}];
const target=(r:RuleReport,id:string)=>r.checks.find(c=>c.target?.nodeId===id || c.facts?.identityId===id)!;
async function setup(mode:string,fn:(e:BrowserEngine,sid:string,node:string,id:string)=>Promise<void>){
  const e=new BrowserEngine({persistence:new MemoryStore()});
  try {
    const s=await e.createSession({url:`${fixture.url}/text-truncation.html?mode=${mode}`,headless:true,viewport:{width:800,height:600},
      settleMs:60,observeTimeoutMs:1500,actionTimeoutMs:1000,listExploration:'all',pageExploration:'all',maxActions:12,inspection:{consumers:[{id:'text'}]}});
    const c=e.observation(s.id).controls.find(c=>c.selector==='#target')!;
    await fn(e,s.id,c.localId,c.identityId!);
  } finally { await e.close(); }
}
const run=async(e:BrowserEngine,sid:string)=>(await runner.run(e,latest(e,sid),plan))[0];
async function scroll(e:BrowserEngine,sid:string,expectMovement=true){
  const container=e.observation(sid).controls.find(c=>c.selector==='#scroller') ?? e.observation(sid).controls.find(c=>c.selector==='#outer');
  const action=e.actions(sid).find(a=>a.kind==='scroll' && a.localId===container?.localId && (a.value as any).y>0)!;
  expect(action).toBeDefined(); const attempt=await e.execute(sid,action.id,crypto.randomUUID());
  if(expectMovement) expect(attempt.status).toBe('succeeded');
}

it.each(['healthy','literal','ellipsis-fit','clamp-fit','wrap','native-modal'])('fits %s without mistaking CSS or literal punctuation for actual elision',async mode=>{
  await setup(mode,async(e,sid,node)=>{
    const c=target(await run(e,sid),node);
    expect(c,JSON.stringify(c)).toMatchObject({verdict:'pass',code:'DOM_TEXT_BOXES_FIT',facts:{cuts:[]}});
    expect(e.session(sid).actionCount).toBe(0);
  });
});
it.each(['hard-x','hard-y','ellipsis-vertical','clamp-partial','block-child','label'])('warns about %s using the built-in policy without a product requirement',async mode=>{
  await setup(mode,async(e,sid,node)=>{
    const c=target(await run(e,sid),node);
    expect(c,JSON.stringify(c)).toMatchObject({verdict:'unknown',severity:'warning',code:'TEXT_HARD_CLIP_SUSPECTED',facts:{policy:{source:'builtin',externalRequirements:'not-integrated'}}});
    expect((c.facts!.cuts as any[]).some(c=>c.mechanism==='hard-clip')).toBe(true);
  });
});
it.each(['ellipsis','nested','rtl','clamp'])('records %s overflow without inferring design compliance or a painted ellipsis',async mode=>{
  await setup(mode,async(e,sid,node)=>{
    const c=target(await run(e,sid),node);
    expect(c,JSON.stringify(c)).toMatchObject({verdict:'unknown',severity:'info',code:'TEXT_ELISION_OBSERVED',facts:{elisionMarkerPainted:'unverified'}});
    expect((c.facts!.cuts as any[]).some(c=>c.mechanism===(mode==='clamp'?'line-clamp':'ellipsis'))).toBe(true);
  });
});
it.each(['scroll','viewport','offscreen-hard'])('defers %s rather than asserting a text defect',async mode=>{
  await setup(mode,async(e,sid,node)=>expect(target(await run(e,sid),node)).toMatchObject({verdict:'unknown',severity:'info',code:'TEXT_SCROLL_RECHECK_PENDING'}));
});
it.each(['transform','vertical','columns','clip-margin','absolute-escape','fragments-budget'])('does not certify unsupported or incomplete %s text geometry',async mode=>{
  await setup(mode,async(e,sid,node)=>expect(target(await run(e,sid),node)).toMatchObject({verdict:'unknown',code:'TEXT_RECHECK_UNAVAILABLE'}));
});
it.each(['disabled','empty','title-only','input-value','hidden-label'])('does not substitute metadata or editing values for a visible label (%s)',async mode=>{
  await setup(mode,async(e,sid,node)=>expect(target(await run(e,sid),node).verdict).toBe('not-applicable'));
});
it('uses captured text rectangles, remains read-only, and does not replace old evidence with live text',async()=>{
  await setup('hard-x',async(e,sid,node)=>{
    const task=latest(e,sid), source=await e.captureDetails(sid,task.captureId);
    expect(source.details!.snapshot!.dom!.textGeometry).toMatchObject({version:1,fonts:'loaded'});
    const text=source.details!.snapshot!.dom!.nodes.find(n=>n.parentId===node && n.nodeType==='text')!;
    expect(text.textLayout).toMatchObject({version:1,status:'captured'});
    expect(text.textLayout!.rects.length).toBeGreaterThan(0);
    const selection=await pageOf(e).evaluate(()=>getSelection()?.toString());
    await pageOf(e).locator('#target').evaluate(el=>el.textContent='Short');
    expect(target((await runner.run(e,task,plan))[0],node).code).toBe('TEXT_HARD_CLIP_SUSPECTED');
    expect(await pageOf(e).evaluate(()=>getSelection()?.toString())).toBe(selection);
    expect(e.session(sid).actionCount).toBe(0);
    await e.observe(sid);
    expect(target(await run(e,sid),node).code).toBe('DOM_TEXT_BOXES_FIT');
  });
});
it('keeps old captures, loading fonts, missing ancestors and truncated text unknown',async()=>{
  await setup('healthy',async(e,sid,node)=>{
    const task=latest(e,sid), original=await e.captureDetails(sid,task.captureId);
    for(const alter of [
      (source:typeof original)=>{ delete source.details!.snapshot!.dom!.textGeometry; },
      (source:typeof original)=>{ source.details!.snapshot!.dom!.textGeometry!.fonts='loading'; },
      (source:typeof original)=>{ source.details!.snapshot!.dom!.nodes=source.details!.snapshot!.dom!.nodes.filter(n=>n.tag!=='body'); },
      (source:typeof original)=>{ source.details!.snapshot!.dom!.nodes.find(n=>n.parentId===node && n.nodeType==='text')!.textLayout!.status='truncated'; },
      (source:typeof original)=>{ source.details!.snapshot!.dom!.nodes.find(n=>n.id===node)!.layout!.client.width=NaN; },
    ]) {
      const source=structuredClone(original); alter(source);
      expect(target((await runner.run({captureDetails:async()=>source},task,plan))[0],node).verdict).toBe('unknown');
    }
  });
});

it.each(['scroll','modal-scroll','inner-scroll','label-scroll'])('rechecks normal exploration %s without extra actions and persists an immutable report',async mode=>{
  await setup(mode,async(e,sid,node,id)=>{
    const tracker=new TextTruncationTracker(), firstTask=latest(e,sid), first=await tracker.run(e,firstTask), copy=structuredClone(first);
    expect(target(first,id)).toMatchObject({code:'TEXT_SCROLL_RECHECK_PENDING',facts:{lifecycle:'pending'}});
    await scroll(e,sid); const count=e.session(sid).actionCount;
    const report=await tracker.run(e,latest(e,sid)), check=target(report,id);
    expect(check,JSON.stringify(check)).toMatchObject({verdict:'pass',code:'TEXT_CLIPPING_NO_LONGER_OBSERVED',facts:{lifecycle:'resolved',issueId:target(first,id).facts!.issueId}});
    expect(check.facts!.ancestorScrollChanges).toHaveLength(1);
    expect(e.session(sid).actionCount).toBe(count); expect(await pageOf(e).evaluate(()=>scrollY)).toBe(0);
    expect(first).toEqual(copy); expect(await tracker.run(e,latest(e,sid))).toEqual(report);
    await expect(tracker.run(e,firstTask)).rejects.toThrow('OUT_OF_ORDER');
    expect(await e.completeInspection(sid,latest(e,sid).id,'text',toInspectionResults([report]))).toBeDefined();
  });
});

it('does not claim scrolling or upgrade severity when the page cancels movement',async()=>{
  await setup('cancel',async(e,sid,node,id)=>{
    const tracker=new TextTruncationTracker(); await tracker.run(e,latest(e,sid)); await scroll(e,sid,false);
    expect(target(await tracker.run(e,latest(e,sid)),id)).toMatchObject({verdict:'unknown',severity:'info',facts:{ancestorScrollChanges:[],lifecycle:'pending'}});
  });
});

it('keeps a hard-clip warning through elision and resolves only comparable geometry, then reopens on recurrence',async()=>{
  await setup('hard-x',async(e,sid,node,id)=>{
    const tracker=new TextTruncationTracker(), first=await tracker.run(e,latest(e,sid)), issueId=target(first,id).facts!.issueId;
    await pageOf(e).locator('#target').evaluate(el=>(el as HTMLElement).style.textOverflow='ellipsis'); await e.observe(sid);
    expect(target(await tracker.run(e,latest(e,sid)),id)).toMatchObject({verdict:'unknown',severity:'warning',facts:{lifecycle:'unverified',issueId}});
    await pageOf(e).locator('#target').evaluate(el=>(el as HTMLElement).style.width='500px'); await e.observe(sid);
    expect(target(await tracker.run(e,latest(e,sid)),id)).toMatchObject({verdict:'pass',facts:{lifecycle:'resolved',issueId}});
    await pageOf(e).locator('#target').evaluate(el=>{ (el as HTMLElement).style.width='120px'; (el as HTMLElement).style.textOverflow='clip'; }); await e.observe(sid);
    expect(target(await tracker.run(e,latest(e,sid)),id)).toMatchObject({verdict:'unknown',severity:'warning',facts:{lifecycle:'suspected',issueId}});
  });
});

it.each(['text-change','text-rebuild','control-rebuild'])('does not transfer recovery across %s even with an unchanged accessible name',async mode=>{
  await setup('hard-x',async(e,sid,node,id)=>{
    await pageOf(e).locator('#target').evaluate(el=>el.setAttribute('aria-label','Stable name')); await e.observe(sid);
    const tracker=new TextTruncationTracker(); await tracker.run(e,latest(e,sid));
    await pageOf(e).locator('#target').evaluate((el,mode)=>{
      if(mode==='text-change') el.firstChild!.textContent='Short';
      if(mode==='text-rebuild') el.textContent=el.textContent;
      if(mode==='control-rebuild') { const replacement=el.cloneNode(true) as HTMLElement; el.replaceWith(replacement); el=replacement; }
      (el as HTMLElement).style.width='500px';
    },mode); await e.observe(sid);
    expect(target(await tracker.run(e,latest(e,sid)),id)).toMatchObject({verdict:'unknown',severity:'warning',code:'TEXT_BASELINE_CHANGED',facts:{lifecycle:'unverified'}});
  });
});

it('retains missing evidence and removed targets as unresolved, and processes backlog without live DOM',async()=>{
  await setup('hard-x',async(e,sid,node,id)=>{
    const tracker=new TextTruncationTracker(); await tracker.run(e,latest(e,sid));
    await e.observe(sid); const task=latest(e,sid), source=await e.captureDetails(sid,task.captureId);
    delete source.details!.snapshot!.dom!.textGeometry;
    expect(target(await tracker.run({captureDetails:async()=>source},task),id)).toMatchObject({verdict:'unknown',severity:'warning',facts:{lifecycle:'unverified'}});
    await pageOf(e).locator('#target').evaluate(el=>el.remove()); await e.observe(sid);
    expect(target(await tracker.run(e,latest(e,sid)),id)).toMatchObject({code:'TEXT_TARGET_UNOBSERVED',verdict:'unknown',severity:'warning'});
  });
  await setup('scroll',async(e,sid,node,id)=>{
    const tasks=[latest(e,sid)]; await scroll(e,sid); tasks.push(latest(e,sid));
    await pageOf(e).locator('#target').evaluate(el=>el.remove());
    const tracker=new TextTruncationTracker(), count=e.session(sid).actionCount;
    const reports=await Promise.all(tasks.map(t=>tracker.run(e,t)));
    expect(target(reports[1],id).facts!.lifecycle).toBe('resolved');
    expect(e.session(sid).actionCount).toBe(count);
  });
});
it('exposes proposal-only interfaces and refuses to silently execute requirements or agent decisions',async()=>{
  const proposal={schemaVersion:1,status:'proposed',ruleId:'text-truncation',ruleVersion:'1.0.0',
    target:{sessionId:'s',observationId:'o',captureId:'c',documentId:'d',nodeId:'n',instanceId:'i'},
    requirement:'full-text-inline',source:{kind:'agent-judgment',agentId:'agent',basis:'inference'},reason:'Possible primary action',evidence:['capture:c']};
  expect(textRequirementProposalSchema.parse(proposal).status).toBe('proposed');
  expect(()=>textRequirementProposalSchema.parse({...proposal,status:'confirmed'})).toThrow();
  expect(()=>textRequirementProposalSchema.parse({...proposal,evidence:[]})).toThrow();
  expect(()=>textRequirementProposalSchema.parse({...proposal,target:{nodeId:'n'}})).toThrow();
  await setup('ellipsis',async(e,sid,node)=>{
    await expect(runner.run(e,latest(e,sid),[{...plan[0],options:{requirements:[proposal]}}])).rejects.toThrow();
    expect(target(await run(e,sid),node)).toMatchObject({verdict:'unknown',severity:'info'});
    expect(runner.catalog()[0].optionsSchema).toBeDefined();
  });
});

it('retains the original clipped text when a changed label establishes a new baseline', async () => {
  await setup('hard-x', async (e, sid, node, id) => {
    const tracker = new TextTruncationTracker(), first = target(await tracker.run(e, latest(e, sid)), id);
    expect(first.facts!.lastObservedFinding).toMatchObject({ code: 'TEXT_HARD_CLIP_SUSPECTED', severity: 'warning', facts: { cuts: first.facts!.cuts } });
    await pageOf(e).locator('#target').evaluate(el => el.textContent = 'OK'); await e.observe(sid);
    const changed = target(await tracker.run(e, latest(e, sid)), id);
    expect(changed).toMatchObject({ code: 'TEXT_BASELINE_CHANGED', verdict: 'unknown', facts: { lastObservedFinding: first.facts!.lastObservedFinding, currentObservation: { verdict: 'pass', code: 'DOM_TEXT_BOXES_FIT' } } });
    await pageOf(e).locator('#target').evaluate(el => el.remove()); await e.observe(sid);
    expect(target(await tracker.run(e, latest(e, sid)), id).facts!.lastObservedFinding).toEqual(first.facts!.lastObservedFinding);
  });
});
