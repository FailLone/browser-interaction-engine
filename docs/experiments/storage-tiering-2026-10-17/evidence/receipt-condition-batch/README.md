# SDK receipt-condition batch checkpoint

This checkpoint proves a narrower claim: one synchronous batch returns the same full receipt-condition results as the prior single-query API while sharing some repeated reads. It does not establish faster real-page recovery, higher recovery success, exhaustive coverage, or a change from O(M×N) to O(M+N) for the entire query.

## Fixed comparison and ownership

- Baseline product: `5eca079d01e88dbc7da5e1f61f5553499dd25d8e`, extracted into a private temporary archive. All 28 workspace dependency links resolve inside that archive. External dependency links reuse installed packages only. `preparation.json` records ownership and paths. The archive prepared for the separate task-store benchmark was not used or modified.
- Candidate product: working tree based on `49702b41e578557e82c492e3d3ea673d850aafd9`, with the SDK batch implementation. Exact tested source hashes are in `candidate.json` and `validation.json`.
- `fixture.json.gz` retains one local HTML fixture with four genuinely executed checkbox receipts. They are four different native attempts, not cloned receipt IDs/statuses. The page includes a separate hidden owner, so all four proofs exercise the document-bound policy. The baseline generated this seed once; candidate batch tests reload exactly the same records without attaching a browser.
- The extra pre-existing receipt-condition regression file uses its own local browser fixtures. All owned fixture servers/browsers were closed in `finally`; no live OKX browser, service, task database, or frozen OKX database was used.
- `baseline.json` is an earlier, invalid read-cost probe and is retained for traceability. It spied on the backing `MemoryStore` after `RetainedPersistence` had bound its methods, missing `require` and `list` calls. Its zero list count is **not** evidence of low read cost and is not used in this comparison. `baseline-fixed.json` and `candidate.json` spy on `host.store`, the actual SDK read boundary.

## Four distinct receipts: mechanism result

All result fields, source coordinates, policies, condition keys, evidence, reasons and false authority flags are equal between the fixed old implementation, candidate singles and candidate batch. The fixture record digest is also equal. Candidate singles retain the old read counts.

| SDK-boundary read | Fixed baseline: 4 singles | Candidate: 4 in one batch | Change |
| --- | ---: | ---: | ---: |
| `require` calls | 44 | 17 | -61.4% |
| `list` calls | 56 | 23 | -58.9% |
| attempt-list calls | 24 | 9 | -62.5% |
| total rows returned by list calls | 96 | 36 | -62.5% |
| observation `require` calls | 8 | 5 | -37.5% |
| hypothesis-list calls | 8 | 2 | -75.0% |

The same four receipts plus four repeated inputs preserve order and full outputs. The baseline eight singles use 112 list calls; the batch uses 35. This repeated-input case is supplementary; the benefit above already holds for four **different** receipts. Per-receipt boundary and authority checks still run, including for duplicate inputs. Those boundary checks still scan the attempt/continuation ledger, so total batch work is not yet linear in just the receipt count plus ledger size. No wall-clock timing or peak-memory improvement is claimed here.

## Behavior validation

`baseline-fixed.log`: the one baseline mechanism test passed against fixed old sources; 16 candidate-only cases were deliberately skipped because the old SDK has no batch API.

`candidate-tests.log`: 31 of 33 cases passed in the initial combined run (17 new batch cases plus 16 existing receipt-condition regressions). The existing 16 all passed, including actual B execution against retained A conditions, actual supplied values, portable review revocation, missing legacy evidence, wrong ownership/value, and unresolved outcomes.

Two new test assumptions were corrected without changing product code:

1. A repeated receipt still invokes the per-receipt boundary blocker. Expecting the same total attempt-list count for four and eight batch inputs was incorrect; the test now compares against the corresponding single-query cost while retaining the per-item checks.
2. The boundary-debt fixture attached an exit result to the first of four receipts. The existing boundary contract uses the last attempt, so that historical result did not block either singles or batch. The fixture now attaches its unverified result to the actual last attempt.

`candidate-corrections.log`: only those two failed cases were rerun, and both passed. This is evidence across the initial checkpoint and targeted corrections, **not** a claim that a final 33-case full rerun occurred.

The new tests cover ordered results, duplicates, missing/foreign attempts, empty/missing sessions, next-query unknown/executing/dirty/boundary/pending invalidation, per-receipt custom unknown/factory/denial hooks, throwing hooks, custom single-query overrides, and prototype replacement after the default functions were captured. Queries neither write records/events nor attach a driver. Custom denials remain authoritative and failures stay isolated to individual inputs.

The main thread’s first type check found that the custom denial fixture returned a reason outside the browser subclass’s existing inferred return union. The fixture now uses the valid `source_authority_unavailable` reason while preserving its per-receipt denial/revocation assertions; only that case was rerun (`custom-hook-type-correction.log`, 1 passed). No product type or runtime behavior was changed. The comparison artifact retains the test-source hash from before this type-only fixture correction; `validation.json` records both that hash and the final test-source hash. The main thread owns the final type check; this subtask does not claim its result. The tests do not prove behavior on an arbitrary dynamic page or across concurrent external database writers; batch sharing is scoped to one synchronous call.

## Reproduction

Use Node 24.22.0 and the repository's installed Vitest. The source seed and both result artifacts are retained here. The baseline private archive path is recorded in `preparation.json`. On a fresh evidence destination, supply:

- `BIE_RECEIPT_BATCH_SEED`: retained fixture gzip path (same path for baseline and candidate).
- Baseline: `BIE_RECEIPT_BATCH_BASELINE`, run `tests/operation-receipt-batch.test.ts` filtered to `baseline:` against the fixed archive.
- Candidate: `BIE_RECEIPT_BATCH_REFERENCE` pointing to the baseline JSON; `BIE_RECEIPT_BATCH_CANDIDATE` pointing to a new candidate JSON. Run the batch and existing receipt-condition test files.

Artifact writes are exclusive; use new output files for an explicitly justified rerun rather than replacing the evidence here.

## Plugin and final checkpoint

The plugin's 16 new protocol tests passed: three distinct retained receipts use one batch instead of three singles, with identical reconciled plan contents. Invalid/partial/misordered responses fail closed; A/B sources and unknown debt remain distinct; old hosts retain lazy reads, and a rejected new receipt does not prefetch old condition proofs. See `plugin-validation.json` and `plugin-tests.log`. The 16 existing plugin receipt-condition regressions also passed (`plugin-related.log`).

The first root type check found only new test typing errors. The SDK custom hook now uses an existing permitted denial reason; the plugin assertion avoids TypeScript's stale narrowing after a method mutates `resolvedBy`. Only the affected SDK and plugin cases were rerun, each 1/1. Product sources did not change for these corrections. Final root and core type checks passed. `final-validation.json` records final source hashes, all log hashes, and the remaining release/real-page acceptance boundary. This is not a claim of one final combined full-suite run.

第 3 项的这一代码/受控验证检查点完成。接下来是发布构建与接口验收、合并和独立真实续测；任务库压缩/全量读取进一步优化仍后置，不在本补丁内展开。原测试浏览器、服务、任务库与其他工作区未修改。
