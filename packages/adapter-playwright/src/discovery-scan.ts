import { z } from 'zod';
import type { Observation } from './types.js';

const text = z.string().trim().min(1);
export const discoveryScanBudgetSchema = z.object({
  offset: z.number().int().min(0).max(1000000).default(0),
  elements: z.number().int().min(1).max(5000).default(1000),
  templateNodes: z.number().int().min(100).max(500).default(100),
  templateDepth: z.number().int().min(8).max(20).default(8),
  collections: z.number().int().min(300).max(1000).default(300),
}).strict();
export const supplementDiscoverySchema = z.object({ observationId: text, targetId: text, source: text,
  evidence: z.array(text).min(1).max(100), budget: discoveryScanBudgetSchema }).strict();
export type SupplementDiscoveryInput = z.input<typeof supplementDiscoverySchema>;
export type DiscoveryScanBudget = z.infer<typeof discoveryScanBudgetSchema>;
export interface DiscoveryScanTarget { id: string; selector: string; tag: string; label: string; elementCount: number }
export interface DiscoveryOmission {
  kind: 'template_nodes' | 'template_depth' | 'row_window' | 'collections';
  ownerId: string; ownerSelector: string; rowId?: string; rowSelector?: string;
  limit: number; observed: number;
}
export interface DiscoverySnapshot {
  version: 'dom-discovery/v1'; topologyKey: string; nodeCount: number;
  signal: { baselineLimit: number; scanned: number; omitted: number;
    firstOmitted?: { id: string; selector: string; index: number; parentId?: string } };
  structural: { templatesTruncated: number; collectionsTruncated: boolean; rowWindowsTruncated: number;
    omissions: DiscoveryOmission[]; omittedLocations: number };
  controls: { discovered: number; collected: number; limit: number };
  targets: DiscoveryScanTarget[];
  supplement?: { requestId: string; targetId: string; budget: DiscoveryScanBudget; status: 'active' | 'invalidated'; reason?: string };
}
export interface DiscoveryScanPlan {
  requestId: string; documentId: string; url: string; topologyKey: string; targetId: string; budget: DiscoveryScanBudget;
}
export interface DiscoveryScanRecord extends DiscoveryScanPlan {
  id: string; sessionId: string; observationId: string; source: string; evidence: string[]; at: string;
  status: 'active' | 'invalidated' | 'superseded' | 'failed'; resultObservationId?: string;
  invalidation?: { observationId: string; reason: string }; replacedBy?: string; error?: string;
}
export interface DiscoveryScanMaterial {
  sessionId: string; observationId: string; url: string; instanceScope: string;
  context: Observation['context']; gaps: Observation['gaps']; discovery?: DiscoverySnapshot; records: DiscoveryScanRecord[];
}
