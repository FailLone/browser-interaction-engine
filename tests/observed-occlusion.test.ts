import { beforeAll, afterAll, expect, it } from 'vitest';
import { BrowserEngine, type ActionAttempt } from '@interaction/browser';
import { MemoryStore } from '@interaction/storage-memory';
import { ObservedOcclusionTracker, toInspectionResults, type ObservedOcclusionOptions, type RuleReport } from '@interaction/rules';
import { fixtureServer, pageOf } from './helpers.js';

let fixture: Awaited<ReturnType<typeof fixtureServer>>;
beforeAll(async () => { fixture = await fixtureServer(); });
afterAll(async () => { await fixture.server.close(); });
const latest = (e: BrowserEngine, sid: string) => e.listInspections(sid, {limit:500}).items.at(-1)!;
const targetCheck = (report: RuleReport, identityId: string) => report.checks.find(c => c.facts?.identityId === identityId)!;
async function setup(mode: string, fn: (e: BrowserEngine, sid: string, id: string) => Promise<void>) {
  const e = new BrowserEngine({ persistence: new MemoryStore() });
  try {
    const s = await e.createSession({ url: `${fixture.url}/observed-occlusion.html?mode=${mode}`, headless:true, viewport:{width:800,height:600},
      settleMs:60, observeTimeoutMs:1500, actionTimeoutMs:1500, maxActions:12, listExploration:'all', pageExploration:'all', inspection:{consumers:[{id:'rules'}]} });
    await fn(e,s.id,e.observation(s.id).controls.find(c=>c.name==='Target')!.identityId!);
  } finally { await e.close(); }
}
const requirement = (identityId:string): ObservedOcclusionOptions => ({ requirements:[{identityId,kind:'sampled-pointer-at-observed-position',reason:'Target must have a reachable sampled point at each observed position',evidence:['fixture:explicit-requirement']}] });
async function scroll(e:BrowserEngine,sid:string,selector='#scroller',reverse=false, expectMovement=true) {
  const container = e.observation(sid).scrollContainers!.find(c=>c.selector===selector)!;
  expect(container).toBeDefined();
  const action=e.actions(sid).find(a=>a.kind==='scroll' && (a.localId===container.nodeId
    ? (reverse ? (a.value as any).y<0 || (a.value as any).x<0 : (a.value as any).y>0 || (a.value as any).x>0)
    : a.source==='scroll-traversal' && (a.value as any).containerNodeId===container.nodeId &&
      (reverse ? (a.value as any).top<container.top || (a.value as any).left<container.left : (a.value as any).top>container.top || (a.value as any).left>container.left)))!;
  expect(action).toBeDefined();
  const attempt=await e.execute(sid,action.id,crypto.randomUUID());
  if (expectMovement) expect(attempt.status).toBe('succeeded'); return attempt;
}

it.each(['modal','horizontal','nested'])('rechecks %s scrolling without the inspector performing actions',async mode=>{
  await setup(mode,async(e,sid,id)=>{
    const tracker=new ObservedOcclusionTracker();
    const firstTask=latest(e,sid), first=await tracker.run(e,firstTask);
    expect(targetCheck(first,id)).toMatchObject({verdict:'unknown',severity:'warning',facts:{lifecycle:'suspected'}});
    const original=structuredClone(first);
    await scroll(e,sid);
    const beforeCount=e.session(sid).actionCount;
    const after=await tracker.run(e,latest(e,sid));
    expect(targetCheck(after,id)).toMatchObject({code:'OCCLUSION_RECOVERED_AFTER_SCROLL',verdict:'pass',facts:{lifecycle:'resolved',issueId:targetCheck(first,id).facts!.issueId}});
    expect(targetCheck(after,id).facts!.changedScrollContainers).toHaveLength(1);
    expect(e.session(sid).actionCount).toBe(beforeCount);
    expect(await pageOf(e).evaluate(()=>scrollY)).toBe(0);
    expect(first).toEqual(original);
    await e.completeInspection(sid,latest(e,sid).id,'rules',toInspectionResults([after]));
    await expect(tracker.run(e,firstTask)).rejects.toThrow('OUT_OF_ORDER');
    expect(await tracker.run(e,latest(e,sid))).toEqual(after);
  });
});

it('requires an explicit current-position contract before escalating persistent obstruction',async()=>{
  await setup('persistent',async(e,sid,id)=>{
    const strict=new ObservedOcclusionTracker(requirement(id)), ordinary=new ObservedOcclusionTracker();
    const first=await strict.run(e,latest(e,sid)); await ordinary.run(e,latest(e,sid));
    expect(targetCheck(first,id).severity).toBe('warning');
    await scroll(e,sid);
    const confirmed=await strict.run(e,latest(e,sid));
    expect(targetCheck(confirmed,id)).toMatchObject({verdict:'fail',severity:'error',code:'OBSERVED_POINTER_REQUIREMENT_FAILED'});
    expect(targetCheck(await ordinary.run(e,latest(e,sid)),id)).toMatchObject({verdict:'unknown',severity:'warning'});
    await pageOf(e).locator('#cover').evaluate(el=>el.remove()); await e.observe(sid);
    expect(targetCheck(await strict.run(e,latest(e,sid)),id)).toMatchObject({verdict:'pass',facts:{lifecycle:'resolved',confirmedAt:confirmed.captureId}});
  });
});

it.each(['rebuild','rebind','grow'])('does not infer scroll recovery after %s',async mode=>{
  await setup(mode,async(e,sid,id)=>{
    const tracker=new ObservedOcclusionTracker(requirement(id)); await tracker.run(e,latest(e,sid));
    await scroll(e,sid);
    expect(targetCheck(await tracker.run(e,latest(e,sid)),id)).toMatchObject({verdict:'unknown',facts:{lifecycle:'unverified'}});
  });
});

it('does not resolve offscreen, missing, or closed-scope targets',async()=>{
  await setup('modal',async(e,sid,id)=>{
    const tracker=new ObservedOcclusionTracker(); await tracker.run(e,latest(e,sid));
    await scroll(e,sid); await scroll(e,sid);
    const offscreen=await tracker.run(e,latest(e,sid));
    expect(targetCheck(offscreen,id)).toMatchObject({verdict:'unknown',facts:{lifecycle:'unverified'}});
    await pageOf(e).evaluate(()=> (window as any).closeModal()); await e.observe(sid);
    expect(targetCheck(await tracker.run(e,latest(e,sid)),id).code).toBe('OCCLUSION_TARGET_UNOBSERVED');
    await pageOf(e).evaluate(()=> (window as any).openModal()); await e.observe(sid);
    expect(targetCheck(await tracker.run(e,latest(e,sid)),id).facts!.lifecycle).toBe('unverified');
  });
});

it('uses actual ancestor offsets rather than an unrelated scroll action',async()=>{
  await setup('page',async(e,sid,id)=>{
    const tracker=new ObservedOcclusionTracker(requirement(id)); await tracker.run(e,latest(e,sid));
    await scroll(e,sid,'#side');
    const check=targetCheck(await tracker.run(e,latest(e,sid)),id);
    expect(check).toMatchObject({verdict:'unknown',severity:'warning',facts:{changedScrollContainers:[]}});
  });
});

it('processes saved captures after exploration has already advanced',async()=>{
  await setup('modal',async(e,sid,id)=>{
    const first=latest(e,sid); await scroll(e,sid); const second=latest(e,sid);
    const count=e.session(sid).actionCount; const tracker=new ObservedOcclusionTracker();
    const [a,b]=await Promise.all([tracker.run(e,first),tracker.run(e,second)]);
    expect(targetCheck(a,id).facts!.lifecycle).toBe('suspected');
    expect(targetCheck(b,id).facts!.lifecycle).toBe('resolved');
    expect(e.session(sid).actionCount).toBe(count);
  });
});

it('can replay the full automatic exploration backlog without blocking or moving the page',async()=>{
  await setup('modal',async(e,sid,id)=>{
    await e.explore(sid); await e.waitForIdle();
    const count=e.session(sid).actionCount, position=await pageOf(e).locator('#scroller').evaluate(el=>el.scrollTop);
    const tracker=new ObservedOcclusionTracker(), reports:RuleReport[]=[];
    for (const task of e.listInspections(sid,{limit:500}).items) {
      const report=await tracker.run(e,task); reports.push(report);
      await e.completeInspection(sid,task.id,'rules',toInspectionResults([report]));
    }
    expect(reports.some(r=>targetCheck(r,id)?.code==='OCCLUSION_RECOVERED_AFTER_SCROLL')).toBe(true);
    expect(e.session(sid).actionCount).toBe(count);
    expect(await pageOf(e).locator('#scroller').evaluate(el=>el.scrollTop)).toBe(position);
  });
});

it('does not mistake a scroll command cancelled by the page for actual movement',async()=>{
  await setup('no-movement',async(e,sid,id)=>{
    const tracker=new ObservedOcclusionTracker(requirement(id)); await tracker.run(e,latest(e,sid));
    await scroll(e,sid,'#scroller',false,false);
    expect(await pageOf(e).locator('#scroller').evaluate(el=>el.scrollTop)).toBe(0);
    expect(targetCheck(await tracker.run(e,latest(e,sid)),id)).toMatchObject({verdict:'unknown',severity:'warning',facts:{changedScrollContainers:[]}});
  });
});

it('scrolls the modal root through its bound control without allowing a container override',async()=>{
  await setup('root-modal',async(e,sid)=>{
    const attempt=await scroll(e,sid,'#modal');
    expect(attempt.action.localId).toBe(e.observation(sid).controls.find(c=>c.selector==='#modal')!.localId);
    expect(await pageOf(e).locator('#modal').evaluate(el=>el.scrollTop)).toBeGreaterThan(0);
    const action=e.actions(sid).find(a=>a.kind==='scroll' && a.localId===attempt.action.localId)!;
    await expect(e.execute(sid,action.id,'outside-modal',{containerNodeId:'background',top:100})).rejects.toMatchObject({code:'INVALID_INPUT'});
    expect(e.actions(sid).some(a=>a.source==='scroll-traversal')).toBe(false);
    expect(await pageOf(e).evaluate(()=>scrollY)).toBe(0);
  });
});

it('does not transfer a warning across an unresolved identity',async()=>{
  await setup('modal',async(e,sid,id)=>{
    const tracker=new ObservedOcclusionTracker(); await tracker.run(e,latest(e,sid)); await scroll(e,sid);
    const task=latest(e,sid), source=await e.captureDetails(sid,task.captureId);
    source.details!.observation.controls.find(c=>c.identityId===id)!.hypothesisId='pending-identity-review';
    expect(targetCheck(await tracker.run({captureDetails:async()=>source},task),id)).toMatchObject({verdict:'unknown',actual:'IDENTITY_UNCERTAIN',facts:{lifecycle:'unverified'}});
  });
});

it('preserves unknown when a historical hit grid or identity is unavailable',async()=>{
  await setup('modal',async(e,sid,id)=>{
    const tracker=new ObservedOcclusionTracker(); await tracker.run(e,latest(e,sid)); await scroll(e,sid);
    const task=latest(e,sid),source=await e.captureDetails(sid,task.captureId);
    const control=source.details!.observation.controls.find(c=>c.identityId===id)!;
    delete source.details!.snapshot!.dom!.nodes.find(n=>n.id===control.localId)!.layout!.hitSamples;
    expect(targetCheck(await tracker.run({captureDetails:async()=>source},task),id)).toMatchObject({verdict:'unknown',facts:{lifecycle:'unverified'}});
    const fresh = await new ObservedOcclusionTracker().run({captureDetails:async()=>source},task);
    expect(fresh.checks.find(c=>c.target?.nodeId===control.localId)).toMatchObject({verdict:'unknown',code:'OCCLUSION_RECHECK_UNAVAILABLE'});
  });
});

it('discovers scoped traversal, rejects stale containers and lets DFS scroll without an inspector',async()=>{
  await setup('modal',async(e,sid)=>{
    expect(e.actions(sid).filter(a=>a.kind==='scroll' && !a.preconditions.blockers?.length).every(a=>a.boundary?.key===e.observation(sid).boundaries!.at(-1)!.key)).toBe(true);
    const old=e.actions(sid).find(a=>a.kind==='scroll' && !a.preconditions.blockers?.length)!;
    await pageOf(e).locator('#scroller').evaluate(el=>el.replaceWith(el.cloneNode(true)));
    await expect(e.execute(sid,old.id,'stale-container')).rejects.toMatchObject({code:'STALE_OBSERVATION'});
    await e.explore(sid); await e.waitForIdle();
    const attempts=e.list<ActionAttempt>(sid,'attempt');
    expect(attempts.some(a=>a.purpose==='exploration' && a.action.kind==='scroll' && a.status==='succeeded')).toBe(true);
    expect(attempts.every(a=>a.action.source!=='external-probe')).toBe(true);
    expect(await pageOf(e).evaluate(()=>scrollY)).toBe(0);
  });
});
