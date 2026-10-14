import type { SessionOptions } from '@interaction/browser';

/** Only for this repository's document-local React fixture, never a production default. */
export const testSiteProfile = {
  exploration: 'representative',
  contextRules: [],
  interfaceActions: ['rebuild', 'quick-market', 'reset-interface'].map(id => ({ stableKey: `id:${id}` })),
  reversible: ['amount', 'price', 'pair', 'unit', 'post-only', 'time-in-force'].map(id => ({ stableKey: `id:${id}` })),
  environmentReset: 'document-reload',
  // These deliberately non-convergent/ambiguous fixtures have their own regression tests.
  exclude: [{ stableKey: 'id:background' }, { stableKey: 'id:duplicate' }],
} satisfies Partial<SessionOptions>;
