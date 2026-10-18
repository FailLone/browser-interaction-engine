# Unified guarded fragment traversal

The human request on 2026-10-18 explicitly replaces the old exploration scheduler with one FRAGGEN-derived strategy. There is no normal/FRAGGEN switch and no fallback to the old quota scheduler. `programNavigation` remains a caller authorization contract, not a strategy selector. Finite coverage and full-checkpoint capture retain their separate evidence semantics.

## Implemented chain

| Stage | Product implementation | Evidence and limits |
| --- | --- | --- |
| Host fragments | `adapter-playwright/region-candidates.ts` | Actual ordered DOM trees rooted in existing semantic/layout suggestions; DOM ancestry, nearest candidate owner, bounded to 32 attempted roots, 2048 visited nodes, 256 nodes per root and 196608 estimated bytes. Failed/truncated roots grant no mapping. This replaces visual segmentation; no VIPS/APTED/image equality claim. |
| Guarded correspondence | `adapter-playwright/fragment-projection.ts` | Exact local ordered structure and complete local attributes/text, including hidden destinations; unique relative paths plus operation kind/value, binding, record/slot, all available observed selector modes, options, declared context, caller authority and rule version. Same structure alone never propagates access. |
| Access and propagation | `explorer-plugin/fragment-traversal-core.ts`, `fragment-traversal.ts` | Translated influence/factor/local and state choice formulas; actual durable succeeded attempts create immutable source events. Late registration imports access; live propagation uses event union. Direct and indirect access remain distinct; cycles/reloads cannot mint visits. |
| Reversible pruning | Same ledger, task header persistence | Current and retained ordinary targets read the same candidate access. Plan items retain IDs, scopes, original discovery evidence, pending status and unknown duties. No propagated success/coverage or fake attempt. Mapping changes create fresh projections; explicit edge revocation rebuilds access from source events. |
| Local selection | `selectFragmentWork` called unconditionally by runtime | Active boundary work and selected original continuation first; then fresh current candidates, with fragment influence × duplication factor. Unmapped candidates remain normal work. No four-action quota, page counter reset or forced remote switch. Captured exact-current-URL links defer ordinary preference without deleting their duties. |
| State selection and restore | `fragmentStateOrder`, existing `scheduledRecovery` and SDK | Recompute remaining registered candidate work and actual known one-command native-history route costs per state. Unreachable states are separate; unknown strict routes remain host-validated fallback paths in the same strategy. Every selected route is revalidated after awaits. Required entry/path actions bypass ordinary pruning; the original child still needs its own real SDK receipt. |
| Restart | Existing TaskWriter/ExplorerStore, new versioned task ledger | Bounded 2 MiB estimated metadata, 128 fragments, 4096 mapping edges and obligation associations, 256 states. Reaching a limit disables new optimization; it never deletes source evidence or pending work. Normal and dispatch-before-receipt process exits tested. |

`fragment.frontier`, `fragment.access_recorded`, `fragment.candidates_ranked` and `fragment.states_ranked` separate sampled/pruned work from actual execution and functional coverage. Every propagated prune includes immutable origin attempt IDs and explicit candidate mappings. The full ledger is available in the task export. Pruning is a sampling decision under observed conditions, not proof of hidden JavaScript state or exhaustive website behavior.

Complete canonical owner and guard strings use the lossless `deflate-raw/base64-v1:` representation. `fragment-material.ts` provides an exact audit decoder; no semantic normalization is involved. Full encoded equality is checked after hash lookup. The metadata limit applies to the encoded durable representation. A rejected large addition is recorded without globally disabling later additions that fit. Duplication weight is shared by every candidate owned by the same closest fragment, as in upstream; state influence includes negative actual-access scores.

## Removed strategy paths

Removed `selectObligation` and the four-action `localSelectionLimit`; removed both operation sample-priority functions and their runtime branches; replaced the conditional program/legacy selector with one `selectFragmentWork` call. Old `localSelections` fields may deserialize as ignored historical metadata. They are never consulted or updated as a quota. Retained cursor and route retry debt still serve the same strategy. Legacy tests asserting a forced remote turn or counter increments were migrated to the human-requested continuous-fresh-work behavior; SDK guard, original-child, unknown-outcome and await-invalidation assertions remain.

## Upstream attribution and deliberate changes

Fixed source and executable Java oracle: `/Users/xietian/Experiments/fraggen-port-evidence-20261018`. The oracle compiled 223 original Java files and matched 23 top-level outputs, including three state-selection cases. This is method-level evidence, not an OKX result.

The selected core is Apache-2.0 and its license is included under `docs/third-party/crawljax`. No VIPS, APTED, OpenCV or Java binary is bundled. The original's path-only `/buy`→`/sell` propagation, non-idempotent setters, failed-action access, stale unexplored latch, current-only distance-cache key and cached influence drift are deliberately not copied. Exact ordered-tree equality covers only the zero-distance structural case. Host semantic guards are stricter; missing correspondence loses an optimization and leaves work available.

## Validation status

Implementation tests include cross-page menu pruning with a unique destination; actual source return, repeated entry and independent original child receipt; different destinations/wrappers/order/options/modes/context/truncation and missing binding; two real executions of the same operation under different external modes; cyclic/late import, revocation and cold/warm equivalence; normal and abrupt real process restarts. The original program-navigation tests retain continuous new destinations and finite-exhaustion restoration. Full original local acceptance, frozen confirmation, 251-test baseline comparison and identical-budget OKX runs must be recorded in the final results before claiming migration validation complete.
