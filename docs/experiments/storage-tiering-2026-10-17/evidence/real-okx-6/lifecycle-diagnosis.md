# Run6 obligation lifecycle and evidence diagnosis

Baseline source: `f6d7b9e2b427b5edf1fad359ecf8cc5a3df8ffcf`. Run: `f581575e-64ad-4983-8627-462c51067509`. This is a frozen-evidence reconstruction and small offline completion regression, not a browser run or a performance measurement. The original and frozen databases were never passed to an SDK constructor. SDK reads used a complete private frozen-6 copy; both original SQLite SHA-256 values remained unchanged. Inputs, source hashes, original diagnostic programs and outputs are retained in [lifecycle-review](./lifecycle-review/README.md).

## What the 174 rows mean

The plan grew 543 → 721. Four new `observed_in_scope` items succeeded; the other 174 were unresolved: 173 `region_review_required` and one `pointer_intercepted`. All 174 were first recorded from observation `c11abe9e-e2a4-44f2-bf53-64ebf22a1dd2`, after the source return and before Trade. They are not 174 repeated executions or 174 proved equivalent obligations.

The independent [row-level extraction](./plan-growth-diagnosis.json) partitions the 174 as follows:

| Retained relationship | Rows | Interpretation |
| --- | ---: | --- |
| Same complete public scope and same scheduling key | 14 | New mechanical reason differs from retained `observed_in_scope`, `operation_not_executed`, or interception history. No old row has the same reason/scope/key triple. |
| Same complete public scope, different scheduling key | 116 | The measured key difference is the capture-specific owner instance embedded inside `scope.stableKey`; the public record/target binding has not changed. This is key churn, not an SDK equivalence proof. |
| No retained equal complete scope | 44 | Includes new coin pairs and changing price labels. Sixteen have a native operation-reference hint, which still does not prove completion. |

Every one of the 174 has unverified branch/source conditions and unavailable target conditions. The correct reduction target is unnecessary scheduling duplication while preserving these unfinished source obligations. Collapsing all 174 as equivalent, or declaring old coverage from their labels/hashes, would be unsound.

## Exact lifecycle path

`auditRemainingScopes` audits operation candidates within an accepted broad scope. It excludes current proved completion and already-tried work; unknown navigation creates an independent unknown obligation. Unsupported classification/operation basis creates its own review obligation. For an ordinary unexecuted candidate, `unexecutedAction` supplies the first current availability blocker, then `gap` receives the complete operation scope, scheduling key, and current observation reference.

In the baseline, `gap` identifies an item with `{reason, scope, operationConditionKey}`. A changed reason therefore creates another row even when the scope/key match. Identical triples already append another source to `PlanItem.evidence[]`: the data model already supports multiple sources. The missing distinction is between an unfinished operation and its changing availability explanation; adding a second generic source table is not a prerequisite.

The control review ledger is not the owner of these 174 concrete operation rows. Its negative-classification reconciliation covers review targets without an operation kind. `remapStoredScopes` and source recovery repair retained hints/references; they do not prove a new document equivalent to an old source. Run6 emitted no `scope.remapped`, `operation.conditions_migrated`, or `scope.source_recovered` event. The `projectObligations` alias path requires fresh SDK evidence; the unverified scheduling key does not satisfy it.

The withdrawn run4 same-frame prototype does not solve this case. It saved one row in the first observation, then the next observation had no correspondence proof and created an independent gap; its final saving was zero. The present 14 rows expose a different lifecycle issue: changing mechanical availability can be retained as evidence about unfinished work, provided all sources remain binding completion requirements.

## Why source conditions are unavailable

The captured page has empty known context, no critical observation gap, 26 selector controls, and no missing check/selection state. The selector limit is not exceeded. Two hidden “Open sub-menu” selectors carry unresolved hypotheses (`a9fa43d1-bbc0-48e2-bf9c-2f7f7eb8d90d` and `635bfd2b-2759-4a6a-bf21-247ef2e10a34`) and share the same portable binding. Their unresolved binding is already sufficient to reject branch conditions; the duplicate binding is an additional ambiguity. Pure baseline `browserBranchConditions` is unavailable for all 206 captured actions. See [mode-gaps.json](./lifecycle-review/mode-gaps.json).

This does not justify omitting hidden selectors, nearby-only dependency checks, or treating identical labels as identity. A nonlocal mode can change an operation without moving its control. A minimal key correction may remove a proven redundant capture owner token from a versioned scheduling representation while retaining structural owner/record/template/slot semantics. It must leave these branch conditions unverified and must not change execution or correspondence permission.

## The 26 JEV requests and safe reuse

All 26 calls were applied: 21 region reviews, one control classification, one identity review, one control risk review, and two probe risk reviews. The 21 region calls use 21 distinct candidate IDs: one dialog and twenty page regions. The twenty page regions were processed in four batches of five; the later batches retain the earlier regions. This is not evidence that the same current candidate was repeatedly questioned. The independent [review-cost report](./review-cost-diagnosis.md) joins calls, records and invalidation events.

The private SDK reconstruction finds 18 retained region-review records containing 157 regions, 13 records predating this run, and **zero explicit reuse policies**. Therefore no old region was eligible for the existing reusable-region contract. Counterfactual condition comparison finds four current region judgments with equal complete old/current conditions, ten with only the structural-item owner token differing in member stable keys, and seven with unavailable conditions. These are diagnostic opportunities, not retroactive authority. The ten differences are recorded field by field in [region-differences.json](./lifecycle-review/region-differences.json).

The safe next step is explicit, scoped reuse only for future freshly approved regions, through the SDK's complete membership, uniqueness, context and rule checks. A versioned portable structural binding can address the ten owner-token cases after its redundancy is proved. Missing bindings, active modal regions, changed members, changed context and ambiguity still require fresh review. No region include judgment means an operation was executed.

For the generic “Don't show for 7 days” wrapper, portable classification identity and condition keys match five historical records, but all of those records classify it as `interaction`. Existing reusable classification deliberately accepts original display/container interpretations. The extra interaction review was not a rejected valid negative proof. Positive interpretation reuse would require a separate contract and must not become click/probe permission. Wallet and generic probe evidence remain missing; classification correspondence cannot settle their operation risk.

## Completion precondition for availability aggregation

The baseline direct completion path had a concrete safety defect independent of the proposed aggregation. `recordOutcome` could mark a derived row succeeded from a current successful attempt when its full scope and bound scheduling key matched, without proving all retained discovery sources. The step can select both old and current matching rows, so the issue already affects separate rows; it is not introduced only by appending sources to one row.

The new independent test uses two observations A/B with equal public scope/key, an unresolved nonlocal mode and SDK equivalence=false. It calls the actual `recordOutcome` method. A complete isolated `git archive f6d7b9e` with private workspace links reproduces **5 failures / 3 passes**: old A, aggregate A+B, shared-name/shared-identity historical targets, and prior unknown/executing history are incorrectly completed by B. Exact B receipt, literal user one-shot intent, and SDK-positive correspondence pass. Baseline source and test hashes are recorded in [baseline-8-manifest.json](./lifecycle-review/completion-regression/baseline-8-manifest.json); the expected failures are preserved in [baseline-8.log](./lifecycle-review/completion-regression/baseline-8.log).

The working-tree source completion gate passes those eight cases. Two additional cases retain unknown/executing history present only in `item.attempts[].evidence`; coverage reconciliation must inspect that ledger too, rather than bypassing the direct gate. With both paths checked, the current targeted test is **10/10**. The initial eight-test green file originally had a misleading `/tmp/...baseline.log` filename; it is explicitly archived as [working-tree-gate-8.log](./lifecycle-review/completion-regression/working-tree-gate-8.log), not as baseline evidence. A transient concurrent-edit syntax failure and the subsequent successful ten-test run are also retained.

For a derived obligation, every retained discovery source and previous attempt-before source must have an exact successful receipt for its session/observation/action, or fresh SDK operation correspondence to such a receipt. The current after-observation need not retain the same control: navigation may remove it. Unknown/executing receipts cannot be converted to success. Literal user one-shot intent keeps its separate fulfillment semantics. Reaching a source page and matching a scheduling key remain insufficient.

## Minimal aggregation boundaries

- Treat only mechanical availability explanations as updates to unfinished, required, derived operation work: ordinary not-executed, region-not-reviewed, pointer interception, scroll/boundary access, and supported control readiness. Require a unique current action and a complete matching scope/key policy; preserve each source reference and reason change in the audit log.
- Keep unknown outcomes, checkpoint/source verification debts, capability gaps, classification/purpose/risk review, identity uncertainty, exclusions, sampling, and repetition permission separate. Do not fold attempted/completed/migrated/superseded rows into a new availability owner.
- Preserve historical rows, attempt records and route retry debt. The fourteen historical rows need not be deleted or relabeled. A future availability update can choose an unfinished scheduling owner while retaining every source and enforcing the completion rule above.
- Distinct prerequisites or route paths are not equivalent merely because the operation key matches. Either require equal prerequisite meaning for aggregation or retain each source/path explicitly and keep route budgets independent. Recording a new path only in an event does not authorize it as an executable prerequisite.
- Test same-name A/B controls and nonlocal mode changes with SDK=false, unknown history in either ledger, changed scope/value/record/context, ambiguous current actions, changed availability reasons, exact local receipts after navigation, and explicit positive SDK correspondence. Reuse and reduced row counts must never be asserted as coverage.

These are proposed and independently tested boundaries, not a claim that the real task is exhausted or that the next live visit will avoid every review. Final integration and live behavior require the separately frozen product revision and subsequent acceptance window.
