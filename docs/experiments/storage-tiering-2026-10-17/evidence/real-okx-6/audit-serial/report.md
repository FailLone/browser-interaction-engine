# Run 6 fixed-input serial audit cost

This comparison preserves the negative result: current `d103747` emits 47 new gaps instead of the `f6d7b9e` baseline's 174, but full-audit first-call CPU wall time increases from **125.683 ms to 360.439 ms (2.868×)**. Including the current version's first startup normalization, the combined median is **667.639 ms (5.312× baseline)**. Final task JSON increases by **200,975 bytes (+20.65%)**. Fewer appended obligations is not a CPU or storage performance win.

The five independent processes per version all exit 0. Each paired run uses identical worker bytes, Node 24.22.0, third-party dependencies, and fixed input; order is AB, BA, AB, BA, AB. The root released its full-suite CPU window before execution. Light host report/hash/Git work may coexist; this is not an OS-exclusive or multi-machine benchmark.

## Measurements

Times are median (minimum–maximum), in milliseconds. Each fresh process executes one normalization/audit sequence. Constructor timing is separate. Imports, 327 MB material parsing, oracle checks, report serialization, byte accounting and close are outside these phase clocks. These are **first-call synchronous CPU wall times, not warmed steady-state timings**.

| Phase | Baseline f6d7b9e | Current d103747 |
|---|---:|---:|
| Plugin construction | 0.050 (0.048–0.062) | 0.050 (0.047–0.051) |
| Startup normalization | 0.000 (0.000–0.000) | 310.533 (297.127–321.692) |
| Full auditRemainingScopes | 125.683 (123.786–130.306) | 360.439 (353.698–364.242) |
| Normalization + audit | 125.683 (123.786–130.306) | 667.639 (657.449–685.934) |

| Stable per-process result | Baseline | Current |
|---|---:|---:|
| Input / final plan rows | 543 / 717 | 543 / 590 |
| Newly appended rows | 174 | 47 |
| First normalization rows | 0 | 325 |
| Startup observation / actions / attempt-list calls | 0 / 0 / 0 | 61 / 60 / 1 |
| Audit observation / actions / attempt-list calls | 4 / 0 / 0 | 3 / 1 / 1 |
| Save sink calls | 1 | 1 |
| scope.audit events | 1 | 1 |
| operation.scheduling_normalized events | 0 | 115 |
| scope.availability_updated events | 0 | 128 |
| Initial task JSON | 812,334 B | 812,334 B |
| Task JSON after startup normalization | 812,334 B | 1,067,538 B |
| Final task JSON | 973,285 B | 1,174,260 B |
| Final plan JSON | 780,975 B | 981,950 B |
| Appended-row JSON | 158,144 B | 43,131 B |
| Final normalization metadata JSON | 0 B | 261,516 B |
| Emitted-event JSON | 108,240 B | 331,014 B |
| Startup returned-object logical JSON bytes | 0 B | 239,355,970 B |
| Audit returned-object logical JSON bytes | 14,802,136 B | 11,943,387 B |
| Sampled process peak RSS median | 2,131.859 MiB | 2,145.016 MiB |

Current startup observation calls touch 21 distinct observation IDs and actions calls touch 20. Returned-object bytes sum each actual host return separately, including repeats. The memory host returns already-parsed references: **these bytes are not physical reads, and their JSON serialization occurs after the measured phases**. RSS includes the entire extracted 327 MB material, TS imports, oracle/report preparation and return-byte accounting; it is not production audit memory use.

The 174 baseline additions comprise 173 `region_review_required` and 1 `pointer_intercepted`. Current adds 45 `region_review_required`, 1 `operation_not_executed`, and 1 `pointer_intercepted`. Byte/count/result fields are identical across all five processes within each revision. This experiment does not attribute the CPU delta to individual functions or establish whether it persists after the first audit; a separately archived repeated-audit experiment can answer that without changing these results.

## Fixed input and oracle

Both versions begin with the same retained 543-row task (543 distinct IDs). The only reconstruction is the exact `recovery.position_reconciled` event **sequence 2952**: the final round's `entryPath=[]` and position are restored identically. It does not recreate every live preaudit field. The current observation is `c11abe9e-e2a4-44f2-bf53-64ebf22a1dd2`; all **206** captured actions, exact **204** recorded pending candidates/availability facts, five identity obligations, and the original explicit empty completed set are retained.

The original integrity-oracle source block is byte-identical (SHA-256 `3eaac2dd8cd1bcc7345f48e58f966facaff8251808abf27254c5539e32e13a24`). It verifies all old statuses, attempts, original condition keys, scopes, prerequisites, results and exact evidence references; all rounds, route debt and scheduling state; and the exact emitted obligations. New assertions require all 204 pending actions to remain emitted, no omissions, unchanged input hashes, and zero forbidden host/network calls. The fixture retains 12 nonempty prerequisite rows and 1,605 exact source references. Its route ledger has four unverified, one verified and one unreachable outcome, all preserved.

**Unknown boundary:** the real material contains 31 SDK attempts and 85 plan-attempt entries, all succeeded, with no pending dispatch or route `unknown` flag. Status/attempt/debt integrity checks remain in place, but this fixture does not dynamically exercise a nonempty unknown-outcome case. No synthetic unknown case or altered oracle was introduced.

The existing f6 archive was independently checked against a fresh full git archive: all 2,381 tracked files match. The current full archive contains 2,396 tracked files. Both have 28 workspace dependency links resolving inside their own archive. Source manifests match before and after all 10 processes. Original TS/JSON/oracle/source/extraction files and the original material hash remain unchanged. No SDK, database, browser or provider was constructed. No product/test file was edited.

## Reproduction and boundaries

`worker.ts`, `runner.py`, `make-worker.py`, and `oracle-equivalence.json` are archived here exactly as executed/prepared. `preparation.json` records both complete archive roots, full manifests and dependency links; each `pair-*.json` contains phase CPU/wall times, calls, JSON byte counts and unchanged-state assertions. `execution.json` records the 10 distinct worker PIDs and exact commands. `summary.json` is the numeric aggregation, and `final-verification.json` additionally records the original material's final hash.

The private material copy is `/private/var/folders/s9/dy_jbdrs3fn1qzt_gnsy4tgw0000gn/T/bie-run6-audit-serial-owned-6pl3jvbl/material.json`; the original retained extraction is `/var/folders/s9/dy_jbdrs3fn1qzt_gnsy4tgw0000gn/T/okx-run6-plan-growth-vsx8jidd/material.json`. Both are 327,480,435 bytes with SHA-256 `4253c3d8f95c863ce0462cdbc72ea573152fcedf448c9fd04ac5d9c480e050e2`. No DB or large material is committed. Keep these temporary sources for reruns. If removed, the existing `../plan-growth-extract.py` specifies the original immutable/query-only extraction and hash validation; rebuilding must occur in a separate owned copy of that extraction environment, because the original extractor writes its metadata beside itself. Do not rerun it against this archived evidence directory.

To repeat, copy this directory's scripts to a new private preparation directory, choose a **new** evidence output path in the copied runner (it refuses to overwrite existing evidence), preserve the fixed revisions/material and original source/oracle hashes, then run its preparation step and explicit `--run`. Both archives reuse installed third-party dependencies read-only; no installation or build occurs. `NODE_OPTIONS`, `NODE_PATH` and provider credentials are excluded; TSX cache is disabled. Only `.data` in the owned archives receives worker/config files.

This measures CPU work in the real plugin methods against a recording memory host/sink. It excludes SQLite decoding/compression, capture, network, model calls, full resume and end-to-end task work. JSON bytes are logical sizes. Current normalizes startup state once, and the current full audit can normalize changed items internally as part of its actual implementation. No metadata or old evidence is removed to improve the result. References to current source: `packages/explorer-plugin/src/runtime.ts` lines 132–150 (normalization/read scope), 163–198 (gap maintenance), and 1341–1384 (full audit). `d103747`'s UI-only extraction is independently evidenced in `../../run6-ui-dependency-fix/function-equivalence.json`; this run imports the exact committed d103 source, not an edited working tree.
