import { InspectionCoordinator, validateInspectionOptions } from './inspection.js';
import type { InspectionResult } from './inspection-types.js';
import { InteractionEngine as CoreEngine, EngineError, type Persistence, type Predicate, type InteractionScope, type Checkpoint } from '@interaction/core';
import { RetainedPersistence, type RetentionOptions } from '@interaction/storage-retained';
import { subscribeEvents, projectEvent, type SubscriptionOptions, type SnapshotEvent, type DeliveryMode } from './subscription.js';
import { PlaywrightAdapter, commandSchema, type Command, type Observation, type SessionOptions, type EngineHooks } from '@interaction/adapter-playwright';
import { scrollProbeSchema, type ScrollProbeOptions } from '@interaction/adapter-playwright';
import { explainBrowserDiff } from './diff-details.js';
export * from './diff-details.js';
import { BrowserEvidenceQueries, type DomQuery, type ArtifactKind } from './evidence.js';
import { withFrontierStates } from './frontier.js';
import { describeControlCoverage } from './control-coverage.js';
export * from './control-coverage.js';
export * from '@interaction/adapter-playwright';
export * from './evidence.js';
export * from './evidence-availability.js';
export * from './subscription.js';
export * from './frontier.js';
export * from './inspection-types.js';
export { inspectionResultSchema, completeInspectionSchema, inspectionConsumerSchema, inspectionPageSchema, validateInspectionOptions } from './inspection.js';
/** Browser composition only. The caller chooses persistence; there is no implicit disk storage. */
export class BrowserEngine extends CoreEngine<Observation, SessionOptions> {
  declare readonly store: RetainedPersistence;
  private readonly inspections: InspectionCoordinator;
  override async createSession(input: unknown) { return super.createSession(validateInspectionOptions(input)); }
  scrollProbe(sessionId: string, observationId: string, localId: string, options: ScrollProbeOptions, requestId: string) {
    return super.probe(sessionId, observationId, localId, 'scroll', requestId, scrollProbeSchema.parse(options));
  }
  protected override beforeCapture(sessionId: string, observationId: string) { return this.inspections.prepare(sessionId, observationId); }
  protected override afterCapture(observation: Observation, previous?: Observation, attemptId?: string) { return this.inspections.finish(observation, previous, attemptId); }
  protected override captureFailed(sessionId: string, observationId: string, error: unknown) { return this.inspections.failed(sessionId, observationId, error); }
  protected override beforeAction(sessionId: string) { return this.inspections.beforeAction(sessionId); }
  listInspections(sessionId: string, query: { after?: number; limit?: number } = {}) { return this.inspections.list(sessionId, query); }
  inspection(sessionId: string, inspectionId: string) { return this.inspections.inspection(sessionId, inspectionId); }
  captureDetails(sessionId: string, captureId: string) { return this.inspections.captureDetails(sessionId, captureId); }
  captureNodes(sessionId: string, captureId: string, query: DomQuery = {}) {
    const capture = this.inspections.capture(sessionId, captureId);
    if (!capture.observationId) throw new EngineError('EVIDENCE_UNAVAILABLE', 'This capture has no DOM observation');
    return this.dom(sessionId, capture.observationId, query);
  }
  nodeContext(sessionId: string, captureId: string, nodeId: string) { return this.inspections.nodeContext(sessionId, captureId, nodeId); }
  async regionContext(sessionId: string, captureId: string, regionKey: string) {
    const capture = this.inspections.capture(sessionId, captureId);
    if (!capture.observationId) throw new EngineError('EVIDENCE_UNAVAILABLE', 'This capture has no region observation');
    const region = await this.regionDetails(sessionId, capture.observationId, regionKey);
    const observation = this.observation(sessionId, capture.observationId);
    return { ...region, captureId, overlay: observation.overlays?.find(o => o.key === regionKey), page: (await this.observationDetails(sessionId, observation.id)).snapshot?.dom?.environment };
  }
  captureArtifact(sessionId: string, captureId: string, kind: ArtifactKind) {
    const capture = this.inspections.capture(sessionId, captureId);
    if (!capture.observationId) throw new EngineError('EVIDENCE_UNAVAILABLE', 'This capture has no observation artifacts');
    return this.evidenceArtifact(sessionId, capture.observationId, kind);
  }
  receiveInspection(sessionId: string, inspectionId: string, consumerId: string) { return this.inspections.receipt(sessionId, inspectionId, consumerId); }
  renewInspection(sessionId: string, inspectionId: string, consumerId: string) { return this.inspections.renew(sessionId, inspectionId, consumerId); }
  completeInspection(sessionId: string, inspectionId: string, consumerId: string, results: InspectionResult[] = []) { return this.inspections.complete(sessionId, inspectionId, consumerId, results); }
  cancelInspection(sessionId: string, inspectionId: string, consumerId: string) { return this.inspections.cancel(sessionId, inspectionId, consumerId); }
  private subscriptions = new Set<ReturnType<typeof subscribeEvents>>();
  private readonly evidenceQueries = new BrowserEvidenceQueries(this);
  override frontierCoverage(sessionId: string) { return withFrontierStates(super.frontierCoverage(sessionId), id => this.store.get<Observation>('observation', id)); }
  controlCoverage(sessionId: string) { return describeControlCoverage(this.list<Observation>(sessionId, 'observation'), this.list(sessionId, 'attempt')); }
  override report(sessionId: string) { return { ...super.report(sessionId), controlCoverage: this.controlCoverage(sessionId) }; }
  observationDetails(sessionId: string, observationId: string) { return this.evidenceQueries.details(sessionId, observationId); }
  controlDetails(sessionId: string, observationId: string, controlId: string) { return this.evidenceQueries.control(sessionId, observationId, controlId); }
  componentDetails(sessionId: string, observationId: string, componentId: string) { return this.evidenceQueries.component(sessionId, observationId, componentId); }
  regionDetails(sessionId: string, observationId: string, key: string) { return this.evidenceQueries.region(sessionId, observationId, key); }
  dom(sessionId: string, observationId: string, query: DomQuery = {}) { return this.evidenceQueries.dom(sessionId, observationId, query); }
  eventContext(sessionId: string, sequence: number) { return this.evidenceQueries.eventContext(sessionId, sequence); }
  evidenceArtifact(sessionId: string, observationId: string, kind: ArtifactKind) { return this.evidenceQueries.artifact(sessionId, observationId, kind); }
  evidenceStats(sessionId: string) { this.session(sessionId); return this.store.evidence.stats(sessionId); }
  async pinEvidence(sessionId: string, observationId: string, owner: string) {
    const o = this.observation(sessionId, observationId); const keys = Object.values(o.evidence?.artifacts || {}).map(a => a!.key);
    if (!keys.length) throw new EngineError('EVIDENCE_UNAVAILABLE', 'No artifacts were captured');
    await this.store.evidence.pin(keys, `caller:${sessionId}:${owner}`); return this.evidenceStats(sessionId);
  }
  async unpinEvidence(sessionId: string, owner: string) { this.session(sessionId); await this.store.evidence.unpin(`caller:${sessionId}:${owner}`); return this.evidenceStats(sessionId); }
  async releaseEvidence(sessionId: string, observationId: string) { this.observation(sessionId, observationId); await this.store.evidence.release(sessionId, observationId); return this.evidenceStats(sessionId); }
  async releaseCheckpointEvidence(sessionId: string, checkpointId: string) {
    const cp = this.list<Checkpoint>(sessionId, 'checkpoint').find(c => c.id === checkpointId); if (!cp) throw new EngineError('NOT_FOUND', 'Checkpoint not found');
    await this.store.evidence.unpin(`checkpoint:${cp.id}`); return this.evidenceStats(sessionId);
  }
  projectEvent(event: import('@interaction/core').EngineEvent, delivery: DeliveryMode = 'inline', maxBytes?: number) { return projectEvent(this, event, delivery, maxBytes); }
  subscribeEvents(sessionId: string, listener: (event: SnapshotEvent) => void | Promise<void>, options: SubscriptionOptions = {}) {
    this.session(sessionId); const subscription = subscribeEvents(this, sessionId, listener, options);
    this.subscriptions.add(subscription); void subscription.done.finally(() => this.subscriptions.delete(subscription)); return subscription;
  }
  override async close() { const subscriptions = [...this.subscriptions]; for (const s of subscriptions) s.close(); await Promise.all(subscriptions.map(s => s.done)); await this.inspections.close(); await super.close(); }
  constructor(options: { persistence: Persistence; hooks?: EngineHooks; retention?: RetentionOptions }) {
    // Migrate only the browser-specific legacy field; immutable observations stay intact.
    options.persistence.transaction(() => {
      for (const scope of options.persistence.list<InteractionScope & { overlayKeys?: string[] }>('scope')) {
        if (!scope.anchors) options.persistence.put('scope', { ...scope, anchors: scope.overlayKeys || [] });
      }
    });
    super({ persistence: options.persistence instanceof RetainedPersistence ? options.persistence : new RetainedPersistence(options.persistence, options.retention), adapter: new PlaywrightAdapter(options.hooks), hooks: options.hooks });
    this.inspections = new InspectionCoordinator(this, (sid, type, data) => this.publish(sid, type, data));
  }
  override async diffDetails(sessionId: string, beforeId: string, afterId: string, region?: string) { return explainBrowserDiff(await super.diffDetails(sessionId, beforeId, afterId, region), this.store.evidence); }
  override async attemptDiffDetails(sessionId: string, attemptId: string) { return explainBrowserDiff(await super.attemptDiffDetails(sessionId, attemptId), this.store.evidence); }
  override async eventDiffDetails(sessionId: string, sequence: number) { return explainBrowserDiff(await super.eventDiffDetails(sessionId, sequence), this.store.evidence); }
  override async scopeDiffDetails(sessionId: string, scopeId: string) { return explainBrowserDiff(await super.scopeDiffDetails(sessionId, scopeId), this.store.evidence); }
  async command(sessionId: string, input: unknown) {
    const command: Command = commandSchema.parse(input);
    switch (command.type) {
      case 'scrollProbe': return this.scrollProbe(sessionId, command.observationId, command.localId, command.options, command.requestId);
      case 'describeComponent': { const { type: _, ...description } = command; return this.describeComponent(sessionId, description); }
      case 'probe': return this.probe(sessionId, command.observationId, command.localId, command.kind, command.requestId);
      case 'observe': return this.observe(sessionId);
      case 'inspect': return this.inspect(sessionId, command.region);
      case 'execute': return this.execute(sessionId, command.actionId, command.requestId, command.value);
      case 'explore': case 'resume': return this.explore(sessionId);
      case 'pause': return this.pause(sessionId);
      case 'stop': return this.stop(sessionId);
      case 'resolveIdentity': return this.resolveIdentity(sessionId, command.hypothesisId, command.identityId, command.source, command.evidence, command.guard);
      case 'openScope': return this.openScope(sessionId, command.name, command.region);
      case 'closeScope': return this.closeScope(sessionId, command.scopeId);
      case 'createCheckpoint': {
        return this.createCheckpoint(sessionId, command.name, command.predicates as Predicate[], command.acceptable as Predicate[], o => {
          const keys = command.retainEvidence ? Object.values(o.evidence?.artifacts || {}).map(a => a!.key) : [];
          if (command.retainEvidence && !keys.length) throw new EngineError('EVIDENCE_UNAVAILABLE', 'No artifacts were captured for this checkpoint');
          return keys;
        });
      }
      case 'reachCheckpoint': return this.reachCheckpoint(sessionId, command.checkpointId);
    }
  }
}
export { BrowserEngine as InteractionEngine };
