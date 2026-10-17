# Static capture budget checkpoint

The native v2 collector cannot retain the required roots within the existing 512-node / 128 KiB budget on either of these two conservatively mapped static HTML inputs. Both return `byte_budget`, `inventoryComplete: false`, and an empty retained graph. This is one structural capacity conclusion, not a recovery or performance conclusion.

The single completed checkpoint used collector commit `9e8f4553319b0e0ddee01a73a828ef8252aa6ba3`, with checkout at `211841e008634d0571cbad7513698484d19380f7`. The collector source hash matches that native commit. The first launch stopped at a harness preflight guard before database access, browser creation or collector execution. Its corrected guard accepts an empty WAL only when the main file matches the previously recorded settled hash; the reason is retained in `result.json`. No static collector case was repeated.

| Static input | Retained controls mapped | Detail instance paths verified | Required control roots retained complete | Result |
| --- | ---: | ---: | ---: | --- |
| First before / checkbox | 301 / 301 | 194 | 0 / 33 | `byte_budget`, also `missing_idref` |
| Before `1W` | 304 / 304 | 187 | 0 / 37 | `byte_budget` |

Every mapped control also passed its retained attribute binding check; neither frame used a fallback selector. The collector cleared its nodes/roots/closures after the byte limit was reached, so the reported final 1,922 / 2,084 bytes describe the refusal record, not a successful compressed graph or peak collected bytes. The first frame's missing reference is an additional static reason; this checkpoint does not diagnose its original runtime behavior.

The temporary main database, empty WAL, and SHM fingerprints are unchanged. All 294 referenced evidence files are unchanged. Each private context fulfilled exactly one in-memory document; CSP prevented page script/resource loading, and no other request reached the route. Both contexts and their headless browser were closed.

Inputs are the first before observation and the before observation for `1W`, referenced by `../real-okx-8/collection-diagnosis.json`. The original evidence is read directly and hash checked, without opening its database or copying HTML. Only the already exclusive, settled temporary audit database is opened read-only to decode those two complete observations. No SDK host/store or browser driver is constructed.

The script refuses execution without an explicit native commit whose collector matches the working file, and refuses to overwrite `result.json`. Execution creates its own headless Chromium process and two isolated contexts. It serves the saved HTML in memory once at its original URL; CSP blocks page scripts and resources, the route aborts every other request, and host resolution is disabled. No server, user browser, live task database, provider, or interaction is used.

The original control selector must uniquely match an element of the same tag. Retained review/purpose attributes must match. When a retained detail node is present, its element path and complete attributes must also match; a truncated field fails the mapping. Missing detail nodes require retained binding attributes. Duplicate element bindings, ambiguity, missing targets, or mismatches make that entire frame `unverifiable_input_mapping`; the collector is then not called. No fallback selector or inferred association is invented.

For a valid mapping, the original controls are passed unchanged and fixture elements receive their retained IDs only as measurement labels. New IDs use the same document-prefix shape, with a six-digit counter. The report keeps root completeness/reasons, graph counts and bytes, input/source hashes and read boundaries. It does not retain the generated graph, duplicate HTML, or copy prior evidence.

This is not interactive page restoration, the original live same-frame capture, or a coverage/dispatch witness. HTML defaults are not retained live form values. The separate timestamps and synthetic identity labels prevent backfilling old graphs or claiming real recovery success. It is also not a timing or memory benchmark.

The original HTML uses saved attribute defaults, not live native values. Fixture-generated node IDs also use a conservative six-digit suffix. Those differences can affect exact bytes: this checkpoint proves the bounded collector rejects these static inputs, not that the original live frame would consume precisely the same space. No graph was persisted or backfilled. Repeating with larger budgets or altered selectors is outside this checkpoint.

Recorded invocation (already completed; the script refuses to overwrite the retained result):

```sh
node --import tsx --conditions=development docs/experiments/storage-tiering-2026-10-17/evidence/native-capture-budget-checkpoint/checkpoint.mjs --execute --native-commit 9e8f4553319b0e0ddee01a73a828ef8252aa6ba3
```
