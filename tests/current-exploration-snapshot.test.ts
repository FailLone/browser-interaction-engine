import { expect, it, vi } from 'vitest';
import type { ActionAttempt } from '@interaction/browser';
import { explorerFixture } from './explorer-plugin-helpers.js';

const options={headless:true,exploration:'controls',settleMs:0,observeTimeoutMs:100,interfaceActions:[{kind:'click'}]};
const currentOnly={includeHistoryAudit:false} as const;
function currentFacts<T extends {frontier:unknown;explorationAudit:unknown;completionAudit:unknown;historyAuditIncluded:boolean}>(snapshot:T) {
  const {frontier:_frontier,explorationAudit:_audit,completionAudit:_completion,historyAuditIncluded:_included,...facts}=snapshot;return facts;
}

it('returns identical current facts without loading historical observations or claiming historical coverage',async()=>{
  const f=await explorerFixture('<canvas></canvas><div id="unknown" style="cursor:pointer">Unknown</div><button type="button">Ready</button>');
  try{
    const s=await f.host.createSession({...options,url:f.url});await f.host.observe(s.id);const o=f.host.observation(s.id),eventCount=f.host.store.events(s.id).length;
    const reads=vi.spyOn(f.host.store,'list'),writes=vi.spyOn(f.host.store,'put');
    const light=f.host.explorationSnapshot(s.id,o.id,currentOnly);
    expect(reads.mock.calls.filter(([kind])=>kind==='observation')).toEqual([]);expect(writes).not.toHaveBeenCalled();
    reads.mockClear();const full=f.host.explorationSnapshot(s.id,o.id);
    expect(reads.mock.calls.filter(([kind])=>kind==='observation')).toHaveLength(1);expect(currentFacts(light)).toEqual(currentFacts(full));
    expect(light).toMatchObject({historyAuditIncluded:false,frontier:undefined,explorationAudit:undefined,completionAudit:undefined});
    expect(full.historyAuditIncluded).toBe(true);expect(full.explorationAudit.discoveryComplete).toBe(false);
    expect(light.facts.some(x=>x.kind==='unsupported'&&x.code==='UNSUPPORTED_CANVAS')).toBe(true);
    expect(f.host.store.events(s.id)).toHaveLength(eventCount);expect(f.host.session(s.id).actionCount).toBe(0);
    const completion=f.host.explorationSnapshot(s.id,o.id,{includeCompletionAudit:true});
    expect(completion.completionAudit?.exhaustive).toBe(false);expect(completion.completionAudit?.gaps.some(g=>g.code==='UNSUPPORTED_CANVAS')).toBe(true);
    expect(()=>f.host.explorationSnapshot(s.id,o.id,{includeHistoryAudit:false,includeCompletionAudit:true})).toThrow('Completion audit requires historical evidence');
  }finally{await f.close();}
});

it('rebuilds review and sampling blockers on the same observation, and dispatch still revalidates',async()=>{
  const f=await explorerFixture('<section aria-label="Area"><button id="one" type="button">One</button><button id="two" type="button">Two</button></section>');
  try{
    const s=await f.host.createSession({...options,url:f.url,regionExploration:'review'}),initial=f.host.observation(s.id),region=f.host.regionReviewMaterial(s.id);
    await f.host.reviewRegions(s.id,{observationId:initial.id,source:'test',evidence:['Visible region'],regions:[{key:'area',label:'Area',candidateIds:[region.candidates.find(c=>c.label==='Area')!.id]}]});
    const o=f.host.observation(s.id),group=f.host.explorationReviewMaterial(s.id).groups.find(g=>g.kind==='reviewed-region')!;
    await f.host.decideExplorationGroup(s.id,group.id,group.revision,{mode:'all',source:'test',evidence:['All members in scope']});
    const allowed=f.host.explorationSnapshot(s.id,o.id,currentOnly),a=allowed.actions.find(a=>a.label==='One')!;
    expect(allowed.availability.actions.find(x=>x.actionId===a.id)?.executable).toBe(true);
    let updated=f.host.explorationReviewMaterial(s.id).groups.find(g=>g.id===group.id)!;
    await f.host.decideExplorationGroup(s.id,updated.id,updated.revision,{mode:'sample',memberKeys:[updated.members.find(m=>m.actionId!==a.id)!.key],source:'test',evidence:['Only another member']});
    const sampled=f.host.explorationSnapshot(s.id,o.id,currentOnly);
    expect(sampled.observationId).toBe(allowed.observationId);expect(sampled.revision).not.toBe(allowed.revision);
    expect(sampled.availability.actions.find(x=>x.actionId===a.id)?.blockers).toContainEqual(expect.objectContaining({selection:expect.objectContaining({state:'unselected'})}));
    updated=f.host.explorationReviewMaterial(s.id).groups.find(g=>g.id===group.id)!;
    await f.host.decideExplorationGroup(s.id,updated.id,updated.revision,{mode:'defer',source:'test',evidence:['Review withdrawn']});
    const deferred=f.host.explorationSnapshot(s.id,o.id,currentOnly);expect(currentFacts(deferred)).toEqual(currentFacts(f.host.explorationSnapshot(s.id,o.id)));
    expect(deferred.availability.actions.find(x=>x.actionId===a.id)?.executable).toBe(false);
    await expect(f.host.execute(s.id,a.id,'revoked',undefined,{observationId:o.id,profile:'interface-exploration'})).rejects.toMatchObject({code:'ACTION_BLOCKED'});
    expect((await f.host.execute(s.id,a.id,'manual')).status).toBe('succeeded');
    expect(()=>f.host.explorationSnapshot(s.id,o.id,currentOnly)).toThrow('Audit requires the current observation');
  }finally{await f.close();}
});

it('retains unknown outcomes and their execution blockers in the current-only query',async()=>{
  const f=await explorerFixture('<button type="button">Run</button>');
  try{
    const s=await f.host.createSession({...options,url:f.url}),action=f.host.actions(s.id).find(a=>a.label==='Run')!,attempt=await f.host.execute(s.id,action.id,'known');
    f.host.store.put('attempt',{...attempt,status:'unknown',reason:'Result evidence unavailable'} satisfies ActionAttempt);
    const light=f.host.explorationSnapshot(s.id,undefined,currentOnly),full=f.host.explorationSnapshot(s.id);
    expect(currentFacts(light)).toEqual(currentFacts(full));expect(light.unknownAttempts.map(a=>a.id)).toContain(attempt.id);
    expect(light.recovery.unknownAttempts.map(a=>a.id)).toContain(attempt.id);expect(light.facts.some(f=>f.kind==='unknown-result')).toBe(true);
    expect(light.availability.actions.every(a=>!a.executable)).toBe(true);expect(f.host.list<ActionAttempt>(s.id,'attempt')[0].status).toBe('unknown');
  }finally{await f.close();}
});

it('uses fresh active-boundary facts on each dialog entry without reusing an earlier visit',async()=>{
  const f=await explorerFixture('<button id="open" onclick="document.querySelector(\'dialog\').showModal()">Open</button><dialog><button onclick="this.parentElement.close()">Close</button></dialog>');
  try{
    const s=await f.host.createSession({...options,url:f.url}),click=async(label:string)=>f.host.execute(s.id,f.host.actions(s.id).find(a=>a.label===label&&a.kind==='click')!.id,crypto.randomUUID());
    await click('Open');const first=f.host.explorationSnapshot(s.id,undefined,currentOnly);expect(first.boundary.active?.scopeId).toBeTruthy();
    expect(currentFacts(first)).toEqual(currentFacts(f.host.explorationSnapshot(s.id)));
    const background=first.actions.find(a=>a.label==='Open'&&a.kind==='click');if(background)expect(first.availability.actions.find(a=>a.actionId===background.id)?.blockers.some(b=>b.reason==='outside_active_boundary')).toBe(true);
    await click('Close');expect(f.host.explorationSnapshot(s.id,undefined,currentOnly).boundary.active).toBeUndefined();
    await click('Open');const second=f.host.explorationSnapshot(s.id,undefined,currentOnly);expect(second.boundary.active?.scopeId).not.toBe(first.boundary.active?.scopeId);
    expect(()=>f.host.explorationSnapshot(s.id,first.observationId,currentOnly)).toThrow('Audit requires the current observation');
  }finally{await f.close();}
});

it('rechecks classification evidence after revocation while preserving unsupported facts',async()=>{
  const f=await explorerFixture('<canvas></canvas><div id="label" tabindex="0">Information</div>');
  try{
    const s=await f.host.createSession({...options,url:f.url}),o=f.host.observation(s.id),c=o.controls.find(c=>c.stableKey==='id:label')!;
    const [record]=await f.host.classifyControls(s.id,{observationId:o.id,source:'test',classifications:[{localId:c.localId,classification:'display',reason:'Display only',evidence:['Observed text']}]});
    const interpreted=f.host.explorationSnapshot(s.id,undefined,currentOnly);expect(interpreted.nonInteractive.some(x=>x.classificationId===record.id)).toBe(true);
    await f.host.revokeControlClassification(s.id,{classificationId:record.id,source:'test',reason:'Withdraw interpretation'});
    const revoked=f.host.explorationSnapshot(s.id,undefined,currentOnly);expect(revoked.nonInteractive).toEqual([]);expect(revoked.revision).not.toBe(interpreted.revision);
    expect(currentFacts(revoked)).toEqual(currentFacts(f.host.explorationSnapshot(s.id)));expect(revoked.facts.some(x=>x.kind==='unsupported')).toBe(true);
  }finally{await f.close();}
});
