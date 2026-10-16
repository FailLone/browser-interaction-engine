export interface RecordedNavigationEdge { to: string; attemptId: string }

export type RecordedNavigationCost = (edge: RecordedNavigationEdge, from: string) => number;

type Predecessor = { from: string; attemptId: string };
type QueueEntry = { state: string; cost: number; order: number };

/** Stable binary min-heap. Equal-cost states retain discovery order, including
 * when a query assigns the same cost to every edge. */
class RouteQueue {
  private readonly entries: QueueEntry[] = [];

  push(entry: QueueEntry) {
    let child = this.entries.length;
    this.entries.push(entry);
    while (child > 0) {
      const parent = (child - 1) >>> 1;
      if (!this.before(entry, this.entries[parent])) break;
      this.entries[child] = this.entries[parent]; child = parent;
    }
    this.entries[child] = entry;
  }

  pop(): QueueEntry | undefined {
    const head = this.entries[0], last = this.entries.pop();
    if (!this.entries.length) return head;
    let parent = 0;
    while (parent * 2 + 1 < this.entries.length) {
      let child = parent * 2 + 1;
      if (child + 1 < this.entries.length && this.before(this.entries[child + 1], this.entries[child])) child++;
      if (!this.before(this.entries[child], last!)) break;
      this.entries[parent] = this.entries[child]; parent = child;
    }
    this.entries[parent] = last!;
    return head;
  }

  private before(a: QueueEntry, b: QueueEntry) {
    return a.cost < b.cost || a.cost === b.cost && a.order < b.order;
  }
}

function reconstruct(from: string, to: string, predecessor: Map<string, Predecessor>): string[] {
  const path: string[] = []; let at = to;
  while (at !== from) { const step = predecessor.get(at)!; path.push(step.attemptId); at = step.from; }
  return path.reverse();
}

/** Strict observation graph, incrementally indexed by recorded attempt ID. It
 * is a route hint, never dispatch permission or arrival proof. Current replay
 * constraints and newly captured results must still be validated separately. */
export class RecordedNavigationGraph {
  private readonly edges = new Map<string, Map<string, RecordedNavigationEdge>>();
  private readonly sources = new Map<string, string>();

  get size() { return this.sources.size; }

  add(from: string, edge: RecordedNavigationEdge) {
    this.upsert(from, edge);
  }

  /** Replacing an edge at the same source preserves its insertion order. An
   * attempt moved to another source is removed from the original adjacency. */
  upsert(from: string, edge: RecordedNavigationEdge) {
    const previous = this.sources.get(edge.attemptId);
    if (previous !== undefined && previous !== from) this.remove(edge.attemptId);
    let outgoing = this.edges.get(from);
    if (!outgoing) { outgoing = new Map(); this.edges.set(from, outgoing); }
    outgoing.set(edge.attemptId, { to: edge.to, attemptId: edge.attemptId });
    this.sources.set(edge.attemptId, from);
  }

  remove(attemptId: string): boolean {
    const from = this.sources.get(attemptId);
    if (from === undefined) return false;
    const outgoing = this.edges.get(from)!;
    outgoing.delete(attemptId);
    if (!outgoing.size) this.edges.delete(from);
    this.sources.delete(attemptId);
    return true;
  }

  clear() {
    this.edges.clear(); this.sources.clear();
  }

  /** Without a cost callback, retain the cheaper linear BFS implementation.
   * Weighted queries use Dijkstra; costs are query-local, finite and >= 0.
   * Invalid costs throw instead of silently changing route order. */
  path(from: string, to: string, firstEdgeAllowed?: (edge: RecordedNavigationEdge) => boolean, edgeCost?: RecordedNavigationCost): string[] | null {
    if (from === to) return [];
    return edgeCost ? this.weightedPath(from, to, firstEdgeAllowed, edgeCost) : this.unweightedPath(from, to, firstEdgeAllowed);
  }

  private unweightedPath(from: string, to: string, firstEdgeAllowed?: (edge: RecordedNavigationEdge) => boolean): string[] | null {
    const queue = [from], predecessor = new Map<string, Predecessor>();
    const visited = new Set([from]);
    // Mark on enqueue and retain only predecessors: no queue.shift or copying
    // every path prefix, including on graphs with many converging routes.
    for (let cursor = 0; cursor < queue.length; cursor++) {
      const state = queue[cursor];
      for (const edge of this.edges.get(state)?.values() || []) {
        if (visited.has(edge.to) || state === from && firstEdgeAllowed && !firstEdgeAllowed(edge)) continue;
        visited.add(edge.to); predecessor.set(edge.to, { from: state, attemptId: edge.attemptId });
        if (edge.to === to) return reconstruct(from, to, predecessor);
        queue.push(edge.to);
      }
    }
    return null;
  }

  private weightedPath(from: string, to: string, firstEdgeAllowed: ((edge: RecordedNavigationEdge) => boolean) | undefined, edgeCost: RecordedNavigationCost): string[] | null {
    const queue = new RouteQueue(), distances = new Map([[from, 0]]), predecessor = new Map<string, Predecessor>();
    const settled = new Set<string>();
    let order = 0;
    queue.push({ state: from, cost: 0, order: order++ });
    for (let current = queue.pop(); current; current = queue.pop()) {
      const { state, cost } = current;
      if (settled.has(state) || distances.get(state) !== cost) continue;
      if (state === to) return reconstruct(from, to, predecessor);
      settled.add(state);
      for (const edge of this.edges.get(state)?.values() || []) {
        if (settled.has(edge.to) || state === from && firstEdgeAllowed && !firstEdgeAllowed(edge)) continue;
        const weight = edgeCost(edge, state);
        if (!Number.isFinite(weight) || weight < 0) throw new RangeError(`Invalid navigation cost for attempt ${edge.attemptId}: expected a finite nonnegative number`);
        const nextCost = cost + weight;
        if (!Number.isFinite(nextCost)) throw new RangeError(`Navigation path cost overflow at attempt ${edge.attemptId}`);
        if (nextCost >= (distances.get(edge.to) ?? Infinity)) continue;
        distances.set(edge.to, nextCost); predecessor.set(edge.to, { from: state, attemptId: edge.attemptId });
        queue.push({ state: edge.to, cost: nextCost, order: order++ });
      }
    }
    return null;
  }
}
