# OKX run 4: read-only performance diagnosis

Source: `868e8b47afd31782161deba4f8bd7a14e0349430`; run `5f350d86-b9dd-43e5-ac07-43a79a9e30f0`. Metrics SHA-256 `6c36418ea49de897a7c13600ce05b7eea8c7af34cfa5c2b712132766b6526400`. No browser/provider was started. Offline reads used an exclusive temporary copy of the frozen engine database. Original and frozen files were not modified.

## What the live timings establish

Use nested engine/plugin event `data.at`, not the metrics wrapper timestamp: event delivery lagged as much as 9.6 seconds. Trade, 1h and 24h SDK actions took 4.656, 4.639 and 4.617 seconds. The ~14.6-second figure is start-to-start, not an idle gap: roughly 4.65 seconds SDK time, 7.3 seconds completed-to-next-selection and 2.6 seconds next-selection-to-SDK-start. There were no provider calls in these later intervals. SDK time includes dispatch, capture, persistence and hooks; this evidence does not isolate browser waits or CPU.

27 JEV calls used 17.181 seconds total provider time; no LLM calls. 22 were region reviews. Following SOURCE_REACHED, 21 region calls were applied in five batches (5/5/5/5/1), each followed by recapture. This follows the interface-only review batch limit of five, not proof of repeated identical model questions. The returned-page region phase lasted about 44.5 seconds; provider time alone does not explain that elapsed interval.

## Plan growth

Plan grew from 25 to 539 rows, with 514 new IDs. Of those, 447 first cite observation `5f80a3df-8355-444a-8499-4a625cb89577`, the broad page visible after returning out of the modal and finishing region review. This includes 183 `observed_in_scope` and 183 `operation_not_executed` rows sharing exact scope/operation-condition pairs, plus classification, basis, identity and blocked-operation obligations. These two reasons are distinct ledger roles created by step discovery and remaining-scope auditing; 366 rows are not 366 unique operations. Subsequent scroll/Trade/1h/24h observations add 8/25/1/30 rows, respectively. Raw scope equality is not sufficient proof to merge or discharge historical obligations.

## Synchronous offline baseline

Probe uses the final 539-row plan with pre-24h observation `d0b567f7-791f-49b5-9a0d-80a6cd81ed35` (292 controls, 207 current actions). It is not a reconstruction of the precise historic 509-row task. Two calls each are diagnostics, not a statistical benchmark. Row counts are decoded API records, not physical reads or peak memory. Driver starts: zero.

| Query | Elapsed ms, two calls | Key reads per call |
|---|---:|---|
| actions | 42.4 / 42.6 | all 11,450 historical actions to return 207 |
| controlInterpretationSnapshot | 121.8 / 96.4 | all 11,450 actions; 2 observations |
| actionAvailability | 138.0 / 125.0 | all 11,450 actions; 2 observations |
| explorationSnapshot, current only | 466.2 / 454.1 | all 11,450 actions; 24 observation reads |
| reviewGapChanges | 215.7 / 210.2 | all 11,450 actions; 5 observations |
| completedOperations | 208.8 / 207.6 | 12 observations; 148 action lookups |
| projectObligations | 2256.1 / 2264.1 | 83 observations; three full action lists (34,350 rows) |
| reviewRecoveryChanges, checkpoint | 815.3 / 813.8 | 16 observations; six full action lists (68,700 rows) |

The source confirms that `core.actions` and `captureCurrentFacts` list every action in the session before filtering by observation. This is a definite unnecessary decoded-row cost for current-only queries. The actual historical audit still needs the full history.

Other falsifiable experiments, deferred: request-local observation memoization in region review delta (currently one source load per changed region); retain bounded correspondence readers across request chunks instead of reconstructing the same current/source facts; evaluate larger guarded batches of clear interface-only region decisions while preserving stale/uncertain cutoffs. Do not cache permissions across awaits or turn failed equivalence into coverage. Same-frame reuse must retain freshness and memory bounds.

## Artifacts

- `/tmp/okx-run4-performance-readonly.json`: event timing and provider totals.
- `/tmp/okx-run4-plan-growth.json`: plan reason/pair counts.
- `/tmp/okx-run4-offline-profile.mjs`: reproducible offline probe.
- `/tmp/okx-run4-offline-profile.json`: all baseline API counts and timings.
- `/tmp/okx-run4-offline-profile.log`: probe output.
