# Audit normalization CPU sample

One additional d103 process ran the identical carried-state worker under Node's CPU sampler after the six-process comparison. It is **excluded from all timing medians**. The archived d103 source and fixed material remained unchanged; no product instrumentation, SDK instance, DB, browser or provider was used.

The sampled call chain supports the proposed narrow normalization reuse work. Across all three audit calls, `auditRemainingScopes` has **445.040 ms** of inclusive sampled time; `audit → gap → normalizeScheduling → normalizeOperationScheduling` accounts for **312.749 ms (70.27%)**. `actionScope` is **247.958 ms** inclusive, `browserControlBindingKey` **130.497 ms**, and `browserControlCorrespondence` **116.127 ms**. These frames overlap, so their times must not be summed. Startup normalization is a separate **298.333 ms** of samples.

The largest sampled stack follows:

`auditRemainingScopes → gap → normalizeScheduling → normalizeOperationScheduling → source-record callbacks → actionScope → browserControlBindingKey / browserControlCorrespondence → canonicalization`

The two most frequent exact product stack strings in `hotspots.json` account for 82.247 ms and 57.125 ms. This profile identifies where computation occurs; it **does not measure an exact number of SourceRecord constructions or scope projections**. The 114 audit normalization events are independently recorded by the worker. The static observation that each constructs a source scope map is consistent with these sampled stacks, but a speedup from a future factory must be measured on its own frozen source.

The sample includes startup plus three audit calls; `analyze-profile.py` categorizes samples by their `auditRemainingScopes` / `normalizeScheduling` ancestors. It does not use product changes or monkey patches. Import, material loading/parsing, report/oracle checks and logical-byte serialization account for 4,175.794 ms outside these method categories. Because the profile covers the entire process, those costs must not be described as audit cost. Raw V8 source coordinates reflect TSX-transformed source (often line 0), so `hotspots.json` does not present them as original TypeScript line numbers.

The raw profile is `CPU.20261017.083132.27592.0.001.cpuprofile` (SHA-256 `3796a1a3ab282f0f3c0528d6970dbfd5b3defbd59c37f64645e334c05e11763d`). `worker-result.json` retains all semantic assertions and the profiled phase timings, which are diagnostic only. `execution.json` records the exact command, requested 1,000 µs sample interval, zero exit code and source/material checks. `worker.ts` is byte-identical to the carried-state worker; `profile.py` and `analyze-profile.py` make the diagnostic reproducible. Use a fresh evidence destination for another explicitly authorized run; do not overwrite this result.
