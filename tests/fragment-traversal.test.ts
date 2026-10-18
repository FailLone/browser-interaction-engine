import {expect,it} from 'vitest';
import {bestFragmentCandidate,bestFragmentState,emptyFragmentAccess,fragmentAccessCounters,fragmentCandidateInfluence,fragmentDuplicationFactor,mapFragmentCandidates,recordFragmentAccess,transferFragmentAccess,type TraversalFragment} from '../packages/explorer-plugin/src/fragment-traversal-core.js';
const fragment=(id:string,guard='/buy'):TraversalFragment=>({id,structure:'nav/a[1]',owner:'main-navigation',revision:id,candidates:[{id:id+'-a',path:'a[1]',operation:'click',guard,access:emptyFragmentAccess()}]});
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
