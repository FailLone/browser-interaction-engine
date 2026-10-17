# One frozen post-fix verification

Product commit: `63c57e5b435864cf4948afe385b50e479e849a67` (including negative-wait commit `a77bdd6`). This was one authorized frozen run12 sample with the original 240-second bound. No baseline or candidate was repeated.

All archived product sources, SDK/store/adapter methods and prototypes remained unchanged. The reused epoch worker only gained outer forwarding/counters for optional `recoveryReviewMaterial` and `reviewMaterial`. The exact worker patch and source hashes are recorded in `result/`. No old predicate diagnostic was injected. Only the owned engine database copy was opened, and browser launch/connect entry points were blocked. InspectionCoordinator's timer remained enabled, so not every internal cost is separately attributable.

## Result

The selector returned unresolved USD classification item `92e78cad-25e8-495e-a317-6194ec309298`, source `ba4f54b4-e386-4b61-b194-abf9a5436812`, checkpoint `733cc84c-3ed5-4df6-97c1-606901bf6e66`. Its actual pure `revalidate` callback passed. The selection uses the strict checkpoint contract (`targetActionIds=[]`, `returnToSource=false`); it was not dispatched.

The old diagnostic establishes the concrete change: this item had 24 ordered checkpoint candidates, but old code visited only the first, source `b0381d61-11e9-451a-9d0c-7859f4dcc8cc`. That first source genuinely had the same portable classification conditions as the current occurrence, but `stop:true` ended the entire historical scan. The repaired selector continued to the original second candidate and selected it. This demonstrates recovery of previously skipped scheduling work; it does not demonstrate actual checkpoint arrival or new UI coverage.

The original 1,241 plan rows, budget, usage, rounds/cursor and all eight old retry debts are unchanged. Compared with the old full semantic result, only selection, callback, task scheduling and ordered events differ. The complete new result is saved once as `semantic-27d6950b8adaaac7a7cfbe55950aa2ea37dd90da43446db45ad00216d6edba97.json.gz` (625,192 bytes); its compressed and uncompressed hashes were independently checked.

## Observed work and time

| Stage/read | Actual result |
| --- | --- |
| Worker process | 8,748.6 ms, exit 0 |
| Selector | 7,249.2 ms |
| Pure selected revalidation | 176.9 ms, passed |
| Selection view | Acquired once, closed once |
| Selector source material | 66 calls, 39 distinct sources, 27 repeats; 13,836 returned actions |
| Selector anchors | 35 calls, 35 distinct sources |
| Selector review material | 1 forwarded call, 234 returned controls |
| Selector checkpoint strategies | 1 call, 8 checkpoint IDs |
| Revalidation | 1 fresh source read (206 actions), 1 checkpoint assessment |
| Availability | 1 outer setup read and 1 materialization within view creation |

The earlier epoch sample's selector took 8,526.2 ms and made 91 source reads. This run returns a candidate earlier, so the decrease in time/read count is **not evidence of a pure algorithmic speedup**. Published deferral events fell from 55 to 11, but they count newly changed output rows, not all processed items. Inclusive nested times must not be added. Internal SDK/raw SQL read counts were not measured.

## Integrity and limits

Query-only SQL changes were zero after construction (SQLite constructor cumulative changes 1; SQLite plus engine cumulative changes 2). Original protected hashes, scripts and archived sources were unchanged. The database handle was closed, PID 12920 was independently confirmed absent, and the owned temporary directory was removed. No browser, service, original task database, product file or test was changed by this verification.

The new review-material reader was exercised, but this alone does not prove that all four historical waits were invalidated. The selected checkpoint's prior SDK assessment was an entry-replay strategy hint; actual browser restoration and final dispatch validation remain untested here. Missing portable target conditions versus strict checkpoint recovery remains a separate contract question.

`result/analysis.json` summarizes checks and actual work. `result/report.json`, `result/verification.json`, and `result/execution.json` retain stage timing, full semantic difference paths and lifecycle evidence. The old diagnostic trace is referenced, not copied.
