import { describe, expect, it, vi } from 'vitest';
import { reconcileCoverage, type ActionAttempt, type ActionCandidate, type FrontierItem, type IdentityHypothesis,
  type Observation, type ReceiptCoverageReader, type Session } from '@interaction/core';

interface SampleObservation extends Observation { mode: string; portable: boolean }
const session = { id: 'session', options: { exploration: 'controls' } } as Session;
function observation(id: string): SampleObservation {
  return { id, sessionId: session.id, capturedAt: '2026-10-17T00:00:00Z', instanceScope: 'document', mode: 'A', portable: true,
    controls: [{ localId: 'target', instanceId: 'node', identityId: 'identity', role: 'control', name: 'Target', label: 'Target', region: 'root', visible: true, enabled: true }],
    regions: [], context: {}, gaps: [], stable: true, stateId: 'state', visitId: id, fingerprint: 'facts', canonical: 'facts', ruleVersion: 'fixture', cause: 'inspection' };
}
function action(o: SampleObservation, overrides: Partial<ActionCandidate> = {}): ActionCandidate {
  return { id: `action:${o.id}`, sessionId: session.id, observationId: o.id, stateId: o.stateId, controlId: o.controls[0].identityId,
    localId: o.controls[0].localId, kind: 'set', value: 'A', label: 'Target', risk: 'interface', replayable: false, excluded: false, source: 'fixture', sampleValidity: 'known',
    preconditions: { context: o.context, visible: true, enabled: true, identityResolved: !o.controls[0].hypothesisId },
    basis: { status: 'supported', evidence: [{ source: 'fixture', rule: 'native/v1', facts: {} }] }, ...overrides };
}
function item(id: string, a: ActionCandidate): FrontierItem {
  return { id, sessionId: session.id, key: id, stateId: a.stateId, contextKey: '{}', action: a, status: 'pending', attempts: [], depth: 0 };
}
describe.each(['array', 'bounded-reader'] as const)('%s coverage facts', mode => {
function fixture() {
  const before = observation('before'), after = observation('after'), current = observation('current');
  const source = action(before), target = action(current);
  const attempt: ActionAttempt = { id: 'success', sessionId: session.id, requestId: 'request', action: source, beforeId: before.id,
    afterId: after.id, startedAt: before.capturedAt, finishedAt: after.capturedAt, status: 'succeeded', purpose: 'exploration' };
  const sample = vi.fn((_a: ActionCandidate, o: SampleObservation) => o.portable
    ? { key: o.mode, policy: 'portable-fixture/v1', evidence: [`mode:${o.mode}`] } : undefined);
  const receipt = vi.fn(() => ({ key: 'receipt', policy: 'retained-fixture/v1', evidence: ['verified-receipt'] }));
  const evaluate = (frontier = [item('pending', target)], observations = [before, after, current], attempts = [attempt], hypotheses: IdentityHypothesis[] = [], retained?: ReceiptCoverageReader<SampleObservation>) => {
    const cache = new Map<string, SampleObservation | undefined>();
    const reader = { get: (id: string) => {
      if(cache.has(id))return cache.get(id);
      const value=structuredClone(observations.findLast(o=>o.id===id&&o.sessionId===session.id));cache.set(id,value);
      if(cache.size>4)cache.delete(cache.keys().next().value!);
      return value;
    } };
    return reconcileCoverage(session, frontier, attempts, mode==='array'?observations:reader, hypotheses, sample, retained);
  };
  return { before, after, current, source, target, attempt, sample, receipt, evaluate };
}

it('samples a valid candidate while excluding unrelated targets before expensive portable derivation', () => {
  const f = fixture(), others = Array.from({ length: 128 }, (_, i) => {
    const o = observation(`unexecuted:${i}`); o.controls[0].identityId = `unexecuted-identity:${i}`; return o;
  });
  const frontier = [...others.map(o => item(o.id, action(o))), item('valid', f.target)];
  const result = f.evaluate(frontier, [f.before, f.after, f.current, ...others]);
  expect([...result.keys()]).toEqual(['valid']);
  expect(result.get('valid')).toMatchObject({ attemptId: 'success', identityId: 'identity', policy: 'portable-fixture/v1' });
  expect(f.sample).toHaveBeenCalledTimes(2);
  expect(f.sample.mock.calls.map(([a]) => a.observationId)).toEqual(['before', 'current']);
  expect(frontier.every(f => !f.attempts.length && f.status === 'pending')).toBe(true);
});

it('indexes the resolved identity across aliases without mutating retained observations or dispatch bindings', () => {
  const f = fixture();
  const hypothesis = (o: SampleObservation, provisionalIdentityId: string, identityId: string): IdentityHypothesis => ({ id: `hypothesis:${o.id}`,
    sessionId: session.id, observationId: o.id, localId: o.controls[0].localId, provisionalIdentityId, candidateIds: [identityId], evidence: [], conflicts: [], status: 'resolved',
    revisions: [{ identityId, source: 'fixture', evidence: ['retained identity'], at: o.capturedAt }] });
  const a = hypothesis(f.before, 'old-alias', 'identity'), b = hypothesis(f.current, 'new-alias', 'old-alias');
  Object.assign(f.before.controls[0], { identityId: a.provisionalIdentityId, hypothesisId: a.id });
  Object.assign(f.current.controls[0], { identityId: b.provisionalIdentityId, hypothesisId: b.id, instanceId: 'rebuilt-node' });
  f.attempt.action = action(f.before); const target = action(f.current), saved = structuredClone([f.before, f.current, f.attempt, target]);
  const result = f.evaluate([item('alias', target)], undefined, undefined, [a, b]);
  expect(result.get('alias')).toMatchObject({ identityId: 'identity', attemptId: 'success' });
  expect(f.sample).toHaveBeenCalledTimes(2);
  expect(f.sample.mock.calls.every(([a, o]) => a.controlId === 'identity' && a.preconditions.identityResolved
    && o.controls[0].identityId === 'identity' && !o.controls[0].hypothesisId)).toBe(true);
  expect([f.before, f.current, f.attempt, target]).toEqual(saved);
});

it('uses the complete instance fallback and never equates another node or document', () => {
  const f = fixture(); f.before.controls[0].identityScope = f.current.controls[0].identityScope = 'instance';
  f.current.controls[0].identityId = 'new-provisional';
  const otherNode = structuredClone(f.current), otherDocument = structuredClone(f.current);
  otherNode.id = 'other-node'; otherNode.controls[0].instanceId = 'other-node';
  otherDocument.id = 'other-document'; otherDocument.instanceScope = 'other-document';
  const result = f.evaluate([item('same-instance', action(f.current)), item('other-node', action(otherNode)), item('other-document', action(otherDocument))],
    [f.before, f.after, f.current, otherNode, otherDocument]);
  expect([...result.keys()]).toEqual(['same-instance']);
  expect(result.get('same-instance')?.identityId).toBeUndefined(); expect(f.sample).toHaveBeenCalledTimes(2);
});

it('keeps exact input, risk, kind and full declared context as necessary conditions', () => {
  const f = fixture();
  f.before.context = { market: { value: 'spot', source: 'fixture', status: 'known' } };
  f.current.context = { market: { status: 'known', source: 'fixture', value: 'spot' } };
  f.attempt.action = action(f.before, { value: { currency: 'USD', values: [1, 2] } });
  const target = action(f.current, { value: { values: [1, 2], currency: 'USD' } });
  const changed = observation('changed-context'); changed.context = { market: { value: 'margin', status: 'known', source: 'fixture' } };
  const result = f.evaluate([item('same', target), item('input', { ...target, value: { values: [2, 1], currency: 'USD' } }),
    item('risk', { ...target, risk: 'submission' }), item('kind', { ...target, kind: 'other' }), item('context', action(changed, { value: target.value }))],
    [f.before, f.after, f.current, changed]);
  expect([...result.keys()]).toEqual(['same']); expect(f.sample).toHaveBeenCalledTimes(2);
});

it('does not reuse a candidate-ID cache between different supplied input values', () => {
  const f = fixture(), a = { ...f.target, id: 'shared-id' }, b = { ...a, value: 'B' };
  const result = f.evaluate([item('B', b), item('A', a)]);
  expect([...result.keys()]).toEqual(['A']); expect(f.sample).toHaveBeenCalledTimes(2);
});

it('still compares complete portable modes after a coarse-index hit and blocks retained washing of two known samples', () => {
  const f = fixture(); f.current.mode = 'B';
  expect(f.evaluate(undefined, undefined, undefined, undefined, f.receipt).size).toBe(0);
  expect(f.sample.mock.calls.some(([a, o]) => a.observationId === 'current' && o.mode === 'B')).toBe(true);
  expect(f.receipt).not.toHaveBeenCalled();
});

it.each(['unknown', 'executing', 'failed', 'blocked', 'missing-after', 'incomplete-before', 'incomplete-after'] as const)(
  'never seeds the index from an unverified receipt: %s', change => {
    const f = fixture();
    if (change === 'missing-after') delete f.attempt.afterId;
    else if (change === 'incomplete-before') f.before.gaps.push({ code: 'missing', message: 'Missing source', critical: true });
    else if (change === 'incomplete-after') f.after.gaps.push({ code: 'missing', message: 'Missing result', critical: true });
    else f.attempt.status = change;
    expect(f.evaluate(undefined, undefined, undefined, undefined, f.receipt).size).toBe(0);
    expect(f.sample).not.toHaveBeenCalled(); expect(f.receipt).not.toHaveBeenCalled();
  });

it('keeps unknown, attempted and migrating frontier debt outside equivalence', () => {
  const f = fixture(), pending = item('pending', f.target);
  expect(f.evaluate([{ ...pending, id: 'unknown', status: 'unknown' }, { ...pending, id: 'executing', status: 'executing' },
    { ...pending, id: 'attempted', attempts: ['failed'] }, { ...pending, id: 'migration', samplingMigration: {
      version: 'retained-sampling-sources/v1', sourceKey: 'legacy', sources: [], children: [] } }], undefined, undefined, undefined, f.receipt).size).toBe(0);
  expect(f.sample).toHaveBeenCalledTimes(1); expect(f.receipt).not.toHaveBeenCalled();
});

it('does not seed an unavailable portable sample and still permits verified retained fallback', () => {
  const f = fixture(); f.before.portable = false;
  const result = f.evaluate(undefined, undefined, undefined, undefined, f.receipt);
  expect(result.get('pending')).toMatchObject({ policy: 'retained-fixture/v1', attemptId: 'success' });
  expect(f.receipt).toHaveBeenCalledTimes(1);
  // The fallback must inspect raw portable evidence even when the success index is empty.
  expect(f.sample.mock.calls.some(([a]) => a === f.target)).toBe(true);
});

it('preserves retained fallback after a coarse mismatch but never washes two available portable samples', () => {
  const f = fixture(); f.current.portable = false; f.target.risk = 'unknown';
  expect(f.evaluate(undefined, undefined, undefined, undefined, f.receipt).get('pending')?.policy).toBe('retained-fixture/v1');
  expect(f.receipt).toHaveBeenCalledTimes(1);
  f.current.portable = true; f.receipt.mockClear(); f.sample.mockClear();
  expect(f.evaluate(undefined, undefined, undefined, undefined, f.receipt).size).toBe(0);
  expect(f.receipt).not.toHaveBeenCalled();
  expect(f.sample.mock.calls.some(([a]) => a === f.target)).toBe(true);
});

it('does not make duplicate resolved identities or changed unknown context eligible through the index', () => {
  const f = fixture(), duplicate = structuredClone(f.current), unknown = observation('unknown-context');
  duplicate.id = 'duplicate'; duplicate.controls.push({ ...duplicate.controls[0], localId: 'rival', instanceId: 'rival' });
  unknown.context = { market: { status: 'unknown', value: null, source: 'fixture' } };
  expect(f.evaluate([item('duplicate', action(duplicate)), item('unknown', action(unknown))], [f.before, f.after, duplicate, unknown]).size).toBe(0);
  expect(f.sample).toHaveBeenCalledTimes(1);
});
});

it('retains the complete proof and ordered retained alternatives across source eviction', () => {
  const source=observation('before'),after=observation('after'),current=observation('current');source.portable=false;current.portable=false;
  const observations=[source,after,current],attempts:ActionAttempt[]=[];
  for(let i=0;i<12;i++){
    const before=observation(`before-${i}`),end=observation(`after-${i}`);before.portable=false;
    observations.push(before,end);
    attempts.push({id:`receipt-${i}`,sessionId:session.id,requestId:`request-${i}`,status:'succeeded',beforeId:before.id,afterId:end.id,
      action:action(before),startedAt:before.capturedAt,finishedAt:end.capturedAt,purpose:'exploration'});
  }
  const frontier=[item('A',action(current)),item('B',action(current,{value:'B'})),{...item('unknown',action(current)),status:'unknown' as const}];
  const sample=()=>undefined,receipt:ReceiptCoverageReader<SampleObservation>=(_a,_o,attempt)=>attempt.id==='receipt-11'
    ?{key:'last-valid',policy:'fixture-retained/v1',evidence:['complete-dependencies','actual-succeeded:receipt-11']}:undefined;
  const expected=reconcileCoverage(session,frontier,attempts,observations,[],sample,receipt),reads:string[]=[],cache=new Map<string,SampleObservation|undefined>();
  const actual=reconcileCoverage(session,frontier,attempts,{get(id){
    if(cache.has(id))return cache.get(id);reads.push(id);
    const value=structuredClone(observations.find(o=>o.id===id));cache.set(id,value);
    if(cache.size>4)cache.delete(cache.keys().next().value!);return value;
  }},[],sample,receipt);
  expect([...actual]).toEqual([...expected]);expect([...actual.keys()]).toEqual(['A']);
  expect(actual.get('A')).toMatchObject({attemptId:'receipt-11',beforeId:'before-11',afterId:'after-11',policy:'fixture-retained/v1'});
  expect(reads.filter(id=>id==='before-0')).toHaveLength(2);
  expect(reads).not.toContain('before');expect(reads).not.toContain('after');
});

it('rejects wrong ID and foreign records, propagates reader errors and never loads unrelated history', () => {
  const before=observation('before'),after=observation('after'),current=observation('current'),a=action(before);
  const attempts:ActionAttempt[]=[{id:'success',sessionId:session.id,requestId:'request',status:'succeeded',beforeId:before.id,afterId:after.id,action:a,startedAt:before.capturedAt,purpose:'exploration'}];
  const frontier=[item('pending',action(current))],sample=()=>({key:'known',policy:'fixture/v1',evidence:[]});
  for(const replacement of [undefined,{...after,id:'wrong'},{...after,sessionId:'foreign'}]){
    const read=vi.fn((id:string)=>id==='before'?before:id==='after'?replacement:current);
    expect(reconcileCoverage(session,frontier,attempts,{get:read},[],sample).size).toBe(0);
    expect(read.mock.calls.map(([id])=>id)).toEqual(['before','after']);
  }
  const failure=new Error('source decode failed');
  expect(()=>reconcileCoverage(session,frontier,attempts,{get(){throw failure;}},[],sample)).toThrow(failure);
});
