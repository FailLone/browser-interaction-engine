export interface RecordedNavigationEdge { to: string; attemptId: string }

/** A query-local strict observation graph. It is a route hint, never dispatch
 * permission or arrival proof. Newly captured results are validated separately. */
export class RecordedNavigationGraph {
  private readonly edges = new Map<string, RecordedNavigationEdge[]>();

  add(from: string, edge: RecordedNavigationEdge) {
    const outgoing = this.edges.get(from);
    if (outgoing) outgoing.push(edge);
    else this.edges.set(from, [edge]);
  }

  path(from: string, to: string, firstEdgeAllowed?: (edge: RecordedNavigationEdge) => boolean): string[] | null {
    if (from === to) return [];
    const queue = [from], predecessor = new Map<string, { from: string; attemptId: string }>();
    const visited = new Set([from]);
    // Mark on enqueue and retain only predecessors: no queue.shift or copying
    // every path prefix, including on graphs with many converging routes.
    for (let cursor = 0; cursor < queue.length; cursor++) {
      const state = queue[cursor];
      for (const edge of this.edges.get(state) || []) {
        if (visited.has(edge.to) || state === from && firstEdgeAllowed && !firstEdgeAllowed(edge)) continue;
        visited.add(edge.to); predecessor.set(edge.to, { from: state, attemptId: edge.attemptId });
        if (edge.to === to) {
          const path: string[] = []; let at = to;
          while (at !== from) { const step = predecessor.get(at)!; path.push(step.attemptId); at = step.from; }
          return path.reverse();
        }
        queue.push(edge.to);
      }
    }
    return null;
  }
}
