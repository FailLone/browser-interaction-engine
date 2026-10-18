import {canonical,hash,type ActionAttempt,type ExplorationCase} from '@interaction/core';
import {navigationScopeFor,navigationScopeMaterial} from './navigation-readiness.js';
import {navigationIntent} from './navigation.js';
import type {ActionCandidate,Observation,Session} from './types.js';

type View=Parameters<typeof navigationScopeMaterial>[0];
/** All collected modes, records, native fields, ancestors and IDREF ownership
 * remain in this material. No volatile-field blacklist or whole-page hash. */
export function localOperationMaterial(o:View,localId:string):{reason:string;rootId?:string;key?:string;material?:ReturnType<typeof navigationScopeMaterial>;diagnostic?:unknown} {
 const target=o.controls.filter(c=>c.localId===localId),scope=navigationScopeFor(o,[localId]);
 const reject=(reason:string,rootId?:string)=>{
  const scopes=(o.navigationScopes||[]).filter(s=>s.controlIds.includes(localId));
  let diagnostic:unknown={documentId:o.documentId,url:o.url,boundaries:o.boundaries,scroll:o.scroll,scopes,
   targets:target.map(c=>({localId:c.localId,instanceId:c.instanceId,actionable:c.actionable,readiness:c.readiness}))};
  if(new TextEncoder().encode(canonical(diagnostic)).byteLength>524288)diagnostic={documentId:o.documentId,url:o.url,reason:'diagnostic_byte_bound',scopes:scopes.map(s=>({rootId:s.rootId,complete:s.complete,reasons:s.reasons}))};
  return {reason,rootId,diagnostic};
 };
 if(target.length!==1||o.controls.filter(c=>c.instanceId===target[0].instanceId).length!==1)return reject('local_target_not_unique');
 if(!scope)return reject('local_scope_incomplete');
 if(scope.blockedControlIds?.includes(localId)||scope.binding!.references.some(r=>r.status!=='unique'))return reject('local_reference_or_content_unresolved',scope.rootId);
 const material=navigationScopeMaterial(o,scope),encoded=canonical(material);
 if(new TextEncoder().encode(encoded).byteLength>524288)return reject('local_material_byte_bound',scope.rootId);
 const key=hash(encoded);
 return {reason:'local_sample_complete',rootId:scope.rootId,material,key};
}

/** Consumes only newly captured, actual native-operation evidence. Legacy
 * observations are never repaired, and this result is never ordinary coverage. */
export function actualLocalReceipt(action:ActionCandidate,before:Observation,after:Observation,attempt:ActionAttempt,session:Session):
 {sample:ExplorationCase;identityBasis:'same-document-instance-v1'}|{unavailable:string}|undefined {
 const audit=after.localDispatchAudit,intent=navigationIntent(action,before);
 if(!audit||before.coveragePolicy!=='finite-ui-v1'||session.options.coveragePolicy!=='finite-ui-v1')return;
 const local=action.localId?localOperationMaterial(before,action.localId):undefined;
 // Non-navigation operations without a collected local scope retain their
 // existing receipt policy. A native link never falls through after rejection.
 if(!intent&&!local?.key&&!before.navigationScopes?.some(s=>s.controlIds.includes(action.localId||'')))return;
 const reject=(unavailable:string)=>({unavailable});
 if(audit.status!=='matched')return reject(audit.reason);
 if(attempt.status!=='succeeded'||!attempt.dispatchWitness||after.gaps.some(g=>g.critical)||before.gaps.some(g=>g.critical))return reject('actual_native_receipt_incomplete');
 const target=before.controls.find(c=>c.localId===action.localId);
 if(audit.version!=='browser-local-dispatch-v1'||audit.sessionId!==before.sessionId||audit.beforeId!==before.id||audit.actionId!==action.id
  ||audit.actionKey!==hash(action)||audit.documentId!==before.documentId||audit.instanceScope!==before.instanceScope
  ||audit.browserSessionId!==before.navigation?.browserSessionId||audit.url!==before.url||audit.contextKey!==hash(before.context)
  ||audit.targetId!==action.localId||audit.targetInstanceId!==target?.instanceId||audit.rootId!==local?.rootId
  ||!local?.key||audit.sourceKey!==local.key||audit.finalKey!==local.key
  ||audit.sourceArtifact!==`dispatch-local-${local.key}.json`||audit.finalArtifact!==audit.sourceArtifact
  ||!Number.isFinite(Date.parse(audit.capturedAt))||Date.parse(audit.capturedAt)<Date.parse(attempt.startedAt)
  ||!Number.isFinite(Date.parse(attempt.dispatchWitness.returnedAt))||Date.parse(audit.capturedAt)>Date.parse(attempt.dispatchWitness.returnedAt))return reject('local_dispatch_binding_mismatch');
 if(canonical(before.context)!==canonical(after.context))return reject('receipt_context_changed');
 let policy='browser-local-operation-receipt-v1';
 if(intent){
  const proof=after.navigationCapture,source=before.navigation,destination=after.navigation,
    original=source?.entries[source.currentIndex],current=destination?.entries[destination.currentIndex];
  // Canonical URL includes search and fragment. Redirects need their own
  // evidence contract; similarity, labels, and a new document are insufficient.
  let expected:string,observed:string;try{expected=new URL(intent.targetUrl).href;observed=new URL(after.url).href;}catch{return reject('navigation_destination_invalid');}
  if(expected!==observed){
   const requested=new URL(expected),arrived=new URL(observed),trace=audit.nativeNavigation;
   arrived.hash='';
   // An unspecified destination fragment is not a mode selection. Accept only
   // a witnessed exact native commit followed by same-document fragment changes
   // on that very loader. Never erase an explicit source fragment or normalize
   // a changed path/query, and never infer redirect equivalence.
   const commit=trace?.events[0],last=trace?.events.at(-1);
   if(requested.hash||arrived.href!==expected||!trace||trace.truncated||!commit||commit.kind!=='commit'
     ||commit.url!==expected||!commit.loaderId||commit.loaderId!==trace.finalLoaderId
     ||trace.finalDocumentId!==after.documentId||trace.finalFrameId!==trace.sourceFrameId
     ||trace.events.length<2||last?.url!==observed||trace.events.some((e,i)=>e.frameId!==trace.sourceFrameId
       ||e.at<Date.parse(audit.capturedAt)||e.at>Date.parse(after.capturedAt)||i>0&&(e.kind!=='same-document'||(()=>{try{const u=new URL(e.url);u.hash='';return u.href!==expected;}catch{return true;}})())))return reject('navigation_destination_mismatch');
  }
  if(!proof||proof.version!==1||proof.beforeId!==before.id||proof.actionId!==action.id||proof.sourceDocumentId!==before.documentId
   ||proof.documentId!==after.documentId||proof.sourceUrl!==before.url||proof.requestedUrl!==intent.targetUrl||proof.observedUrl!==after.url
   ||proof.samples<2||proof.settledMs<0||before.documentId===after.documentId)return reject('navigation_cross_document_arrival_unverified');
  if(!source||!destination||source.browserSessionId!==destination.browserSessionId||original?.method!=='GET'||original.url!==before.url
   ||current?.method!=='GET'||current.url!==after.url||current.id===original.id
   ||destination.entries.filter(e=>e.id===original.id&&e.url===original.url&&e.method==='GET').length!==1
   ||destination.entries.filter(e=>e.id===current.id).length!==1)return reject('navigation_history_unverified');
  policy='browser-native-navigation-receipt-v1';
 }else if(before.documentId!==after.documentId||before.url!==after.url)return reject('local_operation_document_changed');
 return {identityBasis:'same-document-instance-v1',sample:{key:hash({policy,action:hash(action),before:before.id,after:after.id,attempt:attempt.id,local:local.key}),policy,
  evidence:[`native-local-dispatch:${audit.actionId}`,`local-material:${audit.sourceArtifact}`,`actual-receipt:${attempt.id}`,
   ...(intent?[`native-destination:${intent.targetUrl}`,'Path/query and explicit source fragment exact; any later unspecified fragment requires exact native commit and same-loader trace; new view unverified']:[]),
   'Actual operation only; business effects, identity, replay and sampling coverage remain independent']}};
}

/** Fixed bounded comparison categories make a rejection diagnosable without
 * querying or diffing the entire document. Both complete samples are retained. */
export function localMaterialChanges(a:NonNullable<ReturnType<typeof localOperationMaterial>['material']>,b:NonNullable<ReturnType<typeof localOperationMaterial>['material']>) {
 const parts=(m:typeof a)=>({...m,scope:undefined,'scope.binding':undefined,
  ...Object.fromEntries(Object.entries(m.scope).filter(([k])=>k!=='binding').map(([k,v])=>[`scope.${k}`,v])),
  ...Object.fromEntries(Object.entries(m.scope.binding||{}).map(([k,v])=>[`scope.binding.${k}`,v]))});
 const x=parts(a),y=parts(b);return Object.keys(x).filter(k=>canonical(x[k as keyof typeof x])!==canonical(y[k as keyof typeof y]));
}
