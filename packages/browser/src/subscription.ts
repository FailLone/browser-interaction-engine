import { Buffer } from 'node:buffer';
import { EngineError, clone, type EngineEvent, type EvidenceAvailability, type Gap } from '@interaction/core';
import type { BrowserEngine } from './index.js';
import type { ObservationDetails, ArtifactKind } from './evidence.js';

export type DeliveryMode = 'reference' | 'inline' | 'hybrid';
export interface EvidenceDelivery {
  mode: DeliveryMode; status: 'available' | 'partial' | 'unavailable';
  details?: ObservationDetails;
  artifacts: { kind: ArtifactKind; key: string; mediaType: string; availability: EvidenceAvailability; encoding?: 'base64'; data?: string }[];
  gaps: Gap[];
}
export interface SnapshotEventData { observationId: string; stateId: string; visitId: string; gaps: Gap[]; evidence?: EvidenceDelivery }
export type SnapshotEvent = EngineEvent;
export interface SubscriptionGap { code: 'SUBSCRIPTION_GAP'; sessionId: string; lastDelivered: number; failedSequence?: number; reason: string }
export interface SubscriptionOptions {
  after?: number; delivery?: DeliveryMode; maxSnapshotBytes?: number; consumerTimeoutMs?: number;
  onGap?: (gap: SubscriptionGap) => void;
}

/** Project a durable reference event without changing the durable log. */
export async function projectEvent(engine: BrowserEngine, event: EngineEvent, delivery: DeliveryMode = 'inline', maxBytes = 8 * 1024 ** 2): Promise<SnapshotEvent> {
  if (!['reference', 'inline', 'hybrid'].includes(delivery) || !Number.isSafeInteger(maxBytes) || maxBytes < 1024 || maxBytes > 64 * 1024 ** 2) throw new EngineError('INVALID_QUERY', 'Invalid snapshot delivery mode or size limit');
  if (delivery === 'reference' || event.type !== 'observation.created') return clone(event);
  const data = event.data as SnapshotEventData;
  const evidence: EvidenceDelivery = { mode: delivery, status: 'unavailable', artifacts: [], gaps: [] };
  try {
    const details = await engine.observationDetails(event.sessionId, data.observationId);
    let bytes = Buffer.byteLength(JSON.stringify(details));
    if (bytes > maxBytes) evidence.gaps.push({ code: 'SNAPSHOT_DELIVERY_LIMIT', message: `Snapshot exceeds ${maxBytes} bytes; query retained evidence by observationId` });
    else {
      evidence.details = details; evidence.gaps.push(...details.gaps);
      evidence.status = details.snapshot ? details.observation.evidence?.status === 'partial' || details.gaps.length ? 'partial' : 'available' : 'unavailable';
      for (const kind of ['screenshot', 'fullPageScreenshot'] as const) {
        const ref = details.observation.evidence?.artifacts[kind]; if (!ref) continue;
        const availability = await engine.store.evidence.availability(ref.key);
        const artifact: EvidenceDelivery['artifacts'][number] = { kind, key: ref.key, mediaType: ref.mediaType, availability };
        if (delivery === 'inline' && availability.status === 'available') {
          if (bytes + Math.ceil(ref.bytes / 3) * 4 > maxBytes) evidence.gaps.push({ code: 'SNAPSHOT_DELIVERY_LIMIT', reference: ref.key, message: 'Image omitted from inline delivery due to the byte limit' });
          else {
            try { const result = await engine.evidenceArtifact(event.sessionId, data.observationId, kind); artifact.encoding = 'base64'; artifact.data = Buffer.from(result.data).toString('base64'); bytes += artifact.data.length; }
            catch (error) { evidence.gaps.push({ code: 'ARTIFACT_DELIVERY_UNAVAILABLE', reference: ref.key, message: String(error) }); }
          }
        }
        if (availability.status !== 'available') evidence.gaps.push({ code: `EVIDENCE_${availability.status.toUpperCase()}`, reference: ref.key, message: availability.reason || 'Artifact is unavailable' });
        evidence.artifacts.push(artifact);
      }
      if (evidence.gaps.length && evidence.status === 'available') evidence.status = 'partial';
    }
  } catch (error) { evidence.gaps.push({ code: 'SNAPSHOT_UNAVAILABLE', message: String(error) }); }
  // Include envelope, availability and gap metadata in the evidence budget.
  // The pre-existing reference event is outside this projection budget.
  if (Buffer.byteLength(JSON.stringify(evidence)) > maxBytes) {
    for (const artifact of evidence.artifacts) { delete artifact.data; delete artifact.encoding; }
    evidence.status = evidence.details?.snapshot ? 'partial' : 'unavailable';
    evidence.gaps.push({ code: 'SNAPSHOT_DELIVERY_LIMIT', message: 'Inline images omitted to fit the complete evidence envelope' });
    if (Buffer.byteLength(JSON.stringify(evidence)) > maxBytes) {
      delete evidence.details; evidence.artifacts = []; evidence.status = 'unavailable';
      evidence.gaps = [{ code: 'SNAPSHOT_DELIVERY_LIMIT', message: `Evidence envelope exceeds ${maxBytes} bytes; use the event observationId to query retained evidence` }];
    }
  }
  return { ...clone(event), data: { ...clone(data), evidence } satisfies SnapshotEventData };
}

/** Pull one committed event at a time; never accumulate a queue of full snapshots. */
export function subscribeEvents(engine: BrowserEngine, sessionId: string, listener: (event: SnapshotEvent) => void | Promise<void>, options: SubscriptionOptions = {}) {
  const after = options.after ?? 0; const timeoutMs = options.consumerTimeoutMs ?? 10000;
  const delivery = options.delivery ?? 'inline'; const maxBytes = options.maxSnapshotBytes ?? 8 * 1024 ** 2;
  if (!Number.isSafeInteger(after) || after < 0 || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000 || !['reference', 'inline', 'hybrid'].includes(delivery) || !Number.isSafeInteger(maxBytes) || maxBytes < 1024 || maxBytes > 64 * 1024 ** 2) throw new EngineError('INVALID_QUERY', 'Invalid subscription options');
  let cursor = after; let closed = false; let wake: (() => void) | undefined; let cancel: () => void;
  const cancelled = new Promise<void>(resolve => { cancel = resolve; });
  const signal = (event: EngineEvent) => { if (event.sessionId === sessionId) { wake?.(); wake = undefined; } };
  const close = () => { if (closed) return; closed = true; engine.events.off('event', signal); wake?.(); cancel!(); };
  engine.events.on('event', signal);
  const done = (async () => {
    let failedSequence: number | undefined;
    try {
      while (!closed) {
        const event = engine.store.events(sessionId, cursor, 1)[0];
        if (!event) { await new Promise<void>(resolve => { wake = resolve; }); continue; }
        failedSequence = event.sequence;
        const projected = await projectEvent(engine, event, delivery, maxBytes); if (closed) break;
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([Promise.resolve().then(() => listener(projected)), cancelled, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new EngineError('CONSUMER_TIMEOUT', 'Subscriber did not finish before its timeout')), timeoutMs); })]);
        } finally { if (timer) clearTimeout(timer); }
        if (!closed) cursor = event.sequence;
      }
    } catch (error) {
      if (!closed) { try { options.onGap?.({ code: 'SUBSCRIPTION_GAP', sessionId, lastDelivered: cursor, failedSequence, reason: String(error) }); } catch { /* Consumer errors cannot discard committed facts. */ } }
    } finally { close(); }
  })();
  return { close, done, get cursor() { return cursor; } };
}
