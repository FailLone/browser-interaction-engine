# Run7 retained review-source counterfactual

The visibility gate prevents the prior hidden review destination from being selected. **The new result is no selected route, not a successful recovery.** One `e06f057` read-only selector process reused the completed `875ce50` baseline’s full semantic output and the identical fixed input and worker. No browser, provider, navigation or execution ran.

## Exact scope of the comparison

This is the terminal run7 task with all 803 ordered plan occurrences and final failed-route debt retained, paired with the earlier observed current frame. The prior documented fixture changes only the scheduler cursor to the actual earlier selection and clears its deferred-reason cache. It cannot reconstruct the exact live pre-selection task.

The pure-performance baseline actually selected item `53cc4e09-7c99-43e6-bb57-272e46dbc6b3`, route `384664f26110b4b21e407321678506726127c64e8239f83730d8beaa547b5001`, checkpoint `b1e80845-ab4f-4c31-809d-ba37be180e92`, source `5f80a3df-8355-444a-8499-4a625cb89577`. The original live selection was item `35a22c35-fa78-47fb-8681-2ac3250539cd`; those are not interchangeable. Its later failure was never deleted to force a replay.

`e06f057ecc1fd43feaa8cfa42d14c65e9750a08e` differs from `875ce5019751c8222df23cba00a63a1ddc1c29c9` by the source-review visibility gate and its tests. The complete result changed to null. No replacement route or restoration success is inferred. Changed work means this is a behavior comparison, not a performance comparison; raw legacy worker timing fields are retained without ratios.

## Source evidence and additional deferrals

Both blocked review obligations point to the same retained source. Its context/URL/gap gates pass, but the exact production control-scope matcher finds only hidden controls:

| Obligation | Matched source localId suffixes | Visible | Enabled |
|---|---|---|---|
| `35a22c35…`, Open sub-menu review | `:1491`, `:1497` | false, false | true, true |
| `53cc4e09…`, bound link review | `:1496`, `:1499` | false, false | true, true |

All four belong to document/instance prefix `87b91bd6-ee8a-4d8e-9567-574f45b28a78`. The source has no active boundary. This real sample directly verifies hidden-target rejection; background/innermost-boundary cases remain covered by `tests/explorer-review-source-visibility.test.ts`, rather than claimed as real-run observations. Ambiguous visible review material would remain reviewable and would not gain action permission.

Events change from 270 to 282. The first 269 events are unchanged in order; the old last defer is replaced and twelve later defers are added, producing thirteen new or changed payloads. Each has independent retained-material support:

| Reason | Count | Checked basis |
|---|---:|---|
| source_review_target_not_available | 2 | The exact source matches above are all hidden. |
| current_review_occurrence_present | 1 | Five visible, enabled current controls match by exact scope and/or SDK retained-control transition. |
| source_target_unverified | 9 | Each has exactly one filtered action at the retained source, but production browserTargetConditions returns undefined. Visibility alone does not authorize recovery. |
| unchanged_unresolved_review | 1 | The production wait validator confirms the stored unresolved review still matches its source material. |

`event-basis.json` retains every full event and plan item plus exact matched controls/actions, conditions, current-presence mappings and wait proof. The proof reader used three retained observations from the same private read-only copy, invoked no selector a second time and constructed no engine or store. SQLite query_only was enabled and total_changes remained zero.

## Complete state differences and retained debt

All **803 plan occurrences**, array order and complete rounds are unchanged. The entire original retry ledger is identical: **6 routes**, outcomes {'unverified': 4, 'verified': 3, 'unreachable': 2}. All **6** pre-existing scheduled-route bindings remain equal. Pending/unknown field presence and values are unchanged.

This input contains 0 unknown plan attempts, 0 unknown retry-route flags and 0 unverified-recovery rows; pendingDispatch present = False. It is not a new nonempty-unknown execution test.

Relative to the original fixed input, only scheduling.deferred changes. Relative to the baseline result, the following exact paths differ (complete before/after values, including the full selected object, are retained in full-diff.json.gz):

- `/task/scheduling/deferred/0c194579-4db1-447f-ac8c-b3d48fde1dc2`
- `/task/scheduling/deferred/19a0689d-268d-4062-ac04-1c1fa00120b5`
- `/task/scheduling/deferred/33fb7be9-ce3d-4839-8241-c8ef8b5a9c60`
- `/task/scheduling/deferred/35a22c35-fa78-47fb-8681-2ac3250539cd/reason`
- `/task/scheduling/deferred/53cc4e09-7c99-43e6-bb57-272e46dbc6b3`
- `/task/scheduling/deferred/88a950ff-2447-42cd-90d9-8374382104da`
- `/task/scheduling/deferred/a145daa0-e621-4d99-a55a-0df73eb8ca56`
- `/task/scheduling/deferred/b10c4870-eef2-4957-845d-b427b1c56a2e`
- `/task/scheduling/deferred/b296bd9d-2f7d-4356-9900-0e564bb623c7`
- `/task/scheduling/deferred/ca7358ce-334d-4895-b406-a90426e0d700`
- `/task/scheduling/deferred/cc52542c-a8e5-4979-a867-9c8517064b23`
- `/task/scheduling/deferred/cdc80291-64cd-4bd8-9b9f-e412cc30fac3`
- `/task/scheduling/deferred/f79abeec-57e8-4916-9074-5100268c0c7e`
- `/task/scheduling/routes/384664f26110b4b21e407321678506726127c64e8239f83730d8beaa547b5001`

The omitted baseline route binding was created by that baseline selection and was absent from the input. No old route failure, source reference, attempt, review wait or plan entry was erased. Ordered event opcodes and full differing event payloads are stored in the diff; no fields are ignored to declare equivalence.

## Integrity and reproduction

The baseline full semantic archive is copied from source-material-isolation/pair-1-current. Its three completed `875ce50` samples agreed before reuse. The new run uses a complete Git archive of e06 and the exact same worker bytes; source/input/private-copy/frozen-database hashes all remained unchanged. Both complete semantic results and the complete difference are retained losslessly as gzip. No temporary DB or large material export is committed.

Run `runner.py --run` only in a new empty evidence directory after the prerequisite source-material-isolation experiment finishes. It creates one independent archive and one read-only worker. Then invoke explain.ts with Node24/tsx from that archive and this evidence directory as its argument, followed by `python3 -B finalize.py`. setup.json and the execution records retain exact paths, commands and source hashes. The archived worker’s inherited “three pairs” description belongs to its source protocol; this wrapper explicitly ran one new behavior process.

These results justify rejecting this unavailable retained review source. They do not establish a navigation path that reveals it, erase the unresolved work, weaken SDK target conditions, or declare the exploration complete.
