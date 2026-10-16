import { describe, expect, it } from 'vitest';
import { RecordedNavigationGraph } from '../packages/core/src/navigation-path.js';

function graph(edges: [from: string, to: string, attemptId: string][]) {
  const result = new RecordedNavigationGraph();
  for (const [from, to, attemptId] of edges) result.add(from, { to, attemptId });
  return result;
}

describe('recorded navigation route costs', () => {
  it('chooses a cheaper longer route while leaving default BFS unchanged', () => {
    const routes = graph([['root', 'target', 'slow'], ['root', 'menu', 'open'], ['menu', 'target', 'fast']]);
    const costs: Record<string, number> = { slow: 12, open: 2, fast: 3 };
    expect(routes.path('root', 'target')).toEqual(['slow']);
    expect(routes.path('root', 'target', undefined, edge => costs[edge.attemptId])).toEqual(['open', 'fast']);
  });

  it('revises an expensive discovery before settling the destination', () => {
    const routes = graph([['root', 'a', 'ra'], ['root', 'b', 'rb'], ['b', 'a', 'ba'], ['a', 'target', 'at'], ['b', 'target', 'bt']]);
    const costs: Record<string, number> = { ra: 8, rb: 1, ba: 1, at: 1, bt: 20 };
    expect(routes.path('root', 'target', undefined, edge => costs[edge.attemptId])).toEqual(['rb', 'ba', 'at']);
  });

  it('preserves discovery order on ties and default BFS behavior under equal weights', () => {
    const routes = graph([['root', 'a', 'ra'], ['root', 'b', 'rb'], ['a', 'target', 'at'], ['b', 'target', 'bt']]);
    expect(routes.path('root', 'target')).toEqual(['ra', 'at']);
    expect(routes.path('root', 'target', undefined, () => 1)).toEqual(['ra', 'at']);
    routes.upsert('root', { to: 'a', attemptId: 'ra' });
    expect(routes.path('root', 'target', undefined, () => 1)).toEqual(['ra', 'at']);
  });

  it('handles zero costs, cycles, already reached and disconnected destinations', () => {
    const routes = graph([['root', 'a', 'ra'], ['a', 'root', 'ar'], ['a', 'b', 'ab'], ['b', 'a', 'ba'], ['b', 'target', 'bt']]);
    expect(routes.path('root', 'target', undefined, () => 0)).toEqual(['ra', 'ab', 'bt']);
    expect(routes.path('root', 'missing', undefined, () => 0)).toBeNull();
    expect(routes.path('root', 'root', undefined, () => 0)).toEqual([]);
    expect(routes.path('absent', 'target', undefined, () => 1)).toBeNull();
  });

  it.each([-1, NaN, Infinity, -Infinity])('rejects invalid cost %s', cost => {
    const routes = graph([['root', 'target', 'edge']]);
    expect(() => routes.path('root', 'target', undefined, () => cost)).toThrow(RangeError);
  });

  it('rejects overflow instead of treating an unrepresentable sum as unreachable', () => {
    const routes = graph([['root', 'a', 'ra'], ['a', 'target', 'at']]);
    expect(() => routes.path('root', 'target', undefined, () => Number.MAX_VALUE)).toThrow(/overflow/);
  });

  it('applies current first-edge eligibility before costs, without blocking later edges', () => {
    const routes = graph([['root', 'target', 'blocked'], ['root', 'menu', 'allowed'], ['menu', 'target', 'later']]);
    const calls: [string, string][] = [];
    expect(routes.path('root', 'target', edge => edge.attemptId === 'allowed', (edge, from) => {
      calls.push([edge.attemptId, from]); return 1;
    })).toEqual(['allowed', 'later']);
    expect(calls).toEqual([['allowed', 'root'], ['later', 'menu']]);
    expect(routes.path('root', 'target', () => false, () => 1)).toBeNull();
  });

  it('updates and removes individual attempts without leaving stale source edges', () => {
    const routes = graph([['root', 'a', 'mutable'], ['a', 'target', 'at'], ['root', 'b', 'rb'], ['b', 'target', 'bt']]);
    routes.upsert('root', { to: 'missing', attemptId: 'mutable' });
    expect(routes.size).toBe(4);
    expect(routes.path('root', 'target')).toEqual(['rb', 'bt']);
    routes.upsert('other', { to: 'target', attemptId: 'mutable' });
    expect(routes.path('root', 'missing')).toBeNull();
    expect(routes.path('other', 'target')).toEqual(['mutable']);
    expect(routes.remove('mutable')).toBe(true);
    expect(routes.remove('mutable')).toBe(false);
    expect(routes.size).toBe(3);
    expect(routes.path('other', 'target', undefined, () => 1)).toBeNull();
    routes.remove('rb');
    expect(routes.path('root', 'target')).toBeNull();
    routes.clear();
    expect(routes.size).toBe(0);
    expect(routes.path('b', 'target')).toBeNull();
  });

  it('matches independently relaxed minimum costs on cyclic and converging graphs', () => {
    let seed = 58127;
    const random = (max: number) => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % max; };
    for (let sample = 0; sample < 40; sample++) {
      const routes = new RecordedNavigationGraph();
      const edges: { from: string; to: string; attemptId: string; cost: number }[] = [];
      for (let i = 0; i < 55; i++) {
        const edge = { from: `${random(12)}`, to: `${random(12)}`, attemptId: `a${i}`, cost: random(11) };
        edges.push(edge); routes.add(edge.from, edge);
      }
      const costs = new Map(edges.map(edge => [edge.attemptId, edge.cost]));
      const distances = new Map([['0', 0]]);
      // Bellman-Ford relaxation is deliberately independent of the queue and
      // predecessor mechanism used by the route implementation.
      for (let pass = 0; pass < 11; pass++) for (const edge of edges) {
        const candidate = (distances.get(edge.from) ?? Infinity) + edge.cost;
        if (candidate < (distances.get(edge.to) ?? Infinity)) distances.set(edge.to, candidate);
      }
      for (let destination = 0; destination < 12; destination++) {
        const path = routes.path('0', `${destination}`, undefined, edge => costs.get(edge.attemptId)!);
        expect(path === null ? Infinity : path.reduce((total, attemptId) => total + costs.get(attemptId)!, 0)).toBe(distances.get(`${destination}`) ?? Infinity);
        expect(routes.path('0', `${destination}`, undefined, () => 1)).toEqual(routes.path('0', `${destination}`));
      }
    }
  });
});
