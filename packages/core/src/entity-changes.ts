import type { EntityChanges } from './ports.js';
import { id } from './util.js';

const trackedKinds = new Set(['attempt', 'transition', 'observation', 'evidence-entry', 'evidence-retention']);
interface Change { revision: number; kind: string; sessionId: string; id: string }

/** A bounded, process-local hint journal. It holds no entity bodies and never
 * grants replay permission. Overflow and invalidation require a full reread. */
export class BoundedEntityChanges {
  private generation = id();
  private revision = 0;
  private readonly ring: (Change | undefined)[];

  constructor(private readonly capacity = 4096) {
    if (!Number.isSafeInteger(capacity) || capacity < 1) throw new RangeError('Change journal capacity must be a positive integer');
    this.ring = new Array(capacity);
  }

  record(kind: string, sessionId: string, entityId: string): void {
    if (!trackedKinds.has(kind)) return;
    if (this.revision === Number.MAX_SAFE_INTEGER) this.invalidate();
    const revision = ++this.revision;
    this.ring[(revision - 1) % this.capacity] = { revision, kind, sessionId, id: entityId };
  }

  invalidate(): void {
    this.generation = id();
    this.revision = 0;
    this.ring.fill(undefined);
  }

  changes(kind: string, sessionId: string, sinceToken?: string): EntityChanges {
    const token = JSON.stringify([this.generation, kind, sessionId, this.revision]);
    const reset = (): EntityChanges => ({ token, reset: true, ids: [] });
    if (!trackedKinds.has(kind) || !sinceToken) return reset();
    let cursor: unknown;
    try { cursor = JSON.parse(sinceToken); } catch { return reset(); }
    if (!Array.isArray(cursor) || cursor.length !== 4 || cursor[0] !== this.generation || cursor[1] !== kind || cursor[2] !== sessionId
      || !Number.isSafeInteger(cursor[3]) || cursor[3] < 0 || cursor[3] > this.revision || this.revision - cursor[3] > this.capacity) return reset();
    const ids = new Set<string>();
    for (let revision = cursor[3] + 1; revision <= this.revision; revision++) {
      const change = this.ring[(revision - 1) % this.capacity];
      if (!change || change.revision !== revision) return reset();
      if (change.kind === kind && change.sessionId === sessionId) ids.add(change.id);
    }
    return { token, reset: false, ids: [...ids] };
  }
}
