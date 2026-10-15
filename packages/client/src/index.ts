import type { InspectionOptionsInput, InspectionResult, CaptureProfile, inspectionCapabilities, validateCaptureProfile } from '@interaction/browser';
import type { BrowserComponent, ComponentDetails, ComponentDescription, ComponentDescriptionInput } from '@interaction/browser';
import type { BrowserDiffDetails, Command, ActionCandidate, ActionAttempt, Checkpoint, EngineEvent, FrontierItemView, BrowserFrontierCoverageGroup, Graph, Observation, Session, SessionOptions } from '@interaction/browser';
import type { ObservationDetails, ControlDetails, RegionDetails, DomResult, DomQuery, EventContext, ArtifactKind, EvidenceOptions, EvidenceRetentionPolicy, SubscriptionOptions, BrowserEngine, evidenceCapabilities } from '@interaction/browser';
export * from './identity-review.js';
export class InteractionClient {
  constructor(public baseUrl = 'http://127.0.0.1:4173') {}
  async request<T>(path: string, body?: unknown): Promise<T> {
    const response = await fetch(`${this.baseUrl}/v1${path}`, { method: body === undefined ? 'GET' : 'POST', headers: body === undefined ? {} : { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    const result = await response.json();
    if (!response.ok) throw Object.assign(new Error(result.error?.message || response.statusText), result.error || {}); return result as T;
  }
  sessions() { return this.request<Session[]>('/sessions'); }
  evidenceCapabilities() { return this.request<typeof evidenceCapabilities>('/capabilities/evidence'); }
  createSession(options: Pick<SessionOptions, 'url'> & Partial<Omit<SessionOptions, 'evidence' | 'evidenceRetention' | 'inspection'>> & { inspection?: InspectionOptionsInput; evidence?: Partial<EvidenceOptions>; evidenceRetention?: Pick<EvidenceRetentionPolicy, 'mode'> & Partial<EvidenceRetentionPolicy> }) { return this.request<Session>('/sessions', options); }
  inspectionCapabilities() { return this.request<typeof inspectionCapabilities>('/capabilities/inspection'); }
  validateCaptureProfile(profile: Partial<CaptureProfile> = {}) { return this.request<ReturnType<typeof validateCaptureProfile>>('/capabilities/inspection/validate', profile); }
  listInspections(id: string, query: { after?: number; limit?: number } = {}) { return this.request<ReturnType<BrowserEngine['listInspections']>>(`/sessions/${encodeURIComponent(id)}/inspections?${new URLSearchParams(Object.entries(query).map(([k, v]) => [k, String(v)]))}`); }
  inspection(id: string, inspectionId: string) { return this.request<Awaited<ReturnType<BrowserEngine['inspection']>>>(`/sessions/${encodeURIComponent(id)}/inspections/${encodeURIComponent(inspectionId)}`); }
  captureDetails(id: string, captureId: string) { return this.request<Awaited<ReturnType<BrowserEngine['captureDetails']>>>(`/sessions/${encodeURIComponent(id)}/captures/${encodeURIComponent(captureId)}`); }
  captureNodes(id: string, captureId: string, query: DomQuery = {}) { return this.request<Awaited<ReturnType<BrowserEngine['captureNodes']>>>(`/sessions/${encodeURIComponent(id)}/captures/${encodeURIComponent(captureId)}/nodes?${new URLSearchParams(Object.entries(query).map(([k, v]) => [k, String(v)]))}`); }
  nodeContext(id: string, captureId: string, nodeId: string) { return this.request<Awaited<ReturnType<BrowserEngine['nodeContext']>>>(`/sessions/${encodeURIComponent(id)}/captures/${encodeURIComponent(captureId)}/nodes/${encodeURIComponent(nodeId)}/context`); }
  regionContext(id: string, captureId: string, key: string) { return this.request<Awaited<ReturnType<BrowserEngine['regionContext']>>>(`/sessions/${encodeURIComponent(id)}/captures/${encodeURIComponent(captureId)}/region?${new URLSearchParams({ key })}`); }
  receiveInspection(id: string, inspectionId: string, consumerId: string) { return this.request<Awaited<ReturnType<BrowserEngine['receiveInspection']>>>(`/sessions/${encodeURIComponent(id)}/inspections/${encodeURIComponent(inspectionId)}/receive`, { consumerId }); }
  renewInspection(id: string, inspectionId: string, consumerId: string) { return this.request<Awaited<ReturnType<BrowserEngine['renewInspection']>>>(`/sessions/${encodeURIComponent(id)}/inspections/${encodeURIComponent(inspectionId)}/renew`, { consumerId }); }
  cancelInspection(id: string, inspectionId: string, consumerId: string) { return this.request<Awaited<ReturnType<BrowserEngine['cancelInspection']>>>(`/sessions/${encodeURIComponent(id)}/inspections/${encodeURIComponent(inspectionId)}/cancel`, { consumerId }); }
  completeInspection(id: string, inspectionId: string, consumerId: string, results: InspectionResult[] = []) { return this.request<Awaited<ReturnType<BrowserEngine['completeInspection']>>>(`/sessions/${encodeURIComponent(id)}/inspections/${encodeURIComponent(inspectionId)}/complete`, { consumerId, results }); }
  session(id: string) { return this.request<Session>(`/sessions/${id}`); }
  report(id: string) { return this.request<ReturnType<BrowserEngine['report']>>(`/sessions/${id}/report`); }
  observe(id: string) { return this.command<Observation>(id, { type: 'observe' }); }
  observation(id: string, observationId?: string) { return this.request<Observation>(`/sessions/${id}/observation${observationId ? `?id=${observationId}` : ''}`); }
  actions(id: string) { return this.request<ActionCandidate[]>(`/sessions/${id}/actions`); }
  observationDetails(id: string, observationId: string) { return this.request<ObservationDetails>(`/sessions/${encodeURIComponent(id)}/observations/${encodeURIComponent(observationId)}/details`); }
  controlDetails(id: string, observationId: string, controlId: string) { return this.request<ControlDetails>(`/sessions/${encodeURIComponent(id)}/observations/${encodeURIComponent(observationId)}/controls/${encodeURIComponent(controlId)}`); }
  components(id: string, observationId: string) { return this.request<{ observationId: string; components: BrowserComponent[]; descriptions: ComponentDescription[] }>(`/sessions/${encodeURIComponent(id)}/observations/${encodeURIComponent(observationId)}/components`); }
  componentDetails(id: string, observationId: string, componentId: string) { return this.request<ComponentDetails>(`/sessions/${encodeURIComponent(id)}/observations/${encodeURIComponent(observationId)}/components/${encodeURIComponent(componentId)}`); }
  describeComponent(id: string, description: ComponentDescriptionInput) { return this.command<ComponentDescription>(id, { ...description, type: 'describeComponent' }); }
  probe(id: string, observationId: string, localId: string, kind: 'hover' | 'focus', requestId: string) { return this.command<ActionAttempt>(id, { type: 'probe', observationId, localId, kind, requestId }); }
  regionDetails(id: string, observationId: string, key: string) { return this.request<RegionDetails>(`/sessions/${encodeURIComponent(id)}/observations/${encodeURIComponent(observationId)}/region?${new URLSearchParams({ key })}`); }
  dom(id: string, observationId: string, query: DomQuery = {}) { return this.request<DomResult>(`/sessions/${encodeURIComponent(id)}/observations/${encodeURIComponent(observationId)}/dom?${new URLSearchParams(Object.entries(query).map(([k, v]) => [k, String(v)]))}`); }
  eventContext(id: string, sequence: number) { return this.request<EventContext>(`/sessions/${encodeURIComponent(id)}/events/${sequence}/context`); }
  evidenceStats(id: string) { return this.request<Awaited<ReturnType<BrowserEngine['evidenceStats']>>>(`/sessions/${encodeURIComponent(id)}/evidence-retention`); }
  pinEvidence(id: string, observationId: string, owner: string) { return this.request(`/sessions/${encodeURIComponent(id)}/observations/${encodeURIComponent(observationId)}/evidence-retention`, { action: 'pin', owner }); }
  unpinEvidence(id: string, owner: string) { return this.request(`/sessions/${encodeURIComponent(id)}/evidence-retention/unpin`, { owner }); }
  releaseEvidence(id: string, observationId: string) { return this.request(`/sessions/${encodeURIComponent(id)}/observations/${encodeURIComponent(observationId)}/evidence-retention`, { action: 'release' }); }
  releaseCheckpointEvidence(id: string, checkpointId: string) { return this.request(`/sessions/${encodeURIComponent(id)}/checkpoints/${encodeURIComponent(checkpointId)}/release-evidence`, {}); }
  async captureArtifact(id: string, captureId: string, kind: ArtifactKind = 'screenshot') {
    const response = await fetch(`${this.baseUrl}/v1/sessions/${encodeURIComponent(id)}/captures/${encodeURIComponent(captureId)}/artifacts/${encodeURIComponent(kind)}`);
    if (!response.ok) { const result = await response.json(); throw Object.assign(new Error(result.error?.message || response.statusText), result.error || {}); }
    return { mediaType: response.headers.get('content-type') || 'application/octet-stream', data: new Uint8Array(await response.arrayBuffer()) };
  }
  async evidenceArtifact(id: string, observationId: string, kind: ArtifactKind = 'screenshot') {
    const response = await fetch(`${this.baseUrl}/v1/sessions/${encodeURIComponent(id)}/observations/${encodeURIComponent(observationId)}/artifacts/${encodeURIComponent(kind)}`);
    if (!response.ok) { const result = await response.json(); throw Object.assign(new Error(result.error?.message || response.statusText), result.error || {}); }
    return { mediaType: response.headers.get('content-type') || 'application/octet-stream', data: new Uint8Array(await response.arrayBuffer()) };
  }
  graph(id: string) { return this.request<Graph>(`/sessions/${id}/graph`); }
  diffDetails(id: string, beforeId: string, afterId: string, region?: string) {
    const query = new URLSearchParams({ before: beforeId, after: afterId }); if (region !== undefined) query.set('region', region);
    return this.request<BrowserDiffDetails>(`/sessions/${encodeURIComponent(id)}/compare/details?${query}`);
  }
  attemptDiffDetails(id: string, attemptId: string) { return this.request<BrowserDiffDetails>(`/sessions/${encodeURIComponent(id)}/attempts/${encodeURIComponent(attemptId)}/diff/details`); }
  eventDiffDetails(id: string, sequence: number) { return this.request<BrowserDiffDetails>(`/sessions/${encodeURIComponent(id)}/events/${sequence}/diff/details`); }
  scopeDiffDetails(id: string, scopeId: string) { return this.request<BrowserDiffDetails>(`/sessions/${encodeURIComponent(id)}/scopes/${encodeURIComponent(scopeId)}/diff/details`); }
  frontier(id: string, options: { offset?: number; limit?: number; status?: string } = {}) { return this.list<FrontierItemView>(id, 'frontier', options); }
  frontierCoverage(id: string) { return this.request<BrowserFrontierCoverageGroup[]>(`/sessions/${encodeURIComponent(id)}/frontier-coverage`); }
  list<T>(id: string, resource: string, options: { offset?: number; limit?: number; status?: string } = {}) { return this.request<{ items: T[]; total: number }>(`/sessions/${id}/${resource}?${new URLSearchParams(Object.entries(options).map(([k, v]) => [k, String(v)]))}`); }
  execute(id: string, actionId: string, requestId: string, value?: Extract<Command, { type: 'execute' }>['value']) { return this.command<ActionAttempt>(id, { type: 'execute', actionId, requestId, value }); }
  checkpoint(id: string, name: string, retainEvidence = false) { return this.command<Checkpoint>(id, { type: 'createCheckpoint', name, predicates: [], acceptable: [], retainEvidence }); }
  command<T = unknown>(id: string, command: Command) { return this.request<T>(`/sessions/${id}/commands`, command); }
  async *events(id: string, after = 0, signal?: AbortSignal, options: Pick<SubscriptionOptions, 'delivery' | 'maxSnapshotBytes'> = {}): AsyncGenerator<EngineEvent> {
    let cursor = after;
    while (!signal?.aborted) {
      let response: Response;
      try { response = await fetch(`${this.baseUrl}/v1/sessions/${id}/events?${new URLSearchParams({ after: String(cursor), delivery: options.delivery || 'reference', ...(options.maxSnapshotBytes === undefined ? {} : { maxSnapshotBytes: String(options.maxSnapshotBytes) }) })}`, { signal }); }
      catch (error) { if (signal?.aborted) return; await new Promise(r => setTimeout(r, 500)); continue; }
      if (!response.ok || !response.body) throw new Error(`Event stream failed: ${response.status}`);
      const reader = response.body.getReader(); const decoder = new TextDecoder(); let buffer = '';
      try {
        while (!signal?.aborted) {
          const { done, value } = await reader.read(); if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let end: number;
          while ((end = buffer.indexOf('\n\n')) >= 0) {
            const frame = buffer.slice(0, end); buffer = buffer.slice(end + 2);
            const data = frame.split('\n').find(line => line.startsWith('data: '));
            if (data && frame.split('\n').includes('event: gap')) throw Object.assign(new Error('Event subscription interrupted'), JSON.parse(data.slice(6)));
            if (data) { const event = JSON.parse(data.slice(6)) as EngineEvent; if (event.sequence > cursor) { cursor = event.sequence; yield event; } }
          }
        }
      } catch (error) { if (signal?.aborted) return; if ((error as { code?: string }).code === 'SUBSCRIPTION_GAP') throw error; }
      finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
      if (!signal?.aborted) await new Promise(r => setTimeout(r, 500));
    }
  }
}
