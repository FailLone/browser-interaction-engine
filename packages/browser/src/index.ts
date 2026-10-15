import { BoundaryExits } from './boundary-exits.js';
import { continueScrollTraversal } from './scroll-traversal.js';
import { DiscoveryScans } from './discovery-scans.js';
import { RegionReviews } from './region-reviews.js';
import { ControlReviews } from './control-reviews.js';
import { ControlClassifications } from './control-classifications.js';
import { contextKey, type ExplorationGroup } from '@interaction/core';
import { PageExploration } from './page-exploration.js';
export type { PageExplorationState } from './page-exploration.js';
import { InspectionCoordinator, validateInspectionOptions } from './inspection.js';
import { PurposeReviews } from './purpose-reviews.js';
import type { ActionCandidate, ListPurposeReviewInput, RevokePurposeReviewInput } from '@interaction/adapter-playwright';
import type { InspectionResult } from './inspection-types.js';
import { InteractionEngine as CoreEngine, EngineError, type Persistence, type Predicate, type InteractionScope, type Checkpoint } from '@interaction/core';
import { RetainedPersistence, type RetentionOptions } from '@interaction/storage-retained';
import { subscribeEvents, projectEvent, type SubscriptionOptions, type SnapshotEvent, type DeliveryMode } from './subscription.js';
import { BrowserAdapter, supplementDiscoverySchema, reuseControlReviewsSchema, reuseRegionReviewsSchema, PlaywrightAdapter, commandSchema, regionReviewSchema, boundaryExitReviewSchema, type Command, type Observation, type SessionOptions, type EngineHooks } from '@interaction/adapter-playwright';
import { explainBrowserDiff } from './diff-details.js';
export * from './diff-details.js';
import { BrowserEvidenceQueries, type DomQuery, type ArtifactKind } from './evidence.js';
import { withFrontierStates } from './frontier.js';
import { describeControlCoverage } from './control-coverage.js';
import { auditBrowserCompletion } from './completion-audit.js';
export * from './control-coverage.js';
export * from './completion-audit.js';
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
  private readonly purposeReviews: PurposeReviews;
  private readonly pages: PageExploration;
  private readonly regions: RegionReviews;
  private readonly boundaryExits: BoundaryExits;
  private readonly boundaryExitHook?: EngineHooks['boundaryExitReview'];
  private readonly controls: ControlReviews;
  private readonly classifications: ControlClassifications;
  private readonly discoveryScans: DiscoveryScans;
  private readonly classificationHook?: EngineHooks['controlClassification'];
  private readonly controlHook?: EngineHooks['controlReview'];
  private readonly regionHook?: EngineHooks['regionReview'];
  protected override async reviewActions(actions: ActionCandidate[], o: Observation) {
    this.controls.reconcile(o);
    let reviewed=this.controls.apply(actions,o);
    this.classifications.reconcile(o, reviewed);
    if (this.classificationHook && this.classifications.request(o, reviewed, 'hook')) {
      const material = this.classifications.material(o, reviewed);
      const result = await this.hook(o.sessionId, 'controlClassification', () => this.classificationHook!(structuredClone(material), structuredClone({ session: this.session(o.sessionId), observation: o })));
      if (result.value !== undefined) {
        const valid = await this.hook(o.sessionId, 'controlClassification-preflight', async () => {
          if (await this.driver!.preflight(o, undefined, result.value!.classifications.map(c => c.localId)) !== 'valid') throw new EngineError('STALE_CONTROL_CLASSIFICATION', 'Classification facts changed');
          return true;
        });
        if (valid.value) await this.hook(o.sessionId, 'controlClassification-record', () => this.store.transaction(() => this.classifications.record(o, reviewed, result.value!)));
      }
    }
    if(this.controlHook&&this.controls.request(o,reviewed,'hook')){
      const material=this.controls.material(o,reviewed);
      const result=await this.hook(o.sessionId,'controlReview',()=>this.controlHook!(structuredClone(material),structuredClone({session:this.session(o.sessionId),observation:o})));
      if(result.value!==undefined){
        // Only commit after the bounded asynchronous preflight has returned.
        // A timed-out preflight must never write a late approval.
        const valid=await this.hook(o.sessionId,'controlReview-preflight',async()=>{
          if(!(this.driver instanceof BrowserAdapter) || await this.driver.preflight(o,undefined,result.value!.reviews.map(r=>r.localId),result.value!.reviews.filter(r=>r.reuse).map(r=>r.localId))!=='valid')throw new EngineError('STALE_CONTROL_REVIEW','Control facts changed while being reviewed');
          return true;
        });
        if(valid.value)await this.hook(o.sessionId,'controlReview-record',()=>this.store.transaction(()=>this.controls.record(o,result.value!)));
      }
      reviewed=this.controls.apply(actions,o);
    }
    this.boundaryExits.reconcile(o);
    if (this.boundaryExitHook && this.boundaryExits.request(o, reviewed, 'hook')) {
      const result = await this.hook(o.sessionId, 'boundaryExitReview', () => this.boundaryExitHook!(structuredClone(this.boundaryExits.material(o, reviewed)), structuredClone({ session: this.session(o.sessionId), observation: o })));
      if (result.value !== undefined) {
        const valid = await this.hook(o.sessionId, 'boundaryExitReview-preflight', async () => {
          await this.validateExitReview(o, result.value!); return true;
        });
        if (valid.value) await this.hook(o.sessionId, 'boundaryExitReview-record', () => this.store.transaction(() => this.boundaryExits.record(o, result.value!)));
      }
    }
    return this.boundaryExits.apply(reviewed, o);
  }
  boundaryExitMaterial(sid: string) { return this.boundaryExits.material(this.observation(sid), this.actions(sid)); }
  private async validateExitReview(o: Observation, input: import('@interaction/adapter-playwright').BoundaryExitReviewInput) {
    if (input.observationId !== o.id) throw new EngineError('STALE_BOUNDARY_EXIT_REVIEW', 'Review the latest observation');
    if (this.activeId !== o.sessionId || !(this.driver instanceof BrowserAdapter) || !this.driver.connected()) throw new EngineError('BROWSER_UNAVAILABLE', 'Observe this session before reviewing an exit');
    const record = this.boundaryExits.prepare(o, input);
    if (record.decision.mode === 'attempt' && await this.driver.preflight(o, this.boundaryExits.action(record, o)) !== 'valid') {
      throw new EngineError('STALE_BOUNDARY_EXIT_REVIEW', 'Outside target, boundary or preserved conditions changed');
    }
  }

  reviewBoundaryExit(sid: string, input: import('@interaction/adapter-playwright').BoundaryExitReviewInput) {
    const snapshot = structuredClone(input);
    return this.enqueueMeasured(sid, async () => {
      const parsed = boundaryExitReviewSchema.parse(snapshot), o = this.observation(sid);
      await this.validateExitReview(o, parsed);
      const record = this.store.transaction(() => this.boundaryExits.record(o, parsed));
      await this.capture(sid, 'inspection');
      return this.store.require<import('@interaction/adapter-playwright').BoundaryExitReviewRecord>('boundary-exit-review', record.id);
    });
  }
  discoveryScanMaterial(sid: string) { return this.discoveryScans.material(this.observation(sid)); }
  supplementDiscovery(sid: string, input: import('@interaction/adapter-playwright').SupplementDiscoveryInput) {
    return this.enqueueMeasured(sid, async () => {
      const parsed = supplementDiscoverySchema.parse(input), o = this.observation(sid);
      const record = this.discoveryScans.prepare(o, parsed);
      if (this.activeId !== sid || !(this.driver instanceof BrowserAdapter) || !this.driver.connected()) throw new EngineError('BROWSER_UNAVAILABLE', 'Observe this session before supplementing discovery');
      if (await this.driver.preflight(o) !== 'valid' || !await this.driver.validateDiscoveryScan(o)) {
        await this.capture(sid, 'inspection');
        throw new EngineError('STALE_DISCOVERY_SCAN', 'Document or discovery window changed; use the new observation');
      }
      this.store.transaction(() => this.discoveryScans.record(record));
      this.driver.setDiscoveryScan(record);
      try { await this.capture(sid, 'inspection'); }
      catch (error) { this.driver.invalidateDiscoveryScan('capture_failed'); this.discoveryScans.failed(record, error); throw error; }
      return this.store.require<import('@interaction/adapter-playwright').DiscoveryScanRecord>('discovery-scan', record.id);
    });
  }
  controlClassificationMaterial(sid: string) { return this.classifications.material(this.observation(sid), this.actions(sid)); }
  classifyControls(sid: string, input: import('@interaction/adapter-playwright').ClassifyControlsInput) {
    return this.enqueueMeasured(sid, async () => {
      const o = this.observation(sid);
      if (input.observationId !== o.id) throw new EngineError('STALE_CONTROL_CLASSIFICATION', 'Classify the latest observation');
      if (this.activeId !== sid || !this.driver?.connected()) throw new EngineError('BROWSER_UNAVAILABLE', 'Observe this session before classifying controls');
      if (await this.driver.preflight(o, undefined, input.classifications.map(c => c.localId)) !== 'valid') { await this.capture(sid, 'inspection'); throw new EngineError('STALE_CONTROL_CLASSIFICATION', 'Target facts changed; classify the new observation'); }
      const records = this.store.transaction(() => this.classifications.record(o, this.actions(sid), input));
      await this.capture(sid, 'inspection');
      return records.map(r => this.store.require<import('@interaction/adapter-playwright').ControlClassificationRecord>('control-classification', r.id));
    });
  }
  revokeControlClassification(sid: string, input: import('@interaction/adapter-playwright').RevokeControlClassificationInput) {
    return this.enqueueMeasured(sid, async () => {
      this.session(sid); const record = this.store.transaction(() => this.classifications.revoke(sid, input));
      if (this.activeId === sid && this.driver?.connected()) await this.capture(sid, 'inspection');
      return record;
    });
  }
  controlReviewMaterial(sid:string) { return this.controls.material(this.observation(sid),this.actions(sid)); }
  reviewControls(sid:string,input:import('@interaction/adapter-playwright').ControlReviewInput) {
    return this.enqueueMeasured(sid,async()=>{
      const o=this.observation(sid);
      if(input.observationId!==o.id)throw new EngineError('STALE_CONTROL_REVIEW','Review the latest observation');
      if(this.activeId!==sid||!(this.driver instanceof BrowserAdapter)||!this.driver.connected())throw new EngineError('BROWSER_UNAVAILABLE','Observe this session in a connected browser before reviewing controls');
      if(await this.driver.preflight(o,undefined,input.reviews.map(r=>r.localId),input.reviews.filter(r=>r.reuse).map(r=>r.localId))!=='valid'){await this.capture(sid,'inspection');throw new EngineError('STALE_CONTROL_REVIEW','Control facts changed; review the new observation');}
      const records=this.store.transaction(()=>this.controls.record(o,input));
      await this.capture(sid,'inspection');
      return records.map(r=>this.store.require<import('@interaction/adapter-playwright').ControlReviewRecord>('control-review',r.id));
    });
  }
  reuseControlReviews(sid:string,input:import('@interaction/adapter-playwright').ReuseControlReviewsInput) {
    const snapshot=structuredClone(input);
    return this.enqueueMeasured(sid,async()=>{
      const parsed=reuseControlReviewsSchema.parse(snapshot),o=this.observation(sid);
      if(parsed.observationId!==o.id)throw new EngineError('STALE_CONTROL_REVIEW','Read current reuse material before deciding');
      if(this.activeId!==sid||!(this.driver instanceof BrowserAdapter)||!this.driver.connected())throw new EngineError('BROWSER_UNAVAILABLE','Observe this session before reusing a judgment');
      const targets=parsed.reviews.map(r=>r.localId);
      if(await this.driver.preflight(o,undefined,targets,targets)!=='valid'){
        await this.capture(sid,'inspection');throw new EngineError('STALE_CONTROL_REVIEW','Reuse conditions changed; read fresh material');
      }
      const records=this.store.transaction(()=>this.controls.reuse(o,parsed));
      await this.capture(sid,'inspection');
      return records.map(r=>this.store.require<import('@interaction/adapter-playwright').ControlReviewRecord>('control-review',r.id));
    });
  }
  revokeControlReview(sid:string,input:import('@interaction/adapter-playwright').RevokeControlReviewInput) {
    return this.enqueueMeasured(sid,async()=>{this.session(sid);return this.store.transaction(()=>{
      const record=this.controls.revoke(sid,input);this.controls.retire(this.observation(sid),[]);return record;
    });});
  }
  protected override async explorationScopes(actions: ActionCandidate[], o: Observation) {
    const session = this.session(o.sessionId);
    if (session.options.regionExploration !== 'review') return this.pages.proposals(actions, o, session);
    this.regions.reconcile(o);
    if (this.regions.request(o, actions, session) && this.regionHook) {
      const material = this.regions.material(o, actions, session);
      const result = await this.hook(o.sessionId, 'regionReview', () => this.regionHook!(structuredClone(material), structuredClone({ session, observation: o })));
      if (result.value !== undefined) {
        const prepared=await this.hook(o.sessionId,'regionReview-preflight',async()=>{
          const input=regionReviewSchema.parse(result.value);
          const anchors=[...input.regions.filter(r=>r.reuse).flatMap(r=>r.candidateIds),...this.regions.activeReuseAnchors(o.sessionId)];
          // New opt-in evidence must still describe the live browser after the hook.
          if(anchors.length && (!(this.driver instanceof BrowserAdapter) || await this.driver.preflight(o,undefined,[],[],anchors)!=='valid')) throw new EngineError('STALE_REGION_REVIEW','Reusable region facts changed');
          return input;
        });
        if(prepared.value) await this.hook(o.sessionId, 'regionReview-record', () => this.store.transaction(() => this.regions.record(o, actions, session, prepared.value!)));
      }
    }
    return [...this.pages.proposals(actions, o, session), ...this.regions.proposals(o, actions)];
  }
  protected override afterExplorationDecisions(sid: string) { this.regions.gate(this.observation(sid), this.session(sid)); }
  regionReviewMaterial(sid: string) { return this.regions.material(this.observation(sid), this.actions(sid), this.session(sid)); }
  reviewRegions(sid: string, input: import('@interaction/adapter-playwright').RegionReviewInput) {
    const snapshot = structuredClone(input);
    return this.enqueueMeasured(sid, async () => {
      const review = regionReviewSchema.parse(snapshot);
      const o = this.observation(sid);
      if (review.observationId !== o.id) throw new EngineError('STALE_REGION_REVIEW', 'Review the latest complete observation');
      if (this.activeId !== sid || !this.driver?.connected()) throw new EngineError('BROWSER_UNAVAILABLE', 'Observe this session in a connected browser before reviewing regions');
      const anchors = [...review.regions.flatMap(r => r.candidateIds), ...(review.rejectedCandidateIds || [])];
      const candidates = new Map((o.regionCandidates || []).map(c => [c.id, c]));
      const targets = [...new Set(anchors.flatMap(id => candidates.get(id)?.controlIds || []))];
      const active = o.overlays?.at(-1), activeIds = new Set([...(active?.controlIds || []), ...(active?.exitControlIds || [])]);
      // Only a partition wholly inside the observed active boundary can use its
      // local readiness. A mixed ancestor, page traversal or unknown anchor keeps
      // the whole-page check, even when an individual region selects fewer members.
      const scopedTargets = !review.update && active?.key === o.boundaries?.at(-1)?.key && targets.length > 0
        && anchors.every(id => candidates.has(id)) && targets.every(id => activeIds.has(id)) && !review.regions.some(r => r.pageTraversal) ? targets : undefined;
      if (!(this.driver instanceof BrowserAdapter) || await this.driver.preflight(o, undefined, scopedTargets, [], [...review.regions.filter(r=>r.reuse).flatMap(r=>r.candidateIds),...this.regions.activeReuseAnchors(sid)]) !== 'valid') { await this.capture(sid, 'inspection'); throw new EngineError('STALE_REGION_REVIEW', 'Region facts changed; review the new observation'); }
      const record = this.store.transaction(() => this.regions.record(o, this.actions(sid), this.session(sid), review));
      await this.capture(sid, 'inspection');
      return this.store.require<import('@interaction/adapter-playwright').RegionReviewRecord>('region-review', record.id);
    });
  }
  reuseRegionReviews(sid:string,input:import('@interaction/adapter-playwright').ReuseRegionReviewsInput) {
    const snapshot=structuredClone(input);
    return this.enqueueMeasured(sid,async()=>{
      const parsed=reuseRegionReviewsSchema.parse(snapshot),o=this.observation(sid),session=this.session(sid);
      const plan=this.regions.reusePlan(o,this.actions(sid),session,parsed);
      if(this.activeId!==sid || !(this.driver instanceof BrowserAdapter) || !this.driver.connected()) throw new EngineError('BROWSER_UNAVAILABLE','Observe this session in a connected browser before reusing regions');
      if(await this.driver.preflight(o,undefined,[],[],[...plan.matches.flatMap(c=>c.candidateIds),...this.regions.activeReuseAnchors(sid)])!=='valid') {
        await this.capture(sid,'inspection');throw new EngineError('STALE_REGION_REVIEW','Region reuse facts changed; read fresh material');
      }
      const record=this.store.transaction(()=>this.regions.acceptReuse(o,this.actions(sid),session,parsed));
      await this.capture(sid,'inspection');return this.store.require<import('@interaction/adapter-playwright').RegionReviewRecord>('region-review',record.id);
    });
  }
  revokeRegionReuse(sid:string,input:import('@interaction/adapter-playwright').RevokeRegionReuseInput) {
    const snapshot=structuredClone(input);
    return this.enqueueMeasured(sid,async()=>this.store.transaction(()=>{
      const record=this.regions.revokeReuse(this.observation(sid),snapshot);this.regions.gate(this.observation(sid),this.session(sid));return record;
    }));
  }
  protected override preflightAction(action:ActionCandidate,o:Observation,purpose:import('@interaction/core').ActionAttempt['purpose']) {
    if(this.driver instanceof BrowserAdapter && purpose!=='external' && action.boundary?.intent!=='exit' && action.kind!=='history') {
      return this.driver.preflight(o,action,[],[],this.regions.reuseAnchors(o,action));
    }
    return super.preflightAction(action,o,purpose);
  }
  protected override explorationCandidates(items: import('@interaction/core').FrontierItem[], o: Observation) {
    const session = this.session(o.sessionId);
    const eligible = this.pages.candidates(items, o, session);
    return session.options.exploration === 'controls'
      ? continueScrollTraversal(eligible, o, this.list(o.sessionId, 'attempt'), id => this.store.get<Observation>('observation', id))
      : eligible;
  }
  protected override explorationIdleReason(sid: string) { return this.pages.idleReason(sid, this.session(sid)) || this.regions.idleReason(sid, this.outstandingFrontier(sid)); }
  protected override async runAction(sid: string, actionId: string, requestId: string, value?: ActionCandidate['value'], purpose: import('@interaction/core').ActionAttempt['purpose'] = 'external') {
    if (purpose !== 'external' && this.boundaryExits.blockingResult(sid)) throw new EngineError('BOUNDARY_EXIT_UNVERIFIED', 'Review the changed or unverified exit before automated recovery');
    const attempt = await super.runAction(sid, actionId, requestId, value, purpose);
    this.boundaryExits.finishUnknown(attempt, this.driver instanceof BrowserAdapter ? this.driver.dismissalDispatch(attempt.action.id) : undefined);
    return attempt;
  }
  protected override async beforeExplorationStep(sid: string): Promise<'continue' | 'changed' | 'paused'> {
    const exitFailure = this.boundaryExits.blockingResult(sid);
    if (exitFailure) {
      const session = this.session(sid); session.status = 'paused'; session.stopReason = 'BOUNDARY_EXIT_UNVERIFIED'; this.store.put('session', session);
      this.publish(sid, 'exploration.paused', { reason: session.stopReason, resultId: exitFailure.id });
      return 'paused';
    }
    const o = this.observation(sid);
    this.regions.gate(o, this.session(sid));
    if (!this.pages.shouldReturn(o, this.session(sid), () => this.getFrontier(sid))) return 'continue';
    // Existing boundary scheduling can execute only current exits: page members remain gated.
    if (o.boundaries?.length) return 'continue';
    const state = this.pages.state(sid);
    const targetId = state?.frames.at(-1)?.sourceObservationId;
    const target = targetId ? this.observation(sid, targetId) : undefined;
    let navigationTarget = target;
    let action = target && this.observationReturn(sid, target);
    // An SPA can replace the most recent source entry while an older observed
    // GET entry for that page still exists. Page scheduling verifies location and
    // declared context, not the old checkpoint's full state. Keep this fallback
    // out of strict checkpoint restoration and retain the actual navigation proof.
    if (!action && target && !target.gaps.some(g => g.critical)) {
      for (const prior of this.list<Observation>(sid, 'observation').toReversed()) {
        if (prior.id === target.id || prior.url !== target.url || contextKey(prior.context) !== contextKey(target.context)) continue;
        const candidate = this.observationReturn(sid, prior);
        if (candidate) { action = candidate; navigationTarget = prior; break; }
      }
    }
    const blocked = (reason: string, attemptId?: string, afterId?: string) => {
      const latest = this.pages.state(sid);
      if (latest) {
        latest.lastReturn = { fromId: o.id, targetId: targetId || '', navigationTargetId: navigationTarget?.id, afterId, attemptId, status: 'blocked', reason };
        this.store.put('page-exploration', latest);
      }
      const session = this.session(sid); session.status = 'paused'; session.stopReason = 'PAGE_RETURN_BLOCKED'; this.store.put('session', session);
      this.publish(sid, 'exploration.page_return_blocked', { fromId: o.id, targetId, attemptId, afterId, reason });
      this.publish(sid, 'exploration.paused', { reason: 'PAGE_RETURN_BLOCKED', observationId: this.observation(sid).id });
      return 'paused' as const;
    };
    if (!action || !target) return blocked('No verified return path to the source page; page exploration remains unapproved');
    this.store.put('action', action);
    // Normal preflight, inspection, budgets and the action ledger apply to the return.
    const attempt = await this.runAction(sid, action.id, crypto.randomUUID(), undefined, 'recovery');
    const after = this.observation(sid);
    if (attempt.status !== 'succeeded' || after.gaps.some(g => g.critical) || after.url !== target.url
      || contextKey(after.context) !== contextKey(target.context)) return blocked('Source page location/context could not be verified', attempt.id, after.id);
    const updated = this.pages.state(sid)!;
    updated.lastReturn = { fromId: o.id, targetId: target.id, navigationTargetId: navigationTarget?.id, afterId: after.id, attemptId: attempt.id, status: 'returned' };
    this.store.put('page-exploration', updated);
    this.publish(sid, 'exploration.page_returned', { ...updated.lastReturn, stateRestored: false });
    return 'changed';
  }
  protected override prepareActions(actions: ActionCandidate[], observation: Observation) {
    const reviewed = this.purposeReviews.apply(actions, observation);
    this.classifications.reconcile(observation, reviewed);
    return this.classifications.apply(reviewed, observation);
  }
  protected override validatePreparedAction(action: ActionCandidate, observation: Observation, purpose:import('@interaction/core').ActionAttempt['purpose']) { this.boundaryExits.validate(action, observation); this.classifications.validate(action, observation); this.controls.validate(action, observation); this.purposeReviews.validate(action, observation); if(purpose!=='external') this.regions.validateAction(observation,action,this.session(observation.sessionId)); }
  purposeReviewMaterial(sessionId: string, groupId: string) { return this.purposeReviews.material(this.observation(sessionId), this.actions(sessionId), groupId); }
  reviewListPurpose(sessionId: string, review: ListPurposeReviewInput) {
    return this.enqueueMeasured(sessionId, async () => this.store.transaction(() => this.purposeReviews.record(this.observation(sessionId), this.actions(sessionId), review)));
  }
  revokePurposeReview(sessionId: string, revocation: RevokePurposeReviewInput) {
    return this.enqueueMeasured(sessionId, async () => { this.session(sessionId); return this.store.transaction(() => this.purposeReviews.revoke(sessionId, revocation)); });
  }
  override async createSession(input: unknown) { return super.createSession(validateInspectionOptions(input)); }
  protected override beforeCapture(sessionId: string, observationId: string) { return this.inspections.prepare(sessionId, observationId); }
  protected override afterCapture(observation: Observation, previous?: Observation, attemptId?: string) {
    const attempt = attemptId ? this.store.get<import('@interaction/core').ActionAttempt>('attempt', attemptId) : undefined;
    this.boundaryExits.finish(observation, previous, attemptId, attempt && this.driver instanceof BrowserAdapter ? this.driver.dismissalDispatch(attempt.action.id) : undefined);
    this.boundaryExits.request(observation, this.actions(observation.sessionId), 'event');
    this.discoveryScans.reconcile(observation);
    this.pages.reconcile(observation, previous, this.session(observation.sessionId));
    this.purposeReviews.reconcile(observation, this.actions(observation.sessionId));
    this.controls.retire(observation,this.actions(observation.sessionId));
    this.classifications.retire(observation);
    this.classifications.request(observation, this.actions(observation.sessionId));
    // Publish only when the observation and final caller policy are queryable.
    this.controls.request(observation,this.actions(observation.sessionId));
    return this.inspections.finish(observation, previous, attemptId);
  }
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
  controlCoverage(sessionId: string) { return describeControlCoverage(this.list<Observation>(sessionId, 'observation'), this.list(sessionId, 'attempt'), this.list(sessionId, 'action'), this.classifications.records(sessionId), this.list(sessionId, 'hypothesis')); }
  override report(sessionId: string) {
    const report = super.report(sessionId), controlCoverage = this.controlCoverage(sessionId);
    return { ...report, discoveryScans: this.discoveryScans.records(sessionId), pageExploration: this.pages.state(sessionId), controlCoverage,
      completionAudit: auditBrowserCompletion(report.explorationAudit, controlCoverage, this.list<Observation>(sessionId, 'observation'), report.session.currentObservationId, this.list<ExplorationGroup>(sessionId, 'exploration-group'), this.classifications.records(sessionId)) };
  }
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
    this.boundaryExits = new BoundaryExits(this.store, (sid, type, data) => this.publish(sid, type, data));
    this.boundaryExitHook = options.hooks?.boundaryExitReview;
    this.discoveryScans = new DiscoveryScans(this.store, (sid, type, data) => this.publish(sid, type, data));
    this.pages = new PageExploration(this.store);
    this.regions = new RegionReviews(this.store, (sid, type, data) => this.publish(sid, type, data));
    this.classifications = new ControlClassifications(this.store, (sid,type,data)=>this.publish(sid,type,data));
    this.controls = new ControlReviews(this.store,(sid,type,data)=>this.publish(sid,type,data), (c,o)=>!!this.classifications.negative(c,o));
    this.classificationHook = options.hooks?.controlClassification;
    this.controlHook = options.hooks?.controlReview;
    this.regionHook = options.hooks?.regionReview;
    this.inspections = new InspectionCoordinator(this, (sid, type, data) => this.publish(sid, type, data));
    this.purposeReviews = new PurposeReviews(this.store, (sid, type, data) => this.publish(sid, type, data));
  }
  override async diffDetails(sessionId: string, beforeId: string, afterId: string, region?: string) { return explainBrowserDiff(await super.diffDetails(sessionId, beforeId, afterId, region), this.store.evidence); }
  override async attemptDiffDetails(sessionId: string, attemptId: string) { return explainBrowserDiff(await super.attemptDiffDetails(sessionId, attemptId), this.store.evidence); }
  override async eventDiffDetails(sessionId: string, sequence: number) { return explainBrowserDiff(await super.eventDiffDetails(sessionId, sequence), this.store.evidence); }
  override async scopeDiffDetails(sessionId: string, scopeId: string) { return explainBrowserDiff(await super.scopeDiffDetails(sessionId, scopeId), this.store.evidence); }
  async command(sessionId: string, input: unknown) {
    const command: Command = commandSchema.parse(input);
    switch (command.type) {
      case 'supplementDiscovery': return this.supplementDiscovery(sessionId, command.scan);
      case 'classifyControls': return this.classifyControls(sessionId, command.classification);
      case 'revokeControlClassification': return this.revokeControlClassification(sessionId, command.revocation);
      case 'reviewControls': return this.reviewControls(sessionId,command.review);
      case 'reuseControlReviews': return this.reuseControlReviews(sessionId,command.review);
      case 'revokeControlReview': return this.revokeControlReview(sessionId,command.revocation);
      case 'reviewBoundaryExit': return this.reviewBoundaryExit(sessionId, command.review);
      case 'reviewRegions': return this.reviewRegions(sessionId, command.review);
      case 'reuseRegionReviews': return this.reuseRegionReviews(sessionId, command.review);
      case 'revokeRegionReuse': return this.revokeRegionReuse(sessionId, command.revocation);
      case 'describeComponent': { const { type: _, ...description } = command; return this.describeComponent(sessionId, description); }
      case 'probe': return this.probe(sessionId, command.observationId, command.localId, command.kind, command.requestId);
      case 'observe': return this.observe(sessionId);
      case 'inspect': return this.inspect(sessionId, command.region);
      case 'execute': return this.execute(sessionId, command.actionId, command.requestId, command.value);
      case 'explore': case 'resume': return this.explore(sessionId);
      case 'pause': return this.pause(sessionId);
      case 'stop': return this.stop(sessionId);
      case 'resolveIdentity': return this.resolveIdentity(sessionId, command.hypothesisId, command.identityId, command.source, command.evidence, command.guard);
      case 'decideExplorationGroups': return this.decideExplorationGroups(sessionId, command.resolutions);
      case 'decideExplorationGroup': return this.decideExplorationGroup(sessionId, command.groupId, command.revision, command.decision);
      case 'reviewListPurpose': return this.reviewListPurpose(sessionId, command.review);
      case 'revokePurposeReview': return this.revokePurposeReview(sessionId, command.revocation);
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
