import type { Persistence } from './ports.js';
import type { ActionAttempt, Observation, Transition } from './types.js';
import { RecordedNavigationGraph } from './navigation-path.js';

type Sample = { key: string; duration: number; failure: number };
type Fact = { beforeId: string; afterId?: string; from?: string; to?: string; condition?: string; sample?: Sample };
const kinds = ['attempt', 'transition', 'observation'] as const;

/** Disposable index of retained facts, never cached execution permission. No
 * observations/action payloads are retained. Old stores can omit the optional
 * change feed and get the same answers through a fresh scan each query. */
export class NavigationIndex<O extends Observation> {
  readonly graph = new RecordedNavigationGraph();
  private tokens = new Map<string, string>();
  private facts = new Map<string, Fact>();
  private transitions = new Map<string, { attemptId: string; replayable: boolean }>();
  private byAttempt = new Map<string, Set<string>>();
  private byObservation = new Map<string, Set<string>>();
  private costs = new Map<string, { count: number; duration: number; failures: number }>();
  readonly metrics = { rebuilds: 0, refreshes: 0, attemptsRead: 0, observationsRead: 0 };

  constructor(private store: Persistence, private sessionId: string,
    private key: (observation: O) => string,
    private condition: (action: ActionAttempt['action'], observation: O, strictKey: string) => string) {}

  private clear() {
    this.tokens.clear(); this.graph.clear(); this.facts.clear(); this.transitions.clear();
    this.byAttempt.clear(); this.byObservation.clear(); this.costs.clear();
  }
  private sample(attempt: ActionAttempt): Sample | undefined {
    const s = attempt.recoverySegment;
    if (attempt.status !== 'succeeded' || !s || !['matched', 'no_progress', 'diverged'].includes(s.outcome)
      || !Number.isFinite(s.durationMs) || s.durationMs < 0) return;
    return { key: `${s.mode}:${s.conditionKey}`, duration: Math.min(60_000, Math.max(1, s.durationMs)), failure: s.outcome === 'matched' ? 0 : 1 };
  }
  private adjust(sample: Sample | undefined, sign: number) {
    if (!sample) return;
    const prior = this.costs.get(sample.key) || { count: 0, duration: 0, failures: 0 };
    prior.count += sign; prior.duration += sign * sample.duration; prior.failures += sign * sample.failure;
    if (prior.count) this.costs.set(sample.key, prior); else this.costs.delete(sample.key);
  }
  private refreshEdge(attemptId: string) {
    const fact = this.facts.get(attemptId);
    const replayable = [...this.byAttempt.get(attemptId) || []].some(id => this.transitions.get(id)?.replayable);
    if (fact?.from && fact.to && replayable) this.graph.upsert(fact.from, { to: fact.to, attemptId });
    else this.graph.remove(attemptId);
  }
  private putTransition(id: string, edge?: Transition) {
    const prior = this.transitions.get(id);
    if (prior) { this.byAttempt.get(prior.attemptId)?.delete(id); this.transitions.delete(id); }
    if (edge?.sessionId === this.sessionId) {
      this.transitions.set(id, { attemptId: edge.attemptId, replayable: edge.replayable });
      const references = this.byAttempt.get(edge.attemptId) || new Set<string>();
      references.add(id); this.byAttempt.set(edge.attemptId, references); this.refreshEdge(edge.attemptId);
    }
    if (prior) this.refreshEdge(prior.attemptId);
  }
  private putAttempt(id: string, attempt: ActionAttempt | undefined, observations: Map<string, O | undefined>, keys: Map<string, string>) {
    const prior = this.facts.get(id);
    this.adjust(prior?.sample, -1);
    if (prior) for (const oid of [prior.beforeId, prior.afterId]) if (oid) {
      const dependents = this.byObservation.get(oid); dependents?.delete(id);
      if (!dependents?.size) this.byObservation.delete(oid);
    }
    this.facts.delete(id);
    if (attempt?.sessionId === this.sessionId) {
      const fact: Fact = { beforeId: attempt.beforeId, afterId: attempt.afterId, sample: this.sample(attempt) };
      const read = (oid: string) => {
        if (!observations.has(oid)) { this.metrics.observationsRead++; observations.set(oid, this.store.get<O>('observation', oid)); }
        const o = observations.get(oid); return o?.sessionId === this.sessionId ? o : undefined;
      };
      if (attempt.status === 'succeeded' && attempt.action.replayable && attempt.afterId) {
        const before = read(attempt.beforeId), after = read(attempt.afterId);
        if (before && after && !before.gaps.some(g => g.critical) && !after.gaps.some(g => g.critical)) {
          const key = (o: O) => { let value = keys.get(o.id); if (value === undefined) { value = this.key(o); keys.set(o.id, value); } return value; };
          fact.from = key(before); fact.to = key(after); fact.condition = this.condition(attempt.action, before, fact.from);
        }
      }
      this.facts.set(id, fact); this.adjust(fact.sample, 1);
      for (const oid of [fact.beforeId, fact.afterId]) if (oid) {
        const dependents = this.byObservation.get(oid) || new Set<string>();
        dependents.add(id); this.byObservation.set(oid, dependents);
      }
    }
    this.refreshEdge(id);
  }
  /** Returns false under repeated concurrent external changes; callers must not
   * consume a partially refreshed index. A later query can rebuild safely. */
  refresh(): boolean {
    for (let retry = 0; retry < 2; retry++) {
      const changes = kinds.map(kind => this.store.entityChanges?.(kind, this.sessionId, this.tokens.get(kind)));
      const full = changes.some(c => !c || c.reset), observations = new Map<string, O | undefined>(), keys = new Map<string, string>();
      if (full) {
        this.clear(); this.metrics.rebuilds++;
        const attempts = this.store.list<ActionAttempt>('attempt', this.sessionId);
        for (const a of attempts) { this.metrics.attemptsRead++; this.putAttempt(a.id, a, observations, keys); }
        for (const edge of this.store.list<Transition>('transition', this.sessionId)) this.putTransition(edge.id, edge);
      } else {
        const affected = new Set(changes[0]!.ids);
        for (const oid of changes[2]!.ids) for (const aid of this.byObservation.get(oid) || []) affected.add(aid);
        for (const aid of affected) { this.metrics.attemptsRead++; this.putAttempt(aid, this.store.get<ActionAttempt>('attempt', aid), observations, keys); }
        for (const tid of changes[1]!.ids) this.putTransition(tid, this.store.get<Transition>('transition', tid));
      }
      this.metrics.refreshes++;
      if (!this.store.entityChanges) return true;
      const after = kinds.map(kind => this.store.entityChanges!(kind, this.sessionId, changes[kinds.indexOf(kind)]!.token));
      // An explicitly transaction-local snapshot is usable once. It must not
      // seed a reusable cursor, including if that transaction later rolls back.
      if (full && changes.every(c => c?.cacheable === false) && after.every(c => c.cacheable === false)) return true;
      if (after.every((c, i) => !c.reset && c.token === changes[i]!.token)) {
        kinds.forEach((kind, i) => this.tokens.set(kind, after[i].token)); return true;
      }
      this.clear();
    }
    return false;
  }
  /** An unmeasured edge has a uniform prior, retaining the old shortest-hop
   * ordering. Quantization limits timing jitter. Failure is a finite penalty,
   * not a ban: if it is the only permitted route, it can still be attempted. */
  cost(attemptId: string, mode: 'target' | 'checkpoint', currentCondition?: string): number {
    const condition = currentCondition ?? this.facts.get(attemptId)?.condition;
    const stats = condition && this.costs.get(`${mode}:${condition}`);
    if (!stats) return 1000;
    const duration = Math.ceil(stats.duration / stats.count / 250) * 250;
    return duration + 4000 * stats.failures / stats.count;
  }
}
