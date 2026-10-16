import type { ExplorationCase, InteractionAdapter, Persistence } from './ports.js';
import type { ActionCandidate, FrontierItem, Observation, Session, SessionOptions } from './types.js';
import { canonical, contextKey, hash } from './util.js';

/** Shared with normal frontier creation: a policy version is part of the key. */
export function sampledFrontierKey(action: ActionCandidate, sample: ExplorationCase) {
  return hash({ sample: sample.key, policy: sample.policy, control: action.controlId, kind: action.kind,
    value: action.value, context: action.preconditions.context });
}

function childBinding(parent: FrontierItem, child: FrontierItem) {
  return child.sessionId === parent.sessionId && child.action.sessionId === parent.sessionId
    && child.stateId === child.action.stateId && !!child.action.observationId
    && child.sampling?.observationIds.includes(child.action.observationId)
    && child.action.kind === parent.action.kind && child.action.controlId === parent.action.controlId
    && canonical(child.action.value) === canonical(parent.action.value)
    && canonical(child.action.preconditions.context) === canonical(parent.action.preconditions.context);
}

/** A parent is retired only while every source is backed by an extant child.
 * Missing or mismatched children reopen the accounting gap, never become proof. */
export function migratedSamplingChildren(parent: FrontierItem, items: Map<string, FrontierItem>): string[] | undefined {
  const migration = parent.samplingMigration;
  if (parent.status !== 'superseded' || parent.reason !== 'sampling_policy_migrated' || parent.attempts.length
    || migration?.version !== 'retained-sampling-sources/v1' || migration.sourceKey !== parent.key || !parent.sampling) return;
  const expected = [...new Set([...parent.sampling.observationIds, parent.action.observationId])];
  if (!expected.length || migration.sources.length !== expected.length
    || new Set(migration.sources.map(s => s.observationId)).size !== expected.length
    || migration.sources.some(s => !expected.includes(s.observationId) || s.reason || !s.childId || !s.actionId)) return;
  const children = new Map(migration.children.map(c => [c.frontierId, c]));
  for (const source of migration.sources) {
    const ref = children.get(source.childId!), child = items.get(source.childId!);
    const lineage = child?.samplingParents?.find(p => p.frontierId === parent.id);
    if (!ref || !child || child.id === parent.id || !childBinding(parent, child) || child.key !== ref.key
      || child.sampling?.policy !== ref.policy || !lineage?.observationIds.includes(source.observationId)
      || !lineage.actionIds.includes(source.actionId!)) return;
  }
  return [...new Set(migration.sources.map(s => s.childId!))];
}

/** Expand only retained, unattempted representative work. This does not infer
 * undiscovered combinations, replace historical observations, or transfer grants. */
export function migrateSamplingSources<O extends Observation, S extends SessionOptions>(store: Persistence,
  session: Session<S>, adapter: InteractionAdapter<O, S>, unknownOutcomes: boolean, force = false) {
  const revision = adapter.explorationCaseRevision;
  if (session.options.exploration !== 'representative' || !revision || !adapter.legacyExplorationCases || !adapter.explorationCase) return;
  const items = store.list<FrontierItem>('frontier', session.id), byId = new Map(items.map(f => [f.id, f]));
  const observations = new Map<string, O | undefined>();
  const read = (oid: string) => {
    if (!observations.has(oid)) {
      const o = store.get<O>('observation', oid); observations.set(oid, o?.sessionId === session.id ? o : undefined);
      if (observations.size > 8) observations.delete(observations.keys().next().value!);
    }
    return observations.get(oid);
  };
  const sourceSignature = (f: FrontierItem) => hash({ key: f.key, policy: f.sampling?.policy,
    sources: f.sampling?.observationIds, actionId: f.action.id, unknownOutcomes });
  const childrenSignature = (f: FrontierItem) => hash(f.samplingMigration?.children.map(ref => {
    const child = byId.get(ref.frontierId);
    // A fresh observation replaces a pending child's action ID/source without
    // changing its scope. Hash the binding invariants, never that live churn.
    return [ref, child && { key: child.key, policy: child.sampling?.policy, binding: childBinding(f, child),
      parent: child.samplingParents?.find(p => p.frontierId === f.id) }];
  }));
  const changed = items.filter(f => {
    if (!f.sampling || f.attempts.length || ['executed', 'executing', 'unknown', 'skipped', 'deferred'].includes(f.status)) return false;
    if (f.samplingMigration) {
      if (migratedSamplingChildren(f, byId)) return false;
      const audit = f.samplingMigration.audit;
      return force || audit?.revision !== revision || audit.sourceSignature !== sourceSignature(f) || audit.childrenSignature !== childrenSignature(f);
    }
    if (f.status === 'superseded') return false;
    if (!force && f.sampling.revision === revision) return false;
    const o = read(f.action.observationId), sample = o && adapter.explorationCase!(f.action, o, session);
    if (sample && sampledFrontierKey(f.action, sample) === f.key) { f.sampling.revision = revision; store.put('frontier', f); return false; }
    return true;
  });
  if (!changed.length) return;
  const byObservation = new Map<string, ActionCandidate[]>();
  for (const action of store.list<ActionCandidate>('action', session.id)) {
    const list = byObservation.get(action.observationId) || []; list.push(action); byObservation.set(action.observationId, list);
  }
  const byKey = new Map(items.map(f => [f.key, f]));
  const keyCounts = new Map<string, number>();
  for (const item of items) keyCounts.set(item.key, (keyCounts.get(item.key) || 0) + 1);
  for (const parent of changed) {
    const migration: NonNullable<FrontierItem['samplingMigration']> = { version: 'retained-sampling-sources/v1', sourceKey: parent.key, sources: [], children: [] };
    for (const observationId of new Set([...parent.sampling!.observationIds, parent.action.observationId])) {
      const source: typeof migration.sources[number] = { observationId }; migration.sources.push(source);
      const previous = parent.samplingMigration?.sources.find(s => s.observationId === observationId);
      if (previous?.childId) {
        source.childId = previous.childId; source.actionId = previous.actionId;
        const ref = parent.samplingMigration!.children.find(c => c.frontierId === previous.childId);
        if (ref && !migration.children.some(c => c.frontierId === ref.frontierId)) migration.children.push(ref);
        const child = byId.get(previous.childId);
        if (!child) { source.reason = 'derived_scope_missing'; continue; }
        if (!ref || child.key !== ref.key || child.sampling?.policy !== ref.policy || !childBinding(parent, child)) {
          source.reason = 'derived_scope_binding_unverified'; continue;
        }
      }
      if (unknownOutcomes) { source.reason = 'unknown_execution_outcome'; continue; }
      const o = read(observationId);
      if (!o) { source.reason = 'source_observation_missing'; continue; }
      if (o.gaps.some(g => g.critical) || !o.stable || Object.values(o.context).some(c => c.status !== 'known')) { source.reason = 'source_observation_unverified'; continue; }
      const matches = (byObservation.get(observationId) || []).filter(a => adapter.legacyExplorationCases!(a, o, session)
        .some(s => s.policy === parent.sampling!.policy && sampledFrontierKey(a, s) === parent.key));
      if (matches.length !== 1) { source.reason = matches.length ? 'source_action_ambiguous' : 'source_action_or_legacy_key_unverified'; continue; }
      const action = matches[0]; source.actionId = action.id;
      const control = o.controls.find(c => c.localId === action.localId);
      if (action.stateId !== o.stateId || !control || !control.identityId || control.identityId !== action.controlId || control.hypothesisId || control.identityScope === 'instance'
        || o.controls.filter(c => c.identityId === control.identityId).length !== 1 || !action.preconditions.identityResolved
        || action.basis?.status !== 'supported' || canonical(action.preconditions.context) !== canonical(o.context)) {
        source.reason = 'source_target_unverified'; continue;
      }
      const sample = adapter.explorationCase!(action, o, session);
      if (!sample) { source.reason = 'current_source_conditions_unverified'; continue; }
      const key = sampledFrontierKey(action, sample);
      if (key === parent.key) { source.reason = 'sampling_policy_not_changed'; continue; }
      let child = byKey.get(key);
      if (child?.samplingMigration) { source.reason = 'derived_scope_requires_reconciliation'; continue; }
      if ((keyCounts.get(key) || 0) > 1) { source.reason = 'derived_scope_ambiguous'; continue; }
      let created = false;
      if (!child) {
        const gated = !!parent.explorationGroups?.length;
        const childId = hash({ kind: 'sampling-derived-frontier', sessionId: session.id, key });
        if (byId.has(childId)) { source.reason = 'derived_id_conflict'; continue; }
        child = { id: childId, sessionId: session.id, key,
          stateId: o.stateId, contextKey: contextKey(o.context), action, depth: parent.depth, attempts: [],
          status: gated ? 'blocked' : 'pending', ...(gated ? { reason: 'sampling_scope_review_required', unblock: 'Observe this retained source and review its current scope before dispatch' } : {}),
          sampling: { policy: sample.policy, evidence: sample.evidence, observationIds: [observationId], revision } };
        created = true;
      }
      if (child.sampling?.policy !== sample.policy || !childBinding(parent, child)) { source.reason = 'derived_scope_binding_unverified'; continue; }
      const childSource = read(child.action.observationId), childSample = childSource && adapter.explorationCase!(child.action, childSource, session);
      if (!childSample || sampledFrontierKey(child.action, childSample) !== key) { source.reason = 'derived_scope_action_unverified'; continue; }
      child.samplingParents ??= [];
      let lineage = child.samplingParents.find(p => p.frontierId === parent.id);
      if (!lineage) { lineage = { frontierId: parent.id, observationIds: [], actionIds: [] }; child.samplingParents.push(lineage); }
      if (!lineage.observationIds.includes(observationId)) lineage.observationIds.push(observationId);
      if (!lineage.actionIds.includes(action.id)) lineage.actionIds.push(action.id);
      if (!child.sampling.observationIds.includes(observationId)) child.sampling.observationIds.push(observationId);
      try { store.put('frontier', child); }
      catch (error) { if ((error as { code?: string }).code !== 'ID_CONFLICT') throw error; source.reason = 'derived_id_conflict'; continue; }
      if (created) { byKey.set(key, child); byId.set(child.id, child); keyCounts.set(key, 1); }
      source.childId = child.id;
      if (!migration.children.some(c => c.frontierId === child!.id)) migration.children.push({ frontierId: child.id, key, policy: sample.policy });
    }
    parent.samplingMigration = migration;
    migration.audit = { revision, sourceSignature: sourceSignature(parent), childrenSignature: childrenSignature(parent) };
    const complete = migration.sources.length > 0 && migration.sources.every(s => s.childId && !s.reason);
    parent.status = complete ? 'superseded' : 'blocked';
    parent.reason = complete ? 'sampling_policy_migrated' : 'sampling_migration_incomplete';
    parent.unblock = complete ? undefined : 'Recover the missing or unverified retained source evidence; current page observations cannot replace it';
    store.put('frontier', parent);
  }
}
