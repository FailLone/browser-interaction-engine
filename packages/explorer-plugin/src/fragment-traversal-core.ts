/**
 * Selected algorithms translated from Crawljax, Apache-2.0.
 * Upstream a9e14583e85569f6a7775fa6391c13cf53b3fd6d:
 * CandidateElement.java access setters/wasExplored; Fragment.java 385-457;
 * FragmentManager.java 656-838; UnfiredFragmentCandidates.java 94-137.
 * License: docs/third-party/crawljax/LICENSE.
 * Modified 2026-10-18: immutable event IDs, guarded relative-path mapping,
 * host segmentation, recomputed scores, explicit reachable costs. No VIPS,
 * visual equality, ND2, success coverage or dispatch authorization is implied.
 */
export interface FragmentAccess {
  direct:string[]; duplicate:string[]; equivalent:string[];
}
export interface FragmentCounters {direct:boolean;duplicate:number;equivalent:number}
export type FragmentAccessView=FragmentAccess|FragmentCounters;
export interface FragmentCandidate {
  id:string; path:string; operation:string; guard:string;
  access:FragmentAccess;
}
export interface TraversalFragment {
  id:string; structure:string; owner:string; revision:string;
  candidates:FragmentCandidate[];
}
export interface FragmentMapping {
  sourceFragmentId:string; targetFragmentId:string;
  sourceCandidateId:string; targetCandidateId:string;
  kind:'duplicate'|'equivalent';
  revoked?:{reason:string};
}
export const emptyFragmentAccess=():FragmentAccess=>({direct:[],duplicate:[],equivalent:[]});
const union=(...values:string[][])=>[...new Set(values.flat())].sort();
/** Every actual direct visit increments duplicate and equivalent upstream. The
 * host derives that from unique durable events, so replay/loading is idempotent. */
export function fragmentAccessCounters(access:FragmentAccessView):FragmentCounters {
  if(typeof access.direct==='boolean')return access as FragmentCounters;
  access=access as FragmentAccess;
  const direct=union(access.direct),duplicate=union(direct,access.duplicate),equivalent=union(duplicate,access.equivalent);
  return {direct:direct.length>0,duplicate:duplicate.length,equivalent:equivalent.length};
}
export function fragmentWasExplored(access:FragmentAccessView) {
  const counts=fragmentAccessCounters(access);return counts.direct||counts.duplicate>0||counts.equivalent>0;
}
export function fragmentCandidateInfluence(access:FragmentAccessView) {
  const c=fragmentAccessCounters(access);return (c.direct?0:1)-.5*c.duplicate-.25*c.equivalent;
}
export function fragmentDuplicationFactor(duplicates:number,equivalents:number) {return 2*(1+duplicates)-1+equivalents;}
/** Ordered local tree equality substitutes only zero structural edit distance.
 * No image comparison is available, hence host relations are equivalent only.
 * Unlike upstream XPath alone, operation/guard must also agree and be unique. */
export function mapFragmentCandidates(source:TraversalFragment,target:TraversalFragment):FragmentMapping[] {
  if(source.structure!==target.structure||source.owner!==target.owner)return [];
  const key=(candidate:FragmentCandidate)=>JSON.stringify([candidate.path,candidate.operation,candidate.guard]);
  const index=(items:FragmentCandidate[])=>{const values=new Map<string,FragmentCandidate[]>();for(const item of items){const k=key(item);values.set(k,[...values.get(k)||[],item]);}return values;};
  const from=index(source.candidates),to=index(target.candidates),mapped:FragmentMapping[]=[];
  for(const [key,old] of from){const current=to.get(key);if(old.length!==1||current?.length!==1)continue;
    mapped.push({sourceFragmentId:source.id,targetFragmentId:target.id,sourceCandidateId:old[0].id,targetCandidateId:current[0].id,kind:'equivalent'});
  }
  return mapped;
}
/** Max transfer and live increments become source-event union. Cyclic relations
 * cannot mint additional visits. A rejected mapping transfers nothing. */
export function transferFragmentAccess(source:FragmentAccess,target:FragmentAccess,kind:FragmentMapping['kind']):FragmentAccess {
  const all=union(source.direct,source.duplicate,source.equivalent);
  return {direct:[...target.direct],duplicate:kind==='duplicate'?union(target.duplicate,source.direct,source.duplicate):[...target.duplicate],
    equivalent:union(target.equivalent,all).filter(id=>!target.direct.includes(id)&&!target.duplicate.includes(id))};
}
export function recordFragmentAccess(access:FragmentAccess,eventId:string):FragmentAccess {
  return {...access,direct:union(access.direct,[eventId])};
}
/** Fresh-first positive scoring follows getBestCandidate. Host skipExplored is
 * applied outside this function and never removes an obligation or route. */
export function bestFragmentCandidate<T extends {access:FragmentAccessView;factor:number}>(candidates:readonly T[],maxRepeat=2):T|undefined {
  let fresh:T|undefined,repeated:T|undefined,maxFresh=0,maxRepeated=0;
  for(const candidate of candidates){const c=fragmentAccessCounters(candidate.access);if(c.direct||c.equivalent>=maxRepeat)continue;
    const score=fragmentCandidateInfluence(candidate.access)*candidate.factor;
    if(!fragmentWasExplored(candidate.access)){if(score>maxFresh){maxFresh=score;fresh=candidate;}}
    else if(score>maxRepeated){maxRepeated=score;repeated=candidate;}
  }
  return fresh||repeated;
}
/** The host supplies current route costs; no current-only hop cache, unreachable
 * -1 reward or permanent false hasUnexplored latch is carried over. */
export function bestFragmentState<T extends {fresh:number;influence:number;cost:number|undefined;reachable:boolean}>(states:readonly T[]):T|undefined {
  let best:T|undefined,score=-Infinity;
  for(const state of states){if(!state.reachable||state.cost===undefined||!Number.isFinite(state.cost)||state.cost<0)continue;
    const value=state.influence-state.cost;
    if(!best||Number(state.fresh>0)>Number(best.fresh>0)||Number(state.fresh>0)===Number(best.fresh>0)&&value>score){best=state;score=value;}
  }
  return best;
}
