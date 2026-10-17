# Synchronous normalization factory: fixed-input comparison

The committed factory change removes most of the first audit's repeated computation **without changing the complete task or accumulated event output on this fixed input**. Against d103, 900edf7 reduces audit 1 median from **366.680 ms to 62.658 ms (−82.91%)**. Startup normalization remains about **300 ms**; startup plus audit 1 improves from **666.190 ms to 363.646 ms (−45.41%)**. The median of combined times is computed per process, not by adding separate medians.

The two later same-snapshot audits show small negative results: **49.633→50.593 ms (+1.93%)** and **46.223→46.790 ms (+1.23%)**. These are three samples per revision; no statistical significance or steady-state speedup is claimed. The retained startup work, metadata/event bytes and host read counts do not improve. This experiment closes the scoped repeated-computation investigation; it does not evaluate additional task-store compression or full-read work.

## Frozen versions and execution

- Reference: `d103747ee78779b3f1df8223854600cd321e36ee`.
- Patched: `900edf7d5c60c3ddcf9265538758033ccecc5832`, verified direct child of d103.
- The commit changes only `operation-scheduling.ts`, `runtime.ts`, and the dedicated factory test. This experiment edits none of them and runs no product test, database, SDK instance, provider or browser.
- Complete independent git archives contain 2,396 and 2,397 tracked files; each has 28 workspace links resolving inside its own archive. Both use the same installed third-party dependencies read-only and Node 24.22.0. No install/build occurs.
- Six fresh processes run serially in AB/AB/AB order. Each keeps one task, plugin, host and cumulative event/save sink through three audits. Both versions call startup normalization exactly once. No metadata is cleared or task reset between audits.
- Root granted a quiet CPU window; only light report/hash/Git work was allowed elsewhere. There is no OS-wide exclusivity or multi-machine claim. All six processes exit 0. Source manifests, private fixed material, original counterfactual inputs and all three prior experiment manifests/files remain unchanged.

## Timings

Values are median (minimum–maximum) milliseconds. Each full method is measured directly; material loading/parsing, module imports, oracle checks, JSON-byte accounting, full-state copying/serialization and close are outside phase clocks. First-call and carried-state measurements are distinct.

| Phase | d103 baseline | 900edf7 factory | Current / baseline |
|---|---:|---:|---:|
| Startup normalization | 301.187 (297.610–303.056) | 300.185 (298.011–300.987) | 0.997× / -0.33% |
| Audit 1 | 366.680 (363.134–379.633) | 62.658 (62.348–64.501) | 0.171× / -82.91% |
| Startup + audit 1 | 666.190 (664.290–680.819) | 363.646 (360.358–364.687) | 0.546× / -45.41% |
| Audit 2, carried state | 49.633 (49.558–50.289) | 50.593 (50.045–54.844) | 1.019× / +1.93% |
| Audit 3, carried state | 46.223 (45.763–46.423) | 46.790 (46.316–48.003) | 1.012× / +1.23% |

Sampled process peak RSS medians through audit 3 are **2145.391 MiB** and **2144.203 MiB**. They include the full 327 MB extracted material, TypeScript imports, oracle/report work and semantic snapshots, so they are not production audit memory footprints. The small difference is not presented as a memory optimization.

## Complete semantic gate

All **seven** full structural comparisons pass before timing aggregation: three matched cross-version pairs, plus two within-version consistency comparisons for each revision. Every process produces the same canonical hash:

`013f1bf636860f0faf809e318543a8b7539aa14f1a333ab51d5fbb69fd4539cb`

Each `pair-*-semantic.json` retains the complete initial task and the actual entire task plus accumulated events after audits 1, 2 and 3. The comparator maps only the **47 genuinely new plan UUID values**, in the exact order the rows were appended. It does not rewrite arbitrary UUIDs or substrings, remove fields, sort arrays, normalize times, or alter dictionary keys. Existing IDs, exact source references, original operation keys, conditions, statuses, attempts, prerequisites, unknown/debt fields and event ordering all participate in equality. Object property order alone is not semantic JSON structure.

The original integrity-oracle block remains byte-identical (`3eaac2dd8cd1bcc7345f48e58f966facaff8251808abf27254c5539e32e13a24`). The task entering each phase must hash exactly as the previous phase left it; audits 2 and 3 do not alter task JSON at all. Old row order and pending dispatch are additionally checked. The normalizer reuses immutable source projections only within the synchronous audit; this harness neither supplies coverage grants nor changes retained outcomes.

Both versions start with the identical 543-row task, exact seq2952 reconciled **empty entryPath** and recorded position, all **206** c11 actions, and all **204** pending candidates/availability facts. All 204 are still emitted in every phase. Twelve nonempty prerequisite rows and 1,605 old source references remain. The original explicit empty completed set is preserved. This reconstruction restores only the recorded path/position, not every live preaudit field.

The real fixture has 31 SDK attempts and 85 plan-attempt entries, all succeeded, and no pending dispatch/nonempty route unknown flag. Its four unverified, one unreachable and one verified route outcomes remain exact. Unknown-related fields are fully compared and the original status/attempt guard remains, but this is **not** a newly synthesized nonempty-unknown negative test.

## Unchanged work and costs

| Stable field, identical across versions | Audit 1 (including startup where noted) | Audit 2 | Audit 3 |
|---|---:|---:|---:|
| Final plan rows | 590 | 590 | 590 |
| Newly appended gap rows | 47 | 0 | 0 |
| Startup normalized rows | 325 | 0 | 0 |
| Audit observation / actions / attempt-list calls | 3 / 1 / 1 | 3 / 0 / 1 | 3 / 0 / 1 |
| Startup observation / actions / attempt-list calls | 61 / 60 / 1 | 0 | 0 |
| Normalization events (including startup) | 115 | 0 | 0 |
| Availability events | 128 | 0 | 0 |
| Scope-audit events | 1 | 1 | 1 |
| Cumulative event count | 244 | 245 | 246 |
| Save sink calls | 1 | 1 | 1 |
| Final task / plan JSON bytes | 1,174,260 / 981,950 | same | same |
| Final normalization-metadata bytes | 261,516 | same | same |
| Emitted phase-event JSON bytes | 331,014 | 108,240 | 108,240 |

The 47 new rows are 45 `region_review_required`, one `operation_not_executed`, and one `pointer_intercepted`. The existing metadata/event volume is deliberately retained. Startup returns objects whose summed logical JSON length is 239,355,970 B; audit 1 returns 11,943,387 B. These logical byte totals and call counts are identical across versions. The host returns already-parsed in-memory references, so the totals are **not physical DB reads**. The improvement is internal source-projection computation reuse; this experiment does not instrument exact internal projection counts or repeat the prior diagnostic profile.

The recording sink intentionally matches the original counterfactual, including its omission of real `store.save` timestamp/CAS/SQL behavior. These methods do not reload persisted event/decision history or branch on `updatedAt`; the full task and accumulated in-memory events are retained for repeated calls. No SQLite decoding/compression, capture, network/model cost, live recapture, full resume, operation coverage gain or end-to-end task speedup is measured.

## Evidence and reproduction

`setup.json` records exact commits, owned archive roots, full source manifests, dependency links, the fixed material/hash, worker/comparator hashes and original evidence protection. `execution.json` records six PIDs, zero exits and all seven comparisons. `summary.json` contains every raw timing sample and stable call/byte/event field. `semantic-cross-pair-*.json` and `semantic-within-*.json` retain complete comparison policy, raw/canonical hashes, append-order maps and empty structural diff lists. Raw semantic snapshots are retained alongside the reports. `final-verification.json` independently checks phase chaining and state/pending invariants.

The material copy is `/private/var/folders/s9/dy_jbdrs3fn1qzt_gnsy4tgw0000gn/T/bie-run6-audit-factory-owned-_06ison1/material.json` (327,480,435 B; SHA-256 `4253c3d8f95c863ce0462cdbc72ea573152fcedf448c9fd04ac5d9c480e050e2`). No DB or 327 MB material file is committed. Reconstruction/provenance is documented in the preserved `../audit-serial` experiment. `runner.py`, `worker.ts`, `compare-semantic.py`, prepared worker provenance and reporting source are archived here. The executed runner requires explicit `--run` and refuses to overwrite an existing evidence directory.

For a rerun, copy the archived scripts to a new private preparation directory, select a new evidence destination in that copied runner, and retain the exact revisions/material. Its archive helper is the preserved `../audit-serial/runner.py`; all workspace links are remapped to new archives before execution. Run only in another authorized CPU window. The environment excludes provider credentials, `NODE_OPTIONS` and `NODE_PATH`; TSX cache is disabled. Only owned archive `.data` files and new evidence are written.
