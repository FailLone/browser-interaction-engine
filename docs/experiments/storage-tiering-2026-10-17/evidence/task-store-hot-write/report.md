# Task-store hot-write follow-up

Fixed archives: `106a1cdfddfe3e73cab9e01b28ba4dd8439653e2` → `855a3a47b513305077ef160a8d4d5716fe1780f9`. Twelve serial fresh processes completed successfully. Six baseline/current comparisons preserve the full initial/final task, ordered occurrence handles, original decisions and audit events. Every intermediate task was also checked against its complete expected state. Archive sources, full private frozen copy, fixture seeds and original frozen database hashes remained unchanged.

The run7 case improves unchanged-round CAS by **13.50%**, active-item CAS by **15.78%**, and compatibility saves whose items are unchanged by **30.28%**. The history case improves those operations by **16.73%**, **17.68%**, and **39.77%** respectively. These are local ExplorerStore costs, not whole browser-round throughput.

**Measured cost:** canonical JSON parsing of changed items moved into the write transaction. Changed-round transaction-body time rises by 0.521 ms (+48.4%) for run7 and 0.752 ms (+74.7%) for the history fixture. History changed-round total CAS rises 12.67%. The complete-read implementation and persisted layout are unchanged; no new full-read or storage saving is claimed.

## Implementation and inputs

The store now serializes/hashes each supplied record once, decoding canonical JSON only when the persisted content hash differs. It still respects a supplied toJSON result and derives all projections and packed values from that exact canonical string. A failed later write or stale CAS still rolls back all earlier transaction changes. No persistent cache, schema upgrade, new reference, deletion, or relaxed corruption check was added.

Cold-packing uses the original eligibility and trigger, but first probes at most 64 eligible rows without transferring JSON to JavaScript. Below the threshold, it returns immediately. Threshold hits perform one extra bounded query before the original ordered pack. Old plain cold rows remain eligible on the next normal current-round delta; explicit maintenance still packs below the threshold. Tests cover 63/64, historical round promotion, older plain rows, unknown/occurrence retention and rollback.

The unchanged run7 SQLite seed has 803 plan occurrences, one current round, 5,384 events and 123 decisions. Its 34 succeeded plan rows remain below the automatic packing threshold. Header JSON is 293,862 bytes, current-round JSON 446,912 bytes. The history fixture explicitly derives 5,000 plan rows from run7 values (4,990 succeeded, 10 unresolved) and adds one historical round. It is synthetic cost control, not replay or evidence of coverage.

## Timings

Values are milliseconds: median of each process’s per-operation median, then median across three fresh processes/version. Pairs run AB, BA, AB for each input. First full read is the first API read in a fresh process, without evicting OS page caches. Initialization, individual reads/writes and maintenance are separate. Correctness assertions, byte accounting and audit export are outside operation clocks.

### run7

| Operation | Baseline ms | Current ms | Change |
|---|---:|---:|---:|
| Initialization | 5.359 | 5.892 | +9.95% |
| First full read | 10.848 | 11.077 | +2.11% |
| Repeated full read | 7.843 | 7.909 | +0.83% |
| Active item read | 4.266 | 4.264 | -0.04% |
| Header read | 0.727 | 0.702 | -3.48% |
| Header-only CAS | 1.884 | 1.894 | +0.55% |
| Unchanged-round CAS | 3.863 | 3.342 | -13.50% |
| Active-item CAS | 3.935 | 3.314 | -15.78% |
| Changed-round CAS | 5.539 | 5.435 | -1.88% |
| Unchanged-items compatibility save | 9.666 | 6.740 | -30.28% |
| Explicit maintenance + reclaim | 70.517 | 66.656 | -5.48% |

Transaction body only (excludes BEGIN/COMMIT and serialization before the transaction):

| Write | Baseline ms | Current ms | Change |
|---|---:|---:|---:|
| Header-only CAS | 0.045 | 0.045 | -0.73% |
| Unchanged-round CAS | 0.118 | 0.088 | -24.97% |
| Active-item CAS | 0.160 | 0.124 | -22.28% |
| Changed-round CAS | 1.077 | 1.599 | +48.39% |
| Unchanged-items compatibility save | 0.833 | 0.712 | -14.55% |

Process maxRSS median: **397,280 → 387,312 KiB**, -9.73 MiB (-2.51%). This includes complete task/occurrence comparisons, fixture data, retained audit material and semantic serialization. The measured difference is retained, but it is not isolated production heap.

### history

| Operation | Baseline ms | Current ms | Change |
|---|---:|---:|---:|
| Initialization | 5.314 | 5.532 | +4.11% |
| First full read | 34.047 | 33.885 | -0.48% |
| Repeated full read | 25.939 | 24.107 | -7.06% |
| Active item read | 0.098 | 0.096 | -1.88% |
| Header read | 0.728 | 0.735 | +0.86% |
| Header-only CAS | 1.968 | 2.012 | +2.25% |
| Unchanged-round CAS | 3.992 | 3.324 | -16.73% |
| Active-item CAS | 4.014 | 3.304 | -17.68% |
| Changed-round CAS | 5.140 | 5.792 | +12.67% |
| Unchanged-items compatibility save | 43.034 | 25.920 | -39.77% |
| Explicit maintenance + reclaim | 416.668 | 407.496 | -2.20% |

Transaction body only (excludes BEGIN/COMMIT and serialization before the transaction):

| Write | Baseline ms | Current ms | Change |
|---|---:|---:|---:|
| Header-only CAS | 0.052 | 0.055 | +4.21% |
| Unchanged-round CAS | 0.071 | 0.065 | -7.93% |
| Active-item CAS | 0.094 | 0.089 | -4.89% |
| Changed-round CAS | 1.006 | 1.758 | +74.69% |
| Unchanged-items compatibility save | 3.846 | 3.433 | -10.74% |

Process maxRSS median: **729,888 → 673,280 KiB**, -55.28 MiB (-7.76%). This includes complete task/occurrence comparisons, fixture data, retained audit material and semantic serialization. The measured difference is retained, but it is not isolated production heap.

## Work counts and space

A separate untimed final CAS instruments JSON.parse and cold-row transfers. For run7, baseline parses the unchanged 447,128-byte round (it includes nine intentionally appended cost-only strings) and transfers 34 cold rows / 83,288 JSON bytes. Current parses zero item bytes, transfers zero cold-row JSON bytes and performs one bounded qualification probe. History similarly eliminates the unchanged-round parse; its cold history was already packed, so both transfer zero cold JSON. These counts do not instrument the timed loops.

Both versions have exactly the same logical task bytes and DB/WAL/SHM sizes at each reported boundary. Explicit maintenance’s reduction is existing schema4 functionality, not a new space benefit.

| Input | Initial / final task JSON bytes | DB / WAL / SHM before maintenance | DB after maintenance | DB after close |
|---|---:|---:|---:|---:|
| run7 | 2,234,498 / 2,234,704 | 11,329,536 / 4,416,672 / 32,768 | 10,547,200 | 10,547,200 |
| history | 10,321,040 / 10,321,252 | 3,641,344 / 4,379,592 / 32,768 | 3,125,248 | 3,125,248 |

WAL is zero after maintenance; SHM is 32,768 bytes until the last connection closes, then zero. All samples within each version have these same sizes.

## Validation and limits

Four exact test files passed 47/47: the new write-cost tests plus existing packed, normalized and delta store suites. Logs are `focused-7.log` and `store-tests-47.log`. Original independent business-ID occurrences, plan order, all unknown/recovery debt, complete audit payloads and stale-writer rejection remain checked. The benchmark deliberately updates revision/time, one active row reason and current-round actions/tried; it makes no SDK execution or coverage claim. Random CAS tokens are checked for changes and stale rejection rather than equal random bytes across processes.

The initially attempted joined-array JSON.parse path was slower than per-row parsing in its small feasibility probe and was rejected; `feasibility.json` retains that negative result. The current full-read implementation is unchanged. Small apparent gains/losses in read-only phases or initialization are samples, not evidence of an implemented read optimization. Changed-round lock duration is a real implementation tradeoff and remains a follow-up consideration for multiple writers.

Reproduce with `runner.py --prepare`, then `runner.py --run` in a fresh evidence directory, then `finalize.py`. Requires the complete frozen-7 input, Node 24.22.0, installed dependencies and both Git revisions. The tracked archive helper path and SHA are in `preparation.json`; workspace imports resolve within each exact source archive. `initial-inspect.mjs` and `initial-probe.mjs` reproduce the earlier feasibility step using a complete private copy: put its parent directory (containing frozen-copy) in `/tmp/bie-task-store-next-path`, then invoke those files with Node 24. They never construct ExplorerStore.

Complete semantic gzip bytes are retained under `semantic-objects`; `semantic-artifact-index.json` maps all twelve original filenames without discarding full input/output/audit content. `artifact-manifest.json` hashes all evidence files except itself. No private database or large temporary material was copied into the repository. Original and new evidence are separate. Formal workers ran after the root/lifecycle CPU release and before releasing it to the next test agent; light report/Git activity on the same machine remains possible.
