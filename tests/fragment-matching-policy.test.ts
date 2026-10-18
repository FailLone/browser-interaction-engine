import {expect,it} from 'vitest';
import {readFileSync} from 'node:fs';
import {gunzipSync} from 'node:zlib';
import {createHash} from 'node:crypto';
import {browserTraversalFragments,fragmentProjectionPolicy} from '../packages/adapter-playwright/src/fragment-projection.js';
import {assessBrowserReviewBranchConditions} from '../packages/adapter-playwright/src/branch-conditions.js';
import {modeStructureReader} from '../packages/adapter-playwright/src/mode-structure.js';
import type {Observation,ActionCandidate,ActionAttempt} from '@interaction/browser';
import type {PlanItem} from '@interaction/explorer-plugin';
import {emptyFragmentAccess,mapFragmentCandidates,recordFragmentAccess} from '../packages/explorer-plugin/src/fragment-traversal-core.js';
import {registerFragmentObservation,recordFragmentOutcome,fragmentActionEvidence,fragmentSamplingDecision,fragmentObligationSampled,fragmentStateOrder,sampledFragmentAction,preferFragmentCandidate} from '../packages/explorer-plugin/src/fragment-traversal.js';
import {fragmentFixture} from './fragment-storage-helpers.js';
import {digest} from '../packages/explorer-plugin/src/policy.js';
import {navigationModeFixture} from './fixtures/mode-structure.js';
const bytes=gunzipSync(readFileSync(new URL('./fixtures/fraggen-matching/okx-public-captures.json.gz',import.meta.url)));
const manifest=JSON.parse(readFileSync(new URL('./fixtures/fraggen-matching/manifest.json',import.meta.url),'utf8'));
const rows=JSON.parse(bytes.toString()) as {index:number;observation:Observation;actions:ActionCandidate[]}[];
const capture=(index:number)=>structuredClone(rows.find(r=>r.index===index)!);
const projections=(r:ReturnType<typeof capture>)=>browserTraversalFragments(r.observation,r.actions,'authority');
const candidates=(r:ReturnType<typeof capture>)=>projections(r).flatMap(f=>f.candidates);
function mappings(a:ReturnType<typeof capture>,b:ReturnType<typeof capture>){
 const convert=(r:ReturnType<typeof capture>)=>projections(r).map(f=>({...f,id:r.observation.id+f.regionId,candidates:f.candidates.map(c=>({...c,id:c.actionId,access:emptyFragmentAccess()}))}));
 return convert(a).flatMap(x=>convert(b).flatMap(y=>mapFragmentCandidates(x,y)));
}
const tab=(r:ReturnType<typeof capture>)=>r.observation.controls.find(c=>c.role==='tab'&&c.name==='USDT')!;
const conditions=(r:ReturnType<typeof capture>,target=tab(r))=>assessBrowserReviewBranchConditions(target,r.observation,modeStructureReader(r.observation,'fragment')).conditions;

it('freezes exact public OKX inputs and reproduces the legacy instance-mode rejection',()=>{
 expect(createHash('sha256').update(bytes).digest('hex')).toBe(manifest.fixtureSHA256);
 const r=capture(10),before=structuredClone(r),t=tab(r);
 expect(t.identityScope).toBe('instance');
 expect(assessBrowserReviewBranchConditions(t,r.observation).assessment.reason).toBe('selector_instance_bound');
 const diagnostic=new Map<string,string>();browserTraversalFragments(r.observation,r.actions,'authority',diagnostic);
 expect([...diagnostic.values()].filter(v=>v==='projectable')).toHaveLength(103);
 // This search control has an incomplete captured dependency edge.
 expect(diagnostic.get('4af4054a-b8d7-4b63-b01c-5d21c258046b')).toBe('mode:related_reference_incomplete');
 expect(conditions(r)?.conditions).toHaveLength(15);
 expect(r).toEqual(before); // Neither target identity nor original evidence is upgraded.
});

it('maps an actually repeated capture, and preserves its local proof under a document-instance rebuild',()=>{
 const original=capture(10),repeat=capture(11);
 expect(mappings(original,repeat)).toHaveLength(103);
 // Metamorphic rebuild of frozen bytes, explicitly separate from the real pair.
 const rebuilt=JSON.parse(JSON.stringify(original).replaceAll(original.observation.documentId,'rebuilt-document'));
 rebuilt.observation.id='rebuilt-observation';rebuilt.observation.url='https://www.okx.com/another-public-document';
 expect(mappings(original,rebuilt)).toHaveLength(103);
 expect(tab(rebuilt).identityScope).toBe('instance');
});

it('separates external document-mode differences from changed relevant tab values',()=>{
 expect(mappings(capture(0),capture(4)).length).toBeGreaterThan(0);
 const a=capture(10),b=capture(14),ids=new Set(a.actions.filter(action=>action.localId===tab(a).localId).map(action=>action.id));
 expect(mappings(a,b).filter(m=>ids.has(m.sourceCandidateId))).toEqual([]);
 expect(conditions(capture(10))?.key).not.toBe(conditions(capture(14))?.key);
 // Unkeyed business records still decline locally; unrelated header work proceeds.
 const r=capture(18),d=new Map<string,string>();browserTraversalFragments(r.observation,r.actions,'authority',d);
 expect(candidates(r).length).toBeGreaterThan(0);expect([...d.values()].some(v=>v==='unkeyed_record'||v==='mode:selector_record_key_missing')).toBe(true);
});

it.each(['external-mode','context','parameter','record','destination','hidden-target','missing','truncated','duplicate-root'])(
 'retains the %s guard when projecting the real menu',kind=>{
  const a=capture(10),b=capture(10),t=tab(b),o=b.observation;
  if(kind==='external-mode'){const external=o.controls.find(c=>c.expanded!==null&&c.expanded!==undefined&&c.name.includes('语言'))!;expect(external).toBeDefined();external.expanded=!external.expanded;}
  if(kind==='context')o.context={variant:{status:'known',value:'B',source:'fixture'}} as Observation['context'];
  if(kind==='parameter')for(const action of b.actions)action.value='changed-parameter';
  if(kind==='record')for(const c of o.controls)c.structuralItem={ownerInstanceId:'owner',rowInstanceId:'row',recordKey:'different-record',slot:'new-slot',template:'row'};
  if(kind==='destination'||kind==='hidden-target')for(const r of o.regionCandidates||[])for(const n of r.fragment?.nodes||[])if(n.attributes.href)n.attributes.href='https://www.okx.com/'+(kind==='destination'?'sell':'new-hidden-child');
  if(kind==='missing')for(const c of o.controls)c.reviewBinding=undefined;
  if(kind==='truncated')for(const c of o.controls)c.classificationBinding={nodes:[],text:'',truncated:true};
  if(kind==='duplicate-root')o.regionCandidates!.push(...JSON.parse(JSON.stringify(o.regionCandidates!).replaceAll(o.documentId,'duplicate-document')));
  if(kind==='destination'||kind==='hidden-target'){
    const affected=new Set(projections(a).filter(f=>a.observation.regionCandidates!.find(r=>r.id===f.regionId)!.fragment!.nodes.some(n=>n.attributes.href)).flatMap(f=>f.candidates.map(c=>c.actionId)));
    expect(affected.size).toBeGreaterThan(0);
    expect(mappings(a,b).filter(m=>affected.has(m.sourceCandidateId))).toEqual([]);
    expect(mappings(a,b).length).toBeGreaterThan(0); // Independent unchanged fragments remain reusable.
  }else if(kind==='external-mode'){
    expect(mappings(a,b).length).toBeGreaterThan(0);
    const from=candidates(a),to=candidates(b);expect(from.some(c=>to.some(d=>c.actionId===d.actionId&&c.context!==d.context))).toBe(true);
  }else expect(mappings(a,b)).toEqual([]);
 });

it.each(['duplicate-destination','missing-link-proof','unkeyed-record','missing-state','duplicate-node','incomplete-owner','outside-navigation'])(
 'rejects navigation tab correspondence with %s',kind=>{
 const r=capture(10),o=r.observation,t=tab(r),owner=o.controls.find(c=>c.tag==='div'&&c.classificationBinding?.nodes.length===165)!;
 expect(modeStructureReader(o,'fragment')(t)).toBeDefined();
 const nodes=owner.classificationBinding!.nodes;
 if(kind==='duplicate-destination'){const links=o.controls.filter(c=>c.tag==='a'&&nodes.some(n=>n.instanceId===c.instanceId));for(const c of links)c.identityContext={binding:JSON.stringify([['link-destination','https://www.okx.com/same','']]),evidence:['link-destination/v1']};}
 if(kind==='missing-link-proof')for(const c of o.controls)if(c.tag==='a')c.identityContext=undefined;
 if(kind==='unkeyed-record')t.structuralItem={ownerInstanceId:owner.instanceId,rowInstanceId:t.instanceId,slot:'tab',template:'row'};
 if(kind==='missing-state')delete nodes.find(n=>n.instanceId===t.instanceId)!.attributes['aria-selected'];
 if(kind==='duplicate-node')nodes.push(structuredClone(nodes.find(n=>n.instanceId===t.instanceId)!));
 if(kind==='incomplete-owner')owner.classificationBinding!.truncated=true;
 if(kind==='outside-navigation')for(const a of owner.reviewReuseBinding!.ancestors)if(a.tag==='nav'){a.tag='main';delete a.attributes.role;}
 expect(modeStructureReader(o,'fragment')(t)).toBeUndefined();
 });

it('does not discard captured external ancestor dependencies merely because a navigation landmark exists',()=>{
 const a=navigationModeFixture({instanceBound:true}),b=navigationModeFixture({instanceBound:true,documentId:'rebuilt'});
 a.owner.reviewReuseBinding!.ancestors.push({tag:'body',selector:'body',attributes:{'data-document-instance':'before'},label:''});
 b.owner.reviewReuseBinding!.ancestors.push({tag:'body',selector:'body',attributes:{'data-document-instance':'after'},label:''});
 expect(modeStructureReader(a.observation)(a.modes.b)?.key).not.toBe(modeStructureReader(b.observation)(b.modes.b)?.key);
 expect(modeStructureReader(a.observation,'fragment')(a.modes.b)?.key).not.toBe(modeStructureReader(b.observation,'fragment')(b.modes.b)?.key);
 b.owner.reviewReuseBinding!.ancestors[1].attributes['data-document-instance']='before';
 expect(modeStructureReader(a.observation,'fragment')(a.modes.b)?.key).toBe(modeStructureReader(b.observation,'fragment')(b.modes.b)?.key);
 b.owner.reviewReuseBinding!.ancestors[0].attributes['data-mode']='different';
 expect(modeStructureReader(a.observation,'fragment')(a.modes.b)?.key).not.toBe(modeStructureReader(b.observation,'fragment')(b.modes.b)?.key);
});

it.each(['guarded-host-fragments/v1','guarded-host-fragments/v2','guarded-host-fragments/v3'])('disables %s derived pruning while retaining IDs, receipts and pending work',policy=>{
 const r=capture(10),active=fragmentFixture(),ids=new Set(r.actions.map(a=>a.id));
 const front=registerFragmentObservation(active.session,r.observation,r.actions,'authority',ids),[actionId,ref]=[...front.byAction][0];
 const item={id:'original-pending-child',scope:{kind:'click'},status:'pending',required:true} as PlanItem;
 active.session.put('obligations',{id:item.id,scopeKey:digest({scope:item.scope}),authority:'authority',candidateIds:[ref.candidateId]});
 active.session.put('events',{id:'actual-receipt',...ref,sessionId:'session',observationId:'before',afterId:'after',actionId});
 const legacy=active.session.exportLegacy();legacy.policy=policy;active.close();
 const old=fragmentFixture(':memory:',legacy),l=old.session,before=old.store.exportFragments('task');
 try{
 expect(fragmentProjectionPolicy).toBe('guarded-host-fragments/v4');
 expect(fragmentObligationSampled(l,item)).toBe(false);expect(fragmentActionEvidence(l,front,actionId)).toBeUndefined();
 expect(fragmentSamplingDecision(l,ref.candidateId)).toBeUndefined();
 expect(sampledFragmentAction(l,r.observation,r.actions,'authority',actionId)).toBe(false);
 expect(fragmentStateOrder(l,r.observation)).toEqual({order:[],deferred:[]});
 const choices=[{actionId},{actionId:'unmapped'}];expect(preferFragmentCandidate(l,front,choices)).toBe(choices[0]);
 expect(registerFragmentObservation(l,r.observation,r.actions,'authority',ids).byAction.size).toBe(0);
 expect(recordFragmentOutcome(l,front,{status:'succeeded',afterId:'after',id:'new'} as ActionAttempt)).toBe(false);
 expect(old.store.exportFragments('task')).toEqual(before);expect(l.delta()).toBeUndefined();expect(item.status).toBe('pending');
 }finally{old.close();}
});
