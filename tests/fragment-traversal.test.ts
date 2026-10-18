import {expect,it} from 'vitest';
import type {Observation} from '@interaction/browser';
import {digest} from '../packages/explorer-plugin/src/policy.js';
import {initialFragmentLedger,preferFragmentCandidate,fragmentStateOrder,type FragmentFrontier} from '../packages/explorer-plugin/src/fragment-traversal.js';
import {encodeFragmentMaterial,decodeFragmentMaterial} from '../packages/explorer-plugin/src/fragment-material.js';
import {bestFragmentCandidate,bestFragmentState,emptyFragmentAccess,fragmentAccessCounters,fragmentCandidateInfluence,fragmentDuplicationFactor,mapFragmentCandidates,recordFragmentAccess,transferFragmentAccess,type TraversalFragment} from '../packages/explorer-plugin/src/fragment-traversal-core.js';
const fragment=(id:string,guard='/buy'):TraversalFragment=>({id,structure:'nav/a[1]',owner:'main-navigation',revision:id,candidates:[{id:id+'-a',path:'a[1]',operation:'click',guard,access:emptyFragmentAccess()}]});
it('retains every byte of repetitive mode evidence while bounding its stored size',()=>{
 const material=JSON.stringify(Array.from({length:30},(_,i)=>({binding:JSON.stringify({anchor:`id:mode-${i}`,scope:'shared semantic navigation region',role:'button',attributes:{'aria-label':'Mode selector'}}),state:{expanded:false},relation:'observed-document-mode'})));
 const encoded=encodeFragmentMaterial(material);expect(decodeFragmentMaterial(encoded)).toBe(material);
 expect(encoded.length).toBeLessThan(material.length/4);
 const changed=material.replace('mode-29','mode-30');expect(encodeFragmentMaterial(changed)).not.toBe(encoded);expect(decodeFragmentMaterial(encodeFragmentMaterial(changed))).toBe(changed);
 expect(encodeFragmentMaterial(decodeFragmentMaterial(encoded))).toBe(encoded);expect(decodeFragmentMaterial('legacy material')).toBe('legacy material');
});
it('preserves the source influence/factor and fresh-first selection, while event propagation is idempotent',()=>{
 const direct=recordFragmentAccess(emptyFragmentAccess(),'attempt-A'),propagated=transferFragmentAccess(direct,emptyFragmentAccess(),'equivalent');
 expect(fragmentAccessCounters(direct)).toEqual({direct:true,duplicate:1,equivalent:1});expect(fragmentCandidateInfluence(direct)).toBe(-.75);
 expect(fragmentCandidateInfluence(propagated)).toBe(.75);expect(fragmentDuplicationFactor(2,3)).toBe(8);
 expect(transferFragmentAccess(direct,propagated,'equivalent')).toEqual(propagated);
 expect(transferFragmentAccess(propagated,direct,'equivalent').direct).toEqual(['attempt-A']);
 const fresh={access:emptyFragmentAccess(),factor:1},repeated={access:propagated,factor:100};expect(bestFragmentCandidate([repeated,fresh])).toBe(fresh);
});
it('requires unique guarded relative mappings, including kind/value, binding, destination, mode and context',()=>{
 const a=fragment('A'),b=fragment('B');expect(mapFragmentCandidates(a,b)).toHaveLength(1);
 for(const guard of ['/sell','mode-B','context-B','record-B','options-B'])expect(mapFragmentCandidates(a,fragment('B',guard))).toEqual([]);
 for(const key of ['path','operation'] as const){const b=fragment('B');b.candidates[0][key]='changed';expect(mapFragmentCandidates(a,b)).toEqual([]);}
 for(const key of ['structure','owner'] as const){const b=fragment('B');b[key]='changed';expect(mapFragmentCandidates(a,b)).toEqual([]);}
 b.candidates.push({...b.candidates[0],id:'ambiguous'});expect(mapFragmentCandidates(a,b)).toEqual([]);
});
it('never rewards an unreachable negative distance or a stale fresh latch',()=>{
 const empty={id:'old',fresh:0,influence:20,reachable:true,cost:1},fresh={id:'fresh',fresh:1,influence:1,reachable:true,cost:2};
 expect(bestFragmentState([empty,fresh,{id:'bad',fresh:100,influence:100,reachable:false,cost:-1}])).toBe(fresh);
 expect(bestFragmentState([{...empty,cost:-1}])).toBeUndefined();
 expect(bestFragmentState([{...empty,fresh:1},fresh])?.id).toBe('old');
});
it('shares the closest fragment factor across old siblings and newly revealed children',()=>{
 const l=initialFragmentLedger(),base=fragment('current');base.candidates.push({...base.candidates[0],id:'new-child',path:'input[1]'});
 l.fragments.push({...base,url:'https://example.test/',source:{sessionId:'s',observationId:'o',regionId:'region'}});
 // Only the old sibling maps to retained snapshots. This affects the whole
 // fragment's expected reuse, never the fresh child's relative priority.
 l.mappings.push(...['old-A','old-B'].map(id=>({sourceFragmentId:'current',targetFragmentId:id,sourceCandidateId:'current-a',targetCandidateId:id+'-a',kind:'equivalent' as const})));
 const front:FragmentFrontier={observationId:'o',byAction:new Map([['child',{fragmentId:'current',candidateId:'new-child'}],['sibling',{fragmentId:'current',candidateId:'current-a'}]]),pruned:[],registered:0,mapped:0,unmapped:0,elapsedMs:0};
 const choices=[{actionId:'child'},{actionId:'sibling'}];expect(preferFragmentCandidate(l,front,choices)).toBe(choices[0]);
});
it('sums negative actual-access influence in state scores instead of clipping it away',()=>{
 const l=initialFragmentLedger(),f=fragment('retained');f.candidates[0].access=recordFragmentAccess(emptyFragmentAccess(),'actual');
 f.candidates.push({...fragment('fresh').candidates[0]});
 l.fragments.push({...f,url:'https://example.test/retained',source:{sessionId:'s',observationId:'old',regionId:'region'}});
 const navigation={browserSessionId:'browser',currentIndex:0,entries:[{id:1,url:'https://example.test/retained',method:'GET'}]} as Observation['navigation'];
 l.states.push({id:'state',url:'https://example.test/retained',context:digest({}),candidateIds:f.candidates.map(c=>c.id),source:{sessionId:'s',observationId:'old'},navigation});
 const result=fragmentStateOrder(l,{url:'https://example.test/current',context:{},navigation} as Observation);
 expect(result.order[0]).toMatchObject({fresh:1,influence:.25,reachable:true,cost:1});
});
