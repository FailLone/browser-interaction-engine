import { expect, it, vi } from 'vitest';
import { InteractionEngine, type ActionAttempt, type ActionCandidate, type ExplorationCase, type IdentityHypothesis,
  type InteractionAdapter, type ReceiptCoverageReader, type Session } from '@interaction/core';
import { PlaywrightAdapter } from '@interaction/adapter-playwright';
import { MemoryStore } from '@interaction/storage-memory';
import { CounterAdapter, type CounterObservation } from '../examples/counter-adapter.js';

const policy = 'captured-operation-controls-v1' as const;
const at = '2026-10-17T00:00:00.000Z';
type Scope = NonNullable<ExplorationCase['identityConflictScope']>;
type Records = { before: CounterObservation; after: CounterObservation; action: ActionCandidate;
  attempt: ActionAttempt; session: Session; hypotheses: IdentityHypothesis[] };
const pending = (overrides: Partial<IdentityHypothesis> = {}): IdentityHypothesis => ({
  id: 'pending-unrelated', sessionId: 'session', observationId: 'other-observation', localId: 'other-control',
  provisionalIdentityId: 'unrelated-provisional', candidateIds: ['unrelated-candidate'], evidence: [], conflicts: [],
  status: 'pending', revisions: [], ...overrides,
});
const alias = (from: string, to: string): IdentityHypothesis => pending({ id: `alias-${from}`, status: 'resolved',
  provisionalIdentityId: from, candidateIds: [to], revisions: [{ identityId: to, source: 'fixture', evidence: [], at }] });

function fixture(options: { scoped?: boolean; scope?: Scope | null; portable?: boolean; instanceRetained?: boolean;
  customBrowser?: boolean; operationReference?:{key:string;policy:string;requiresUniqueTarget?:boolean}; configure?: (records: Records) => void } = {}) {
  const store = new MemoryStore();
  const observation = (id: string): CounterObservation => ({
    id, sessionId: 'session', capturedAt: at, instanceScope: 'fixture-lifetime', count: 0,
    controls: ['target', 'mode'].map(localId => ({ localId, instanceId: `${localId}-instance`, identityId: `${localId}-identity`,
      role: localId === 'target' ? 'accumulator' : 'button', name: localId, label: localId, region: 'machine', visible: true, enabled: true })),
    regions: [], context: {}, stable: true, gaps: [], stateId: `state-${id}`, visitId: `visit-${id}`,
    fingerprint: id, canonical: id, ruleVersion: 'counter-v1', cause: 'inspection',
  });
  const before = observation('before'), after = observation('after');
  const action: ActionCandidate = { id: 'source-action', sessionId: 'session', observationId: before.id, stateId: before.stateId,
    localId: 'target', controlId: 'target-identity', kind: 'increment', label: 'Increment', value: { by: 1 },
    preconditions: { context: {}, visible: true, enabled: true, identityResolved: true },
    basis: { status: 'supported', evidence: [] }, risk: 'interface', replayable: false,
    source: 'fixture', excluded: false, sampleValidity: 'known' };
  const attempt: ActionAttempt = { id: 'receipt', sessionId: 'session', requestId: 'request', action,
    beforeId: before.id, afterId: after.id, status: 'succeeded', purpose: 'exploration', startedAt: at, finishedAt: at };
  const session: Session = { id: 'session', options: { maxActions: 10, maxDepth: 10, maxDurationMs: 1000, context: {}, exploration: 'controls' },
    createdAt: at, status: 'paused', currentObservationId: after.id, actionCount: 1, elapsedMs: 0, mode: 'manual', dirty: false };
  // Exercise the new narrowing path: samples without an existing identity
  // obstacle retain their adapter's pre-existing policy unchanged.
  const records: Records = { before, after, action, attempt, session,
    hypotheses: [pending({ id: 'scope-activation', provisionalIdentityId: 'scope-unrelated', candidateIds: ['scope-other'] })] };
  options.configure?.(records);
  const scope = options.scope === null ? undefined : options.scope ?? { policy, localIds: ['target', 'mode'] };
  const sample = vi.fn(() => options.portable === false ? undefined : ({ key: 'complete-branch', policy: 'fixture-portable',
    evidence: ['complete-condition-proof'], ...scope ? { identityConflictScope: scope } : {} }));
  class Adapter extends CounterAdapter {
    get receiptIdentityScope() { return options.scoped === false ? undefined : policy; }
    correspondenceCase = sample;
    operationCorrespondenceHint = (control:CounterObservation['controls'][number]) => control.localId==='target'&&options.operationReference?{...options.operationReference,evidence:[],invalidatedBy:['changed-operation']}:undefined;
    override createDriver(): never { throw Error('Receipt queries must not create a driver'); }
  }
  const adapter: InteractionAdapter<CounterObservation> = options.customBrowser
    ? Object.assign(new PlaywrightAdapter(), { correspondenceCase: sample,
      createDriver: () => { throw Error('Receipt queries must not create a driver'); } }) as unknown as InteractionAdapter<CounterObservation>
    : new Adapter();
  const retained = vi.fn<ReceiptCoverageReader<CounterObservation>>(() => ({ key: 'document-proof', policy: 'fixture-document', evidence: [] }));
  const reader = options.instanceRetained ? Object.assign(retained, { identityBasis: 'same-document-instance-v1' as const }) : retained;
  class Host extends InteractionEngine<CounterObservation> { protected override retainedReceiptCoverageReader() { return reader; } }
  const host = new Host({ adapter, persistence: store });
  store.put('session', session); store.put('observation', before); store.put('observation', after); store.put('attempt', attempt);
  for (const hypothesis of records.hypotheses) store.put('hypothesis', hypothesis);
  const put = vi.spyOn(store, 'put'), event = vi.spyOn(store, 'event');
  return { ...records, store, adapter, sample, retained, put, event,
    query: () => host.operationReceiptCondition(session.id, { attemptId: attempt.id }) };
}

function rejected(f: ReturnType<typeof fixture>, reason: string) {
  try {
    expect(f.query()).toMatchObject({ actualSuccess: true, conditionVerified: false, status: 'unavailable', reason,
      identityAuthorized: false, replayAuthorized: false, currentExecution: false, arrivalVerified: false });
    expect(f.retained).not.toHaveBeenCalled(); expect(f.put).not.toHaveBeenCalled(); expect(f.event).not.toHaveBeenCalled();
  } finally { f.store.close(); }
}

it('permits a complete operation scope despite unrelated pending identities, without granting any execution authority', () => {
  const f = fixture({ configure: r => { r.hypotheses.push(pending()); } });
  try {
    expect(f.query()).toMatchObject({ actualSuccess: true, conditionVerified: true, status: 'portable', policy: 'fixture-portable',
      identityAuthorized: false, replayAuthorized: false, currentExecution: false, arrivalVerified: false });
    expect(f.sample).toHaveBeenCalledOnce(); expect(f.retained).not.toHaveBeenCalled();
    expect(f.put).not.toHaveBeenCalled(); expect(f.event).not.toHaveBeenCalled();
  } finally { f.store.close(); }
});

it.each(['target', 'mode'])('blocks pending candidate or provisional references to %s', localId => {
  for (const reference of ['candidate', 'provisional']) {
    const f = fixture({ configure: r => { r.hypotheses.push(pending(reference === 'candidate'
      ? { candidateIds: [`${localId}-identity`] } : { provisionalIdentityId: `${localId}-identity` })); } });
    rejected(f, 'identity_pending');
  }
});

it.each(['target', 'mode'])('blocks a pending or missing hypothesis owned by %s', localId => {
  for (const present of [false, true]) {
    const f = fixture({ configure: r => {
      r.before.controls.find(c => c.localId === localId)!.hypothesisId = 'attached-hypothesis';
      if (present) r.hypotheses.push(pending({ id: 'attached-hypothesis' }));
    } });
    rejected(f, present ? 'identity_pending' : 'source_identity_unverified');
  }
});

it.each(['target', 'mode'])('resolves multihop aliases before checking pending intersections with %s', localId => {
  rejected(fixture({ configure: r => { r.hypotheses.push(alias('old', 'middle'), alias('middle', `${localId}-identity`),
    pending({ candidateIds: ['old'] })); } }), 'identity_pending');
});

it('blocks a same-occurrence pending record even when its identity fields do not intersect', () => {
  rejected(fixture({ configure: r => { r.hypotheses.push(pending({ observationId: 'before', localId: 'mode' })); } }), 'identity_pending');
});

it.each([
  ['missing target', ['mode']], ['duplicate local', ['target', 'mode', 'mode']], ['missing control', ['target', 'absent']],
] as const)('rejects an incomplete scope: %s', (_name, localIds) => {
  rejected(fixture({ scope: { policy, localIds: [...localIds] } }), 'source_identity_scope_unverified');
});

it.each(['duplicate local', 'duplicate instance'])('rejects %s occurrences of a mode dependency', duplicate => {
  rejected(fixture({ configure: r => {
    const mode = r.before.controls[1];
    r.before.controls.push({ ...mode, localId: duplicate === 'duplicate local' ? mode.localId : 'other-mode',
      instanceId: duplicate === 'duplicate instance' ? mode.instanceId : 'other-instance' });
  } }), 'source_identity_scope_unverified');
});

it.each(['target', 'mode'])('rejects a competing logical %s identity, including resolved aliases', localId => {
  for (const throughAlias of [false, true]) {
    rejected(fixture({ configure: r => {
      const c = r.before.controls.find(c => c.localId === localId)!;
      r.before.controls.push({ ...c, localId: 'rival', instanceId: 'rival-instance', identityId: throughAlias ? 'rival-alias' : c.identityId });
      if (throughAlias) r.hypotheses.push(alias('rival-alias', c.identityId!));
    } }), 'source_identity_unverified');
  }
});

it.each(['target', 'mode'])('rejects an alias cycle for the %s dependency', localId => {
  rejected(fixture({ configure: r => { r.hypotheses.push(alias(`${localId}-identity`, 'cycle'), alias('cycle', `${localId}-identity`)); } }),
    'source_identity_unverified');
});

it('accepts a resolved alias chain when every relevant logical identity remains unique', () => {
  const f = fixture({ configure: r => { r.hypotheses.push(alias('mode-identity', 'mode-middle'), alias('mode-middle', 'mode-final'), pending()); } });
  try { expect(f.query()).toMatchObject({ conditionVerified: true, status: 'portable' }); }
  finally { f.store.close(); }
});

it('retains structurally proved instance-mode dependencies without promoting them into logical targets', () => {
  const f = fixture({ configure: r => {
    r.before.controls[1].identityScope = 'instance';
    r.before.controls.push({ ...r.before.controls[1], localId: 'other-instance-mode', instanceId: 'other-instance' });
    r.hypotheses.push(pending());
  } });
  try { expect(f.query()).toMatchObject({ conditionVerified: true, status: 'portable', identityAuthorized: false, replayAuthorized: false }); }
  finally { f.store.close(); }
  rejected(fixture({ configure: r => { r.before.controls[0].identityScope = 'instance'; } }), 'source_identity_unverified');
});

it.each(['legacy adapter', 'custom browser callback'])('retains early global rejection for a %s', kind => {
  const f = fixture({ scoped: false, customBrowser: kind === 'custom browser callback', configure: r => { r.hypotheses.push(pending()); } });
  expect(f.adapter.receiptIdentityScope).toBeUndefined();
  rejected(f, 'identity_pending'); expect(f.sample).not.toHaveBeenCalled();
});

it('opts the default browser correspondence implementation into the complete scope contract only', () => {
  const adapter = new PlaywrightAdapter();
  expect(adapter.receiptIdentityScope).toBe(policy);
  adapter.correspondenceCase = () => undefined;
  expect(adapter.receiptIdentityScope).toBeUndefined();
});

it('keeps the global gate when an opted-in sample omits the scope', () => {
  rejected(fixture({ scope: null, configure: r => { r.hypotheses.push(pending()); } }), 'identity_pending');
});

it('does not launder a rejected portable identity proof through an instance-bound document reader', () => {
  const f = fixture({ instanceRetained: true, configure: r => { r.hypotheses.push(pending({ candidateIds: ['mode-identity'] })); } });
  rejected(f, 'identity_pending'); expect(f.sample).toHaveBeenCalledOnce();
});

it.each(['dirty', 'unknown'])('preserves the %s gate before scoped sampling', gate => {
  const f = fixture({ configure: r => { if (gate === 'dirty') r.session.dirty = true; } });
  if (gate === 'unknown') f.store.put('attempt', { ...f.attempt, id: 'unsettled', status: 'unknown', afterId: undefined });
  f.put.mockClear();
  rejected(f, gate === 'dirty' ? 'dirty_session' : 'unknown_execution_outcome'); expect(f.sample).not.toHaveBeenCalled();
});

it('requires a separately revalidated unique operation reference before an instance target can use the receipt scope',()=>{
 const reference={key:'native-operation',policy:'captured-native-operation',requiresUniqueTarget:true};
 const setup=(fault?:string)=>fixture({operationReference:fault==='missing'?undefined:fault==='changed'?{...reference,key:'different'}:fault==='nonunique'?{...reference,requiresUniqueTarget:false}:reference,
  scope:{policy,localIds:['target','mode'],operationTarget:{referenceKey:reference.key,referencePolicy:reference.policy}},
  configure:r=>{r.before.controls[0].identityScope='instance';r.action.target={kind:'instance',instanceScope:r.before.instanceScope!,instanceId:'target-instance',evidence:['captured current instance']};
   if(fault==='wrong-instance')r.action.target.instanceId='other';
   if(fault==='same-target-pending')r.hypotheses.push(pending({candidateIds:['target-identity']}));}});
 const f=setup();try{expect(f.query()).toMatchObject({conditionVerified:true,status:'portable',identityAuthorized:false,replayAuthorized:false,currentExecution:false});expect(f.put).not.toHaveBeenCalled();}finally{f.store.close();}
 for(const fault of ['missing','changed','nonunique'])rejected(setup(fault),'source_operation_reference_unverified');
 rejected(setup('wrong-instance'),'source_target_not_unique');rejected(setup('same-target-pending'),'identity_pending');
});
