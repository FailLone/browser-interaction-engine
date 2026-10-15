import { EngineError, hash, id, now, type Persistence } from '@interaction/core';
import { supplementDiscoverySchema, type SupplementDiscoveryInput, type DiscoveryScanRecord, type DiscoveryScanMaterial, type Observation } from '@interaction/adapter-playwright';

/** Read-only discovery plans never grant actions, dismiss gaps or count as coverage. */
export class DiscoveryScans {
  constructor(private store: Persistence, private emit: (sid: string, type: string, data: unknown) => unknown) {}
  records(sid: string) { return this.store.list<DiscoveryScanRecord>('discovery-scan', sid); }
  material(o: Observation): DiscoveryScanMaterial {
    return structuredClone({ sessionId: o.sessionId, observationId: o.id, url: o.url, instanceScope: o.instanceScope,
      context: o.context, gaps: o.gaps, discovery: o.discoveryScan, records: this.records(o.sessionId) });
  }
  prepare(o: Observation, input: SupplementDiscoveryInput): DiscoveryScanRecord {
    const parsed = supplementDiscoverySchema.parse(input);
    if (o.id !== parsed.observationId || !o.discoveryScan) throw new EngineError('STALE_DISCOVERY_SCAN', 'Use discovery material from the latest observation');
    const target = o.discoveryScan.targets.find(t => t.id === parsed.targetId);
    if (!target || parsed.budget.offset >= target.elementCount) throw new EngineError('INVALID_DISCOVERY_SCAN', 'Select an observed root and an offset inside its current subtree');
    const requestId = id();
    return { ...parsed, id: requestId, requestId, sessionId: o.sessionId, documentId: o.documentId, url: o.url,
      topologyKey: o.discoveryScan.topologyKey, at: now(), status: 'active' };
  }
  record(record: DiscoveryScanRecord) {
    for (const old of this.records(record.sessionId).filter(r => r.status === 'active')) {
      old.status = 'superseded'; old.replacedBy = record.id;
      this.store.put('discovery-scan', old); this.emit(record.sessionId, 'discovery.scan_superseded', old);
    }
    this.store.put('discovery-scan', record); this.emit(record.sessionId, 'discovery.scan_recorded', record);
  }
  failed(record: DiscoveryScanRecord, error: unknown) {
    const current = this.store.require<DiscoveryScanRecord>('discovery-scan', record.id);
    current.status = 'failed'; current.error = String(error);
    this.store.put('discovery-scan', current); this.emit(record.sessionId, 'discovery.scan_failed', current);
  }
  reconcile(o: Observation) {
    for (const record of this.records(o.sessionId).filter(r => r.status === 'active')) {
      const scan = o.discoveryScan?.supplement;
      if (scan?.requestId !== record.id || scan.status !== 'active' || o.discoveryScan?.topologyKey !== record.topologyKey
        || o.documentId !== record.documentId || o.url !== record.url) {
        record.status = 'invalidated'; record.invalidation = { observationId: o.id, reason: scan?.reason || 'scan_plan_or_document_changed' };
        this.store.put('discovery-scan', record); this.emit(o.sessionId, 'discovery.scan_invalidated', record);
      } else if (!record.resultObservationId) {
        record.resultObservationId = o.id; this.store.put('discovery-scan', record);
        this.emit(o.sessionId, 'discovery.scan_completed', { ...record, gaps: o.gaps, discovery: o.discoveryScan });
      }
    }
    const discovery = o.discoveryScan;
    const pending = discovery && (discovery.signal.omitted || discovery.structural.templatesTruncated || discovery.structural.collectionsTruncated || discovery.structural.rowWindowsTruncated || discovery.controls.discovered > discovery.controls.collected);
    const key = pending ? hash({ documentId: o.documentId, url: o.url, topologyKey: discovery.topologyKey, signal: discovery.signal, structural: discovery.structural, controls: discovery.controls, supplement: discovery.supplement }) : null;
    const requestId = `discovery-request:${o.sessionId}`;
    if (this.store.get<{ key: string | null }>('discovery-request', requestId)?.key === key) return;
    this.store.put('discovery-request', { id: requestId, sessionId: o.sessionId, key });
    if (key) this.emit(o.sessionId, 'discovery.scan_requested', { observationId: o.id, discovery });
  }
}
