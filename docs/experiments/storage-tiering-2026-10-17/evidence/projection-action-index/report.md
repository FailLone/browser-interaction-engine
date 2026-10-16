# Projection action index: frozen-frame validation

The new synchronous scope/condition index was compared with the preserved pre-index `projectObligations` implementation against three real observations from frozen OKX run4. **All nine old/new pairs returned deeply equal complete projection and event values.** The first frame had 206 actions, the pre-24h frame 207, and the final unverified-recovery frame 206; all had 292 controls. Each frame was evaluated with the same final 539-row task. Different frames were not compared to one another and this is not a reconstruction of the historical task at each frame.

The source optimization indexes literal matches for one call. It preserves each field's JSON comparison, explicit undefined versus omitted fields, duplicate candidates and action order. It memoizes operation-condition hints per action object without treating those hints as equivalence. The eight-source document bound and all SDK correspondence result gates remain unchanged. This experiment does not grant coverage, execution or recovery success.

## Timings and preserved reads

Three alternating pairs per frame (old/new, new/old, old/new) ran in one process on one exclusive database copy. This is a short diagnostic, not an end-to-end benchmark. Root reserved a CPU window; unrelated OS activity and small agent tests were not fully controlled.

| Frame | Old calls, ms | New calls, ms | Median, ms |
|---|---:|---:|---:|
| post-region-review-before-scroll | 2002.9 / 1920.1 / 1910.7 | 1024.8 / 996.3 / 1001.0 | 1920.1 → 1001.0 |
| pre-24h | 2146.0 / 2140.1 / 2224.4 | 1223.6 / 1214.1 / 1212.0 | 2146.0 → 1214.1 |
| final-unverified-recovery | 2031.9 / 2085.5 / 2129.6 | 1109.1 / 1131.3 / 1133.1 | 2085.5 → 1131.3 |

Every pair retained the same API read calls and returned-row counts. Representative per-call counts below are identical old/new:

| Frame | Observation get calls | Scoped action calls / rows | SDK correspondence calls / requests |
|---|---:|---:|---:|
| post-region-review-before-scroll | 68 | 2 / 414 | 25 / 398 |
| pre-24h | 83 | 3 / 620 | 25 / 398 |
| final-unverified-recovery | 71 | 3 / 620 | 21 / 323 |

The measured improvement is therefore consistent with removing repeated scope/condition computation, not with skipping source reads or SDK proof requests. Other work remains: each projection still reads dozens of observations and runs multiple correspondence batches. No full exploration-cycle speedup is inferred.

## Integrity and negative evidence

- Complete `projection` and `events` passed deepStrictEqual for all 9 pairs; repeated same-frame outputs were also equal. Three full outputs are retained as gzip JSON with SHA-256 values in `comparison.json`.
- Session event count remained 1611 for every frame. Timed calls left SQLite total_changes unchanged (3→3, 4→4, 5→5; the differences between frames are explicit current-observation setup writes on the private copy). Task input JSON remained unchanged.
- Driver-start trap remained zero. No browser/provider/network was used. The frozen database was only read as file bytes for copying and SHA checks; SQLite constructors targeted the exclusive temporary copy. Frozen database hash matched before and after. Source hashes also matched before and after.
- Parent-run tests are preserved: `tests-initial-failed.log` records two failed fixture expectations that omitted the valid same-scope `a6` candidate. The implementation had retained that ambiguity correctly; the expectations were corrected instead of removing the candidate. `tests-final.log` records 33/33 passing tests, including 256 literal scope subsets, ordering/undefined/null/false/zero/empty strings, duplicate targets/local IDs/regions and fresh context/observation behavior. `typecheck.log` records the successful whole-tree check reported by root. This reviewer did not rerun those suites.
- The final unverified-recovery frame remains unresolved under the same projection: 171 active, 344 waiting, 23 resolved and 1 authority row, with 515 unresolved groups and zero aliases. The optimization does not turn that recovery into success.

## Artifacts and reproduction

`baseline-before-index.ts` is the exact preserved baseline supplied by root, including its original absolute repository imports. `compare-frozen-projections.mjs` is the executed comparison script. `comparison.json` contains all raw calls/rows, timings, CPU times, complete result hashes, frame counts, event/write invariants and source/database/task hashes. `comparison.log`, three full result gzip files, `source-hashes.json` and both negative/final unit logs are retained alongside it. `artifact-manifest.json` hashes every artifact.

Run from the recorded repository root with Node 24 and the frozen-4 database present:

```sh
fnm exec --using 24.22.0 node --import tsx --conditions=development docs/experiments/storage-tiering-2026-10-17/evidence/projection-action-index/compare-frozen-projections.mjs
```

For a relocated checkout, rebase only the absolute repository import prefix in a copy of the archived baseline before reproduction; retain the original source/hash as evidence. Temporary paths in raw output identify the isolated measured database, not a dependency on an unarchived result. Product source was not modified by this validation.
