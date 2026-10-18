# Shared fragment storage

This replaces the compressed whole-ledger task header. It does not add an exploration mode or change guarded equivalence. Source alignment: `/Users/xietian/Experiments/fraggen-port-evidence-20261018/storage/`, upstream Crawljax `a9e14583`, and this repository's existing immutable observation packs and transactional TaskWriter.

The v2 storage root in Task contains policy, task ownership, epoch and authority. Full exact structure/owner/operation/guard bytes are content addressed independently of compression. Large top-level JSON value spans share atoms while retaining whitespace, escaping, order and every byte. Candidate and fragment metadata use immutable dictionary/Zstd blocks with validated slots and indexed projections. The material, payload, index and root checks fail closed on corruption. A bounded 8 MiB/2048-entry cache is disposable; durable history has no 2 MiB/128-fragment/4096-edge/256-state coverage ceiling.

New eligible equivalent relations use the exact `(policy,structure,owner,path,operation,guard)` class key, with at most one member per fragment. Candidate identities remain distinct. Each real succeeded attempt has one source event. Indexed class queries derive direct/duplicate/equivalent counters; an explicit recursive graph preserves legacy directed, duplicate, cyclic, missing and revoked edges. Migration never turns an incomplete legacy graph into a clique. Candidate revocation retains own actual origins and removes transfer. Source receipts are paginated; routine audit events contain counters and stable references, not copies of every source and edge.

TaskWriter owns an explicit fragment delta. Its materials, memberships, origins and root commit in the existing ExplorerStore CAS transaction with header, plan, round, pending dispatch and budget changes. Failed commits retain the write set; stale writers never fall back to an unconditional save. The engine receipt database is separate: durable SDK receipt precedes idempotent ingest, and an absent fragment event never means the browser action did not happen.

Normal task reads do not unpack the graph. `ExplorerStore.exportFragments` explicitly materializes a v1 audit view; it is an export, not runtime storage. `FragmentSession.origins` pages actual provenance. `FragmentStore.verify` checks saved references; explicit `compact` removes only unreachable objects/empty packs after validation. It never evicts candidates, states, pending links or actual events. Original plain and deflate wire materials, IDs, source order and legacy capacity diagnostics remain exportable.

## Validation at the storage checkpoint

74 focused cases pass across codec, storage, traversal and existing task stores/writers. Cases cover 300 fragments/300 states, one event across 300 members, no unchanged-graph rewrite, atomic rollback, stale owners, plain/deflate migration, legacy duplicate cycles, single-edge and candidate revocation, late/ambiguous/changed guards, external corruption, packed-index tampering, cache eviction and reachable-object maintenance. Both project typechecks pass. An earlier integration also passed 12 pure/browser/restart cases, including an actual independent original-child receipt and real normal/crash process exits; these must be renewed after final policy integration.

The production experiment uses the research's frozen real 18-fragment/49-candidate export and explicitly synthetic 2/4/8/16 copies. New IDs are mapped back to input occurrences for comparison. At all five scales, complete materials, directed mappings, counters, pruning, influence, fragment peer factors and selected candidate agree. The comparison baseline imports five byte-identical store/writer dependencies from product `574a7ea`; all writes use new experiment databases. No original evidence database is opened.

| Fragments | Old compressed DB bytes | Shared DB bytes | Old event WAL bytes | Shared event WAL bytes |
|---:|---:|---:|---:|---:|
| 18 | 274432 | 372736 | 107152 | 20632 |
| 36 | 290816 | 479232 | 115392 | 20632 |
| 72 | 315392 | 630784 | 127752 | 20632 |
| 144 | 417792 | 905216 | 168952 | 20632 |
| 288 | 970752 | 1462272 | 457352 | 20632 |

These are single production-store samples, not p95 latency claims. At 288 fragments, the new event delta is 511 JSON bytes and commits in 0.414 ms versus the old full-ledger event step's 45.122 ms. The ordinary new header flush writes 4152 WAL bytes and does not call fragment persistence. Registration totals 678.750 ms; explicit whole-audit parity costs 2671.240 ms; cold session load plus first counter query costs 8.292 ms. The indexed shared representation is **not smaller on disk** at these scales. Its primary demonstrated gains are bounded event write amplification and separation of material/history from routine header serialization. Process RSS includes the pairwise reference oracle and full audit export; it is not an isolated runtime-cache measurement.

The first metadata layout consumed 2203648 bytes at 288 fragments. Immutable metadata packing and removal of redundant indexes reduced this to 1462272 bytes. Earlier failures, intermediate layouts and all successful samples are retained in `evidence/shared-storage-evidence.json` and `.data/broader-ui/storage-prep/`. This storage result is not an OKX pruning or strict-reentry success. The earlier zero-chain real runs remain failed.

Reproduce using Node 24.22, the repository dependencies, a fresh output directory, the exported research input and the baseline snapshot recorded in the evidence index:

```sh
node --import tsx --conditions=development docs/experiments/broader-ui-exploration-2026-10-18/benchmark-fragment-storage.ts run /Users/xietian/Experiments/fraggen-port-evidence-20261018/storage/inputs/task-final.json NEW_OUTPUT .data/broader-ui/storage-prep/baseline-574a
```

First matching integration: independent commit `366012568c24e8c5e720552eba801a7fc82b166e` is adapted to the shared session API. Current policy is `guarded-host-fragments/v2`; legacy v1 imports preserve their policy, IDs, materials, edges and actual origins, with derived optimization disabled. Candidate material roles are validated in addition to hashes. Updating a staged state preserves persisted tie order. Recovery selection reads the live writer fragment session while it stages a separate route/scheduling view; read-only selection does not create a new fragment root.

The unchanged original 251 cases again give 207 pass / 44 fail with exactly the prior failure set. All 11 original files are byte-identical to `574a7ea`. An extra six recovery-selection failures reproduce on an isolated `9eac9ee` archive (29/35 pass); current runs retain those six, not new failures. The initial new sampled-range failure and its live-session correction are preserved, as are earlier fixture-adaptation failures. Evidence index: `evidence/shared-integration-evidence.json`. These results are not an all-green regression claim.

Remaining gates: freeze this integration and renew the original full local acceptance twice. Then integrate the human-approved second matching stage, where external context differences can support bounded revocable sampling instead of universally vetoing local correspondence; exact related modes/destinations/parameters and strict execution/arrival/original-child receipts remain mandatory. Renew final regressions, real restart and fixed 240-second/80-command OKX strict reentry plus frozen confirmation. No durable threshold increase, return quota or pending-duty deletion is authorized as a substitute.


## Frozen first matching stage: real controls

At af499ec, original local full-cycle runs pass twice (44.062/39.034 seconds,30commands,41/41duties,1strict chain,15original pending IDs across real restart,0duplicate completions). All522local-source hashes and revisions match, both diffs are empty. Narrow OKX fails217.753s/13commands/0strictchains. Broad OKX fails216.958s/16commands/5productivebranches/0strictchains. No prior failed run is relabeled.

The broad run keeps160fragments/682candidates,8real origins,0cross-page mappings,0propagated prunes; no durable bound trips. The task root is198bytes; the separate full audit is6007149bytes. Registration27calls totals2378.620ms versus the previous compression control4182.852ms, but these are different live observations and matching policy versions, not an isolated storage speedup. Closed explorerDB13410304bytes is larger than the earlier11608064bytes, while retaining more fragments. EngineDB31109120/evidence9139956bytes; exports32987773/auditcopies63481582separate. WorkerpeakRSS1306384KiB; sampled decoder37.619s,readDOM145calls51.793s,capture30calls56.796s(overlappingcategories). The primary real conclusion is removed admission/write amplification limits, not solved matching or strict reentry. Archives: evidence/shared-local-evidence.json, shared-narrow-evidence.json and shared-broad-evidence.json.
