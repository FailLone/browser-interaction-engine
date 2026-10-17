import { expect, it } from 'vitest';
import type { ActionAttempt, ActionCandidate, Observation } from '@interaction/browser';
import type { PlanItem } from '@interaction/explorer-plugin';
import { scopeFor } from '../packages/explorer-plugin/src/policy.js';
import { capturedRoute } from '../packages/explorer-plugin/src/reentry-evidence.js';
import { bindGuardedReentryRoute, guardedReentryReceiptChecks } from '../scripts/okx-plugin-loop-acceptance.js';

// Pure recorded facts only: no engine, database, service or browser is created.
function fixture() {
  const control = (id: string, name: string): Observation['controls'][number] => ({
    localId: id, instanceId: id, tag: 'button', role: 'button', name, label: name, stableKey: `id:${id}`,
    region: 'main', form: '', selector: `#${id}`, rect: { x: 0, y: 0, width: 10, height: 10 },
    value: '', displayedText: name, checked: null, selected: [], visible: true, enabled: true, editable: false,
    expanded: null, controls: null, constraints: { type: 'button', required: false, valid: true }, options: [],
    actions: ['click'], discovery: [], actionable: { visible: true, enabled: true, editable: false, hitTarget: true, unknown: [] },
  });
  const observation = (id: string, sid: string, controls: Observation['controls']): Observation => ({
    id, sessionId: sid, capturedAt: '2026-10-18T00:00:00Z', instanceScope: sid, documentId: sid,
    url: 'https://example.test/', title: '', text: '', viewport: { width: 100, height: 100 }, scroll: { x: 0, y: 0, maxY: 0 },
    controls, regions: [{ key: 'main', label: 'Main', role: 'main', selector: 'main', text: '', rect: { x: 0, y: 0, width: 100, height: 100 } }], context: {}, gaps: [], stable: true,
    stateId: id, visitId: id, fingerprint: id, canonical: id, ruleVersion: 'observable-v1', cause: 'inspection',
  });
  const trade = control('trade', 'Trade'), child = control('child', 'Convert');
  const before = observation('historical-before', 'historical-session', [trade]);
  const source = observation('historical-source', 'historical-session', [trade, child]);
  const current = observation('current', 'new-session', [trade]);
  const action = (id: string, o: Observation, c: Observation['controls'][number]): ActionCandidate => ({
    id, sessionId: o.sessionId, observationId: o.id, stateId: o.stateId, localId: c.localId, kind: 'click', label: c.name,
    preconditions: { context: {}, visible: true, enabled: true, identityResolved: true, targetResolved: true },
    replayable: true, risk: 'interface', source: 'native', excluded: false, sampleValidity: 'known',
  });
  const oldEntry = action('old-trade', before, trade), sourceAction = action('old-child', source, child), currentEntry = action('new-trade', current, trade);
  const retained: ActionAttempt = { id: 'historical-entry', sessionId: before.sessionId, requestId: 'old-request', action: oldEntry,
    startedAt: before.capturedAt, beforeId: before.id, afterId: source.id, status: 'succeeded', purpose: 'exploration' };
  const route = capturedRoute(scopeFor(oldEntry, before), before, source, [child.localId], retained)!;
  const baseline: PlanItem = { id: 'original-child', title: 'Convert', scope: scopeFor(sourceAction, source), prerequisites: [route.entry],
    completion: 'Execute', status: 'unresolved', required: true, dispatchScope: false, reason: 'operation_not_executed',
    evidence: [{ sessionId: source.sessionId, observationId: source.id }], attempts: [] };
  const proposal = { sequence: 10, sessionId: current.sessionId, observationId: current.id,
    planned: { itemId: baseline.id, target: baseline.scope, scope: scopeFor(currentEntry, current), route: [route] } };
  const observations = new Map([before, source, current].map(o => [o.id, o]));
  const actions = new Map([[before.id, [oldEntry]], [source.id, [sourceAction]], [current.id, [currentEntry]]]);
  const host = { observation: (_sid: string, id?: string) => observations.get(id!)!, actions: (_sid: string, id?: string) => actions.get(id!)!,
    interactionTransition: () => ({ verified: true, revealedControlIds: [child.localId] }), attempt: () => retained } as unknown as Parameters<typeof bindGuardedReentryRoute>[5];
  const bind = () => bindGuardedReentryRoute(baseline, proposal, current.sessionId, currentEntry.id, current.id, host);
  return { baseline, proposal, current, source, child, retained, actions, currentEntry, bind };
}

it('binds the original child and historical route across sessions, not the selected entry owner', () => {
  const f = fixture(), bound = f.bind(); expect(bound).toMatchObject({ available: true, binding: {
    source: { sessionId: 'historical-session', observationId: 'historical-source', actionId: 'old-child' },
    repetitionSource: { sessionId: 'historical-session', attemptId: 'historical-entry' }, routeAttemptIds: ['historical-entry'],
  } });
  if (!bound.available) throw new Error(bound.reason);
  const entry: Parameters<typeof guardedReentryReceiptChecks>[0] = { kind: 'guarded-reentry', ...bound.binding,
    proposal: f.proposal, baseline: f.baseline, occurrenceId: 'original-child-occurrence', sessionId: 'new-session',
    actionId: f.currentEntry.id, requestId: 'new-request', guard: { observationId: f.current.id, profile: 'interface-exploration', repetitionSource: bound.binding.repetitionSource },
    selected: { selectedItemId: 'trade-owner', actionId: f.currentEntry.id, reentry: true },
    scheduled: { itemIds: ['trade-owner'], actionId: f.currentEntry.id, requestId: 'new-request', purpose: 'prerequisite' } };
  const receipt: ActionAttempt = { ...f.retained, id: 'new-entry', sessionId: 'new-session', action: f.currentEntry, requestId: 'new-request',
    beforeId: f.current.id, afterId: 'new-opened', executionProfile: 'interface-exploration', repetitionSource: bound.binding.repetitionSource };
  const checks = () => guardedReentryReceiptChecks(entry, receipt, structuredClone(receipt), false);
  expect(Object.values(checks()).every(Boolean)).toBe(true);
  receipt.repetitionSource = { sessionId: 'historical-session', attemptId: 'another-entry' }; expect(checks().repeatedSourceBound).toBe(false);
  receipt.repetitionSource = bound.binding.repetitionSource; receipt.status = 'unknown'; expect(checks().actualNewEntry).toBe(false);
  receipt.status = 'succeeded'; expect(guardedReentryReceiptChecks(entry, receipt, undefined, false).durable).toBe(false);
  expect(guardedReentryReceiptChecks(entry, receipt, receipt, true).actualNewEntry).toBe(false);
});

it.each(['wrong-child', 'wrong-source', 'unknown-route', 'ambiguous-source', 'already-visible'] as const)('rejects %s without manufacturing recovery or arrival', reason => {
  const f = fixture();
  if (reason === 'wrong-child') f.proposal.planned.itemId = 'trade-owner';
  if (reason === 'wrong-source') f.baseline.evidence[0].observationId = 'other-source';
  if (reason === 'unknown-route') f.retained.status = 'unknown';
  if (reason === 'ambiguous-source') f.actions.get(f.source.id)!.push({ ...f.actions.get(f.source.id)![0], id: 'other-child-action' });
  if (reason === 'already-visible') f.current.controls.push(f.child);
  expect(f.bind().available).toBe(false);
});
