# Run 7 route-selection diagnostic

The fixed `069b65b` → `cbd5b87` comparison preserves the complete selected result, task and ordered events in all 8 cross/within-version comparisons. Three serial fresh-process pairs show selector median **42.362 → 35.737 seconds (15.64% reduction)**. This is a controlled selector measurement, not a speed claim for the complete live run.

## Input and historical-state boundary

The live scope.audit sequence 5138 (00:55:36.104 UTC) to recovery.selected sequence 5369 (00:56:20.084) lasted 43.980 seconds. That bracket also includes obligation reconciliation, local ordering and persistence. ExplorerStore stores the latest task, not full historical task versions. The logs do not justify blindly deleting the last failed route to reproduce the original selected item.

The first negative sample deliberately uses the unmodified final task with the actual earlier observation `f6ad38c2-acb1-4801-9edb-6ec802ce8ae7` and recorded availability. Its already-advanced cursor skips the expensive sweep: SQLite 141.190 ms versus memory 89.478 ms. This sample is retained and is **not** evidence that the original 44-second cost disappeared.

The cursor-controlled case changes exactly `task.scheduling.cursor` to `5480402f-ee64-49fc-9f3e-1cfe5ffce00f`, copied from the actual last current selection (sequence 4918). The fresh-deferrals case additionally clears only `scheduling.deferred`, the scan-reason cache. Neither case deletes or resets routeRetries, unknown debt, the final failed route, plan occurrences or retained sources. Both are explicit counterfactuals, not exact history reconstruction.

The final failed route prevents assuming the original selected item. The controlled selector actually chooses `53cc4e09-7c99-43e6-bb57-272e46dbc6b3`, source `5f80a3df-8355-444a-8499-4a625cb89577`, checkpoint `b1e80845-ab4f-4c31-809d-ba37be180e92`; this complete choice is compared, not patched to match the live selection.

## Cost attribution

The cursor-controlled baseline takes 38.970 seconds with CPU profiling, versus 8.795 seconds with the exact same material served in memory. The complete outputs match. Timed readonly reads comprise 1,947 observation reads / 33 unique keys (24.276 seconds), 1,948 session reads / one key (0.111 seconds), and 656 action-list reads / 32 keys (0.462 seconds). These are real JSON/codec read costs in the isolated copy; the comparison must not attribute them all to scope projection.

The original production read methods and eight-entry scheduler LRU remain in the experiment. No SqliteStore or BrowserEngine constructor, migration or mutation runs. Only the ObservationObjectStore reader/cache and pure interactionTransition method are used. SQLite is readonly/query_only and total_changes is zero. The memory event sink records complete submitted payloads in order; it adds no wall-clock timestamp or SQLite sequence, and event SQL writes are outside this experiment.

Formal fresh-deferrals timings (unprofiled, serial AB order):

| Pair | 069 baseline seconds | cbd current seconds |
|---|---:|---:|
| 1 | 43.023 | 35.992 |
| 2 | 42.362 | 35.732 |
| 3 | 42.232 | 35.737 |

Median ratio: 0.843616. All comparison gates precede summary aggregation. The cursor case emits 3 events; fresh-deferrals emits 270 events in both versions.

Formal fresh-deferrals grouped readonly cost (medians; counts stable across all three samples):

| Read | Baseline calls / unique keys | Current calls / unique keys | Baseline seconds | Current seconds |
|---|---:|---:|---:|---:|
| require:observation | 2214 / 33 | 1944 / 33 | 27.326 | 24.302 |
| require:session | 2215 / 1 | 1945 / 1 | 0.124 | 0.109 |
| listByObservation:action | 656 / 32 | 656 / 32 | 0.440 | 0.464 |
| list:checkpoint | 1 / 1 | 1 / 1 | 0.000 | 0.000 |

**Negative memory result:** process maxRSS median rises from 1,637,984 KiB to 1,816,496 KiB: **+174.3 MiB / +10.9%**. Both versions retain the same unique material for diagnostics, but this does not erase the measured version difference. The high-water mark also includes byte accounting and full-result serialization after the timed selector; it is neither production heap nor an isolated selector peak. These data cannot attribute the entire increase to the new caches.

Input task JSON is 2,188,693 bytes and resulting task JSON is 2,234,061 bytes, exactly equal across versions. **No storage saving is claimed.**

The source-read bottleneck remains. The optimization does not expand the raw-source cache, delete audit history or change recovery permission. Full read counts and per-method timing are retained in summary.json and every trial report. Further changes to sharing during one synchronous SDK read require a separate contract and measurement.

## Integrity and reproduction

- Exact source archives: `069b65b47d951cdcced4d895e2abe33738267e5a` and `cbd5b878329f8d3e454e8fd5110d0e2da4f749a7`; workspace dependencies resolve inside each archive. External installed packages are read-only.
- Input: complete owned copy of frozen-7, with engine/plugin DB SHA checked before and after; original active DB is never opened. Archive and raw input checks remain unchanged.
- Every complete semantic artifact is saved losslessly under semantic-objects, addressed by logical JSON SHA; semantic-artifact-index.json maps each original trial filename. Complete task/choice/events are compared without dropping IDs, debt, order or fields.
- Raw CPU profiles and profile-summary.json remain diagnostic. Inclusive samples overlap and cannot be added.

Execution order: runner.py --run; controlled-runner.py (prepare), controlled-runner.py --run; controlled-runner.py --case fresh-deferrals (prepare); compare-runner.py --run; profile-summary.py; archive-semantic.py; make-report.py. Scripts refuse to overwrite executed result directories. Reproduction requires Node 24.22.0, installed workspace/external dependencies, Git archives and the complete frozen-7 directory. setup.json records the private copy/archive/input locations. Initial task material is rebuilt from frozen run/task-after.json plus scope.audit from metrics.jsonl; controlled-preparation.json records the sole cursor substitution. No temporary material/database must be committed.

Peak RSS belongs to the diagnostic worker: it retains every unique first returned value to save the exact material (128.65 MB in the controlled case), then serializes full results. It does not measure the production eight-source cache footprint. Import, setup, byte accounting and output serialization are outside selector clocks. All actual plan rows and failed route debt are retained; the fixture contains no active unknown attempt, so separate unknown/debt product tests remain necessary.
