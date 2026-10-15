import { ExplorerError, type Decision, type ModelAnswer, type ModelRequest, type Providers } from './types.js';

export const POLICY_VERSION = 'evidence-routing-v2';

/** Confidence never authorizes scope reduction. Each result keeps the raw answer in the ledger. */
export function resolveJudgment(req:ModelRequest, answer:ModelAnswer, providers:Providers):Decision['resolution'] {
  const policy=req.policy;
  if(!policy)return;
  const resolve=(value:unknown,reason:string,threshold?:number):NonNullable<Decision['resolution']>=>({
    source:JSON.stringify(value)===JSON.stringify(answer.value)?'jev':'program',value,reason,threshold,policy,policyVersion:POLICY_VERSION,
  });
  const floor=(kind:'classification'|'identity'|'evidence'|'planning')=>providers.thresholds?.[kind]??providers.choiceThreshold??0.8;
  const confident=(threshold:number)=>typeof answer.confidence==='number'&&answer.confidence>=threshold&&answer.value!=='uncertain';
  if(req.kind==='checklist'||req.kind==='noul') {
    const bounds=providers.operationProbability??{low:providers.noulLow??0.1,high:providers.noulHigh??0.9};
    if(!Number.isFinite(bounds.low)||!Number.isFinite(bounds.high)||bounds.low<0||bounds.low>=0.5||bounds.high<=0.5||bounds.high>1)throw new ExplorerError('INVALID_ROUTING_POLICY');
    if(req.kind==='noul'){
      const p=answer.probability,value=p===undefined?null:p>=bounds.high?true:p<=bounds.low?false:null;
      return {...resolve(value,value===null?'evidence_missing':'atomic_evidence_checked'),bounds};
    }
    const probabilities=answer.value as Record<string,number>;
    const value=Object.fromEntries(Object.entries(probabilities).map(([key,p])=>[key,p>=bounds.high?true:p<=bounds.low?false:null]));
    return {...resolve(value,Object.values(value).includes(null)?'evidence_missing':'atomic_evidence_checked'),bounds};
  }
  if(req.kind!=='choice')return;
  const selected=answer.value as string;
  const uncertain=selected==='uncertain'||selected==='none'||selected.startsWith('none-');
  if(policy==='ranking') {
    const value=uncertain?req.fallbackOption:selected;
    if(!value||!Object.hasOwn(req.options||{},value)||value==='uncertain')throw new ExplorerError('INVALID_ROUTING_POLICY');
    return resolve(value,uncertain?'stable_candidate_order':'jev_ranking_only');
  }
  if(policy==='coverage') {
    if(selected==='sample'&&req.allowedReductions?.includes('sample'))return resolve('sample','user_enabled_sampling');
    // The plan matcher still limits execution; opening a group grants no operation permission.
    return resolve('all',selected==='all'?'retain_observed_members':'scope_reduction_not_authorized');
  }
  if(policy==='discovery'||policy==='grouping')return resolve(selected,uncertain?'evidence_missing':'region_grouping_only');
  if(policy==='classification') {
    if(['interaction','probe_required'].includes(selected))return resolve(selected,'retain_possible_interaction');
    const threshold=floor('classification');
    return confident(threshold)&&!req.blockedOptions?.includes(selected)
      ?resolve(selected,'classification_evidence_gate',threshold)
      :resolve('uncertain',req.blockedOptions?.includes(selected)?'contradictory_interaction_evidence':'evidence_missing',threshold);
  }
  if(policy==='identity') {
    const threshold=floor('identity');
    return selected==='independent'||(confident(threshold)&&!req.blockedOptions?.includes(selected))
      ?resolve(selected,selected==='independent'?'keep_occurrence_independent':'identity_evidence_gate',threshold)
      :resolve('independent','keep_occurrence_independent',threshold);
  }
  if(policy==='evidence-gate'||policy==='recovery') {
    const threshold=floor('evidence');
    return confident(threshold)?resolve(selected,'evidence_gate',threshold):resolve('uncertain','evidence_missing',threshold);
  }
  if(policy==='planning-gate') {
    const threshold=floor('planning');
    return selected==='replan'&&confident(threshold)?resolve('replan','new_plan_needed',threshold):resolve('retain','retain_recorded_gaps',threshold);
  }
}
