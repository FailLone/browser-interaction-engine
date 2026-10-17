import {finiteInstanceBinding} from './finite-coverage.js';
import { canonical, hash, id, type CorrespondenceHint, type ExplorationCase, type RestorationStep } from '@interaction/core';
import type { ActionCandidate, Control, Observation, Session } from './types.js';
import { readonlyReadout, observableCanonical } from './model.js';
import { constrain } from './policy.js';
import { ruleMatches, signature, formBinding } from './util.js';
import { browserBranchConditions, browserPortableBranchConditions } from './branch-conditions.js';
import { nativeNavigationOperationReader, nativeNavigationOperationReference } from './native-navigation.js';

/** Opaque compatibility keys remain readable by existing consumers. They are hints, not identities. */
export function browserControlCorrespondence(c: Control): CorrespondenceHint | undefined {
  const item=c.structuralItem, context=c.identityContext;
  const key=item?.recordKey ? `explorer:record:v1:${hash({record:item.recordKey,template:item.template,slot:item.slot,tag:c.tag,role:c.role,name:c.name||c.label,type:c.constraints.type})}`
    : c.stableKey || (!c.list&&!item&&context?.evidence.length&&(context.scope||context.binding)
      ? `explorer:context:v1:${hash({tag:c.tag,role:c.role,name:c.name||c.label,type:c.constraints.type,scope:context.scope,binding:context.binding})}` : undefined);
  return key ? {key,policy:'browser-correspondence-v1',evidence:[item?.recordKey?'captured-record-and-slot':c.stableKey?'captured-stable-key':'captured-semantic-context',...(item?.recordEvidence?.map(e=>e.rule)||[]),...(context?.evidence||[])],
    invalidatedBy:['nonunique-correspondence','changed-owner-or-binding','changed-operation-conditions','changed-declared-context']} : undefined;
}

function controlTargetBinding(c:Control) {
  const context=c.identityContext,item=c.structuralItem;
  return context?.evidence.length&&(context.scope||context.binding)||c.formOwner||item?.recordKey
    ?{context:{scope:context?.scope,binding:context?.binding},form:formBinding(c),record:item?.recordKey?{key:item.recordKey,template:item.template,slot:item.slot}:undefined}:undefined;
}

/** Captured semantic scope refinement for task selection, not a control identity
 * or operation-equivalence proof. It stays independent of sibling count, DOM
 * order, instance IDs and current field values. Equal bindings may remain
 * ambiguous; execution and historical coverage still require SDK validation. */
export function browserControlBindingKey(c:Control,o?:Observation):string|undefined {
  const instance=o&&finiteInstanceBinding(c,o);if(instance)return instance;
  const binding=controlTargetBinding(c);
  return binding?`browser-target-binding:v1:${hash(binding)}`:undefined;
}

/** A native record link has a captured destination independent of its displayed
 * quote/count. This is an operation reference, never a control identity. Explicit
 * labels, record structure, ownership and navigation attributes remain semantic.
 * Old observations/keys stay unchanged; no text is classified by a site pattern.
 */
export function browserOperationCorrespondenceHint(c:Control,kind:string,o:Pick<Observation,'url'>):CorrespondenceHint|undefined {
  return nativeRecordLinkReference(c,kind,o)||(kind==='click'?nativeNavigationOperationReference(c,o):undefined);
}
/** One synchronous query owns this reader, just like the mode-structure reader.
 * Never retain it across mutation, await, a later query or a dispatch. The public
 * single-target helper deliberately creates fresh derived facts on every call. */
export function createBrowserOperationCorrespondenceHintReader(o:Observation) {
  let navigation:ReturnType<typeof nativeNavigationOperationReader>|undefined;
  return (c:Control,kind:string):CorrespondenceHint|undefined=>nativeRecordLinkReference(c,kind,o)
    ||(kind==='click'&&c.tag==='a'&&c.role==='link'&&!c.hypothesisId&&!c.readiness&&c.actionBasis?.click?.status==='supported'
      ?(navigation??=nativeNavigationOperationReader(o))(c):undefined);
}
function nativeRecordLinkReference(c:Control,kind:string,o:Pick<Observation,'url'>):CorrespondenceHint|undefined {
  const item=c.structuralItem,context=c.identityContext,attributes=c.reviewBinding?.attributes;
  if(kind!=='click'||c.tag!=='a'||c.role!=='link'||!item?.recordKey||!item.template
    ||!context?.scope||!context.binding||!context.evidence.includes('link-destination/v1'))return;
  const basis=c.actionBasis?.click,href=attributes?.href;
  if(basis?.status!=='supported'||typeof href!=='string'||!basis.evidence.some(e=>e.source==='html'&&e.rule==='hyperlink/v1'&&e.facts.href===href))return;
  try {
    const record:unknown=JSON.parse(item.recordKey),destination=new URL(href,o.url);
    if(!Array.isArray(record)||record.length!==2||record[0]!=='href'||typeof record[1]!=='string'
      ||new URL(record[1],o.url).href!==destination.href||!['http:','https:'].includes(destination.protocol))return;
    return {key:`browser-native-record-link:v1:${hash({destination:destination.href,tag:c.tag,role:c.role,label:c.label,
      target:attributes?.target,download:attributes?.download,template:item.template,slot:item.slot,
      scope:context.scope,binding:context.binding})}`,policy:'browser-native-record-link-v1',requiresUniqueTarget:true,
      evidence:['captured-native-hyperlink-destination','captured-record-template-and-slot','captured-semantic-owner-and-binding','display-name-not-operation-identity'],
      invalidatedBy:['nonunique-operation-reference','changed-destination-or-navigation-attributes','changed-record-template-or-slot','changed-owner-or-binding','changed-operation-conditions','changed-declared-context']};
  }catch{return;}
}

/** Per-round scheduling hint. Unscoped/no-mode legacy encodings remain readable;
 * captured semantic rebinding and source modes produce new operation revisions. */
export function browserOperationKey(a: ActionCandidate,o: Observation) {
  return operationKey(a,o,'v2');
}
/** v3 scheduling hint removes only a generated structural DOM owner. It is
 * neither portable operation evidence nor permission to merge source coverage. */
export function browserOperationSchedulingKey(a:ActionCandidate,o:Observation) {
  return operationKey(a,o,'v3');
}
/** Decode a retained scheduling revision only. Never use this key for current
 * operation equivalence, replay permission, arrival or successful coverage. */
export function legacyBrowserOperationKey(a: ActionCandidate,o: Observation) {
  return operationKey(a,o,'v1');
}
function operationKey(a: ActionCandidate,o: Observation,version:'v1'|'v2'|'v3') {
  const c=o.controls.find(c=>c.localId===a.localId),r=o.regions.find(r=>r.key===c?.region);
  let key=c&&(c.stableKey||(!c.list&&!c.structuralItem?browserControlCorrespondence(c)?.key:undefined));
  if(version==='v3'&&c?.structuralItem?.recordKey&&c.stableKey?.startsWith('structural-item:')){
    const item=c.structuralItem;
    try{const parts:unknown=JSON.parse(c.stableKey.slice('structural-item:'.length));
      if(Array.isArray(parts)&&parts.length===3&&parts[0]===item.ownerInstanceId&&parts[1]===item.recordKey&&typeof parts[2]==='string')
        key=`structural-operation:v3:${hash({record:item.recordKey,template:item.template,slot:item.slot,localKey:parts[2]})}`;
    }catch{/* An unfamiliar or damaged encoding retains its original hint. */}
  }
  const branchVersion=version==='v1'?'v1':'v2';
  const branch=c?browserBranchConditions(a,o,branchVersion):undefined;
  const targetBinding=c&&(o.coveragePolicy==='finite-ui-v1'?browserControlBindingKey(c,o):controlTargetBinding(c));
  // A shared stable key is not the complete target binding. Its changed owner
  // must not inherit a spent retry key; instance/document IDs remain excluded.
  // Controls without source modes or semantic bindings retain their legacy key.
  // Missing dependency evidence is not a fresh attempt whenever unrelated text
  // changes. This retry marker claims no equivalence; controlCase still refuses
  // coverage, while a known projection or semantic rebinding gets a new key.
  const sourceConditions=c&&!branch?{policy:`browser-branch-conditions-${branchVersion}`,status:'unverified'}:branch?.conditions.length?{policy:branch.policy,key:branch.key}:undefined;
  return hash({scope:{url:o.url,...(r?{region:r.label}:{}),label:a.label,...(c?{role:c.role,...(key?{stableKey:key}:{})}:{}),kind:a.kind,...(['string','boolean','number'].includes(typeof a.value)?{value:a.value}:{})},context:o.context,...(targetBinding?{targetBinding}:{}),...(sourceConditions?{sourceConditions}:{}),...(a.kind==='scroll'?{position:a.value}:{})});
}

function shape(c: Control, portable=false) {
  const { valid: _valid, ...constraints } = c.constraints;
  if(portable){const {instanceId:_instance,...form}=c.reviewBinding?.form||{};return {correspondence:browserControlCorrespondence(c)?.key,context:{scope:c.identityContext?.scope,binding:c.identityContext?.binding},tag:c.tag,role:c.role,name:c.name,readOnly:c.readOnly,constraints,options:c.options,attributes:c.reviewBinding?.attributes,form,formOwner:formBinding(c)};}
  const item=c.structuralItem;
  const structuralItem=item?{ownerInstanceId:item.ownerInstanceId,template:item.template,slot:item.slot,recordKey:item.recordKey,...(item.recordKey?{}:{rowInstanceId:item.rowInstanceId})}:undefined;
  return { signature: signature(c), stableKey: c.stableKey, identityScope: c.identityScope, visible: c.visible, enabled: c.enabled, editable: c.editable, constraints, options: c.options, list: c.list, purposeBinding: c.purposeBinding, formOwner: formBinding(c), structuralItem };
}

/** Deliberate representative sampling, not a proof that other values are irrelevant. */
export function explorationCase(action: ActionCandidate, o: Observation, branchVersion: 'v1' | 'v2' = 'v2'): ExplorationCase | undefined {
  const c = o.controls.find(c => c.identityId === action.controlId && c.localId === action.localId);
  if (!c || c.hypothesisId || o.gaps.some(g => g.critical)) return undefined;
  const branch = browserBranchConditions(action, o, branchVersion); if (!branch) return;
  const input = ['fill', 'select', 'check'].includes(action.kind);
  const structuralScope = o.controls.filter(c => c.visible && c.actions.length).map(c => ({ key: c.stableKey || signature(c), role: c.role })).sort((a, b) => canonical(a).localeCompare(canonical(b)));
  const projection = { url: o.url, boundary: o.boundaries?.map(b => b.key) || [], structuralScope, target: shape(c), valid: c.constraints.valid, branch: branch.key,
    ...(input ? {} : { text: c.displayedText, expanded: c.expanded }),
    risk: action.risk, replayable: action.replayable, basis: action.basis,
    excluded: action.excluded, exclusionReason: action.exclusionReason,
    blockers: action.preconditions.blockers?.map(b => b.code) || [] };
  return { key: hash(projection), policy: 'browser-representative-v2', evidence: [
    'Same logical control, operation, input sample and declared business context',
    'Same URL, boundary, visible control structure and target constraints/options',
    'Other field values and input starting values are sampled; combinations are not exhaustive',
    ...branch.evidence,
  ] };
}

/** Control/operation samples include bounded related UI mode conditions; free
 * text combinations are not exhaustive. Neither state nor identity equivalence. */
export function controlCase(action: ActionCandidate, o: Observation, portable=false): ExplorationCase | undefined {
  return controlCaseProjection(action,o,portable,true);
}

/** Legacy controls-mode queue sampling, never proof that source modes are
 * equivalent. The independent exploration plugin owns branch enumeration and
 * budgets. Missing selector evidence must not turn this into whole-state DFS. */
export function controlsTraversalCase(action:ActionCandidate,o:Observation):ExplorationCase|undefined {
  return controlCaseProjection(action,o,false,false);
}

function controlCaseProjection(action:ActionCandidate,o:Observation,portable:boolean,sourceConditions:boolean):ExplorationCase|undefined {
  if(portable&&!action.localId)return;
  if (!action.controlId && ['scroll', 'press'].includes(action.kind)) return {
    key: hash({ url: o.url, boundaries: o.boundaries?.map(b => b.key) || [], kind: action.kind,
      viewport: action.kind === 'scroll' ? (action.source === 'scroll-traversal' ? action.value : o.scroll) : undefined }), policy: 'browser-controls-live-v3',
    evidence: ['Traversal operation grouped by interaction scope and viewport, independent of form values'],
  };
  const c = o.controls.find(c => c.identityId === action.controlId && c.localId === action.localId);
  if (!c || o.gaps.some(g => g.critical)) return;
  if(portable&&o.coveragePolicy==='finite-ui-v1'&&(c.hypothesisId||c.identityScope==='instance'))return;
  const branch = sourceConditions?(portable?browserPortableBranchConditions(action,o):browserBranchConditions(action,o)):undefined;if(sourceConditions&&!branch)return;
  const identityConflictScope=portable&&branch?{policy:'captured-operation-controls-v1' as const,localIds:branch.identityLocalIds}:undefined;
  const native=portable&&browserOperationCorrespondenceHint(c,action.kind,o);
  if(native&&action.basis?.status==='supported'&&action.basis.evidence.some(e=>e.source==='html'&&e.rule==='hyperlink/v1'&&e.facts.href===c.reviewBinding?.attributes.href)) {
    const {valid:_valid,...constraints}=c.constraints,{instanceId:_instance,...form}=c.reviewBinding?.form||{};
    return {key:hash({url:o.url,reference:native.key,branch:branch?.key,boundary:o.regions.filter(r=>r.key===c.region).map(r=>({label:r.label,role:r.role})),
      readOnly:c.readOnly,constraints,options:c.options,attributes:c.reviewBinding?.attributes,form,formOwner:formBinding(c),basis:action.basis,risk:action.risk}),
      policy:native.policy==='browser-native-navigation-v1'?'browser-native-navigation-operation-v1':'browser-native-record-link-operation-v2',identityConflictScope,evidence:[...native.evidence,...branch?.evidence||[],'Same native navigation operation; displayed text remains retained observation evidence']};
  }
  // Review record IDs identify evidence, not a new operation. Preserve the
  // reviewed DOM conditions and risk; dispatch still validates the exact review.
  const reviewed = action.basis?.evidence.some(e => e.rule === 'reviewed-control/v1');
  const basis = reviewed ? { ...action.basis, evidence: action.basis!.evidence.map(e => e.rule === 'reviewed-control/v1'
    ? { source: e.source, rule: e.rule } : e) } : action.basis;
  const { instanceId: _formInstance, ...reviewForm } = c.reviewBinding?.form || {};
  const reviewBinding = reviewed ? { name: c.name, tag: c.tag, readOnly: c.readOnly,
    attributes: c.reviewBinding?.attributes, form: reviewForm } : undefined;
  return { key: hash({ url: o.url, ...(sourceConditions?{branch:branch?.key}:{}), boundary: portable?o.regions.filter(r=>r.key===c.region).map(r=>({label:r.label,role:r.role})):o.boundaries?.map(b => b.key) || [], shape: shape(c,portable), ...(o.coveragePolicy==='finite-ui-v1'?{targetReference:finiteInstanceBinding(c,o)}:{}),
    instance: !portable&&(c.hypothesisId || c.identityScope === 'instance') ? c.instanceId : undefined,
    basis, reviewBinding, risk: action.risk, scroll: action.kind === 'scroll' ? c.scroll : undefined }), policy: portable?'browser-controls-correspondence-v2':sourceConditions?'browser-controls-live-v4':'browser-controls-live-v3',
    identityConflictScope, evidence: ['One operation sample per encountered control, target constraints, option and declared context',
      portable?'Target-region operation reference only; active boundaries and dispatch permission are checked separately':'Current-instance targets do not assert historical identity; all combinations are outside this coverage unit',
      ...branch?.evidence||[],...sourceConditions?[]:['Legacy controls traversal sample only; source modes require independent correspondence evidence']] };
}

/** Compare interaction semantics, retaining editable values and obstruction checks.
 * Geometry is checked for the selected action target at preflight; unrelated
 * movement must not require the entire page to reach visual rest. */
export function interactionProjection(o: Pick<Observation, 'documentId' | 'url' | 'controls' | 'boundaries' | 'scroll'>, targetInstance?: string) {
  return canonical({ document: o.documentId, url: o.url, boundaries: o.boundaries?.map(b => b.key) || [], scroll: o.scroll,
    controls: o.controls.filter(c => c.instanceId === targetInstance || Object.entries(c.actionBasis || {}).some(([kind, b]) => b.status === 'supported' && !(c.readOnly && kind === 'fill'))).map(c => ({
      instance: c.instanceId, formOwner: c.formOwner, shape: shape(c), value: c.value, checked: c.checked, pressed: c.pressed, selected: c.selected, expanded: c.expanded,
      text: c.liveContent?.text ?? c.displayedText, rect: targetInstance === c.instanceId ? c.rect : undefined,
      actionable: { visible: c.actionable.visible, enabled: c.actionable.enabled, editable: c.actionable.editable,
        hitTarget: c.actionable.hitTarget, outsideScrollableArea: c.actionable.outsideScrollableArea, occludedBy: c.actionable.occludedBy },
      basis: c.actionBasis, scroll: c.scroll,
    })) });
}

const localRestorePolicy = 'browser-local-restoration/v1';
/** A single inverse's observable UI effects, never business-state equality.
 * Retain ALL captured controls (including generic review targets), editable
 * values and nonlocal modes. Only native readout values may vary. Do not use
 * graph grouping here: grouping is not restoration evidence. */
function localRestorationKey(o: Observation, action: ActionCandidate): string | undefined {
  if (o.gaps.some(g => g.critical) || Object.values(o.context).some(c => c.status !== 'known')
    || !o.stable && !o.gaps.some(g => ['INTERACTION_STABLE', 'PARTIAL_INTERACTION_READY'].includes(g.code))) return;
  const target = o.controls.find(c => c.localId === action.localId), branch = browserBranchConditions(action, o);
  if (!target || target.readiness || !branch || new Set(o.controls.map(c => c.instanceId)).size !== o.controls.length
    || new Set(o.controls.map(c => c.localId)).size !== o.controls.length) return;
  const controls = o.controls.map(c => c.nativeReadOnly === true && readonlyReadout(c) ? { ...c, value: '' } : c);
  return hash({ policy: localRestorePolicy, document: o.documentId, instanceScope: o.instanceScope, ruleVersion: o.ruleVersion,
    observable: observableCanonical({ ...o, controls }), branch: branch.key, boundaries: o.boundaries,
    regions: o.regions.map(r => ({ key: r.key, role: r.role, label: r.label, parentKey: r.parentKey })),
    bindings: controls.map(c => ({ localId: c.localId, instanceId: c.instanceId, identityId: c.identityId, hypothesisId: c.hypothesisId,
      readOnly: c.readOnly, nativeReadOnly: c.nativeReadOnly, review: c.reviewBinding, ancestry: c.reviewReuseBinding, declared: c.reviewAttributes,
      context: c.identityContext, record: c.structuralItem, hints: c.interactionHints })),
  });
}

export function verifyRestorationStep(step: RestorationStep, before: Observation, after: Observation) {
  const expected = step.targetPostcondition;
  if (!expected || expected.policy !== localRestorePolicy || expected.beforeObservationId !== before.id
    || step.action.observationId !== before.id || before.sessionId !== after.sessionId
    || !localRestorationKey(before, step.action))
    return { result: 'unknown' as const, reason: 'local_restoration_evidence_unavailable', evidence: [] };
  const actual = localRestorationKey(after, step.action);
  return { result: !actual ? 'unknown' as const : actual === expected.expectedKey ? 'pass' as const : 'fail' as const,
    reason: !actual ? 'local_restoration_evidence_unavailable' : actual === expected.expectedKey ? 'local_restoration_postcondition_verified' : 'local_restoration_effects_changed',
    evidence: [localRestorePolicy, 'Full captured control structure, editable values, modes, bindings and boundary preserved except the declared inverse',
      'Only native noninteractive readonly output values may differ; original observations retained'] };
}

/** Only application-declared reversibility permits synthesizing an inverse operation. */
export function restorationStep(target: Observation, current: Observation, session: Session): RestorationStep | undefined {
  if (!session.options.reversible?.length || target.url !== current.url || canonical(target.context) !== canonical(current.context)
    || canonical(target.boundaries) !== canonical(current.boundaries) || target.gaps.some(g => g.critical) || current.gaps.some(g => g.critical)) return;
  for (const c of current.controls) {
    if (!c.identityId || c.hypothesisId || !c.visible || !c.enabled) continue;
    const matches = target.controls.filter(t => t.identityId === c.identityId && !t.hypothesisId);
    if (matches.length !== 1 || current.controls.filter(t => t.identityId === c.identityId).length !== 1) continue;
    const old = matches[0];
    if (canonical(shape(old)) !== canonical(shape(c))) continue;
    const kind = c.actions.includes('fill') && c.value !== old.value ? 'fill'
      : c.actions.includes('select') && c.value !== old.value ? 'select'
      : c.actions.includes('check') && c.checked !== old.checked && old.checked !== null ? 'check' : undefined;
    if (!kind || c.actionBasis?.[kind]?.status !== 'supported') continue;
    const action: ActionCandidate = { id: id(), sessionId: current.sessionId, observationId: current.id, stateId: current.stateId,
      controlId: c.identityId, localId: c.localId, kind, label: c.name, value: kind === 'check' ? old.checked : old.value,
      preconditions: { context: current.context, visible: true, enabled: true, identityResolved: true }, basis: c.actionBasis[kind],
      risk: 'interface', replayable: true, source: 'recovery-local', excluded: false, sampleValidity: 'known' };
    if (!session.options.reversible.some(rule => ruleMatches(rule, action, c, current.url))) continue;
    const constrained = constrain(action, current, session);
    if (constrained.excluded || constrained.preconditions.blockers?.length) continue;
    // Predict exactly this field's inverse. Unexpected effects on other controls
    // invalidate the step even if its target field was successfully restored.
    const restored: Control = { ...c, value: old.value, checked: old.checked, selected: old.selected, constraints: old.constraints };
    const expected = { ...current, controls: current.controls.map(x => x === c ? restored : x) };
    const expectedCanonical = observableCanonical(expected), expectedKey = localRestorationKey(expected, constrained);
    return { action: constrained, expectedCanonical,
      ...(expectedKey ? { targetPostcondition: { policy: localRestorePolicy, beforeObservationId: current.id, expectedKey } } : {}),
      evidence: ['Application-declared reversible operation', `Restore ${c.identityId} from observation ${target.id}`, 'Strict checkpoint uses the complete observable projection; directed recovery verifies each inverse postcondition'] };
  }
}
