import type { Persistence } from './ports.js';
import type { Session, ActionAttempt, FrontierItem, InteractionScope } from './types.js';
export function recoverStore(store: Persistence) {
    store.transaction(() => {
      for (const s of store.list<Session>('session')) {
        if (s.status !== 'stopped' && s.status !== 'finished') { s.status = 'paused'; s.stopReason = 'process_restart'; store.put('session', s); }
        for (const a of store.list<ActionAttempt>('attempt', s.id).filter(a => a.status === 'executing')) { a.status = 'unknown'; a.reason = 'Process ended after execution intent; do not retry automatically'; store.put('attempt', a); store.event(s.id, 'action.unknown', a); }
        for (const f of store.list<FrontierItem>('frontier', s.id).filter(f => f.status === 'executing')) { f.status = 'unknown'; f.reason = 'Interrupted action'; store.put('frontier', f); }
        for (const scope of store.list<InteractionScope>('scope', s.id).filter(s => s.status === 'open')) { scope.status = 'interrupted'; store.put('scope', scope); }
      }
    });
  }
