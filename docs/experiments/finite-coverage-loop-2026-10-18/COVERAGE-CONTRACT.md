# Finite UI coverage contract (implementation in progress)

`finite-ui-v1` is an explicit caller-selected sampling policy persisted on sessions and observations. It is not the default for retained tasks. The old 217-row ledger, including all 164 remaining required rows, is retained unchanged in the source archive. `legacy-164.json` enumerates each outstanding row, reason, source, attempt and route. `legacy-condition-explanation.json` explains each resolvable source projection and the proposed finite key without granting historical completion or modifying the old task.

A finite operation unit includes page URL and declared context, uniquely referenced target, operation and finite input/option, target constraints/options, semantic owner/form binding, and the target's activation state (expanded/pressed/checked for activation). Field-setting operations have their destination sample in the operation key; their starting value does not create a fresh obligation. New controls, choices, constraints or activation branches remain mandatory. Other selectors remain exact observation evidence and a separate condition-combination inventory; executing one sample does not prove their independence or cover their combinations. Unknown JavaScript dependencies and unbounded input values remain unproved.

Three separate references are retained:

- Navigation grouping: observable URL, interactive inventory, enablement/visibility, editable values, selectors, constraints/options, menus and modal boundaries. Native readonly input names/values are omitted only from navigation grouping. No general numeric-text replacement or site-specific URL normalization is used.
- Target reference: existing SDK identity/correspondence, refined by same-document instance binding for symmetric controls. A same-name replacement does not inherit the old node's work. Unproven correspondence after replacing symmetric instances is a gap.
- Obligation reference: immutable plan item and retained discovery/attempt evidence. Only SDK-verified receipt completion discharges it. A navigation match alone cannot do so.

The condition-key encoding remains compatible with existing scheduling APIs; the embedded source observation and branch policy identify `finite-ui-v1`. Loading an old observation never implicitly opts it into the new policy. Fresh finite sessions require caller opt-in. A future live migration must retain old duties as separately reported conditional coverage and cannot relabel their success. This implementation currently offers read-only migration explanation and new finite runs, not automatic live conversion.

Local simulation authorization is a caller-supplied exact loopback URL. It is checked independently of task prose and model decisions, and requires a native form-submitting click with matching form destination. Submission risk remains visible; effects remain unassessed. This grants no external business transaction authority.

# Experimental mechanism correspondence

| Experiment mechanism | TypeScript mechanism | Verification boundary |
| --- | --- | --- |
| `NormalizedFactory.Vertex` custom state equality | `finiteNavigationState` through `browserStateGrouping` | Graph index only; raw observation retained |
| Native unexplored candidates and graph paths | Existing persisted Explorer plan, graph/checkpoints and route scheduler | No fixed website route or expected answer list in plugin |
| Native replay of previously executed entrance | Existing prerequisite dispatch/repetition proof and route ledger | Recovery has separate receipts and action cost |
| Strict target-arrival audit | SDK target correspondence and `browserTargetConditions` | Current target + condition checks after return |
| Concrete pending-child audit | Immutable item source, successful child receipt and independent DOM event audit | Entry alone cannot complete child |
| Positive/negative normalization samples | `finite-coverage-contract.test.ts`, readonly-label regression and bounded local run | Changing actionable content or missing target remains distinct |

This is an independent implementation using the existing TypeScript engine, not a port of Crawljax source. No upstream Java source is included in product files. Experimental A's numeric-text generalization and OKX URL-specific rules are deliberately absent. FRAGGEN is outside this implementation.
