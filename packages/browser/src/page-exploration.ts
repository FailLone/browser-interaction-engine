import { contextKey, type Persistence, type ExplorationGroup, type ExplorationGroupProposal, type FrontierItem } from '@interaction/core';
import type { ActionCandidate, Observation, Session } from '@interaction/adapter-playwright';

export interface PageExplorationState {
  id: string; sessionId: string; rootUrl: string;
  frames: { url: string; observationId: string; sourceObservationId?: string }[];
  lastReturn?: { fromId: string; targetId: string; navigationTargetId?: string; afterId?: string; attemptId?: string; status: 'returned' | 'blocked'; reason?: string };
}
/** Page permission is a scheduling scope, not a document identity or business-state assertion. */
export class PageExploration {
  constructor(private store: Persistence) {}
  state(sid: string) { return this.store.get<PageExplorationState>('page-exploration', `${sid}:page-exploration`); }
  enabled(session: Session) { return session.options.pageExploration === 'review'; }
  group(o: Observation) {
    return this.store.list<ExplorationGroup>('exploration-group', o.sessionId).find(g => g.kind === 'page' && g.binding === 'context'
      && g.proposalKey === `page:${o.url}` && g.contextKey === contextKey(o.context) && g.status !== 'invalidated');
  }
  proposals(actions: ActionCandidate[], o: Observation, session: Session): ExplorationGroupProposal[] {
    const state = this.state(o.sessionId);
    if (!this.enabled(session) || !state || o.url === state.rootUrl) return [];
    return [{ key: `page:${o.url}`, kind: 'page', label: o.title || o.url, binding: 'context', conditions: { url: o.url },
      actionIds: actions.filter(a => a.kind !== 'scroll').map(a => a.id), traversalActionIds: actions.filter(a => a.kind === 'scroll').map(a => a.id),
      evidence: [{ source: 'browser', rule: 'observed-page-scope/v1', facts: { url: o.url, observationId: o.id, rootUrl: state.rootUrl,
        meaning: 'Permission to explore this exact page URL under the declared context; excludes other destinations and grants no purpose, identity or replay permission' } }],
    }];
  }
  reconcile(o: Observation, previous: Observation | undefined, session: Session) {
    if (!this.enabled(session) || o.gaps.some(g => g.critical)) return;
    let state = this.state(o.sessionId);
    if (!state) {
      // Only an initial capture establishes automatic entry-page permission.
      if (o.cause !== 'initial') return;
      state = { id: `${o.sessionId}:page-exploration`, sessionId: o.sessionId, rootUrl: o.url, frames: [{ url: o.url, observationId: o.id }] };
    } else {
      const index = state.frames.findLastIndex(f => f.url === o.url);
      if (index >= 0) { state.frames = state.frames.slice(0, index + 1); state.frames[index].observationId = o.id; }
      else state.frames.push({ url: o.url, observationId: o.id, sourceObservationId: previous?.id });
    }
    this.store.put('page-exploration', state);
  }
  shouldReturn(o: Observation, session: Session, frontier: () => FrontierItem[]) {
    const state = this.state(o.sessionId);
    if (!this.enabled(session) || state?.rootUrl === o.url) return false;
    const g = this.group(o), d = g?.decisions.at(-1)?.decision;
    if (d?.mode === 'all') return false;
    if (d?.mode === 'sample' && frontier().some(f => f.stateId === o.stateId && f.status === 'pending' && f.depth < session.options.maxDepth
      && f.explorationGroups?.some(r => r.groupId === g!.id && r.memberKey && d.memberKeys.includes(r.memberKey)))) return false;
    return true;
  }
  candidates(items: FrontierItem[], o: Observation, session: Session) {
    if (!this.enabled(session) || o.boundaries?.length) return items;
    const local = items.filter(f => f.stateId === o.stateId && !this.leavesPage(f.action, o));
    return local.length ? local : items;
  }
  private leavesPage(a: ActionCandidate, o: Observation) {
    if (a.kind === 'history' || a.kind === 'navigate') return true;
    if (a.kind !== 'click') return false;
    const href = a.basis?.evidence.find(e => e.rule === 'hyperlink/v1')?.facts.href;
    if (typeof href !== 'string') return false;
    try { return new URL(href, o.url).href !== o.url; } catch { return false; }
  }
  idleReason(sid: string, session: Session) {
    if (!this.enabled(session)) return;
    const groups = this.store.list<ExplorationGroup>('exploration-group', sid).filter(g => g.kind === 'page' && g.binding === 'context' && g.status !== 'invalidated');
    if (groups.some(g => !g.decisions.length)) return 'PAGE_DECISION_REQUIRED';
    if (groups.some(g => g.decisions.at(-1)?.decision.mode === 'defer')) return 'PAGE_EXPLORATION_DEFERRED';
  }
}
