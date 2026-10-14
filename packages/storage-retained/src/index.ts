import { EngineError, clone, evidenceRetentionSchema, hashBytes, type Evidence, type EvidenceAvailability, type EvidenceStore, type EvidenceRetentionPolicy, type Persistence, type Session, type InteractionScope } from '@interaction/core';

interface Group { id: string; sessionId: string; policy: EvidenceRetentionPolicy; createdAt: number; expiresAt?: number; keys: string[]; pins: string[]; pinExpirations?: Record<string, number>; committed: boolean }
interface Entry { id: string; sessionId: string; observationId: string; bytes: number; hash: string; status: EvidenceAvailability['status']; reason?: string }
const GROUP = 'evidence-retention'; const ENTRY = 'evidence-entry';
export interface RetentionOptions { maxMemoryBytes?: number; now?: () => number; sweepIntervalMs?: number }

/** Evidence lifecycle decorator. Working entities and event logs keep their original plugin. */
export class RetainedPersistence implements Persistence {
  readonly evidence: RetainedEvidenceStore;
  transaction: Persistence['transaction']; put: Persistence['put']; get: Persistence['get']; require: Persistence['require']; list: Persistence['list'];
  event: Persistence['event']; events: Persistence['events']; request: Persistence['request']; recordRequest: Persistence['recordRequest'];
  constructor(readonly backing: Persistence, options: RetentionOptions = {}) {
    this.evidence = new RetainedEvidenceStore(backing, options);
    this.transaction = backing.transaction.bind(backing); this.put = backing.put.bind(backing); this.get = backing.get.bind(backing); this.require = backing.require.bind(backing); this.list = backing.list.bind(backing);
    this.event = backing.event.bind(backing); this.events = backing.events.bind(backing); this.request = backing.request.bind(backing); this.recordRequest = backing.recordRequest.bind(backing);
  }
  close() { this.evidence.close(); this.backing.close(); }
}

export class RetainedEvidenceStore implements EvidenceStore {
  private blobs = new Map<string, { value: Evidence; refs: number }>();
  private active?: string;
  private queue: Promise<unknown> = Promise.resolve();
  private timer?: ReturnType<typeof setInterval>;
  private clock: () => number;
  readonly maxMemoryBytes: number;
  constructor(private records: Persistence, options: RetentionOptions = {}) {
    this.clock = options.now || Date.now; this.maxMemoryBytes = options.maxMemoryBytes ?? 128 * 1024 ** 2;
    if (!Number.isSafeInteger(this.maxMemoryBytes) || this.maxMemoryBytes < 1024) throw new EngineError('INVALID_QUERY', 'maxMemoryBytes must be an integer of at least 1024');
    // Process-local evidence cannot be reconstructed from a durable manifest.
    for (const group of this.groups()) {
      if (group.policy.mode !== 'persistent') for (const key of group.keys) { const entry = this.entry(key); if (entry?.status === 'available') this.save({ ...entry, status: 'not_retained', reason: 'process_restarted' }); }
      if (!group.committed) { group.committed = true; group.pins = []; this.saveGroup(group); }
    }
    const interval = options.sweepIntervalMs ?? 1000;
    if (interval > 0) { this.timer = setInterval(() => { void this.sweep().catch(() => {}); }, interval); (this.timer as unknown as { unref?: () => void }).unref?.(); }
  }
  private run<T>(fn: () => Promise<T> | T): Promise<T> { const result = this.queue.then(fn); this.queue = result.catch(() => {}); return result; }
  private groups(sessionId?: string) { return this.records.list<Group & { observationId: string }>(GROUP, sessionId).map(g => ({ ...g, id: g.observationId })); }
  private group(id: string) { const g = this.records.get<Group>(GROUP, `retention:${id}`); return g ? { ...g, id } : undefined; }
  private requireGroup(id: string) { const g = this.group(id); if (!g) throw new EngineError('NOT_FOUND', 'Evidence retention manifest is missing'); return g; }
  private saveGroup(group: Group) { this.records.put(GROUP, { ...group, id: `retention:${group.id}`, observationId: group.id }); }
  private entry(key: string) { const entry = this.records.get<Entry>(ENTRY, `evidence:${key}`); return entry ? { ...entry, id: key } : undefined; }
  private save(entry: Entry) { this.records.put(ENTRY, { ...entry, id: `evidence:${entry.id}`, key: entry.id }); }
  private entries(group: Group) { return group.keys.map(k => this.entry(k)).filter((e): e is Entry => e?.status === 'available'); }
  private memoryBytes() { return [...this.blobs.values()].reduce((n, b) => n + b.value.data.byteLength, 0); }
  private protectionOwners(group: Group) {
    const owners = group.pins.filter(owner => group.pinExpirations?.[owner] === undefined || group.pinExpirations[owner] > this.clock());
    if (!group.committed || group.id === this.active) owners.push('active-capture');
    if (group.policy.mode === 'transient') return owners;
    const session = this.records.get<Session>('session', group.sessionId);
    if (session?.status === 'stopped') return owners;
    if (session && session.currentObservationId === group.id) owners.push('current-observation');
    for (const scope of this.records.list<InteractionScope>('scope', group.sessionId)) if (scope.status === 'open' && scope.beforeId === group.id) owners.push(`scope:${scope.id}`);
    return owners;
  }
  private protected(group: Group) { return this.protectionOwners(group).length > 0; }
  private async drop(group: Group, status: Entry['status'], reason: string) {
    for (const entry of this.entries(group)) {
      if (group.policy.mode === 'persistent') {
        if (!this.records.evidence.delete) throw new EngineError('EVIDENCE_RETENTION_UNSUPPORTED', 'The backing plugin cannot delete evidence');
        await this.records.evidence.delete(entry.id);
      } else {
        const blob = this.blobs.get(entry.hash); if (blob && --blob.refs === 0) this.blobs.delete(entry.hash);
      }
      this.save({ ...entry, status, reason });
    }
  }
  private async expire() {
    const now = this.clock();
    for (const group of this.groups()) {
      const expired = group.pins.filter(owner => group.pinExpirations?.[owner] !== undefined && group.pinExpirations[owner] <= now);
      if (expired.length) {
        group.pins = group.pins.filter(owner => !expired.includes(owner));
        for (const owner of expired) delete group.pinExpirations![owner];
        this.saveGroup(group);
      }
      if (group.expiresAt !== undefined && group.expiresAt <= now && !this.protected(group)) await this.drop(group, 'expired', 'ttl_elapsed');
    }
  }
  beginObservation(context: { sessionId: string; observationId: string; policy?: EvidenceRetentionPolicy }) {
    return this.run(async () => {
      await this.expire(); this.active = undefined;
      // No policy means legacy behavior. Existing session guarantees are preserved.
      if (!context.policy) return;
      const policy = evidenceRetentionSchema.parse(context.policy);
      if (policy.mode === 'persistent' && policy.ttlMs > 0 && !this.records.evidence.delete) throw new EngineError('EVIDENCE_RETENTION_UNSUPPORTED', 'Expiring persistent evidence requires delete support');
      const createdAt = this.clock();
      this.saveGroup({ id: context.observationId, sessionId: context.sessionId, policy, createdAt, expiresAt: policy.ttlMs ? createdAt + policy.ttlMs : undefined, keys: [], pins: [], committed: false } satisfies Group);
      this.active = context.observationId;
    });
  }
  endObservation(observationId: string, committed: boolean) {
    return this.run(async () => {
      const group = this.group(observationId);
      if (group) {
        if (!group.committed && committed && group.policy.ttlMs) group.expiresAt = this.clock() + group.policy.ttlMs;
        group.committed = true; this.saveGroup(group); if (!committed) await this.drop(group, 'released', 'observation_not_committed');
      }
      if (this.active === observationId) this.active = undefined;
      await this.expire();
    });
  }
  put(key: string, evidence: Evidence) {
    evidence = clone(evidence);
    return this.run(async () => {
      const prior = this.entry(key); const groupId = prior?.observationId || this.active;
      const group = groupId ? this.group(groupId) : undefined;
      if (!group) return this.records.evidence.put(key, evidence);
      await this.expire();
      const hash = `${hashBytes(evidence.data)}:${evidence.mediaType}`; const bytes = evidence.data.byteLength;
      const usage = () => {
        const groups = this.groups(group.sessionId); const current = groups.flatMap(g => this.entries(g));
        return { bytes: current.reduce((n, e) => n + e.bytes, 0) - (prior?.status === 'available' ? prior.bytes : 0) + bytes, observations: groups.filter(g => g.id === group.id || this.entries(g).length).length };
      };
      const fits = () => { const used = usage(); return used.bytes <= group.policy.maxBytes && used.observations <= group.policy.maxObservations && (group.policy.mode === 'persistent' || this.memoryBytes() + (this.blobs.has(hash) ? 0 : bytes) <= this.maxMemoryBytes); };
      if (!fits() && group.policy.mode !== 'persistent') {
        // Evict only unprotected memory groups, oldest first. Cross-session groups
        // may be freed for the global memory cap, never persistent evidence.
        for (const other of this.groups().sort((a, b) => a.createdAt - b.createdAt)) {
          if (fits()) break;
          if (other.policy.mode !== 'persistent' && !this.protected(other)) await this.drop(other, 'evicted', 'capacity_limit');
        }
      }
      if (!fits()) throw new EngineError('EVIDENCE_BUDGET_EXHAUSTED', 'Evidence capacity cannot fit this artifact without deleting protected evidence', { observationId: group.id, bytes, policy: group.policy });
      if (group.policy.mode === 'persistent') await this.records.evidence.put(key, evidence);
      else {
        const old = prior?.status === 'available' ? this.blobs.get(prior.hash) : undefined;
        if (old && --old.refs === 0) this.blobs.delete(prior!.hash);
        const shared = this.blobs.get(hash);
        if (shared) shared.refs++; else this.blobs.set(hash, { value: clone(evidence), refs: 1 });
      }
      this.save({ id: key, sessionId: group.sessionId, observationId: group.id, bytes, hash, status: 'available' });
      if (!group.keys.includes(key)) { group.keys.push(key); this.saveGroup(group); }
    });
  }
  private async read(key: string, copy = true): Promise<Evidence | undefined> {
    await this.expire(); const entry = this.entry(key);
    if (!entry) return this.records.evidence.get(key);
    if (entry.status !== 'available') return undefined;
    const group = this.requireGroup(entry.observationId);
    try {
      const value = group.policy.mode === 'persistent' ? await this.records.evidence.get(key) : this.blobs.get(entry.hash)?.value;
      if (!value) { this.save({ ...entry, status: group.policy.mode === 'persistent' ? 'missing' : 'not_retained', reason: 'evidence_not_found' }); return undefined; }
      return copy ? clone(value) : value;
    } catch (error) { this.save({ ...entry, status: 'storage_failed', reason: String(error) }); throw error; }
  }
  get(key: string) { return this.run(() => this.read(key)); }
  availability(key: string) {
    return this.run(async (): Promise<EvidenceAvailability> => {
      let value: Evidence | undefined; let failure: string | undefined;
      try { value = await this.read(key, false); } catch (error) { failure = String(error); }
      const entry = this.entry(key);
      if (!entry) return { status: failure ? 'storage_failed' : value ? 'available' : 'missing', reason: failure, bytes: value?.data.byteLength, durability: this.records.evidence.durability || 'unknown' };
      const group = this.requireGroup(entry.observationId);
      return { status: entry.status, bytes: entry.bytes, reason: entry.reason, mode: group.policy.mode, expiresAt: !this.protected(group) && group.expiresAt !== undefined ? new Date(group.expiresAt).toISOString() : undefined, durability: group.policy.mode === 'persistent' ? this.records.evidence.durability || 'unknown' : 'process' };
    });
  }
  pin(keys: string[], owner: string, options?: { expiresAt: number }) {
    return this.run(async () => {
      if (options && (!Number.isFinite(options.expiresAt) || options.expiresAt <= this.clock())) throw new EngineError('INVALID_QUERY', 'Pin expiry must be in the future');
      const groups = new Map<string, Group>();
      for (const key of keys) {
        if (!await this.read(key)) throw new EngineError('EVIDENCE_UNAVAILABLE', 'Cannot pin unavailable evidence', { key });
        const entry = this.entry(key);
        // Legacy stores have no expiry; their existing retention promise applies.
        if (!entry) continue;
        const group = this.requireGroup(entry.observationId);
        if (group.policy.mode === 'transient') throw new EngineError('EVIDENCE_RETENTION_UNSUPPORTED', 'Use cache or persistent mode to pin historical evidence');
        groups.set(group.id, group);
      }
      if (options && options.expiresAt <= this.clock()) throw new EngineError('INVALID_QUERY', 'Pin expired while reserving evidence');
      this.records.transaction(() => { for (const group of groups.values()) { if (!group.pins.includes(owner)) group.pins.push(owner); group.pinExpirations ||= {}; if (options) group.pinExpirations[owner] = options.expiresAt; else delete group.pinExpirations[owner]; this.saveGroup(group); } });
    });
  }
  unpin(owner: string) { return this.run(async () => { for (const group of this.groups()) if (group.pins.includes(owner)) { group.pins = group.pins.filter(p => p !== owner); if (group.pinExpirations) delete group.pinExpirations[owner]; this.saveGroup(group); } await this.expire(); }); }
  release(sessionId: string, observationId: string) {
    return this.run(async () => {
      const group = this.group(observationId);
      if (!group || group.sessionId !== sessionId) throw new EngineError('NOT_FOUND', 'Managed evidence does not belong to this session');
      if (this.protected(group)) throw new EngineError('EVIDENCE_PINNED', 'Evidence is protected by an active observation, scope or explicit pin', { owners: this.protectionOwners(group) });
      await this.drop(group, 'released', 'explicit_release');
    });
  }
  sweep() { return this.run(() => this.expire()); }
  stats(sessionId?: string) {
    return this.run(async () => {
      await this.expire(); const groups = this.groups(sessionId); const entries = groups.flatMap(g => g.keys.map(k => this.entry(k)!));
      return { trackedObservations: groups.length, retainedObservations: groups.filter(g => this.entries(g).length).length, logicalBytes: entries.filter(e => e.status === 'available').reduce((n, e) => n + e.bytes, 0), memoryBytes: this.memoryBytes(), maxMemoryBytes: this.maxMemoryBytes,
        statuses: entries.reduce<Record<string, number>>((out, e) => { out[e.status] = (out[e.status] || 0) + 1; return out; }, {}),
        protected: groups.filter(g => this.protected(g)).map(g => ({ observationId: g.id, owners: this.protectionOwners(g) })), legacyEvidenceIncluded: false, workingRecordsIncluded: false };
    });
  }
  close() { if (this.timer) clearInterval(this.timer); this.blobs.clear(); }
  async flush() { if (this.timer) clearInterval(this.timer); await this.queue; }
}
