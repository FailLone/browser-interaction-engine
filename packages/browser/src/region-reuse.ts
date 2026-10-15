import { canonical, contextKey, EngineError, hash, now, type Persistence } from '@interaction/core';
import type { Observation, RegionReviewRecord, RegionReuseCandidate, RegionReuseConditions, RevokeRegionReuseInput } from '@interaction/adapter-playwright';

type Region = RegionReviewRecord['regions'][number];
/** A reusable boundary description is independent of its exploration decisions. */
export class RegionReuse {
  constructor(private store:Persistence,private emit:(sid:string,type:string,data:unknown)=>unknown) {}
  private records(sid:string) { return this.store.list<RegionReviewRecord>('region-review',sid); }
  source(sid:string,reviewId:string,key:string) {
    const review=this.store.get<RegionReviewRecord>('region-review',reviewId);
    const region=review?.sessionId===sid && review.regions.find(r=>r.key===key);
    if (!review || !region) return;
    return {review,region};
  }
  available(sid:string,reviewId:string,key:string,seen=new Set<string>()):boolean {
    const ref=canonical([reviewId,key]); if(seen.size>=64 || seen.has(ref)) return false; seen.add(ref);
    const source=this.source(sid,reviewId,key); if(!source || source.region.reuseRevocation) return false;
    const {region}=source;
    if(region.reviewId && region.reviewId!==reviewId) return this.available(sid,region.reviewId,key,seen);
    if(!region.reuse || !region.reuseConditions) return false;
    return !region.reusedFrom || this.available(sid,region.reusedFrom.reviewId,region.reusedFrom.regionKey,seen);
  }
  conditions(o:Observation,anchors:string[],controlIds:string[],pageTraversal:boolean):RegionReuseConditions|undefined {
    if(o.gaps.some(g=>g.critical) || o.boundaries?.length || Object.values(o.context).some(c=>c.status!=='known')) return;
    const candidates=anchors.map(id=>o.regionCandidates?.find(c=>c.id===id));
    if(!candidates.length || candidates.some(c=>!c?.reuseBinding)) return;
    return {version:'region-review-reuse/v1',url:o.url,context:o.context,pageTraversal,
      anchors:candidates.map(c=>({binding:c!.reuseBinding!,selectedIndices:c!.controlIds.flatMap((id,i)=>controlIds.includes(id)?[i]:[])}))};
  }
  matches(review:RegionReviewRecord,r:Region,o:Observation) {
    return !r.reuse || this.available(review.sessionId,r.reviewId || review.id,r.key)
      && canonical(r.reuseConditions)===canonical(this.conditions(o,r.anchors.map(a=>a.id),r.controlIds,r.pageTraversal));
  }
  candidates(o:Observation,controllable:Set<string>,current?:RegionReviewRecord):RegionReuseCandidate[] {
    if(o.gaps.some(g=>g.critical) || o.boundaries?.length || Object.values(o.context).some(c=>c.status!=='known')) return [];
    const byBinding=new Map<string,NonNullable<Observation['regionCandidates']>>();
    for(const c of o.regionCandidates || []) if(c.reuseBinding) {const key=hash(c.reuseBinding);byBinding.set(key,[...byBinding.get(key)||[],c]);}
    const active=current?.status==='active' && current.instanceScope===o.instanceScope ? current.regions.filter(r=>r.status==='active') : [];
    const assigned=new Set(active.flatMap(r=>r.controlIds));
    const result:RegionReuseCandidate[]=[];
    for(const review of this.records(o.sessionId)) for(const region of review.regions) {
      const conditions=region.reuseConditions;
      if(region.reviewId && region.reviewId!==review.id || !region.reuse || !conditions || conditions.url!==o.url || contextKey(conditions.context)!==contextKey(o.context)
        || !this.available(o.sessionId,review.id,region.key) || active.some(r=>r.key===region.key || r.pageTraversal && region.pageTraversal)) continue;
      const matches=conditions.anchors.map(a=>byBinding.get(hash(a.binding)) || []);
      if(matches.some(m=>m.length!==1)) continue;
      const anchors=matches.map(m=>m[0]);
      if(new Set(anchors.map(c=>c.id)).size!==anchors.length || anchors.some(c=>current?.rejectedCandidateIds.includes(c.id))) continue;
      const controlIds=[...new Set(anchors.flatMap((c,i)=>conditions.anchors[i].selectedIndices.map(index=>c.controlIds[index])))];
      if(controlIds.some(id=>!id || !controllable.has(id) || assigned.has(id))) continue;
      if(review.instanceScope===o.instanceScope && canonical(region.anchors.map(a=>a.id))===canonical(anchors.map(c=>c.id)) && canonical(region.controlIds)===canonical(controlIds)) continue;
      if(canonical(conditions)!==canonical(this.conditions(o,anchors.map(c=>c.id),controlIds,region.pageTraversal))) continue;
      const candidate={reviewId:review.id,regionKey:region.key,label:region.label,businessScope:region.reuse.businessScope,conditions,candidateIds:anchors.map(c=>c.id),controlIds,pageTraversal:region.pageTraversal};
      result.push({...candidate,conditionKey:hash(candidate)});
    }
    return result;
  }
  withdraw(sid:string,input:RevokeRegionReuseInput) {
    let found=this.source(sid,input.reviewId,input.regionKey);
    if(!found) throw new EngineError('NOT_FOUND','Region reuse source not found');
    if(found.region.reviewId && found.region.reviewId!==found.review.id) found=this.source(sid,found.region.reviewId,input.regionKey);
    if(!found?.region.reuse) throw new EngineError('INVALID_REGION_REUSE','This region has no reusable boundary judgment');
    if(!found.region.reuseRevocation) {
      found.region.reuseRevocation={source:input.source,reason:input.reason,at:now()};
      this.store.put('region-review',found.review);
      this.emit(sid,'region.reuse_revoked',{reviewId:found.review.id,regionKey:input.regionKey,...found.region.reuseRevocation});
    }
    return found.review;
  }
}
