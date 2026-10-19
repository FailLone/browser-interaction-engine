import { createHash } from 'node:crypto';
import type { CrawlEvent, CrawlStore } from '@interaction/crawler';

/** Short stable id for an abstract state key; keys run to several KB and are repeated in every action. */
export const stateId = (key: string) => createHash('sha1').update(key).digest('hex').slice(0, 12);

/**
 * Events as the debug page needs them: state keys replaced by short ids, and the bulky parts
 * (page signatures, finding facts) left out. The full event stays available by `seq`.
 */
export class DebugView {
  /**
   * State id → key per run, filled as events are slimmed, for screenshot lookups. Only the
   * runs viewed most recently are kept; an evicted run is rebuilt from its events on demand.
   */
  private readonly keys = new Map<string, Map<string, string>>();
  constructor(
    private readonly store: CrawlStore,
    private readonly maxRuns = 20,
  ) {}

  events(runId: string, after: number, limit: number) {
    return this.store.events(runId, after, limit).map(event => this.slim(runId, event));
  }

  /** The state key behind an id, scanning the run's events once if it has not been seen. */
  stateKey(runId: string, id: string): string | undefined {
    const known = this.keys.get(runId)?.get(id);
    if (known) return known;
    for (let after = 0; ; ) {
      const batch = this.store.events(runId, after, 500);
      if (!batch.length) break;
      for (const event of batch) this.slim(runId, event);
      after = batch.at(-1)!.seq;
    }
    return this.keys.get(runId)?.get(id);
  }

  private id(runId: string, key: string) {
    const id = stateId(key);
    this.run(runId).set(id, key);
    return id;
  }

  /** The run's map, moved to most recently used; the least recently used run is dropped past the limit. */
  private run(runId: string) {
    let keys = this.keys.get(runId);
    if (keys) this.keys.delete(runId);
    else keys = new Map();
    this.keys.set(runId, keys);
    if (this.keys.size > this.maxRuns) this.keys.delete(this.keys.keys().next().value as string);
    return keys;
  }

  private slim(runId: string, event: CrawlEvent & { seq: number }) {
    switch (event.type) {
      case 'state':
        return { ...event, state: { ...event.state, key: this.id(runId, event.state.key) } };
      case 'action': {
        const { sigBefore: _b, sigAfter: _a, state, classKey, ...step } = event.step;
        return {
          ...event,
          step: { ...step, classKey: classKey.slice(0, 160), ...(state ? { state: this.id(runId, state) } : {}) },
        };
      }
      case 'finding': {
        const { facts, ...finding } = event.finding;
        return { ...event, state: this.id(runId, event.state), finding: { ...finding, hasFacts: facts !== undefined } };
      }
      case 'plugin_error':
        return { ...event, state: this.id(runId, event.state), error: event.error.slice(0, 400) };
      default:
        return event;
    }
  }
}
