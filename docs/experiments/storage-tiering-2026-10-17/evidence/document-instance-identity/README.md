# Explicit instance-bound receipt coverage contract

Base: `9e8f4553319b0e0ddee01a73a828ef8252aa6ba3` (native dependency capture committed separately). Candidate files and hashes are in `source-before.json`; `validation.json` confirms they did not change during verification.

The core retained reader may explicitly declare `identityBasis: 'same-document-instance-v1'`. That declaration permits a coverage proof based on unique retained instances without first resolving logical identity. An undeclared reader retains the previous identity gate. An available portable sample that fails the identity gate is still rejected; it never falls through to document coverage.

The browser reader supplies that declaration because it independently checks the same session/document/browser lifetime, unique local/instance bindings, complete original dependency graph and native/mode state, actual dispatch witness, known context and current review authority. Only three `hypothesisId` existence checks were removed; readiness, raw control equality, graph validation, ownership, unknown/dirty/boundary failure and review revocation checks remain. Changed logical annotations can still conservatively prevent cross-observation equality. No identity alias, arrival verification or replay permission is granted.

## Verification

One serial, focused invocation selected 70 cases in five files; all passed, with 81 other cases skipped. `tests.log` is the captured output with the terminal trailing blank line omitted. The selected cases cover:

- Undeclared reader refusal; explicit instance-only proof; portable refusal under missing/pending logical identity; resolved portable behavior.
- Complete v1 and v2 graph proofs with shared logical identifiers and same labels but distinct captured instances, including review origin.
- Duplicate local/instance IDs, DOM replacement, document/browser change, nonlocal mode, input A→B, owner change, missing dispatch witness, unstable readiness, unknown receipt and revoked authority rejection.
- Public SDK queries against genuine receipts from isolated local browser fixtures: document coverage remains available with logical identity debt, portable proof remains unavailable, review revocation is re-read, and all authority flags remain false.
- Unknown/executing outcomes, dirty session and boundary failure still block single and batch receipts. Batch results equal single results; adding unrelated logical debt preserves the document proofs exactly.
- Document coverage does not make target-arrival correspondence or repetition eligible.

Command (Node 24.22.0):

```sh
pnpm exec vitest run tests/receipt-identity-basis.test.ts tests/document-coverage-graph.test.ts tests/operation-receipt-condition.test.ts tests/document-operation-coverage.test.ts tests/operation-receipt-batch.test.ts --maxWorkers=1 --no-file-parallelism -t 'retains the default identity gate|accepts explicitly instance-bound|never turns an identity-rejected|preserves portable coverage|compares unique captured instances|keeps instance/raw-evidence rejection|retains raw nonlocal and target conditions|does not trust matching complete booleans|re-reads .* debt or authority|keeps portable receipts unavailable|uses the document instance contract|does not treat unrelated logical identity debt|rechecks new .*|re-reads .* on the next batch'
```

No existing testing browser, service or task database was accessed. Browser fixtures create and close their own local pages; read-only queries assert no attachment or persistence writes. No full protocol, performance measurement or storage measurement was run. Repository-wide type checking is handled by the parent task after integration.

## Limits

This verifies the explicit proof contract and rejection boundaries, not real OKX coverage improvement. Run 8 retains incomplete source graphs and lacks dispatch witnesses; this patch does not repair, backfill or reinterpret that historical evidence. A new real receipt with complete evidence is still needed. Instance-bound proof is local to the retained document and does not prove semantic novelty across sessions or exhaustive coverage of undeclared JavaScript state.
