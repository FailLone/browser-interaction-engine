import { EngineError, hash, type ActionCandidate, type ControlIdentity, type EngineEvent, type Gap, type IdentityHypothesis, type Persistence } from '@interaction/core';
import { artifactKindSchema, domQuerySchema, evidenceCapabilities, type DetailSnapshot, type DomNodeEvidence, type Observation } from '@interaction/adapter-playwright';

interface Reader {
  store: Persistence;
  observation(sessionId: string, observationId: string): Observation;
  actions(sessionId: string, observationId: string): ActionCandidate[];
}
export interface DomQuery { rootId?: string; depth?: number; offset?: number; limit?: number }
export type ArtifactKind = 'screenshot' | 'fullPageScreenshot' | 'details';
/** All methods read committed records. They never consult a browser or latest state. */
export class BrowserEvidenceQueries {
  constructor(private reader: Reader) {}
  private observation(sessionId: string, observationId: string) {
    if (typeof observationId !== 'string' || !observationId) throw new EngineError('INVALID_QUERY', 'An explicit observationId is required');
    return this.reader.observation(sessionId, observationId);
  }
  async artifact(sessionId: string, observationId: string, kind: ArtifactKind) {
    artifactKindSchema.parse(kind);
    const observation = this.observation(sessionId, observationId);
    const reference = observation.evidence?.artifacts[kind];
    const key = reference?.key || (kind === 'screenshot' ? observation.screenshot : undefined);
    if (!key) throw new EngineError('EVIDENCE_UNAVAILABLE', `${kind} was not captured for this observation`, { observationId });
    const evidence = await this.reader.store.evidence.get(key);
    if (!evidence) throw new EngineError('EVIDENCE_UNAVAILABLE', 'Referenced evidence is missing from the persistence plugin', { observationId, kind });
    return { ...evidence, reference };
  }
  async details(sessionId: string, observationId: string) {
    const observation = this.observation(sessionId, observationId);
    const gaps: Gap[] = [...observation.gaps, ...(observation.evidence?.gaps || [])];
    let snapshot: DetailSnapshot | undefined;
    if (observation.evidence?.artifacts.details) {
      try {
        const artifact = await this.artifact(sessionId, observationId, 'details');
        const json = new TextDecoder().decode(artifact.data);
        if (artifact.reference?.sha256 !== hash(json)) throw new Error('Detailed evidence integrity check failed');
        const parsed: DetailSnapshot = JSON.parse(json);
        if (parsed.schemaVersion !== 1 || parsed.observationId !== observationId || parsed.documentId !== observation.documentId) throw new Error('Detailed evidence does not match its observation');
        snapshot = parsed;
      } catch (error) { gaps.push({ code: 'DETAIL_EVIDENCE_UNAVAILABLE', message: String(error) }); }
    } else gaps.push({ code: observation.evidence?.status === 'disabled' ? 'DETAIL_CAPTURE_DISABLED' : 'DETAIL_NOT_CAPTURED', message: 'No historical detailed snapshot exists; request a new observation to collect current evidence' });
    return { schemaVersion: 1 as const, observation, actions: this.reader.actions(sessionId, observationId), snapshot, capabilities: evidenceCapabilities, gaps };
  }
  async dom(sessionId: string, observationId: string, input: DomQuery = {}) {
    const query = domQuerySchema.parse(input); const details = await this.details(sessionId, observationId); const dom = details.snapshot?.dom;
    if (!dom?.rootId) throw new EngineError('EVIDENCE_UNAVAILABLE', 'DOM tree is unavailable for this observation', { gaps: details.gaps });
    const byId = new Map(dom.nodes.map(node => [node.id, node])); const rootId = query.rootId || dom.rootId;
    if (!byId.has(rootId)) throw new EngineError('NOT_FOUND', 'Node is not present in the captured DOM tree', { rootId, gaps: dom.gaps });
    const nodes: DomNodeEvidence[] = []; const queue = [{ id: rootId, depth: 0 }]; let depthLimited = false;
    for (let i = 0; i < queue.length; i++) {
      const item = queue[i]; const node = byId.get(item.id); if (!node) continue;
      nodes.push(node);
      if (item.depth < query.depth) for (const child of node.children) queue.push({ id: child, depth: item.depth + 1 });
      else if (node.children.length) depthLimited = true;
    }
    const end = Math.min(nodes.length, query.offset + query.limit);
    return { observationId, capturedAt: dom.capturedAt, rootId, nodes: nodes.slice(query.offset, end), total: nodes.length, offset: query.offset, limit: query.limit, nextOffset: end < nodes.length ? end : null, depthLimited, captureTruncated: dom.nodesTruncated, gaps: dom.gaps };
  }
  async control(sessionId: string, observationId: string, controlId: string) {
    const details = await this.details(sessionId, observationId); const observation = details.observation;
    const matches = observation.controls.filter(c => c.identityId === controlId || c.localId === controlId);
    if (!matches.length) throw new EngineError('NOT_FOUND', 'Control is not present in this observation');
    if (matches.length > 1) throw new EngineError('TARGET_AMBIGUOUS', 'Use a localId to select an occurrence in this observation');
    const control = matches[0]; const dom = details.snapshot?.dom;
    const nodes = new Map(dom?.nodes.map(n => [n.id, n]) || []); const node = nodes.get(control.localId);
    const ancestors: DomNodeEvidence[] = []; let parent = node?.parentId;
    while (parent && nodes.has(parent)) { const n = nodes.get(parent)!; ancestors.push(n); parent = n.parentId; }
    const relations = Object.fromEntries(Object.entries(node?.relations || {}).map(([key, ids]) => [key, ids.map(id => ({ nodeId: id, node: nodes.get(id), content: this.content(nodes, id, details.snapshot!.limits.maxTextLength, !!dom?.nodesTruncated) }))]));
    const identity = control.identityId ? this.reader.store.get<ControlIdentity>('identity', control.identityId) : undefined;
    const hypothesis = control.hypothesisId ? this.reader.store.get<IdentityHypothesis>('hypothesis', control.hypothesisId) : undefined;
    const revisions = hypothesis?.revisions.filter(r => r.at <= observation.capturedAt) || [];
    return {
      observationId, capturedAt: observation.capturedAt, control, node, ancestors, relations,
      content: this.content(nodes, control.localId, details.snapshot?.limits.maxTextLength || 20000, !!dom?.nodesTruncated),
      actions: details.actions.filter(a => a.localId === control.localId),
      region: observation.regions.find(r => r.key === control.region), form: observation.regions.find(r => r.key === control.form),
      overlays: observation.overlays?.filter(o => o.controlIds.includes(control.localId)) || [], context: observation.context,
      identityEvidence: identity?.sessionId === sessionId ? identity.occurrences.filter(o => o.observationId === observationId && o.localId === control.localId) : [],
      hypothesis: hypothesis?.sessionId === sessionId ? { ...hypothesis, revisions, status: revisions.length ? 'resolved' as const : 'pending' as const } : undefined,
      screenshot: observation.evidence?.artifacts.screenshot || (observation.screenshot ? { key: observation.screenshot } : undefined), screenshotRegion: control.rect,
      businessIntent: { status: 'unknown' as const, evidence: ['control-semantics', 'captured-text', 'dom-relations', 'declared-and-extracted-context'], note: 'Facts are provided for caller interpretation; business intent is not inferred' },
      gaps: [...details.gaps, ...(node?.gaps || []), ...(!node ? [{ code: 'CONTROL_DOM_UNAVAILABLE', message: 'Control DOM evidence was not captured or was truncated' }] : [])],
    };
  }
  private content(nodes: Map<string, DomNodeEvidence>, rootId: string, limit: number, captureTruncated: boolean) {
    if (!nodes.has(rootId)) return { text: '', status: 'unavailable' as const, truncated: captureTruncated };
    let text = ''; const stack = [rootId]; let truncated = captureTruncated;
    while (stack.length && text.length < limit) {
      const node = nodes.get(stack.pop()!); if (!node) { truncated = true; continue; }
      if (node.nodeType === 'text') text += node.text || '';
      if (node.gaps.some(g => g.code === 'FIELD_TRUNCATED')) truncated = true;
      stack.push(...node.children.slice().reverse());
    }
    return { text: text.slice(0, limit), status: 'captured' as const, truncated: truncated || stack.length > 0 || text.length > limit };
  }
  async region(sessionId: string, observationId: string, key: string) {
    const details = await this.details(sessionId, observationId); const observation = details.observation;
    const region = observation.regions.find(r => r.key === key); if (!region) throw new EngineError('NOT_FOUND', 'Region is not present in this observation');
    const inside = (regionKey: string) => { const seen = new Set<string>(); while (regionKey && !seen.has(regionKey)) { if (key === 'document' || regionKey === key) return true; seen.add(regionKey); regionKey = observation.regions.find(r => r.key === regionKey)?.parentKey || ''; } return false; };
    const controls = observation.controls.filter(c => inside(c.region)); const rootId = details.snapshot?.dom?.regionRoots[key];
    return { observationId, capturedAt: observation.capturedAt, region, rootId, controls, actions: details.actions.filter(a => controls.some(c => c.localId === a.localId)), boundaries: observation.boundaries, context: observation.context, screenshot: observation.evidence?.artifacts.screenshot, screenshotRegion: region.rect, gaps: details.gaps };
  }
  async eventContext(sessionId: string, sequence: number) {
    if (!Number.isSafeInteger(sequence) || sequence < 1) throw new EngineError('INVALID_QUERY', 'Event sequence must be a positive safe integer');
    const event = this.reader.store.events(sessionId, sequence - 1, 1)[0];
    if (!event || event.sequence !== sequence) throw new EngineError('NOT_FOUND', 'Event does not belong to this session');
    const refs = observationReferences(event); const observations = [];
    const gaps: Gap[] = refs.length ? [] : [{ code: 'EVENT_HAS_NO_OBSERVATION_REFERENCE', message: 'This event has no historical observation reference; no latest-state substitution was made' }];
    for (const ref of refs) {
      try { observations.push({ ...ref, details: await this.details(sessionId, ref.observationId) }); }
      catch (error) { gaps.push({ code: 'EVENT_OBSERVATION_UNAVAILABLE', reference: ref.observationId, message: String(error) }); }
    }
    return { event, observations, gaps };
  }
}

/** Resolve only explicit historical references. Never infer from the current session. */
function observationReferences(event: EngineEvent) {
  const data = event.data as Record<string, any> | null; if (!data || typeof data !== 'object') return [];
  const refs: { observationId: string; relations: string[] }[] = [];
  const add = (value: unknown, relation: string) => { if (typeof value !== 'string' || !value) return; const ref = refs.find(r => r.observationId === value); if (ref) ref.relations.push(relation); else refs.push({ observationId: value, relations: [relation] }); };
  add(data.observationId, 'observation'); add(data.beforeId, 'before'); add(data.afterId, 'after');
  add(data.currentObservationId, 'currentAtEvent'); add(data.action?.observationId, 'actionSource'); add(data.session?.currentObservationId, 'currentAtEvent');
  return refs;
}
export type ObservationDetails = Awaited<ReturnType<BrowserEvidenceQueries['details']>>;
export type ControlDetails = Awaited<ReturnType<BrowserEvidenceQueries['control']>>;
export type RegionDetails = Awaited<ReturnType<BrowserEvidenceQueries['region']>>;
export type DomResult = Awaited<ReturnType<BrowserEvidenceQueries['dom']>>;
export type EventContext = Awaited<ReturnType<BrowserEvidenceQueries['eventContext']>>;
