import { EngineError, hash, id, now, type Persistence, type FrontierItem } from '@interaction/core';
import { classifyControlsSchema, revokeControlClassificationSchema, controlClassificationConditions, controlClassificationKey, classificationMatches, isNonInteractiveClassification,
  type Control, type Observation, type ActionCandidate, type ClassifyControlsInput, type ControlClassificationRecord, type ControlClassificationMaterial, type RevokeControlClassificationInput } from '@interaction/adapter-playwright';

/** Classifies one observed node. Descendants and supported capabilities are never suppressed. */
export class ControlClassifications {
  constructor(private store: Persistence, private emit: (sid: string, type: string, data: unknown) => unknown) {}
  records(sid: string) { return this.store.list<ControlClassificationRecord>('control-classification', sid); }
  private supported(c: Control, actions: ActionCandidate[]) {
    return Object.values(c.actionBasis || {}).some(b => b.status === 'supported') || actions.some(a => a.localId === c.localId && a.basis?.status === 'supported');
  }
  negative(c: Control, o: Observation) {
    return this.records(o.sessionId).find(r => isNonInteractiveClassification(r.classification) && classificationMatches(r, c, o));
  }
  material(o: Observation, actions: ActionCandidate[]): ControlClassificationMaterial {
    const records = this.records(o.sessionId);
    const controls = o.controls.filter(c => c.visible).map(control => {
      const candidates = actions.filter(a => a.localId === control.localId);
      const classifications = records.filter(r => r.conditions.target.instanceScope === o.instanceScope && r.conditions.target.target.instanceId === control.instanceId);
      return { control, actions: candidates, classifications,
        needsClassification: !control.readOnly && !this.supported(control, candidates) && !classifications.some(r => classificationMatches(r, control, o)) };
    });
    return { sessionId: o.sessionId, observationId: o.id, url: o.url, instanceScope: o.instanceScope, context: o.context, gaps: o.gaps,
      controls, pendingControlIds: controls.filter(c => c.needsClassification).map(c => c.control.localId) };
  }
  request(o: Observation, actions: ActionCandidate[], channel: 'event' | 'hook' = 'event') {
    if (o.gaps.some(g => g.critical)) return false;
    const m = this.material(o, actions), requestId = `classification-request:${o.sessionId}:${channel}`;
    const key = m.pendingControlIds.length ? hash(m.controls.filter(c => c.needsClassification).map(c => controlClassificationConditions(c.control, o))) : null;
    const previous = this.store.get<{ key: string | null }>('control-classification-request', requestId);
    if (previous?.key === key) return false;
    this.store.put('control-classification-request', { id: requestId, sessionId: o.sessionId, key });
    if (key && channel === 'event') this.emit(o.sessionId, 'control.classification_requested', { observationId: o.id, localIds: m.pendingControlIds });
    return key !== null;
  }
  record(o: Observation, actions: ActionCandidate[], input: ClassifyControlsInput) {
    const parsed = classifyControlsSchema.parse(input);
    if (parsed.observationId !== o.id || o.gaps.some(g => g.critical)) throw new EngineError('STALE_CONTROL_CLASSIFICATION', 'Classify the latest complete observation');
    if (Object.values(o.context).some(c => c.status !== 'known')) throw new EngineError('UNKNOWN_REVIEW_CONTEXT', 'Resolve declared context before classifying controls');
    const seen = new Set<string>();
    const records = parsed.classifications.map(classification => {
      const c = o.controls.find(c => c.localId === classification.localId);
      if (!c?.visible || seen.has(c.localId)) throw new EngineError('INVALID_CONTROL_CLASSIFICATION', 'Classify distinct visible current controls');
      seen.add(c.localId);
      if (isNonInteractiveClassification(classification.classification) && (this.supported(c, actions) || !c.classificationBinding || c.classificationBinding.truncated)) {
        throw new EngineError('INVALID_CONTROL_CLASSIFICATION', 'A negative classification requires complete bounded target structure and no supported operation');
      }
      const conditions = controlClassificationConditions(c, o);
      if (!conditions) throw new EngineError('INVALID_CONTROL_CLASSIFICATION', 'Current classification binding is unavailable');
      return { ...classification, id: id(), sessionId: o.sessionId, observationId: o.id, source: parsed.source, at: now(), status: 'active' as const,
        conditions, conditionKey: controlClassificationKey(conditions) };
    });
    for (const record of records) {
      for (const old of this.records(o.sessionId).filter(r => r.status === 'active' && r.conditions.target.instanceScope === o.instanceScope && r.conditions.target.target.instanceId === record.conditions.target.target.instanceId)) {
        old.status = 'superseded'; old.replacedBy = record.id; this.store.put('control-classification', old); this.emit(o.sessionId, 'control.classification_superseded', old);
      }
      this.store.put('control-classification', record); this.emit(o.sessionId, 'control.classified', record);
    }
    return records;
  }
  revoke(sid: string, input: RevokeControlClassificationInput) {
    const { classificationId, source, reason } = revokeControlClassificationSchema.parse(input);
    const r = this.store.get<ControlClassificationRecord>('control-classification', classificationId);
    if (!r || r.sessionId !== sid) throw new EngineError('NOT_FOUND', 'Control classification not found');
    if (r.status === 'revoked') return r;
    r.status = 'revoked'; r.revocation = { source, reason, at: now() }; this.store.put('control-classification', r); this.emit(sid, 'control.classification_revoked', r); return r;
  }
  reconcile(o: Observation, actions: ActionCandidate[]) {
    if (o.gaps.some(g => g.critical)) return;
    for (const r of this.records(o.sessionId).filter(r => r.status === 'active')) {
      const c = o.controls.find(c => c.instanceId === r.conditions.target.target.instanceId);
      if (!c || !classificationMatches(r, c, o) || isNonInteractiveClassification(r.classification) && this.supported(c, actions)) {
        r.status = 'invalidated'; r.invalidation = { observationId: o.id, reason: 'classification_conditions_changed', at: now() };
        this.store.put('control-classification', r); this.emit(o.sessionId, 'control.classification_invalidated', r);
      }
    }
  }
  apply(actions: ActionCandidate[], o: Observation) {
    return actions.filter(a => {
      const c = o.controls.find(c => c.localId === a.localId);
      return a.basis?.status === 'supported' || !c || !this.negative(c, o);
    });
  }
  validate(a: ActionCandidate, o: Observation) {
    const c = o.controls.find(c => c.localId === a.localId);
    if (a.basis?.status !== 'supported' && c && this.negative(c, o)) throw new EngineError('CONTROL_CLASSIFIED_NONINTERACTIVE', 'Revoke or replace the classification before probing this target');
  }
  retire(o: Observation) {
    const negatives = this.records(o.sessionId).filter(r => r.status === 'active' && isNonInteractiveClassification(r.classification));
    if (!negatives.length) return;
    const retired: string[] = [];
    for (const f of this.store.list<FrontierItem>('frontier', o.sessionId)) {
      if (f.attempts.length || f.action.basis?.status === 'supported') continue;
      const source = this.store.get<Observation>('observation', f.action.observationId), c = source?.controls.find(c => c.localId === f.action.localId);
      const r = source && c && negatives.find(r => classificationMatches(r, c, source));
      if (!r || f.status === 'superseded' && f.reason === 'control_classified_noninteractive') continue;
      f.status = 'superseded'; f.reason = 'control_classified_noninteractive'; f.unblock = undefined;
      f.action = { ...f.action, basis: { status: 'tentative', evidence: [...f.action.basis?.evidence || [], { source: r.source, rule: 'classified-control/v1', facts: { classificationId: r.id, conditionKey: r.conditionKey, classification: r.classification, reason: r.reason, evidence: r.evidence } }] } };
      this.store.put('frontier', f); retired.push(f.id);
    }
    if (retired.length) this.emit(o.sessionId, 'frontier.updated', { reason: 'control_classification_changed', frontierIds: retired });
  }
}
