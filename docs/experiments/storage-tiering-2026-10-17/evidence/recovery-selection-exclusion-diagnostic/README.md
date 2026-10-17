# Frozen run12 exclusion diagnostic

One authorized offline run of product `551a6b9020b919862434346d276a21fe3d1f4ac1`, with a 240-second worker deadline. It completed and cleaned its owned archive/database copy. No original database was connected, no browser was created/connected, no service was changed, and no product file was edited by this tool.

The 42 exact-match instrumentation replacements apply only to the owned archive's `packages/explorer-plugin/src/runtime.ts`. The emitted patches and hashes are in `result/`. SDK/store/adapter implementations retain their original identities. Existing epoch-worker guards, query-only mode, cancellation and process cleanup are reused. InspectionCoordinator's timer remains enabled; constructor changes and subsequent query changes are separate. Extra explanatory reads/projections and 57 checkpoint strategy assessments make this a diagnostic, not a performance comparison.

## Findings

- All 1,241 plan rows received a final disposition; 1,169 entered pending. All 4,927 actual candidate begin/end pairs match in order. The 4,860 projection-cache hits match the earlier speculative projection's item/source/result; none was mismatched. This confirms faithful reuse for this sample, not correctness of each original predicate.
- Actual candidate exclusions: 4,770 missing browser target conditions, 72 current review occurrences, 27 ambiguous action matches, 2 unavailable review targets, 35 spent retry conditions, 20 unverified route conditions, and 1 checkpoint with no known path.
- Of 72 current-review exclusions, only 6 have a source/current pair with equal portable classification identity and condition keys. In 56 cases both sides have projections but differ; 10 lack a projection on at least one side. There are 64 cases with a scope-only current match and 8 with a retained-control match.
- Items `6278acdd-d142-40c0-89d1-15a5fea6995e`, `bf095644-b48f-42fd-8c21-3626ce9783a8`, and `946049d7-01aa-4709-a1ac-9e06280e1b82` use only URL/region/role. Each matches two historical controls and one current control by scope alone, with different portable identity and condition keys. This is concrete evidence that current presence does not establish the historical review condition.
- Four negative waits remain valid according to the existing predicate. They refer to the same retained source/control; its conditions equal the stored wait, and its source action list is empty. The stored material key was not revalidated. No historical review-material API was used, so these results do not prove the old negative material is still applicable.
- No actual candidate reached the current-policy-blocked predicate. This sample cannot establish policy-blocking behavior across changed conditions.
- The independent checkpoint query returned 37 `tryable` and 20 `no_known_path` results across 8 batches. Of the missing-target-condition exclusions, 812 actual item/checkpoint combinations span 287 items and all 37 tryable checkpoints. A tryable strategy is not verified arrival, legal target execution, or coverage.
- Current availability contains 3 executable actions out of 214. `scheduledRecovery` returning null does not imply `step` has no local work.

## Integrity and scope

The complete selection/callback/task/ordered-events/before-and-after-debt object equals the previous epoch result with **zero excluded fields**. The duplicate complete semantic file was removed; `execution.json` references the existing oracle. Plan, budget, usage, rounds/cursor and all eight old retry debts remain unchanged. The selection view was acquired and closed once; no selection or callback was present. Query-only SQL changes were zero, protected source hashes were unchanged, and both child exit and temporary-directory removal were confirmed.

Process time was 13.903 seconds, including a 9,679.6 ms instrumented selector and a 2,870.4 ms independent checkpoint-query stage. These durations only document the diagnostic boundary.

`result/analysis.json` contains aggregate counts and cross-tabs. `result/worker.jsonl.gz` is the sole full diagnostic trace, with actual/speculative labels, projection origins, IDs, minimal condition explanations and checkpoint assessments. `result/diagnostic-verification.json` records semantic equality and trace hashes. No complete source facts are duplicated.

## Separate contract question

At frozen runtime line 862, `browserTargetConditions` is required before the later choice between target arrival and strict checkpoint recovery (lines 1032–1035; dispatch lines 1255–1260). The adapter describes these conditions as a portable target projection. Strict checkpoint verification instead checks retained evidence, declared context, completeness, predicates and captured canonical state (`packages/core/src/engine.ts`, `verify`). Thus the current selector has no explicit checkpoint-only route for an operation whose target projection is unavailable.

This is a recovery-mode contract gap to validate separately, not grounds to delete the early gate. Existing tests intentionally reject missing nonlocal conditions, and retry-condition construction has its own conservative guards. A safe checkpoint-only mode would need distinct arrival semantics, preserved unknown/debt limits, strict verification and fresh post-arrival review without granting target equivalence or coverage. The 37 strategy hints alone do not prove such a mode would succeed. No extra test, selector run or product repair was performed for this question.
