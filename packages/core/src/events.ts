import type { EngineEvent } from './types.js';
import { clone } from './util.js';
/** In-process subscriptions only; durable cursors are provided by Persistence. */
export class EventBus {
  private listeners = new Set<(event: EngineEvent) => void>();
  on(_name: 'event', listener: (event: EngineEvent) => void) { this.listeners.add(listener); return this; }
  off(_name: 'event', listener: (event: EngineEvent) => void) { this.listeners.delete(listener); return this; }
  emit(_name: 'event', event: EngineEvent) {
    for (const listener of [...this.listeners]) {
      // Subscriber failures must not change committed execution results.
      try { const result = listener(clone(event)) as unknown; if (result && typeof (result as Promise<unknown>).catch === 'function') void (result as Promise<unknown>).catch(() => {}); } catch { /* Pull the durable log to resume a failed consumer. */ }
    }
  }
}
