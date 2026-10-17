# Validation reads omit unused owner graphs

This patch removes owner/dependency graph construction from five fresh DOM validation paths: discovery validation, preflight, dismissal validation, traversal scroll validation and controlled scroll validation. Existing DOM/context/boundary guards are unchanged. `readDOM` defaults to collecting the graph, both persistent capture paths explicitly keep it, and discovery invalidation recursion preserves the requested flag. No deferred asynchronous graph capture or stale graph cache is introduced.

The six new local tests passed on their first run. They compare every returned DOM field except the optional graph, along with the instance counter; compare normal validation results to the same methods forced to collect their graphs; verify stale dismissal still rejects; verify normal/detailed capture persists the final sample’s graph; and verify discovery recursion stays disabled. The detailed-capture fixture changes a parent binding between samples and confirms the persisted graph belongs to the final sample.

A single test-only diagnostic instrumented the real serialized collector in disposable local browsers. Each of the five successful validation calls changed from one forced-on collector invocation to zero, avoiding a total of 26,658 bytes of graph JSON in that fixture. The additional stale-dismissal case also avoided one 5,322-byte graph while returning the same rejection. These are graph payload sizes, not database savings.

| Local page | Controls | Graph JSON bytes | Capture result | Preflight collector calls off / forced on |
|---|---:|---:|---|---:|
| Complete small graph | 3 | 3,480 | Complete | 0 / 1 |
| Complex shared owner | 200 | 334 | Explicit `byte_budget`, empty incomplete graph | 0 / 1 |
| External hidden native field | 3 | 386 | Explicit `unretained_native_input` | 0 / 1 |

All three subsequent persistent captures still invoked the collector once. The 200-control case paid for a bounded construction attempt before rejecting; its small final graph payload does not imply cheap collection. The diagnostic records individual times only to locate cost: there are no repeat pairs, confidence intervals or real-site speed claims. Test instrumentation overhead, warm page state and fixed call order preclude such conclusions.

Raw log, one compact diagnostic JSON, exact command, source/artifact hashes and measurement boundaries are retained here. No full observations or prior fixtures were copied. Prior collection/graph/integration evidence remains in the earlier checkpoint folders. Root owns the separate existing regression/type-check record. The existing coverage timing concern between persistent before and actual dispatch is a separate investigation; this patch does not claim to fix it. Consumer closure serialization and review-source reads remain unchanged follow-ups.

Root additionally ran the existing document-operation-coverage (24), nonmodal-reentry (9), and observation-stability-window (5) cases once: 38/38 passed. Root/core type checks passed. `related-checkpoint.json` and `types-checkpoint.json` identify their exact commands and selected source hashes before/after. These checks verify persistent capture, nested reentry and coverage behavior affected by this change, not a full-suite or real OKX result. The starting commit was `8d7ef5c0431f82db4a95bb00a84052ae484dc968`; the original worktree, running resources and the two pre-existing untracked launch7 artifacts were preserved.

A separate one-case local counterexample has now confirmed the existing coverage timing concern: both forced-on and omitted preflight graphs allow a hidden parent binding to change A→B; the actual handler reads B while the retained before remains A. The current proof incorrectly accepts A. This optimization is therefore a scoped mechanism result only, not permission to merge or resume a real experiment. A separate dispatch-witness correction follows; its evidence must not be reported as part of this optimization's original checkpoint. Task database compression and full reads remain deferred.
