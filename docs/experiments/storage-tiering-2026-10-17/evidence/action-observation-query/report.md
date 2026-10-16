# Action observation query: read benefit and write cost

The observation index removes full-session action decoding from current-frame queries. It also increases write cost. These are separate measurements; neither establishes whole-run speedup or exploration exhaustion.

## Read comparison

The run4 frame contains 207 current actions and the session contains 11,450 actions. The optional query reduced the returned/decoded action rows from 11,450 to 207. The same source, isolated database and current frame were used with the optional API disabled/enabled. Eight complete public/helper results were compared twice using `deepStrictEqual`: all 16 matched; event count remained 1611 and driver starts remained zero. Full baseline values are archived under `query-baseline-values/` as lossless gzip JSON.

Actions took 41–44 ms without the scoped query versus about 12 ms with it. Checkpoint review's six action reads fell from 68,700 to 1,241 rows and about 804–811 ms total to 605–616 ms. Obligation projection still took about 2.2 seconds. The final 539-row plan was projected against the pre-24h frame, so this is not an exact replay of the historic runtime interval. Two reads per mode are diagnostic measurements, not a statistical performance claim.

The original baseline, all query counts/timings, full result hashes, source hashes and logs are archived in this directory. `query-comparison-original.mjs` preserves the exact script used for that measurement. `okx-run4-action-query-comparison.mjs` changes only input/output path handling for reproduction from the repository root. `okx-run4-offline-profile.mjs` is the original historical profiler and must be interpreted with its recorded source commit.

## Write comparison

Three alternating pairs used six separate Node processes: no-index/index, index/no-index, no-index/index. Each process started from an exclusive copy of frozen run4. No SQLite constructor opened the original or frozen database. No browser, provider or network was used.

All six processes received the same 1,536 actual stored action JSON records, sampled evenly over historical row order in three fixed batches of 512. Each measured batch was one `SqliteStore.transaction` containing ordinary `put('action', value)` calls, including ownership lookup, JSON serialization, SQLite mutation and commit. New inserts changed only IDs to avoid collision. Updates rewrote existing real JSON unchanged; changed semantic fields and single-row transaction latency were not measured. Full original samples and their row IDs, batch hashes and source database hash are archived in `write-input-actions.json.gz` and `write-input-manifest.json`.

Both configurations used identical 64-row insert/update warmup and product-default WAL settings: synchronous NORMAL, automatic checkpoint at 1000 pages, page size 4096. Before timed writes, both copies were compacted so the no-index variant did not benefit from pages left by dropping the index. Setup and verification are outside measured batch time. The root agent reserved a CPU window and other agents avoided loads, but other operating-system activity was not fully controlled.

Each cell below is the sum of three 512-row transactions (milliseconds):

| Process pair | Insert, no index | Insert, indexed | Unchanged update, no index | Unchanged update, indexed |
|---|---:|---:|---:|---:|
| 1 | 30.46 | 65.20 | 29.60 | 70.16 |
| 2 | 29.83 | 57.01 | 30.77 | 63.33 |
| 3 | 29.38 | 59.86 | 27.93 | 68.60 |

- Insert median: **29.83 → 59.86 ms**, 2.01×; +30.03 ms per 1,536 rows (about 19.6 μs/row).
- Unchanged update median: **29.60 → 68.60 ms**, 2.32×; +39.00 ms per 1,536 rows (about 25.4 μs/row).
- Every batch's actual stored JSON exactly matched the requested values. Each batch result SHA matches across all six processes. Final 13,050-action content SHA is `23687c474e6d0cab037bdeaae89eff6a76af87224e0829dc9ebbd253be0a8ec8` in every process; all six SQLite integrity checks passed.
- Explicit index rebuild over 11,450 actions took **42.81–44.15 ms** across the independent processes. These are warm-cache setup measurements, not cold-start bounds.
- Initial index: **946,176 bytes / 231 pages**. After 1,536 measured new rows plus 64 warmup rows: **1,298,432 bytes / 317 pages**.
- WAL file length after the six timed batches was 2,443,192 bytes without the index and 4,552,632 bytes with it in all pairs. File length is not a total I/O byte count. Default checkpoint behavior is included in the timed transactions.

The guarded JSON expression has measurable write amplification. This patch favors repeated current-frame reads at an added per-action write cost; whether it improves a complete capture/exploration cycle still requires integrated observation. Product source was not modified in response to these numbers.

## Correctness and source freeze

Targeted storage/core tests passed 22/22, including current-only versus full audit, unknown blockers, fresh external changes/deletes, rollback, legacy initialization, duplicate/escaped keys and malformed/future compressed fallback. The indexed query keeps unsupported or ambiguous rows in a fallback bucket and runs the original decoder. Complete historical/coverage audit retains the full action list. No new permissions or cached decisions are introduced.

The archived initial typecheck log includes a concurrently edited root test's missing `context.value`; root subsequently fixed that test and reported whole-tree typecheck success before this write comparison. That earlier log is preserved as historical evidence, not a current failure. The six patch file SHA values are in `okx-action-query-source-sha256.json` and independently recorded in every write trial. All six remain unchanged during the experiment.

## Reproduction

Run from the repository root with Node 24.22.0 and the frozen-4 snapshot present. The write experiment makes fresh temporary copies and overwrites only this directory's experiment outputs:

```sh
fnm exec --using 24.22.0 node --import tsx --conditions=development docs/experiments/storage-tiering-2026-10-17/evidence/action-observation-query/action-write-comparison.mjs
fnm exec --using 24.22.0 node --import tsx --conditions=development docs/experiments/storage-tiering-2026-10-17/evidence/action-observation-query/okx-run4-action-query-comparison.mjs
fnm exec --using 24.22.0 pnpm exec vitest run tests/action-observation-query.test.ts tests/storage-contract.test.ts tests/core.test.ts
```

`write-comparison.json` contains summary/order/environment/source hashes; each `write-trial-*` JSON/log retains the per-batch wall/CPU time, RSS, WAL size, hashes and database integrity result. `artifact-manifest.json` lists all archived file hashes. Original/frozen evidence and product files were not modified by this experiment. Temporary database paths in raw logs identify the original isolated executions; all required samples, outputs and reproduction scripts are archived here.
