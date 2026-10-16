# Bounded alternative recovery routes

Baseline: `075b3fc03c7b446795bf4f792c2495608d52bcdc`. The baseline is an independent `git archive` with the final test file copied into it, not a live swap of the working engine. The test SHA-256 and baseline engine provenance are recorded in [files.json](evidence/recovery-routes/files.json). Only disposable fixture HTTP servers, browsers and SQLite directories were used.

## Implementation

- Keep strict observation graph keys and exact endpoints. Grouping is not arrival proof.
- Build one graph snapshot per recovery. Store outgoing edges in mutable arrays and use an enqueue-once BFS with predecessor links instead of copying each partial route and shifting the queue.
- On a known route failure, retain a `checkpoint.path_failed` event with the historical route, step where replay stopped, actual resulting observation, actual new attempts and reason. Replan from the actual observed source. A final target miss is not attributed to the last historical edge as a globally invalid edge.
- Permit at most four candidate plans. Filter unusable first steps before spending those plans: unique current matching, context and current/historical replay permission, plus target-directed repetition proof. Duplicate unusable historical proofs cannot consume all plans before a usable route. If the unfiltered graph has a route but no current first step is usable, stop rather than introduce entry/reset fallback.
- Each replayed step checks current as well as historical replay permission; the existing explicitly confirmed reset permission remains separate. Each dispatch still checks current execution constraints; target-directed replay also uses the existing atomic repetition-source checks. Each success still requires the existing independent target/checkpoint verification.
- Suppress re-dispatch of the same operation from the same exact observed source, instance and target conditions during this recovery. Duplicate historical success records cannot authorize another identical failed click. This suppression is not persistent coverage or an A/B equivalence decision.
- Unknown/unverified dispatch results stop alternative execution. Session action/time budgets remain applicable. Exhausting recorded alternatives does not cause an additional entry reset.

## Causal results

The identical final [test file](../../../tests/recovery-route-alternatives.test.ts) has **3/11 passing on baseline, 11/11 after**. Of those, six are positive recovery cases: baseline **0/6**, after **6/6**.

| Case | Baseline | After | Physical evidence |
| --- | --- | --- | --- |
| Stale direct route, target arrival | Unreachable | Target reached | Route 0 once, then Route 1 once |
| Stale direct route, strict checkpoint | Unreachable | Checkpoint verified | Same two actual clicks |
| Stale nested route, target arrival | Unreachable | Target reached | Open once, Route 0 once, Route 1 once |
| Stale nested route, strict checkpoint | Unreachable | Checkpoint verified | Same three actual clicks, no repeated prefix |
| Duplicate old success proofs for the stale route | Unreachable | Target reached | The stale operation still executes only once |
| Five retained proofs for a route whose current replay permission is withdrawn | Unreachable | Target reached | Skip all five without dispatch; execute the valid other route once |
| Unknown post-click observation | Stops | Stops | Only Route 0; unknown attempt is retained |
| Alternative loses replay permission | Stops | Stops | Only Route 0; alternate is not dispatched |
| Strict recovery: current alternate permission withdrawn, historical permission retained | Stops | Stops | Only Route 0; new alternate search cannot execute Route 1 |
| All six recorded routes are stale | Stops at first | Stops after four distinct plans | Four clicks, no entry reset, target remains unexecuted |
| Action budget allows one more operation | Stops at first stale route | Stops at budget | One click, then `BUDGET_EXHAUSTED` |

The last two baseline assertion failures are absent new scheduling behavior, **not evidence that baseline violated budgets**. No test executes the `Amount` target merely to claim arrival.

[Baseline log](evidence/recovery-routes/baseline.log), [after log](evidence/recovery-routes/after.log), [regression log](evidence/recovery-routes/regression.log), [summary](evidence/recovery-routes/summary.json).

The final focused regression passed **2 files / 20 cases**, including all 11 new cases and 9 exact graph cases. Two earlier implementation regression batches passed 5 files / 43 cases and 4 files / 25 cases; these predate the final first-step and current-permission refinements. They overlap and must not be added as independent samples. They include target arrival, strict recovery, native history return, plugin unknown-outcome debt, scope-source recovery and input reachability. Final TypeScript checking passed. Broader final validation is reported by the parent experiment.

An additional [standalone runner](evidence/alternative-input-runner.ts) dynamically imports the selected source root and independently verifies that the restored target remains interactive. It covers direct/nested routes × target/strict recovery (four cases). The identical runner reports baseline **0/4 arrival and 0/4 continued interaction**, current **4/4 arrival and 4/4 continued interaction**. After confirming that recovery itself made zero `Amount` attempts, it performs a new guarded SDK fill; all four current cases report an actual succeeded attempt, DOM input value `42`, and a separate fixture `input` event with value `42`. This demonstrates usable interaction, not only a reported arrival status. The nested prefix is physically opened once. These cases overlap the mechanisms above and are not independent real-site samples.

[Baseline interaction results](evidence/recovery-routes/interactive-baseline.json), [current interaction results](evidence/recovery-routes/interactive-after.json). Each result includes the runner and engine SHA-256. Reproduce with Node 24:

```sh
pnpm exec tsx --conditions=development docs/experiments/incremental-recovery-2026-10-17/evidence/alternative-input-runner.ts /absolute/source/root /absolute/result.json
```

The four current fixture recoveries took 606–714 ms. They ran alongside other validation; these timings are retained observations, not real-site latency estimates or a fair successful-recovery speed comparison with a baseline that returned unreachable.

## Algorithm benchmark and limits

[The reproducible benchmark](../../../scripts/benchmark-navigation-path.ts) compares the old and new BFS over identical already-built adjacency lists and asserts that the chosen route is identical. Node `v24.22.0`, seven measured runs, median:

| Graph | Previous | Current |
| --- | ---: | ---: |
| 4,000-edge chain | 8.71 ms | 0.64 ms |
| 38,480-edge converging graph | 4.01 ms | 0.46 ms |

[All samples](evidence/recovery-routes/navigation-benchmark.json). This is a route-search benchmark, not an observation/SQLite/browser/end-to-end speedup. Successful alternate recovery can require more time and more clicks than immediately returning unreachable.

This change does not invent routes when none were observed, use approximate visual state as arrival, maintain persistent route reliability weights, or eliminate history scans across separate recovery calls. If the actual post-failure observation has no exact graph path, recovery still stops. Real-site success rates and latency remain to be measured separately. A recovered target is not coverage; unknown result records remain unknown and require the existing explicit recovery-verification contract.
