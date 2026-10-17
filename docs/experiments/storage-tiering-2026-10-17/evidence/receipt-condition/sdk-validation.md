# Public actual-receipt condition query

`operationReceiptCondition(sessionId, { attemptId })` separates retained execution success from condition evidence. It uses the actual `attempt.action`, including supplied values, and returns `actualSuccess`, `conditionVerified`, `status`, `reason`, the condition policy/key when available, source coordinates and evidence. Identity, replay, current execution and arrival flags are always false. This is a synchronous read: no driver attachment, writes or dispatch.

`portable` means the existing adapter operation-sampling policy is available and currently authorized. It does not certify arbitrary business state or add a document-witness requirement to that established policy. `document` means the narrower retained-document reader verified its graph, dispatch witness and review provenance. Missing portable conditions may use the document reader; this new query does not alter target correspondence or the existing known-mismatch fallback guard. `unavailable` preserves a real successful receipt while reporting why its conditions cannot currently be credited.

Each query reads current unknown/executing attempts, session dirtiness, identity hypotheses, boundary debt and revocable review authority. Missing or unresolved target hypothesis references are rejected even if no global pending entry was found. The source action, before/after observations, target uniqueness and timing are checked independently. A same-ID stored candidate with another value cannot replace the actual action. Old graphless/unwitnessed document receipts are not upgraded. Callers may memoize within one synchronous completion calculation; this API stores no positive authority between queries.

The first owned local checkpoint executed a supplied B value after hidden owner A changed to B. The handler read B, the before graph still represented A, and the legacy exact-receipt shortcut was true. The public query returned actual success with `conditionVerified: false` and `dispatch_witness_missing`. The compact receipt and result are saved in `own-source-checkpoint.json`; no old large fixture was copied.

Validation followed the scoped plan:

- First own-source checkpoint: 1/1 passed, 14 skipped.
- Initial related set: 40/41 passed. All 15 new query cases and both existing known-mismatch cases passed. One existing plugin integration failed in the concurrently edited plugin due to a shadowed `condition` function (`condition2 is not a function`). Its original log is retained; this was not a changed SDK oracle.
- After adding the orphan-hypothesis guard, only its new negative and the existing portable/document positives were rerun: 3/3 passed, 13 skipped. The original 15-case set was not repeated.
- After the plugin shadowing fix, only the previously failing public `recordOutcome` integration was rerun: 1/1 passed, 23 skipped. The SDK source and new-test hashes were unchanged.

Root's final type check and the additional plugin completion/restart tests are recorded separately. The targeted SDK and previous public integration checks above are complete; this does not claim a rerun of all tests against the final plugin snapshot. No full suite, 80-trial protocol, performance benchmark or real-site run was launched. Owned localhost servers/headless browsers and Memory clones close in fixture `finally` blocks.

The existing browser completion display remains an execution summary: `control-coverage.ts` marks a kind successful from its recorded attempt, and `completion-audit.ts` still returns `exhaustive: false` and maps a complete action audit to `unverified`. This patch does not relabel that older summary as policy-bound condition proof. SDK source hashes, commands, exit codes and raw evidence hashes are recorded in `sdk-validation.json`.
