import {expect,it} from 'vitest';
import {collectRegionCandidates} from '../packages/adapter-playwright/src/region-candidates.js';
import {explorerFixture} from './explorer-plugin-helpers.js';
import {pageOf} from './helpers.js';

const markup='<nav id="community" aria-label="Community"><a href="/alpha">Alpha</a><a href="/beta">Beta</a><a href="/gamma">Gamma</a></nav><section id="independent" aria-label="Independent"><input aria-label="Search"></section>';
const options={headless:true,executionPolicy:'interface-only' as const,regionExploration:'review' as const,settleMs:0,observeTimeoutMs:300};
const reason={source:'fixture-reviewer',evidence:['Observed complete region'],reuse:{binding:'same-url-context' as const,businessScope:'fixture region scope'}};

it('reuses a captured structural owner after reload while retaining every record and local key and granting no depth or action',async()=>{
  const f=await explorerFixture(markup);try{
    const s=await f.host.createSession({url:f.url,...options}),before=f.host.observation(s.id),candidate=before.regionCandidates!.find(c=>c.label==='Community')!;
    const controls=before.controls.filter(c=>candidate.controlIds.includes(c.localId));
    expect(controls).toHaveLength(3);expect(controls.every(c=>c.stableKey?.startsWith('structural-item:'))).toBe(true);
    const binding=candidate.reuseBinding as any;expect(binding.version).toBe('region-structure-reuse/v2');
    for(const [index,member]of binding.members.entries()){
      const key=JSON.parse(controls[index].stableKey!.slice('structural-item:'.length));
      expect(member.stableKey).toEqual({kind:'structural-item',recordKey:key[1],localKey:key[2]});expect(member.structural.owner.length).toBeGreaterThan(0);expect(member.structural.row.length).toBeGreaterThan(0);
    }
    const record=await f.host.reviewRegions(s.id,{observationId:before.id,source:reason.source,evidence:reason.evidence,regions:[{key:'community',label:'Community',candidateIds:[candidate.id],reuse:reason.reuse}]});
    expect(record.regions[0].reuseConditions?.version).toBe('region-review-reuse/v2');
    await pageOf(f.host).reload();await f.host.observe(s.id);const current=f.host.observation(s.id),next=current.regionCandidates!.find(c=>c.label==='Community')!;
    expect(next.id).not.toBe(candidate.id);expect(next.reuseBinding).toEqual(candidate.reuseBinding);
    const material=f.host.regionReviewMaterial(s.id),match=material.reuseCandidates!.find(c=>c.regionKey==='community')!;expect(match).toBeDefined();
    const copied=await f.host.reuseRegionReviews(s.id,{observationId:current.id,baseReviewId:material.review!.id,source:'fixture-reuse',evidence:['SDK candidate'],businessScope:reason.reuse.businessScope,regions:[{reviewId:match.reviewId,regionKey:match.regionKey,conditionKey:match.conditionKey}]});
    expect(copied.regions[0].reusedFrom?.reviewId).toBe(record.id);
    expect(f.host.explorationReviewMaterial(s.id).groups.filter(g=>g.kind==='reviewed-region').every(g=>!g.decisions.length)).toBe(true);
    expect(f.host.list(s.id,'attempt')).toEqual([]);expect(f.host.session(s.id).options.executionPolicy).toBe('interface-only');
  }finally{await f.close();}
});

it.each(['record','owner','local','duplicate-owner'] as const)('does not treat changed %s evidence as a portable structural binding',async change=>{
  let html=markup;const f=await explorerFixture(()=>html);try{
    const s=await f.host.createSession({url:f.url,...options}),o=f.host.observation(s.id),candidate=o.regionCandidates!.find(c=>c.label==='Community')!;
    await f.host.reviewRegions(s.id,{observationId:o.id,source:reason.source,evidence:reason.evidence,regions:[{key:'community',label:'Community',candidateIds:[candidate.id],reuse:reason.reuse}]});
    if(change==='record')html=markup.replace('/alpha','/other-record');
    if(change==='owner')html=markup.replace('id="community"','id="community" data-owner="different"');
    if(change==='local')html=markup.replace('href="/alpha"','href="/alpha" data-testid="other-local-key"');
    if(change==='duplicate-owner')html=markup+markup;
    await pageOf(f.host).reload();await f.host.observe(s.id);
    expect(f.host.regionReviewMaterial(s.id).reuseCandidates!.some(c=>c.regionKey==='community')).toBe(false);
    expect(f.host.list(s.id,'attempt')).toEqual([]);
  }finally{await f.close();}
});

it('fails closed when the structural stable key cannot be tied to its captured owner, record and containment',async()=>{
  const f=await explorerFixture(markup);try{
    const s=await f.host.createSession({url:f.url,...options}),o=f.host.observation(s.id),candidate=o.regionCandidates!.find(c=>c.label==='Community')!,first=o.controls.find(c=>candidate.controlIds.includes(c.localId))!;
    for(const change of ['bad-json','owner-token','record-token','missing-owner','wrong-row'] as const){
      const controls:any[]=structuredClone(o.controls),target=controls.find(c=>c.localId===first.localId)!;
      if(change==='bad-json')target.stableKey='structural-item:not-json';
      if(change==='owner-token'||change==='record-token'){const key=JSON.parse(target.stableKey!.slice('structural-item:'.length));key[change==='owner-token'?0:1]='unrelated';target.stableKey=`structural-item:${JSON.stringify(key)}`;}
      if(change==='missing-owner')target.structuralItem!.ownerInstanceId='not-captured';
      if(change==='wrong-row')target.structuralItem!.rowInstanceId=o.controls.find(c=>c.name==='Search')!.instanceId;
      const result=await pageOf(f.host).evaluate(({controls,collector})=>{
        const collect=(0,eval)(`(${collector})`),tracker=(window as any).__interactionEvidenceTracker;
        const instance=(el:Element)=>{if(!tracker.ids.has(el))tracker.ids.set(el,`${tracker.documentId}:${++tracker.counter}`);return tracker.ids.get(el);};
        const selector=(el:Element):string=>{if(el.id)return `#${CSS.escape(el.id)}`;const parts:string[]=[];for(let p:Element|null=el;p;p=p.parentElement){const siblings=p.parentElement?[...p.parentElement.children].filter(x=>x.tagName===p!.tagName):[p];parts.unshift(`${p.tagName.toLowerCase()}:nth-of-type(${siblings.indexOf(p)+1})`);}return parts.join(' > ');};
        return collect(controls,[...document.querySelectorAll('*')],instance,selector);
      },{controls,collector:collectRegionCandidates.toString()});
      expect(result.find((r:any)=>r.label==='Community').reuseBinding,change).toBeUndefined();
      expect(result.find((r:any)=>r.label==='Independent').reuseBinding,change).toBeDefined();
    }
  }finally{await f.close();}
});

it('keeps native disabled readiness outside grouping proof without allowing a disabled operation',async()=>{
  let html='<section aria-label="Actions"><button id="run" type="button" onclick="this.disabled=true">Run</button></section>';
  const f=await explorerFixture(()=>html);try{
    const s=await f.host.createSession({url:f.url,...options}),o=f.host.observation(s.id),candidate=o.regionCandidates!.find(c=>c.label==='Actions')!;
    const original=await f.host.reviewRegions(s.id,{observationId:o.id,source:reason.source,evidence:reason.evidence,regions:[{key:'actions',label:'Actions',candidateIds:[candidate.id],reuse:reason.reuse}]});
    const attempt=await f.host.execute(s.id,f.host.actions(s.id).find(a=>a.label==='Run')!.id,'fixture-first');expect(attempt.status).toBe('succeeded');
    const current=f.host.observation(s.id),next=current.regionCandidates!.find(c=>c.label==='Actions')!;
    expect(next.binding).toEqual(candidate.binding);expect(next.reuseBinding).toEqual(candidate.reuseBinding);
    expect(f.host.regionReviewMaterial(s.id).review).toMatchObject({id:original.id,status:'active'});
    expect(f.host.store.events(s.id).filter(e=>e.type==='region.review_invalidated')).toEqual([]);
    const disabled=f.host.actions(s.id).find(a=>a.label==='Run')!;expect(disabled.preconditions.enabled).toBe(false);
    await expect(f.host.execute(s.id,disabled.id,'fixture-disabled')).rejects.toMatchObject({code:'ACTION_BLOCKED'});
    // The same layout can be grouped after reload even when the current action
    // is disabled; neither the boundary proof nor reuse grants execution/depth.
    html=html.replace('id="run"','id="run" disabled');await pageOf(f.host).reload();await f.host.observe(s.id);
    const material=f.host.regionReviewMaterial(s.id),match=material.reuseCandidates!.find(c=>c.regionKey==='actions')!;expect(match).toBeDefined();
    await f.host.reuseRegionReviews(s.id,{observationId:material.observationId,baseReviewId:material.review!.id,source:'fixture-reuse',evidence:['SDK candidate'],businessScope:reason.reuse.businessScope,regions:[{reviewId:match.reviewId,regionKey:match.regionKey,conditionKey:match.conditionKey}]});
    expect(f.host.explorationReviewMaterial(s.id).groups.filter(g=>g.kind==='reviewed-region'&&g.status!=='invalidated').every(g=>g.decisions.length===0)).toBe(true);
    const stillDisabled=f.host.actions(s.id).find(a=>a.label==='Run')!;expect(stillDisabled.preconditions.enabled).toBe(false);
    await expect(f.host.execute(s.id,stillDisabled.id,'fixture-disabled-after-reuse')).rejects.toMatchObject({code:'ACTION_BLOCKED'});
    expect(f.host.list(s.id,'attempt')).toHaveLength(1);
  }finally{await f.close();}
});

it.each(['aria-disabled','data-owner','custom-disabled'] as const)('still invalidates reusable grouping when %s changes',async change=>{
  const f=await explorerFixture('<section id="actions" aria-label="Actions"><button id="run" type="button">Run</button></section>');try{
    const s=await f.host.createSession({url:f.url,...options}),o=f.host.observation(s.id),candidate=o.regionCandidates!.find(c=>c.label==='Actions')!;
    await f.host.reviewRegions(s.id,{observationId:o.id,source:reason.source,evidence:reason.evidence,regions:[{key:'actions',label:'Actions',candidateIds:[candidate.id],reuse:reason.reuse}]});
    await pageOf(f.host).evaluate(change=>document.querySelector(change==='custom-disabled'?'#actions':'#run')!.setAttribute(change==='custom-disabled'?'disabled':change,'true'),change);
    await f.host.observe(s.id);const material=f.host.regionReviewMaterial(s.id);
    expect(material.review?.regions.find(r=>r.key==='actions')?.status).toBe('invalidated');expect(material.reuseCandidates).toEqual([]);
    expect(f.host.list(s.id,'attempt')).toEqual([]);
  }finally{await f.close();}
});
