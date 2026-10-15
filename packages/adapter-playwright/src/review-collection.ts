import { canonical, type ExplorationCollection } from '@interaction/core';
import type { Observation, Region } from './types.js';

/** A shared observed owner organizes review; it is not a business equivalence claim. */
export function reviewCollection(o: Observation, region?: Region, boundary?: Region): ExplorationCollection | undefined {
  if (!region) return undefined;
  const owner = (r?: Region) => r && ({ key: r.key, instanceId: r.instanceId, selector: r.selector, role: r.role, label: r.label, parentKey: r.parentKey });
  const facts = JSON.parse(canonical({ url: o.url, instanceScope: o.instanceScope, owner: owner(region), boundary: owner(boundary) }));
  return { key: canonical(facts), label: (region.key === 'document' ? boundary?.label : '') || region.label || region.role,
    evidence: [{ source: 'adapter-playwright', rule: 'observed-owner-review-collection/v1', facts }] };
}
