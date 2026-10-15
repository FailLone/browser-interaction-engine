import { reviewCollection } from './review-collection.js';
import { canonical, contextKey, type ExplorationGroup, type ExplorationGroupProposal } from '@interaction/core';
import type { ActionCandidate, Observation, Session } from './types.js';

export function listGroups(actions: ActionCandidate[], o: Observation, session: Session, known: ExplorationGroup[]): ExplorationGroupProposal[] {
  if (session.options.listExploration !== 'review') return [];
  const controls = new Map(o.controls.map(c => [c.localId, c]));
  const groups = new Map<string, ExplorationGroupProposal>();
  for (const action of actions) {
    const c = controls.get(action.localId || '');
    if (!c?.visible || !c.list || action.boundary?.intent === 'exit') continue;
    const selection = c.list.role === 'select' && action.kind === 'select';
    const option = c.list.role === 'listbox' && action.kind === 'click' && ['button', 'option'].includes(c.role);
    if (!selection && !option) continue;
    const basis = c.actionBasis?.[action.kind];
    const key = canonical({ owner: c.list, operation: action.kind, role: c.role, tag: c.tag, type: c.constraints.type,
      basis: basis?.status, submitsForm: basis?.evidence.some(e => e.facts.submitsForm === true), rules: basis?.evidence.map(e => [e.source, e.rule]) });
    let group = groups.get(key);
    if (!group) {
      group = { key, kind: 'similar-list', collection: reviewCollection(o, o.regions.find(r => c.regionInstanceId ? r.instanceId === c.regionInstanceId : r.key === (c.region || 'document')), o.regions.find(r => r.key === action.boundary?.key)), label: c.list.label || 'Similar list choices', actionIds: [],
        traversalActionIds: actions.filter(a => a.kind === 'scroll' && controls.get(a.localId || '')?.list?.instanceId === c.list!.instanceId).map(a => a.id),
        evidence: [{ source: 'adapter-playwright', rule: 'semantic-list-similarity/v1', facts: { observationId: o.id, ownerInstanceId: c.list.instanceId,
          ownerSelector: c.list.selector, ownerRole: c.list.role, operation: action.kind, memberRole: c.role, memberTag: c.tag,
          meaning: 'Same observed list owner and operation structure; business equivalence and total list size remain unverified' } }] };
      groups.set(key, group);
    }
    group.actionIds.push(action.id);
  }
  // A temporarily empty virtual window is not permission to enumerate the list.
  // Reuse only this document/context and the exact still-observed list owner.
  for (const previous of known) {
    if (previous.instanceScope !== o.instanceScope || previous.contextKey !== contextKey(o.context) || groups.has(previous.proposalKey)) continue;
    const owner = previous.evidence.find(e => e.rule === 'semantic-list-similarity/v1')?.facts.ownerInstanceId;
    const traversalActionIds = actions.filter(a => a.kind === 'scroll' && controls.get(a.localId || '')?.list?.instanceId === owner).map(a => a.id);
    if (typeof owner === 'string' && traversalActionIds.length) groups.set(previous.proposalKey, { key: previous.proposalKey, kind: previous.kind,
      label: previous.label, collection: previous.collection, actionIds: [], traversalActionIds, evidence: previous.evidence });
  }
  return [...groups.values()];
}

/** Structural collections share traversal decisions, never purpose or identity. */
export function structuralListGroups(actions: ActionCandidate[], o: Observation, session: Session, known: ExplorationGroup[]): ExplorationGroupProposal[] {
  if(session.options.listExploration!=='review')return [];
  const controls=new Map(o.controls.map(c=>[c.localId,c]));
  const proposals=new Map<string,ExplorationGroupProposal>();
  const shape=(localId:string,kind:string)=>{
    const c=controls.get(localId)!;const basis=c.actionBasis?.[kind];
    return {kind,role:c.role,tag:c.tag,type:c.constraints.type,basis:basis?.status||'unconfirmed',rules:basis?.evidence.map(e=>[e.source,e.rule])||[],submitsForm:!!basis?.evidence.some(e=>e.facts.submitsForm===true)};
  };
  const candidates=o.structuralLists||[];
  for(const candidate of candidates){
    const members=new Map(candidate.members.map(m=>[m.localId,m]));
    const traversalActionIds=actions.filter(a=>a.kind==='scroll'&&candidate.traversalLocalIds.includes(a.localId||'')).map(a=>a.id);
    for(const action of actions){
      const member=members.get(action.localId||'');
      if(!member||action.kind==='scroll'||action.boundary?.intent==='exit')continue;
      const operation=shape(member.localId,action.kind);
      const key=canonical({structuralList:candidate.ownerInstanceId,template:candidate.template,slot:member.slot,operation});
      let proposal=proposals.get(key);
      if(!proposal){
        const control=controls.get(member.localId)!;
        proposal={key,kind:'similar-list',minimumMembers:1,label:candidate.label,conditions:{url:o.url,owner:candidate.binding},actionIds:[],traversalActionIds,
          collection:reviewCollection(o,o.regions.find(r=>r.instanceId===control.regionInstanceId),o.regions.find(r=>r.key===action.boundary?.key)),
          evidence:[...candidate.evidence,{source:'adapter-playwright',rule:'structural-list-operation/v1',facts:{ownerInstanceId:candidate.ownerInstanceId,template:candidate.template,slot:member.slot,operation,
            meaning:'Same repeated record slot and operation structure; no shared purpose or dispatch grant'}}]};
        proposals.set(key,proposal);
      }
      proposal.actionIds.push(action.id);
    }
  }
  for(const previous of known){
    const facts=previous.evidence.find(e=>e.rule==='structural-list-operation/v1')?.facts;
    if(!facts||previous.status==='invalidated'||previous.instanceScope!==o.instanceScope||previous.contextKey!==contextKey(o.context)||proposals.has(previous.proposalKey))continue;
    const candidate=candidates.find(c=>c.ownerInstanceId===facts.ownerInstanceId&&c.template===facts.template);
    const currentSlots=candidate?.members.filter(m=>m.slot===facts.slot)||[];
    const changedOperation=currentSlots.some(m=>canonical(shape(m.localId,String((facts.operation as {kind:string}).kind)))!==canonical(facts.operation));
    const available=candidate&&!changedOperation&&(candidate.binding as {templatePresent?:boolean}).templatePresent!==false;
    const conditions:ExplorationGroupProposal['conditions']=available?{url:o.url,owner:candidate.binding}:{url:o.url,unavailable:true,owner:candidate?.binding||null,operationChanged:changedOperation};
    proposals.set(previous.proposalKey,{key:previous.proposalKey,kind:'similar-list',minimumMembers:1,label:previous.label,conditions,actionIds:[],
      traversalActionIds:available?actions.filter(a=>a.kind==='scroll'&&candidate.traversalLocalIds.includes(a.localId||'')).map(a=>a.id):[],collection:previous.collection,evidence:previous.evidence});
  }
  return [...proposals.values()];
}
