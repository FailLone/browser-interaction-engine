import { BoundedEntityChanges, EngineError, canonical, clone, now, type Persistence, type Evidence, type EvidenceStore, type EngineEvent } from '@interaction/core';

export class MemoryEvidenceStore implements EvidenceStore {
  readonly durability = 'process' as const;
  private values = new Map<string, Evidence>();
  async put(key: string, evidence: Evidence) { this.values.set(key, clone(evidence)); }
  async get(key: string) { const value = this.values.get(key); return value ? clone(value) : undefined; }
  async delete(key: string) { this.values.delete(key); }
  async deleteMany(keys: string[]) { for (const key of keys) this.values.delete(key); }
}

/** No disk writes. A fresh instance represents a fresh, empty database. */
export class MemoryStore implements Persistence {
  readonly evidence = new MemoryEvidenceStore();
  private entities = new Map<string, { kind: string; sessionId: string; value: object }>();
  private log: EngineEvent[] = [];
  private requests = new Map<string, { attemptId: string; payload: string }>();
  private sequence = 0;
  private readonly changes = new BoundedEntityChanges();
  transaction<T>(fn: () => T): T {
    const saved = clone({ entities: this.entities, log: this.log, requests: this.requests, sequence: this.sequence });
    try { return fn(); }
    catch (error) { this.entities = saved.entities; this.log = saved.log; this.requests = saved.requests; this.sequence = saved.sequence; this.changes.invalidate(); throw error; }
  }
  put<T extends { id: string; sessionId?: string }>(kind: string, value: T) {
    const prior = this.entities.get(value.id);
    const sessionId = value.sessionId ?? value.id;
    if (prior && (prior.kind !== kind || prior.sessionId !== sessionId)) throw new EngineError('ID_CONFLICT', 'ID already belongs to another entity kind or session');
    if (kind === 'observation' && prior) {
      if (canonical(prior.value) !== canonical(value)) throw new EngineError('IMMUTABLE_OBSERVATION', 'Observations cannot be overwritten');
      return;
    }
    // Match the JSON persistence contract, including omission of undefined fields.
    this.entities.set(value.id, { kind, sessionId, value: JSON.parse(JSON.stringify(value)) });
    this.changes.record(kind, sessionId, value.id);
  }
  entityChanges(kind: string, sessionId: string, sinceToken?: string) { return this.changes.changes(kind, sessionId, sinceToken); }
  get<T>(kind: string, id: string): T | undefined { const row = this.entities.get(id); return row?.kind === kind ? clone(row.value) as T : undefined; }
  require<T>(kind: string, id: string): T { const value = this.get<T>(kind, id); if (value === undefined) throw new EngineError('NOT_FOUND', `${kind} ${id} not found`); return value; }
  list<T>(kind: string, sessionId?: string): T[] { return [...this.entities.values()].filter(r => r.kind === kind && (!sessionId || r.sessionId === sessionId)).map(r => clone(r.value) as T); }
  event(sessionId: string, type: string, data: unknown): EngineEvent {
    const event = { sequence: ++this.sequence, sessionId, type, at: now(), data: JSON.parse(JSON.stringify(data)) };
    this.log.push(event); return clone(event);
  }
  events(sessionId: string, after = 0, limit = 1000) { return clone(this.log.filter(e => e.sessionId === sessionId && e.sequence > after).slice(0, limit)); }
  private requestKey(sessionId: string, requestId: string) { return JSON.stringify([sessionId, requestId]); }
  request(sessionId: string, requestId: string) { return clone(this.requests.get(this.requestKey(sessionId, requestId))); }
  recordRequest(sessionId: string, requestId: string, attemptId: string, payload: string) {
    const key = this.requestKey(sessionId, requestId);
    if (this.requests.has(key)) throw new EngineError('REQUEST_CONFLICT', 'Request ID already exists');
    this.requests.set(key, { attemptId, payload });
  }
  close() { /* Existing records remain available to their owner while this object exists. */ }
}
