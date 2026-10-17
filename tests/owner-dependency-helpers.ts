import type { Observation, OwnerDependencies } from '@interaction/browser';
import { createOwnerDependencyCodec } from '../packages/adapter-playwright/src/owner-dependency-codec.js';

type Captured = Pick<Observation, 'ownerDependencies'>;
/** Inspect a wire capture without changing its retained dispatch hash. */
export function readOwnerGraph(o: Captured): OwnerDependencies {
  const graph = o.ownerDependencies;
  if (!graph) throw Error('Fixture graph is missing');
  if (graph.version !== 'browser-owner-dependencies-v3') return graph;
  const decoded = createOwnerDependencyCodec().decode(graph);
  if (!decoded) throw Error('Fixture wire graph failed decoding');
  return decoded;
}
/** Only for deliberately mutated test clones, never persisted source receipts. */
export function mutableOwnerGraph(o: Captured): OwnerDependencies {
  const graph = readOwnerGraph(o); o.ownerDependencies = graph; return graph;
}
export function compactOwnerGraph(o: Captured) {
  const encoded = createOwnerDependencyCodec().encode(readOwnerGraph(o));
  if (!encoded) throw Error('Mutated fixture graph exceeds its wire contract');
  o.ownerDependencies = encoded; return encoded;
}
