import { EngineError, canonical, id, type ActionAttempt, type EngineEvent, type InteractionScope } from '@interaction/core';
import { z } from 'zod';
import { inspectionCapabilities, sessionSchema, validateCaptureProfile, type Observation, type SessionOptions, type DetailSnapshot } from '@interaction/adapter-playwright';
import type { BrowserEngine } from './index.js';
import type { Capture, EvidenceComponent, Inspection, InspectionBaseline, InspectionDelivery, InspectionResult, InspectionEventData } from './inspection-types.js';

export const inspectionResultSchema = z.object({
  ruleId: z.string().min(1).max(200), ruleVersion: z.string().min(1).max(100),
  status: z.enum(['pass', 'fail', 'inconclusive', 'unsupported', 'not-applicable']), message: z.string().max(10000),
  nodeIds: z.array(z.string().min(1).max(300)).max(1000).optional(), evidence: z.array(z.string().max(2000)).max(100).optional(),
  severity: z.enum(['info', 'warning', 'error']).optional(), details: z.json().optional(),
}).strict();
export const completeInspectionSchema = z.object({ consumerId: z.string().min(1), results: z.array(inspectionResultSchema).max(1000) }).strict();
export const inspectionConsumerSchema = z.object({ consumerId: z.string().min(1).max(100) }).strict();
export const inspectionPageSchema = z.object({ after: z.coerce.number().int().min(0).default(0), limit: z.coerce.number().int().min(1).max(500).default(100) }).strict();

export function validateInspectionOptions(input: unknown): SessionOptions {
  const options = sessionSchema.parse(input) as SessionOptions; const config = options.inspection;
  if (!config) return options;
  const validation = validateCaptureProfile(config.profile);
  if (!validation.valid) throw new EngineError('INSPECTION_UNSUPPORTED', 'Required capture capabilities are unsupported', validation);
  if (config.consumers.length && options.evidenceRetention?.mode === 'transient') throw new EngineError('INSPECTION_RETENTION_REQUIRED', 'Inspection consumers require cache, persistent, or legacy retained evidence');
  return options;
}

/** Capture production and delivery lifecycle share a queue; no operation waits on an inspector. */
export class InspectionCoordinator {
  private queue: Promise<unknown> = Promise.resolve();
  private timer: ReturnType<typeof setInterval>;
  private staging = new Map<string, string>();
  constructor(private engine: BrowserEngine, private publish: (sessionId: string, type: string, data: unknown) => EngineEvent) {
    this.timer = setInterval(() => { void this.sweep().catch(() => {}); }, 1000); this.timer.unref?.();
    // Restore finite leases and detect missing process-local evidence before production.
    void this.sweep().catch(() => {});
  }
  private emit<K extends keyof InspectionEventData>(sessionId: string, type: K, data: Omit<InspectionEventData[K], 'protocolVersion'>) {
    return this.publish(sessionId, type, { ...data, protocolVersion: 1 });
  }
  private run<T>(fn: () => Promise<T>): Promise<T> { const task = this.queue.then(fn); this.queue = task.catch(() => {}); return task; }
  private owned<T extends { sessionId: string }>(kind: string, entityId: string, sessionId: string) {
    if (!entityId) throw new EngineError('INVALID_QUERY', `Explicit ${kind} ID is required`);
    const entity = this.engine.store.get<T>(kind, entityId);
    if (!entity || entity.sessionId !== sessionId) throw new EngineError('NOT_FOUND', `${kind} does not belong to session`);
    return entity;
  }
  private keys(observationId: string, sessionId: string) { return Object.values(this.engine.observation(sessionId, observationId).evidence?.artifacts || {}).map(a => a!.key); }
  prepare(sessionId: string, observationId: string) {
    return this.run(async () => {
      const session = this.engine.session(sessionId); if (!session.options.inspection) return;
      await this.sweepInternal();
      if (!session.options.inspection.consumers.length) return;
      // Protect previous + open-scope baselines before closing a scope can remove
      // their normal retention protection. Staging pins expire even after a crash.
      const ids = new Set([session.currentObservationId, ...this.engine.list<InteractionScope>(sessionId, 'scope').filter(s => s.status === 'open').map(s => s.beforeId)].filter((s): s is string => !!s));
      const owner = `inspection:staging:${observationId}`; this.staging.set(observationId, owner);
      for (const oid of ids) {
        try { await this.engine.store.evidence.pin(this.keys(oid, sessionId), owner, { expiresAt: Date.now() + 120000 }); }
        catch { /* Availability is recorded separately when the inspection is assembled. */ }
      }
    });
  }
  private async cleanup(observationId: string) {
    const owner = this.staging.get(observationId); if (owner) { await this.engine.store.evidence.unpin(owner); this.staging.delete(observationId); }
  }
  failed(sessionId: string, observationId: string, error: unknown) {
    return this.run(async () => {
      if (this.engine.session(sessionId).options.inspection) this.emit(sessionId, 'inspection.failed', { observationId, reason: String(error) });
      await this.cleanup(observationId);
    });
  }
  finish(observation: Observation, previous?: Observation, attemptId?: string) {
    return this.run(async () => {
      const config = this.engine.session(observation.sessionId).options.inspection; if (!config) return;
      const sid = observation.sessionId;
      const reserved: string[] = [];
      try {
        const details = await this.engine.observationDetails(sid, observation.id); const dom = details.snapshot?.dom;
        const components = this.components(observation, details.snapshot, details.availability);
        const required = config.profile.required;
        const missingRequired = required.filter(kind => !components.some(c => c.kind === kind && c.status === 'captured'));
        const quality: Capture['quality'] = { status: missingRequired.length || !observation.stable || observation.gaps.some(g => g.critical) ? 'incomplete' : 'complete', missingRequired, gaps: details.gaps };
        const capture: Capture = {
          id: `capture:${observation.id}`, sessionId: sid, protocolVersion: 1, observationId: observation.id, attemptId, documentId: observation.documentId,
          capturedAt: observation.capturedAt, phase: observation.stable ? 'settled' : 'timeout', profile: config.profile, components, quality, environment: dom?.environment,
          coordinates: { unit: 'css-px', origin: 'layout-viewport', screenshot: 'viewport-image', consistency: 'components_have_individual_timestamps' },
        };
        const scopes = this.engine.list<InteractionScope>(sid, 'scope');
        const overlays = observation.overlays || []; const prevOverlays = previous?.overlays || [];
        const active = overlays.at(-1); const scope = active ? scopes.find(s => s.status === 'open' && s.boundaryKey === active.key) : undefined;
        const exited = scopes.filter(s => s.status === 'closed' && s.afterId === observation.id);
        // Prefer the outermost exited scope if one action closed an entire stack.
        const restored = exited.find(s => !exited.some(p => p.id === s.parentScopeId)) || exited[0];
        const reasons: Inspection['reasons'] = [];
        if (!previous) reasons.push('initial');
        if (overlays.some(o => !prevOverlays.some(p => p.key === o.key))) reasons.push('scope_entered');
        if (prevOverlays.some(o => !overlays.some(p => p.key === o.key))) reasons.push('scope_exited');
        if (attemptId) reasons.push('after_action');
        if (previous && (previous.documentId !== observation.documentId || previous.url !== observation.url)) reasons.push('navigation');
        if (observation.cause === 'external') reasons.push('observed_update');
        if (previous && canonical(previous.viewport) !== canonical(observation.viewport)) reasons.push('environment_changed');
        if (!reasons.length) reasons.push('manual');
        const regionKey = active?.key || 'document';
        const root = dom?.regionRoots[regionKey] || (regionKey === 'document' ? dom?.rootId : undefined);
        const baselineScope = restored || scope;
        const baselines: InspectionBaseline[] = [this.baseline('previous', previous, observation)];
        if (baselineScope) baselines.push(baselineScope.baseline === 'before_entry' ? this.baseline('scopeEntry', this.engine.observation(sid, baselineScope.beforeId), observation) : { role: 'scopeEntry', comparison: 'missing', reason: 'scope_already_open' });
        if (attemptId) { const attempt = this.engine.store.require<ActionAttempt>('attempt', attemptId); baselines.push(this.baseline('actionBefore', this.engine.observation(sid, attempt.beforeId), observation)); }
        const inspection: Inspection = {
          id: id(), sessionId: sid, protocolVersion: 1, captureId: capture.id, observationId: observation.id, sequence: 0, createdAt: new Date().toISOString(), reasons,
          focus: { regionKey, rootIds: root ? [root] : [], scopeId: scope?.id, kind: active ? 'overlay' : 'document', confidence: root && !observation.gaps.some(g => g.critical) ? 'observed' : 'unknown', relatedRegions: [...new Set(['document', ...overlays.map(o => o.key)])] },
          baselines, requirements: config.profile, quality,
        };
        const deliveries: InspectionDelivery[] = [];
        const sourceIds = new Set([observation.id, ...baselines.flatMap(b => b.captureId ? [this.owned<Capture>('capture', b.captureId, sid).observationId!] : [])]);
        const keys = [...sourceIds].flatMap(oid => this.keys(oid, sid));
        for (const consumer of config.consumers) {
          const started = Date.now(); const delivery: InspectionDelivery = {
            id: `${inspection.id}:${consumer.id}`, sessionId: sid, inspectionId: inspection.id, captureId: capture.id, consumerId: consumer.id, status: 'pending',
            createdAt: new Date(started).toISOString(), leaseUntil: new Date(started + consumer.leaseMs).toISOString(), maxLeaseUntil: new Date(started + consumer.maxLeaseMs).toISOString(), owner: `inspection:${inspection.id}:${consumer.id}`, keys,
          };
          try {
            if (!keys.length) throw new Error('No evidence artifacts were captured');
            await this.engine.store.evidence.pin(keys, delivery.owner, { expiresAt: started + consumer.leaseMs }); reserved.push(delivery.owner);
          } catch (error) { delivery.status = 'unavailable'; delivery.reason = String(error); }
          deliveries.push(delivery);
        }
        // Binaries already exist and leases are reserved. The durable event and
        // immutable capture/inspection records become visible in one transaction.
        this.engine.store.transaction(() => {
          this.engine.store.put('capture', capture);
          for (const delivery of deliveries) {
            if (delivery.status === 'pending' && Date.parse(delivery.leaseUntil) <= Date.now()) { delivery.status = 'expired'; delivery.reason = 'lease_elapsed_during_production'; }
            this.engine.store.put('inspection-delivery', delivery);
          }
          const event = this.emit(sid, 'inspection.ready', { inspectionId: inspection.id, captureId: capture.id, observationId: observation.id, reasons, focus: inspection.focus, quality, deliveries: deliveries.map(d => ({ consumerId: d.consumerId, status: d.status, leaseUntil: d.leaseUntil })) });
          inspection.sequence = event.sequence; this.engine.store.put('inspection', inspection);
        });
      } catch (error) {
        for (const owner of reserved) await this.engine.store.evidence.unpin(owner);
        this.emit(sid, 'inspection.failed', { observationId: observation.id, reason: String(error) });
      } finally { await this.cleanup(observation.id); }
    });
  }
  private components(o: Observation, snapshot: DetailSnapshot | undefined, availability: Record<string, import('@interaction/core').EvidenceAvailability>): EvidenceComponent[] {
    const config = this.engine.session(o.sessionId).options.inspection!; const dom = snapshot?.dom;
    const truncatedFields = dom?.nodes.some(n => n.gaps.some(g => g.code === 'FIELD_TRUNCATED'));
    const supported = new Set<string>(inspectionCapabilities.supported);
    return [...new Set([...config.profile.required, ...config.profile.optional])].map(kind => {
      const artifact = kind === 'web.screenshot' ? o.evidence?.artifacts.screenshot : o.evidence?.artifacts.details;
      let status: EvidenceComponent['status'] = artifact ? 'captured' : 'unavailable';
      const gaps = [...(dom?.gaps || [])];
      if (!supported.has(kind)) status = 'unsupported';
      else if (kind === 'web.screenshot') { /* Its own timestamp, not DOM atomicity. */ }
      else if (!snapshot) status = 'unavailable';
      else if (kind === 'web.aria') status = snapshot.accessibility.status !== 'captured' ? 'unavailable' : snapshot.accessibility.truncated ? 'partial' : 'captured';
      else if (kind === 'web.runtime') status = snapshot.runtime.truncatedFields || Object.values(snapshot.runtime.dropped).some(n => n > 0) ? 'partial' : 'captured';
      else if (!dom) status = 'unavailable';
      else if (kind === 'web.environment') status = dom.environment ? 'captured' : 'unavailable';
      else if (kind === 'web.layout') status = dom.spatialVersion !== 1 ? 'unavailable' : dom.nodesTruncated ? 'partial' : 'captured';
      else if (kind === 'web.styles') status = snapshot.limits.styles === 'none' ? 'unavailable' : dom.nodesTruncated || truncatedFields ? 'partial' : 'captured';
      else status = dom.nodesTruncated || truncatedFields ? 'partial' : 'captured';
      const artifactKind = kind === 'web.screenshot' ? 'screenshot' : 'details';
      if (status !== 'unsupported' && artifact && availability[artifactKind]?.status !== 'available') status = 'unavailable';
      return { kind, schemaVersion: 1, collector: { id: 'playwright.spatial', version: 1 }, status,
        coverage: kind === 'web.screenshot' ? 'viewport' : kind === 'web.runtime' ? 'session-runtime' : 'main-document-light-dom', artifact,
        capturedAt: kind === 'web.screenshot' ? artifact?.capturedAt : kind === 'web.runtime' ? snapshot?.runtime.capturedAt : kind === 'web.aria' ? snapshot?.accessibility.capturedAt : dom?.capturedAt, gaps };
    });
  }
  private baseline(role: InspectionBaseline['role'], before: Observation | undefined, after: Observation): InspectionBaseline {
    if (!before) return { role, comparison: 'missing', reason: 'no_prior_capture' };
    const capture = this.engine.store.get<Capture>('capture', `capture:${before.id}`);
    if (!capture) return { role, comparison: 'missing', reason: 'legacy_observation_without_capture' };
    const reason = before.documentId !== after.documentId ? 'document_changed' : canonical(before.viewport) !== canonical(after.viewport) ? 'viewport_changed' : undefined;
    return { role, captureId: capture.id, comparison: reason ? 'incomparable' : 'comparable', reason };
  }
  list(sessionId: string, input: { after?: number; limit?: number } = {}) {
    this.engine.session(sessionId); const query = inspectionPageSchema.parse(input);
    const all = this.engine.store.list<Inspection>('inspection', sessionId).filter(i => i.sequence > query.after).sort((a, b) => a.sequence - b.sequence);
    const items = all.slice(0, query.limit); return { items, nextCursor: items.at(-1)?.sequence ?? query.after, hasMore: all.length > items.length };
  }
  async inspection(sessionId: string, inspectionId: string) {
    await this.sweep(); const inspection = this.owned<Inspection>('inspection', inspectionId, sessionId);
    return { inspection, deliveries: this.engine.store.list<InspectionDelivery>('inspection-delivery', sessionId).filter(d => d.inspectionId === inspectionId) };
  }
  capture(sessionId: string, captureId: string) { return this.owned<Capture>('capture', captureId, sessionId); }
  async captureDetails(sessionId: string, captureId: string) {
    const capture = this.capture(sessionId, captureId);
    const availability = await Promise.all(capture.components.map(async c => ({ kind: c.kind, availability: c.artifact ? await this.engine.store.evidence.availability(c.artifact.key) : { status: 'missing' as const } })));
    const unknownComponents = capture.components.filter(c => c.schemaVersion !== 1 || c.collector.version !== 1 || !inspectionCapabilities.supported.includes(c.kind as typeof inspectionCapabilities.supported[number])).map(c => c.kind);
    return { capture, compatibility: { protocolSupported: capture.protocolVersion === 1, unknownComponents }, availability, details: capture.observationId ? await this.engine.observationDetails(sessionId, capture.observationId) : undefined };
  }
  async nodeContext(sessionId: string, captureId: string, nodeId: string) {
    const details = await this.captureDetails(sessionId, captureId); const dom = details.details?.snapshot?.dom;
    if (!dom) throw new EngineError('EVIDENCE_UNAVAILABLE', 'No retained DOM evidence for this capture');
    const nodes = new Map(dom.nodes.map(n => [n.id, n])); const node = nodes.get(nodeId);
    if (!node) throw new EngineError('NOT_FOUND', 'Node was not captured in this document');
    const ancestors = []; let parent = node.parentId;
    while (parent && nodes.has(parent)) { const n = nodes.get(parent)!; ancestors.push(n); parent = n.parentId; }
    const relatedIds = [...new Set([...Object.values(node.relations || {}).flat(), ...(node.layout?.scrollAncestorIds || []), ...(node.layout?.clipAncestorIds || [])])];
    return { captureId, documentId: dom.documentId, node, ancestors, relations: relatedIds.map(id => ({ nodeId: id, node: nodes.get(id), status: nodes.has(id) ? 'captured' : 'not_captured' })), environment: dom.environment, gaps: [...dom.gaps, ...node.gaps] };
  }
  private delivery(sessionId: string, inspectionId: string, consumerId: string) { inspectionConsumerSchema.parse({ consumerId }); return this.owned<InspectionDelivery>('inspection-delivery', `${inspectionId}:${consumerId}`, sessionId); }
  private async sweepInternal() {
    const availability = new Map<string, Promise<import('@interaction/core').EvidenceAvailability>>();
    const available = (key: string) => { let value = availability.get(key); if (!value) { value = this.engine.store.evidence.availability(key); availability.set(key, value); } return value; };
    for (const d of this.engine.store.list<InspectionDelivery>('inspection-delivery')) if (d.status === 'pending') {
      if (Date.parse(d.leaseUntil) <= Date.now()) { d.status = 'expired'; d.reason = 'lease_expired'; }
      else {
        for (const key of d.keys) if ((await available(key)).status !== 'available') { d.status = 'unavailable'; d.reason = 'evidence_unavailable_or_process_restarted'; break; }
      }
      if (d.status !== 'pending') {
        this.engine.store.transaction(() => { this.engine.store.put('inspection-delivery', d); this.emit(d.sessionId, 'inspection.delivery_gap', { inspectionId: d.inspectionId, consumerId: d.consumerId, status: d.status, reason: d.reason }); });
        await this.engine.store.evidence.unpin(d.owner);
      }
    }
  }
  sweep() { return this.run(() => this.sweepInternal()); }
  receipt(sessionId: string, inspectionId: string, consumerId: string) {
    return this.run(async () => { await this.sweepInternal(); const d = this.delivery(sessionId, inspectionId, consumerId); if (d.status !== 'pending') return d; d.receivedAt ||= new Date().toISOString(); this.engine.store.put('inspection-delivery', d); return d; });
  }
  renew(sessionId: string, inspectionId: string, consumerId: string) {
    return this.run(async () => {
      await this.sweepInternal(); const d = this.delivery(sessionId, inspectionId, consumerId);
      if (d.status !== 'pending') throw new EngineError('INSPECTION_LEASE_CLOSED', 'Only pending inspections can renew', { status: d.status });
      const consumer = this.engine.session(sessionId).options.inspection!.consumers.find(c => c.id === consumerId)!;
      const until = Math.min(Date.now() + consumer.leaseMs, Date.parse(d.maxLeaseUntil));
      if (until <= Date.now()) throw new EngineError('INSPECTION_LEASE_CLOSED', 'Maximum inspection lease reached');
      await this.engine.store.evidence.pin(d.keys, d.owner, { expiresAt: until }); d.leaseUntil = new Date(until).toISOString(); this.engine.store.put('inspection-delivery', d); return d;
    });
  }
  complete(sessionId: string, inspectionId: string, consumerId: string, input: InspectionResult[]) {
    const { results } = completeInspectionSchema.parse({ consumerId, results: input });
    if (new Set(results.map(r => JSON.stringify([r.ruleId, r.ruleVersion]))).size !== results.length) throw new EngineError('INVALID_QUERY', 'Rule/version pairs must be unique');
    return this.run(async () => {
      await this.sweepInternal(); const d = this.delivery(sessionId, inspectionId, consumerId);
      if (d.status === 'completed') { if (canonical(results) !== canonical(d.results)) throw new EngineError('INSPECTION_RESULT_CONFLICT', 'Completion was already recorded with different results'); return d; }
      if (d.status !== 'pending') throw new EngineError('INSPECTION_LEASE_CLOSED', 'Inspection evidence lease is no longer available', { status: d.status });
      const inspection = this.owned<Inspection>('inspection', inspectionId, sessionId);
      if (inspection.quality.status === 'incomplete' && results.some(r => r.status === 'pass')) throw new EngineError('INSPECTION_INCOMPLETE', 'Incomplete required evidence cannot produce a passing result');
      if (results.some(r => r.nodeIds?.length)) {
        const details = await this.captureDetails(sessionId, d.captureId); const nodes = new Set(details.details?.snapshot?.dom?.nodes.map(n => n.id));
        if (results.some(r => r.nodeIds?.some(id => !nodes.has(id)))) throw new EngineError('INVALID_QUERY', 'Result node IDs must belong to this capture');
      }
      if (Date.parse(d.leaseUntil) <= Date.now()) { await this.sweepInternal(); throw new EngineError('INSPECTION_LEASE_CLOSED', 'Lease expired while validating results'); }
      d.status = 'completed'; d.completedAt = new Date().toISOString(); d.results = results;
      this.engine.store.transaction(() => { this.engine.store.put('inspection-delivery', d); this.emit(sessionId, 'inspection.completed', { inspectionId, captureId: d.captureId, consumerId, results }); });
      await this.engine.store.evidence.unpin(d.owner); return d;
    });
  }
  cancel(sessionId: string, inspectionId: string, consumerId: string) {
    return this.run(async () => { await this.sweepInternal(); const d = this.delivery(sessionId, inspectionId, consumerId); if (d.status === 'completed' || d.status === 'cancelled') return d; d.reason = `cancelled_from_${d.status}`; d.status = 'cancelled'; this.engine.store.put('inspection-delivery', d); await this.engine.store.evidence.unpin(d.owner); this.emit(sessionId, 'inspection.cancelled', { inspectionId, consumerId }); return d; });
  }
  async beforeAction(sessionId: string) {
    if (this.engine.session(sessionId).options.inspection?.profile.onIncomplete !== 'pause') return;
    await this.sweep(); const current = this.engine.observation(sessionId); const capture = this.engine.store.get<Capture>('capture', `capture:${current.id}`);
    const deliveries = this.engine.store.list<InspectionDelivery>('inspection-delivery', sessionId);
    if (!capture || capture.quality.status === 'incomplete' || deliveries.some(d => ['expired', 'unavailable'].includes(d.status))) throw new EngineError('INSPECTION_INCOMPLETE', 'Required evidence or delivery guarantee is incomplete; strict inspection policy blocks the next action', { captureId: capture?.id });
  }
  async close() { clearInterval(this.timer); await this.queue; }
}
