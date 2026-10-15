import { afterAll, beforeAll, expect, it } from 'vitest';
import { BrowserEngine } from '@interaction/browser';
import { MemoryStore } from '@interaction/storage-memory';
import { clippedControlRule, ClippedControlTracker, RuleRunner, toInspectionResults, type ClippedControlOptions, type RuleReport } from '@interaction/rules';
import { fixtureServer, pageOf } from './helpers.js';

let fixture: Awaited<ReturnType<typeof fixtureServer>>;
beforeAll(async()=>{ fixture=await fixtureServer(); });
afterAll(async()=>{ await fixture.server.close(); });
const latest=(e:BrowserEngine,sid:string)=>e.listInspections(sid,{limit:500}).items.at(-1)!;
const targetCheck=(r:RuleReport,id:string)=>r.checks.find(c=>c.facts?.identityId===id || c.target?.nodeId===id)!;
const requirement=(identityId:string):ClippedControlOptions=>({requirements:[{identityId,kind:'unclipped-by-nonscroll-container',reason:'Target must not be cut by a non-scroll UI container',evidence:['fixture:target-contract']}]});
const run=async(e:BrowserEngine,sid:string,options:ClippedControlOptions={})=>(await new RuleRunner([clippedControlRule]).run(e,latest(e,sid),[{ruleId:'clipped-control',ruleVersion:'1.0.0',options}]))[0];
async function setup(mode:string,fn:(e:BrowserEngine,sid:string,nodeId:string,id:string)=>Promise<void>){
  const e=new BrowserEngine({persistence:new MemoryStore()});
  try {
    const s=await e.createSession({url:`${fixture.url}/clipped-control.html?mode=${mode}`,headless:true,viewport:{width:800,height:600},
      settleMs:60,observeTimeoutMs:1500,actionTimeoutMs:1000,maxActions:10,listExploration:'all',pageExploration:'all',inspection:{consumers:[{id:'clipping'}]}});
    const c=e.observation(s.id).controls.find(c=>c.selector==='#target')!;
    await fn(e,s.id,c?.localId,c?.identityId!);
  } finally { await e.close(); }
}
async function scroll(e:BrowserEngine,sid:string,expectMovement=true){
  const action=e.actions(sid).find(a=>a.kind==='scroll' && a.localId===e.observation(sid).controls.find(c=>c.selector==='#clip')?.localId &&
    ((a.value as any).y>0 || (a.value as any).x>0))!;
  expect(action).toBeDefined(); const attempt=await e.execute(sid,action.id,crypto.randomUUID());
  if(expectMovement) expect(attempt.status).toBe('succeeded');
}

it.each(['healthy','covered','fixed','native-modal','popover'])('does not invent clipping for %s',async mode=>{
  await setup(mode,async(e,sid,node)=>{
    const check=targetCheck(await run(e,sid),node);
    expect(check,JSON.stringify({check,control:e.observation(sid).controls.find(c=>c.localId===node)})).toMatchObject({verdict:'pass',code:'CONTROL_BOX_UNCLIPPED',facts:{rectangularIntersectionRatio:1}});
    expect(e.session(sid).actionCount).toBe(0);
  });
});
it.each(['default','clip','nested','modal','native-modal-clipped','popover-clipped'])('records %s clipping with bounds and a sourced opt-in failure',async mode=>{
  await setup(mode,async(e,sid,node,id)=>{
    const initial=targetCheck(await run(e,sid),node);
    expect(initial).toMatchObject({verdict:'unknown',severity:'warning',code:'CONTROL_CLIPPING_SUSPECTED'});
    expect(Number(initial.facts!.rectangularIntersectionRatio)).toBeLessThan(1);
    expect(initial.facts!.clips).not.toEqual([]);
    expect(targetCheck(await run(e,sid,requirement(id)),node)).toMatchObject({verdict:'fail',severity:'error',code:'CLIPPING_REQUIREMENT_FAILED'});
    if(mode==='default') expect(initial.facts!.rectangularIntersectionRatio).toBe(.5); // Client edge excludes the 6px border.
    if(mode==='modal') {
      const background=e.observation(sid).controls.find(c=>c.name==='Background')!;
      expect(targetCheck(await run(e,sid),background.localId)).toMatchObject({verdict:'not-applicable',code:'OUTSIDE_ACTIVE_SCOPE'});
    }
  });
});
it.each(['transform','zoom','mask','rounded','clip-margin','absolute-escape','svg','fragments'])('keeps %s geometry unverified even under a strict requirement',async mode=>{
  await setup(mode,async(e,sid,node,id)=>{
    const c=targetCheck(await run(e,sid,requirement(id)),node);
    expect(c.verdict).toBe('unknown'); expect(c.severity).not.toBe('error');
    expect(c.code).toBe(mode==='absolute-escape'?'POSITIONED_CLIP_UNVERIFIED':mode==='svg'?'CLIP_BOX_UNSUPPORTED':'COMPLEX_CLIP_UNVERIFIED');
  });
});
it('keeps ordinary viewport overflow pending and skips disabled controls by default',async()=>{
  await setup('offscreen',async(e,sid,node,id)=>expect(targetCheck(await run(e,sid,requirement(id)),node)).toMatchObject({verdict:'unknown',severity:'info',code:'VIEWPORT_RECHECK_PENDING'}));
  await setup('disabled',async(e,sid,node)=>{
    expect(targetCheck(await run(e,sid),node).verdict).toBe('not-applicable');
    expect(targetCheck(await run(e,sid,{includeDisabled:true}),node).severity).toBe('warning');
  });
});
it.each(['scroll','horizontal'])('rechecks %s through normal exploration without performing inspector actions',async mode=>{
  await setup(mode,async(e,sid,node,id)=>{
    const tracker=new ClippedControlTracker({rule:requirement(id)}), firstTask=latest(e,sid);
    const first=await tracker.run(e,firstTask), immutable=structuredClone(first);
    expect(targetCheck(first,id)).toMatchObject({verdict:'unknown',severity:'info',code:'SCROLL_CLIP_RECHECK_PENDING',facts:{lifecycle:'pending'}});
    await scroll(e,sid); const count=e.session(sid).actionCount;
    const report=await tracker.run(e,latest(e,sid)), check=targetCheck(report,id);
    expect(check,JSON.stringify(check)).toMatchObject({verdict:'pass',code:'CLIPPING_NO_LONGER_OBSERVED',facts:{lifecycle:'resolved',issueId:targetCheck(first,id).facts!.issueId}});
    expect(check.facts!.ancestorScrollChanges).toHaveLength(1);
    expect(e.session(sid).actionCount).toBe(count); expect(await pageOf(e).evaluate(()=>scrollY)).toBe(0);
    expect(first).toEqual(immutable); expect(await tracker.run(e,latest(e,sid))).toEqual(report);
    await expect(tracker.run(e,firstTask)).rejects.toThrow('OUT_OF_ORDER');
    const saved=await e.completeInspection(sid,latest(e,sid).id,'clipping',toInspectionResults([report]));
    expect(saved).toBeDefined();
  });
});
it.each(['rebuild','rebind'])('does not claim recovery after %s',async mode=>{
  await setup(mode,async(e,sid,node,id)=>{
    const tracker=new ClippedControlTracker(); await tracker.run(e,latest(e,sid));
    await scroll(e,sid);
    expect(targetCheck(await tracker.run(e,latest(e,sid)),id)).toMatchObject({verdict:'unknown',facts:{lifecycle:'unverified'}});
  });
});
it('retains warnings while offscreen or missing, and resolves a comparable layout correction',async()=>{
  await setup('default',async(e,sid,node,id)=>{
    const tracker=new ClippedControlTracker(); const first=await tracker.run(e,latest(e,sid));
    await pageOf(e).locator('#clip').evaluate(el=>(el as HTMLElement).style.marginTop='900px'); await e.observe(sid);
    expect(targetCheck(await tracker.run(e,latest(e,sid)),id)).toMatchObject({verdict:'unknown',severity:'warning',facts:{lifecycle:'unverified'}});
    await pageOf(e).locator('#clip').evaluate(el=>{ (el as HTMLElement).style.marginTop='0'; (el as HTMLElement).style.height='160px'; }); await e.observe(sid);
    expect(targetCheck(await tracker.run(e,latest(e,sid)),id).code).toBe('CLIPPING_BASELINE_CHANGED');
    await e.observe(sid);
    expect(targetCheck(await tracker.run(e,latest(e,sid)),id)).toMatchObject({verdict:'pass',facts:{lifecycle:'resolved',issueId:targetCheck(first,id).facts!.issueId}});
  });
  await setup('default',async(e,sid,node,id)=>{
    const tracker=new ClippedControlTracker(); await tracker.run(e,latest(e,sid));
    await pageOf(e).locator('#target').evaluate(el=>el.remove()); await e.observe(sid);
    expect(targetCheck(await tracker.run(e,latest(e,sid)),id)).toMatchObject({code:'CLIPPING_TARGET_UNOBSERVED',verdict:'unknown',facts:{lifecycle:'unverified'}});
  });
});
it('does not infer a scroll or escalate when the page cancels movement',async()=>{
  await setup('cancel',async(e,sid,node,id)=>{
    const tracker=new ClippedControlTracker({rule:requirement(id)}); await tracker.run(e,latest(e,sid));
    await scroll(e,sid,false);
    const check=targetCheck(await tracker.run(e,latest(e,sid)),id);
    expect(check).toMatchObject({verdict:'unknown',severity:'info',facts:{ancestorScrollChanges:[]}});
  });
});
it('processes historical backlog without reading or changing the live page',async()=>{
  await setup('scroll',async(e,sid,node,id)=>{
    const tasks=[latest(e,sid)]; await scroll(e,sid); tasks.push(latest(e,sid));
    await pageOf(e).locator('#target').evaluate(el=>el.remove());
    const tracker=new ClippedControlTracker(), count=e.session(sid).actionCount;
    const reports=await Promise.all(tasks.map(t=>tracker.run(e,t)));
    expect(targetCheck(reports[1],id).facts!.lifecycle).toBe('resolved');
    expect(e.session(sid).actionCount).toBe(count);
  });
});
it('treats old, missing and truncated evidence as unknown and validates rule configuration',async()=>{
  await setup('default',async(e,sid,node)=>{
    const runner=new RuleRunner([clippedControlRule]), task=latest(e,sid), source=await e.captureDetails(sid,task.captureId);
    delete source.details!.snapshot!.dom!.nodes.find(n=>n.id===node)!.layout!.clipping;
    const [report]=await runner.run({captureDetails:async()=>source},task,[{ruleId:'clipped-control',ruleVersion:'1.0.0'}]);
    expect(targetCheck(report,node)).toMatchObject({verdict:'unknown',code:'CLIP_EVIDENCE_UNAVAILABLE'});
    source.details!.snapshot!.dom!.nodesTruncated=true;
    expect((await runner.run({captureDetails:async()=>source},task,[{ruleId:'clipped-control',ruleVersion:'1.0.0'}]))[0].checks[0].code).toBe('EVIDENCE_INCOMPLETE');
    expect(runner.catalog()[0].optionsSchema).toBeDefined();
    await expect(run(e,sid,{tolerancePx:50})).rejects.toThrow();
    await expect(run(e,sid,{requirements:[{identityId:'a',kind:'unclipped-by-nonscroll-container',reason:'',evidence:[]}]})).rejects.toThrow();
  });
});

it('keeps an existing warning until ordinary scrolling actually reveals the whole control, and reopens it on recurrence',async()=>{
  await setup('default',async(e,sid,node,id)=>{
    const tracker=new ClippedControlTracker(), first=await tracker.run(e,latest(e,sid)), issueId=targetCheck(first,id).facts!.issueId;
    await pageOf(e).locator('#clip').evaluate(el=>(el as HTMLElement).style.overflow='auto'); await e.observe(sid);
    expect(targetCheck(await tracker.run(e,latest(e,sid)),id)).toMatchObject({verdict:'unknown',severity:'warning',facts:{lifecycle:'unverified',issueId}});
    await scroll(e,sid);
    expect(targetCheck(await tracker.run(e,latest(e,sid)),id)).toMatchObject({verdict:'pass',facts:{lifecycle:'resolved',issueId}});
    await pageOf(e).locator('#clip').evaluate(el=>{ el.scrollTop=0; (el as HTMLElement).style.overflow='hidden'; }); await e.observe(sid);
    expect(targetCheck(await tracker.run(e,latest(e,sid)),id)).toMatchObject({verdict:'unknown',severity:'warning',facts:{lifecycle:'suspected',issueId}});
  });
});

it('does not transfer resolved geometry through ambiguous identity or a closed scope',async()=>{
  await setup('scroll',async(e,sid,node,id)=>{
    const tracker=new ClippedControlTracker(); await tracker.run(e,latest(e,sid)); await scroll(e,sid);
    const task=latest(e,sid), source=await e.captureDetails(sid,task.captureId);
    source.details!.observation.controls.find(c=>c.identityId===id)!.hypothesisId='unresolved';
    expect(targetCheck(await tracker.run({captureDetails:async()=>source},task),id)).toMatchObject({verdict:'unknown',actual:'IDENTITY_UNCERTAIN',facts:{lifecycle:'unverified'}});
    await expect(tracker.run(e,{...task,id:'different-session-task',sessionId:'different-session'})).rejects.toThrow('SESSION_MISMATCH');
  });
  await setup('modal',async(e,sid,node,id)=>{
    const tracker=new ClippedControlTracker(), first=await tracker.run(e,latest(e,sid)), issue=targetCheck(first,id).facts!.issueId;
    await pageOf(e).locator('#frame').evaluate(el=>{ el.removeAttribute('role'); el.removeAttribute('aria-modal'); }); await e.observe(sid);
    expect((await tracker.run(e,latest(e,sid))).checks.find(c=>c.facts?.issueId===issue)).toMatchObject({verdict:'unknown',code:'CLIPPING_TARGET_UNOBSERVED',facts:{lifecycle:'unverified'}});
  });
});

it('does not partly revise issues when the tracker capacity is exceeded',async()=>{
  await setup('default',async(e,sid,node,id)=>{
    const tracker=new ClippedControlTracker({maxTracked:1}); await tracker.run(e,latest(e,sid));
    await pageOf(e).locator('#target').evaluate(el=>{
      const other=el.cloneNode(true) as HTMLElement; other.id='other'; other.dataset.testid='other'; other.textContent='Other';
      other.style.cssText='position:absolute;top:80px;left:160px;width:100px;height:40px'; el.after(other);
    });
    await e.observe(sid); const task=latest(e,sid);
    await expect(tracker.run(e,task)).rejects.toThrow('CAPACITY_EXCEEDED');
    const source=await e.captureDetails(sid,task.captureId);
    // Model a retry after the caller supplies a reduced capture target set.
    source.details!.observation.controls=source.details!.observation.controls.filter(c=>c.selector!=='#other');
    expect(targetCheck(await tracker.run({captureDetails:async()=>source},task),id).facts!.revision).toBe(2);
  });
});
