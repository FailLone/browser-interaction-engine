# Observation-scoped action reads: offline verification

This patch adds optional `Persistence.listByObservation`. Core current action/fact queries use it; third-party stores fall back to the original list/filter. Historical and completion audit retain the full action list. Memory reads clone only matching records; retention forwards support. SQLite uses an expression index for unambiguous plain action rows, with a NULL fallback bucket decoded on every scoped read for malformed/unsupported/ambiguous encodings. No permission, identity, coverage, retry or dispatch semantics change; there is no new cache.

One initial index scan is required when an old database opens. On the exclusive run4 copy, explicit index-only build over 11,450 action rows took 41.9 ms (one diagnostic measurement). The index occupies 946,176 bytes (231 SQLite pages). This scan does not rewrite action JSON, but it creates index pages and writes the database/WAL. Subsequent action writes also compute the JSON projection; write-path overhead has not been separately benchmarked in this patch. Unsupported compressed rows and invalid JSON still reach the original decoder and fail explicitly; duplicate or escaped field names are decoded before filtering. SQL maintains the index across writes, raw external changes and rollback.

The same current source and same isolated database were queried with the optional API disabled and enabled. Complete returned values of all eight APIs were compared using deepStrictEqual twice: 16/16 equal. Original returned baseline values are preserved in the comparison's temporary directory. Source frame has 292 controls and 207 actions. The final 539-row task is projected against a pre-24h observation, not the precise historical runtime snapshot. No browser/provider runs occurred; driver-start trap remained zero; event count stayed 1611. This is a two-call diagnostic, not a statistical benchmark or a reproduction of the real action gap.

| API | Fallback ms, two calls | Indexed ms, two calls |
|---|---:|---:|
| actions | 44.0 / 41.1 | 12.2 / 12.0 |
| interpretation | 118.4 / 94.2 | 63.6 / 61.7 |
| availability | 144.1 / 130.0 | 98.8 / 94.4 |
| snapshot-current | 443.6 / 426.0 | 405.3 / 401.7 |
| review-ledger | 212.7 / 196.3 | 173.4 / 172.9 |
| completed | 205.5 / 185.2 | 189.2 / 195.0 |
| obligation-projection | 2319.0 / 2254.2 | 2209.1 / 2204.3 |
| review-recovery-checkpoint | 811.2 / 803.5 | 615.6 / 605.4 |

Decoded action rows per call: actions 11,450 → 207; obligation projection 34,350 → 620; checkpoint review 68,700 → 1,241. Completed operations does not use action lists and has no expected improvement; its timing variation is noise. Remaining observation decoding and projection rebuilding dominate larger queries. No end-to-end speedup or exhaustion claim is made.

Validation status: targeted tests 22/22 passed. Initial whole-tree typecheck is blocked only by an independently edited plugin test missing context.value; the scoped-query files have no reported type errors. Final integrated typecheck is pending parent repair.

Validation commands:

- `fnm exec --using 24.22.0 pnpm exec vitest run tests/action-observation-query.test.ts tests/storage-contract.test.ts tests/core.test.ts`
- `fnm exec --using 24.22.0 pnpm typecheck`
- `fnm exec --using 24.22.0 node --import tsx --conditions=development /tmp/okx-run4-action-query-comparison.mjs`

Artifacts:

- `/tmp/okx-run4-action-query-comparison.mjs`, `.json`, `.log`
- `/tmp/okx-action-query-tests-final.log`
- `/tmp/okx-action-query-typecheck-final.log`
- `/tmp/okx-action-query-source-sha256.json`
- Original baseline `/tmp/okx-run4-offline-profile.json` and live-log diagnosis `/tmp/okx-run4-performance-readonly.md`

No source files outside the six listed in the SHA manifest were edited for this patch. Original and frozen run4 databases/evidence remain untouched.

Independent static review: observation_storage found no blocking issue in the single-statement snapshot/order, fallback bucket, rollback/external-write freshness or full-audit preservation. No extra tests or load were run by that reviewer.
