import type { Observation } from '@interaction/browser';
import type { EvidenceRef, ExplorerHost, PlanItem, Task } from './types.js';
import { controlScopeMatcher, digest } from './policy.js';

export const controlReviewGapReasons=new Set(['classification_unresolved','operation_basis_unconfirmed','operation_risk_unresolved','probe_unresolved','identity_unresolved']);
type Proof=NonNullable<PlanItem['reviewResolvedBy']>;
type SourceProofs=NonNullable<PlanItem['reviewSourceProofs']>;
type Binding=SourceProofs['bindings'][number];
export type ReviewGapChange={itemId:string;proof?:Proof;sourceProofs?:SourceProofs;complete?:boolean;reason?:string};
type Correspondence=NonNullable<ExplorerHost['controlReviewTargetCorrespondence']>;
type Request=Parameters<Correspondence>[1];
type Work={item:PlanItem;refs:EvidenceRef[];scopeKey:string;accepted:Map<string,Binding>;legacy:boolean};
type Candidate={work:Work;ref:EvidenceRef;proof:Binding['proof'];sourceLocalId?:string};
const policy='review-source-completion-v1' as const;
const observationKey=(ref:EvidenceRef)=>JSON.stringify([ref.sessionId,ref.observationId]);
const capturedKey=(o:Observation)=>JSON.stringify([o.sessionId,o.id]);
const proofKey=(ref:Proof)=>JSON.stringify([ref.sessionId,ref.observationId,ref.classificationId,ref.classification]);
const plainProof=(proof:Binding['proof']):Proof=>({sessionId:proof.sessionId,observationId:proof.observationId,classificationId:proof.classificationId,classification:proof.classification});

/**
 * A/B sources may be interpreted separately. Persist only source/proof refs;
 * scope locates candidates, while SDK correspondence proves each relation.
 * Existing cross-record bindings are rechecked, not treated as durable grants.
 * One target and one source graph are held at a time; batches retain small refs.
 */
function changesFor(task:Task,o:Observation,host:ExplorerHost,retractionsOnly:boolean):ReviewGapChange[] {
  const items=task.plan.filter(i=>i.required&&i.status!=='excluded'&&controlReviewGapReasons.has(i.reason)&&!i.scope.kind&&i.scope.value===undefined
    &&(!retractionsOnly||!!i.reviewResolvedBy||!!i.reviewSourceProofs));
  if(!items.length)return [];
  const works:Work[]=items.filter(i=>!(i.status==='succeeded'&&!i.reviewResolvedBy&&!i.reviewSourceProofs)).map(item=>({
    item,refs:[...new Map((item.evidence||[]).map(ref=>[observationKey(ref),ref])).values()],scopeKey:digest(item.scope),accepted:new Map(),legacy:false,
  }));
  let snapshot:ReturnType<ExplorerHost['controlInterpretationSnapshot']>|undefined;
  try {
    const refs=[...new Map(works.flatMap(({item})=>[...(item.reviewResolvedBy?[item.reviewResolvedBy]:[]),
      ...(item.reviewSourceProofs?.bindings||[]).map(b=>b.proof)]).map(ref=>[proofKey(ref),ref])).values()];
    const value=host.controlInterpretationSnapshot(o.sessionId,o.id,{retainedClassifications:refs});
    if(value.sessionId===o.sessionId&&value.observationId===o.id&&value.executionAuthorized===false)snapshot=value;
  } catch {/* Failure can withdraw completion but cannot invent a proof. */}
  if(snapshot) {
    const retained=new Map(snapshot.retainedClassifications.map(p=>[proofKey(p.source),p]));
    const currentInScope=controlScopeMatcher(o,snapshot.actions);
    const retainedCandidates:Candidate[]=[];
    for(const work of works) {
      const {item}=work,wanted=new Set(work.refs.map(observationKey)),saved=item.reviewSourceProofs;
      if(saved?.policy===policy) {
        const counts=new Map<string,number>();
        for(const b of saved.bindings)counts.set(observationKey(b.source),(counts.get(observationKey(b.source))||0)+1);
        for(const binding of saved.bindings) {
          const key=observationKey(binding.source),proof=retained.get(proofKey(binding.proof));
          if(!wanted.has(key)||counts.get(key)!==1||!proof?.retained||proof.localId!==binding.proof.localId)continue;
          // Only this reflexive case avoids graph correspondence: the SDK just
          // verified the exact retained classification/control record. A later
          // scene invalidation is historical evidence; revoked/missing is not.
          // A changed scope may still describe this source. Recheck both source
          // and proof uniqueness under it instead of forgetting prior progress.
          if(saved.scopeKey===work.scopeKey&&key===observationKey(binding.proof)&&binding.source.localId===binding.proof.localId)work.accepted.set(key,binding);
          else retainedCandidates.push({work,ref:binding.source,proof:binding.proof,sourceLocalId:binding.source.localId});
        }
      }
      const legacy=item.reviewResolvedBy&&retained.get(proofKey(item.reviewResolvedBy));
      if(item.reviewResolvedBy&&legacy?.retained&&legacy.localId) {
        work.legacy=true;
        for(const ref of work.refs)if(!work.accepted.has(observationKey(ref)))retainedCandidates.push({
          work,ref,proof:{...item.reviewResolvedBy,localId:legacy.localId},
        });
      }
    }

    const prove=(candidates:Candidate[])=>{
      const targets=new Map<string,{ref:EvidenceRef;candidates:Candidate[]}>();
      for(const c of candidates) {
        if(c.work.accepted.has(observationKey(c.ref)))continue;
        const key=observationKey(c.proof),group=targets.get(key)||{ref:c.proof,candidates:[]};group.candidates.push(c);targets.set(key,group);
      }
      for(const group of targets.values()) {
        let target:Observation,targetActions:ReturnType<ExplorerHost['actions']>;
        try {
          target=observationKey(group.ref)===capturedKey(o)?o:host.observation(group.ref.sessionId,group.ref.observationId);
          if(target.sessionId!==group.ref.sessionId||target.id!==group.ref.observationId)continue;
          targetActions=target===o?snapshot!.actions:host.actions(target.sessionId,target.id);
        } catch {continue;}
        const targetInScope=target===o?currentInScope:controlScopeMatcher(target,targetActions),targetScopes=new Map<string,string|undefined>();
        const sources=new Map<string,{ref:EvidenceRef;candidates:Candidate[]}>();
        for(const candidate of group.candidates) {
          if(candidate.work.accepted.has(observationKey(candidate.ref)))continue;
          const scopeKey=candidate.work.scopeKey;
          if(!targetScopes.has(scopeKey)) {
            const matches=target.controls.filter(c=>c.visible&&targetInScope(candidate.work.item.scope,c));
            targetScopes.set(scopeKey,matches.length===1?matches[0].localId:undefined);
          }
          if(targetScopes.get(scopeKey)!==candidate.proof.localId)continue;
          const key=observationKey(candidate.ref),entry=sources.get(key)||{ref:candidate.ref,candidates:[]};
          entry.candidates.push(candidate);sources.set(key,entry);
        }
        const requests=new Map<string,{input:Request;candidates:Candidate[]}>();
        for(const {ref,candidates:entries} of sources.values()) {
          let source:Observation,sourceActions:ReturnType<ExplorerHost['actions']>;
          try {
            source=observationKey(ref)===capturedKey(o)?o:observationKey(ref)===capturedKey(target)?target:host.observation(ref.sessionId,ref.observationId);
            if(source.sessionId!==ref.sessionId||source.id!==ref.observationId)continue;
            sourceActions=source===o?snapshot!.actions:source===target?targetActions:host.actions(source.sessionId,source.id);
          } catch {continue;}
          const sourceInScope=source===target?targetInScope:source===o?currentInScope:controlScopeMatcher(source,sourceActions),scopeTargets=new Map<string,string|undefined>();
          for(const candidate of entries) {
            const scopeKey=candidate.work.scopeKey;
            if(!scopeTargets.has(scopeKey)) {
              const matches=source.controls.filter(c=>c.visible&&sourceInScope(candidate.work.item.scope,c));
              scopeTargets.set(scopeKey,matches.length===1?matches[0].localId:undefined);
            }
            const localId=scopeTargets.get(scopeKey);
            if(!localId||candidate.sourceLocalId&&candidate.sourceLocalId!==localId)continue;
            const input:Request={observationId:target.id,localId:candidate.proof.localId,source:{sessionId:source.sessionId,observationId:source.id,localId}};
            const key=JSON.stringify([source.sessionId,source.id,localId,input.localId]),request=requests.get(key)||{input,candidates:[]};
            request.candidates.push(candidate);requests.set(key,request);
          }
        }
        const entries=[...requests.values()];
        let results:(ReturnType<Correspondence>|undefined)[]=[];
        if(entries.length)try {
          if(host.controlReviewTargetCorrespondences) {
            const batch=host.controlReviewTargetCorrespondences(target.sessionId,{observationId:target.id,requests:entries.map(({input})=>({localId:input.localId,source:input.source}))});
            if(batch.sessionId===target.sessionId&&batch.observationId===target.id&&batch.results.length===entries.length)results=batch.results;
          } else results=entries.map(({input})=>{try{return host.controlReviewTargetCorrespondence?.(target.sessionId,input);}catch{return undefined;}});
        } catch {/* Unknown preserves this source's outstanding review. */}
        for(const [index,{input,candidates:related}] of entries.entries()) {
          const result=results[index];
          const equivalent=!!result&&result.targetMatched&&result.reviewable&&result.sourceEquivalent==='equivalent'
            &&result.source?.sessionId===input.source.sessionId&&result.source.observationId===input.source.observationId&&result.source.localId===input.source.localId
            &&result.target?.sessionId===target.sessionId&&result.target.observationId===target.id&&result.target.localId===input.localId
            &&result.preflightRequired===true&&result.identityAuthorized===false&&result.replayAuthorized===false
            &&result.executionAuthorized===false&&result.currentExecution===false&&result.coverageGranted===false&&result.checkpointVerified===false;
          if(equivalent)for(const c of related)if(!c.work.accepted.has(observationKey(c.ref)))c.work.accepted.set(observationKey(c.ref),{
            source:{...input.source},proof:c.proof,
          });
        }
      }
    };
    // Preserve already reviewed sources before considering new current material.
    // Legacy whole-item claims may shrink to their verified subset on stop.
    prove(retainedCandidates);
    if(!retractionsOnly&&!o.gaps.some(g=>g.critical)) {
      const candidates:Candidate[]=[];
      for(const work of works) {
        const matches=o.controls.filter(c=>c.visible&&currentInScope(work.item.scope,c));
        const negative=matches.length===1&&snapshot.nonInteractive.find(c=>c.localId===matches[0].localId);
        if(!negative||negative.sessionId!==o.sessionId||negative.observationId!==o.id||!['display','container'].includes(negative.classification))continue;
        const proof:Binding['proof']={sessionId:o.sessionId,observationId:o.id,localId:negative.localId,classificationId:negative.classificationId,classification:negative.classification as Proof['classification']};
        for(const ref of work.refs)if(!work.accepted.has(observationKey(ref)))candidates.push({work,ref,proof});
      }
      prove(candidates);
    }
  }
  const changes:ReviewGapChange[]=[];
  for(const work of works) {
    const {item}=work,bindings=work.refs.flatMap(ref=>{const b=work.accepted.get(observationKey(ref));return b?[b]:[];});
    const sourceProofs:SourceProofs={policy,scopeKey:work.scopeKey,bindings},complete=!!work.refs.length&&bindings.length===work.refs.length;
    const changed=digest(item.reviewSourceProofs||null)!==digest(sourceProofs);
    const proof=complete&&!retractionsOnly?plainProof(bindings.at(-1)!.proof):undefined;
    const wholeChanged=proof&&(item.status!=='succeeded'||!item.reviewResolvedBy||proofKey(item.reviewResolvedBy)!==proofKey(proof));
    if(!wholeChanged&&!((item.reviewResolvedBy||item.status==='succeeded'&&item.reviewSourceProofs)&&!complete)&&!(changed&&(bindings.length||item.reviewSourceProofs)))continue;
    changes.push({itemId:item.id,sourceProofs,complete,...proof?{proof}:{},
      ...!complete?{reason:work.legacy?'legacy_review_sources_partially_verified':'review_source_conditions_unverified'}:{}});
  }
  return changes;
}

/** Accumulate independently verified sources; whole completion needs them all. */
export function reviewGapChanges(task:Task,o:Observation,host:ExplorerHost):ReviewGapChange[] {return changesFor(task,o,host,false);}

/** Never adds a current interpretation or upgrades an incomplete item to success. */
export function reviewGapRetractions(task:Task,o:Observation,host:ExplorerHost):ReviewGapChange[] {return changesFor(task,o,host,true);}
