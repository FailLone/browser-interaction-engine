"""Combine static source refs and already-computed results; no SDK or database writes."""
import collections,datetime,hashlib,json,pathlib,subprocess,sys
root=pathlib.Path(sys.argv[1]).resolve();p=pathlib.Path(sys.argv[2]);out=root/'docs/experiments/storage-tiering-2026-10-17/evidence/real-okx-6';a=json.loads((p/'analysis.json').read_text());v=json.loads((p/'material.json').read_text());sha=lambda b:hashlib.sha256(b).hexdigest();time=lambda t:datetime.datetime.fromisoformat(t.replace('Z','+00:00')).timestamp()*1000
sources=['packages/explorer-plugin/src/reviews.ts','packages/explorer-plugin/src/classification-reuse.ts','packages/browser/src/control-classifications.ts','packages/adapter-playwright/src/classification-correspondence.ts','packages/browser/src/region-reviews.ts','packages/browser/src/region-reuse.ts','packages/adapter-playwright/src/region-candidates.ts','packages/browser/src/index.ts','packages/adapter-playwright/src/browser.ts']
a['sourceRevision']='f6d7b9e2b427b5edf1fad359ecf8cc5a3df8ffcf';a['sourceHashes']={s:sha(subprocess.check_output(['git','show',a['sourceRevision']+':'+s],cwd=root)) for s in sources};a['sourceAtDiagnosisMatchesRevision']=all(sha((root/s).read_bytes())==h for s,h in a['sourceHashes'].items());a['sdkReadOnly']=json.loads((p/'sdk.json').read_text());a['scriptHashes']={f.name:sha(f.read_bytes()) for f in sorted((out/'review-cost-tools').glob('*')) if f.is_file()}
page=a['regionPairs'][1:];a['comparisonCounts']={'run6PageRegions':len(page),'matchingRun4SelectorAndLabel':len(page),'sameSelectedControlFacts':sum(x['selectedControlFactsEqual'] for x in page),'equalCompleteReuseBindings':sum(x['reuseBindingEqual'] for x in page),'bothMissingReuseBinding':sum(x['reuseBindingPresent']==[False,False] for x in page),'oldOnlyReuseBinding':sum(x['reuseBindingPresent']==[True,False] for x in page),'onlyStableKeyDiff':sum(bool(x['reuseBindingChangedPaths']) and all(path.startswith('/members/') and path.endswith('/stableKey') for path in x['reuseBindingChangedPaths']) for x in page)}
for n in ['4','6']:
 r=v[n];rr=a['runs'][n]
 for batch in rr['batches']:
  after=next(e for e in r['engineEvents'] if e['type']=='observation.created' and e['at']>batch['at']);batch['recaptureObservationId']=after['json']['observationId'];batch['recaptureEventAt']=after['at'];batch['reviewRecordToObservationEventMs']=round(time(after['at'])-time(batch['at']))
 a['runs'][n]['providerReturnedElapsedSumMs']=sum(x['elapsedMs'] for x in rr['purposeTotals'].values());a['runs'][n]['providerSummaryElapsedMs']=r['summary']['providerCounts']['jev']['elapsedMs']
r=v['6'];after=r['summary']['diskAfterClose'];before=json.loads((out.parent/'real-okx-5/summary.json').read_text())['diskAfterClose'];a['diskSummaryDelta']={k:after[k]-before[k] for k in ['engineDatabase','pluginDatabase','evidenceManifests','evidenceBlobs','runnerAndLogs','total']};a['diskSummaryLimits']='Only summary category delta. Not a new storage allocation/codec benchmark.'
a['findings']=['20 page region decisions revisit the same 20 selector+label pairs among run4’s 21 page regions; 17 retain identical selected control semantic facts, 3 have actual material changes.','No region reuse was accepted/rejected by classificationCorrespondences: these are different APIs. All 18 region-review records in frozen6 lack opt-in, therefore RegionReuse.candidates returns zero.','Run6 has one region invalidation, caused by modal document/url/context change at announced navigation; none occurs during the four page batches. Incremental baseReviewId retains 5→10→15→20 regions. Recapture cost remains even without new invalidations.','Container classification reuse is accepted; generic interaction is outside the negative-only classification contract despite equal portable material keys.','Identity request has 6 historical candidates, all 6 blocked because current stableKey is absent; it chose independent. This is a clear program-rule candidate with no identity merge or execution grant.','Any region opt-in improvement benefits future fresh judgments; old no-opt-in records cannot be converted into reusable authority.']
(out/'review-cost-diagnosis.json').write_text(json.dumps(a,ensure_ascii=False,indent=2)+'\n')
rows='\n'.join(f"| {k} | {s['calls']} | {s['elapsedMs']/1000:.3f} | {s['inputTokens']:,} |" for k,s in a['runs']['6']['purposeTotals'].items());batchrows='\n'.join(f"| {i+1} | {b['newDecisions']} | {b['totalRegions']} | {b['providerElapsedMs']/1000:.3f} | {b['reviewRecordToObservationEventMs']/1000:.3f} |" for i,b in enumerate(a['runs']['6']['batches'][1:]));src=lambda s,line:f'[{s}]({root/s}:{line})'
md=f'''# Run6 review cost diagnosis

Source: `{a['sourceRevision']}`. This is a read-only reconstruction from complete private copies of frozen-4/frozen-6, not a benchmark. Every copied file and both original frozen inputs matched their manifests before and after extraction. SQLite used `mode=ro&immutable=1` and `query_only=on`; no engine/driver constructor, browser, network or provider was used. The report JSON contains database/raw/source/script SHA-256 and decoded object/layout checks.

## Result

The 26 JEV calls are mostly repeated **region grouping**, not repeated operation classification. Twenty page-region calls revisit run4 regions, but existing records contain no reusable-region opt-in. No SDK reuse proof was silently rejected: that authority was never created. The task is `executionPolicy=interface-only`, with region/page/list exploration set to `review`; the existing `observed-ui` deterministic full-region batch is intentionally not selected. Silently switching modes would also change identity/probe/operation policy and is inappropriate.

| Purpose | Calls | Returned-call elapsed seconds | Input tokens |
| --- | ---: | ---: | ---: |
{rows}

All 26 returned and were applied; LLM=0. Provider summary elapsed is {a['runs']['6']['providerSummaryElapsedMs']/1000:.3f}s, while summing `provider.returned.elapsedMs` is {a['runs']['6']['providerReturnedElapsedSumMs']/1000:.3f}s (different instrumentation endpoints, 19.930ms discrepancy, not lost calls). The window is 168.725s. Provider time is not total CPU or observation time. Run4 used 27 JEV: 22 region-review (1 modal +21 page), plus the same five non-region calls.

## Targets and historical comparison

- Modal region: one include judgment for the dialog’s three remaining operation-bearing controls. Diagnostic material is identical to run4 after removing observation IDs and capture UUID prefixes; this is not SDK authority.
- Generic `Don’t show for 7 days`: one interaction classification, then one unresolved probe-risk call. Historical and current portable classification identity/condition keys are equal. The public reuse contract only accepts original display/container classifications: the real SDK module returns `original_negative_classification_required` for the old interaction. Do not treat interaction as negative or as operation permission.
- Empty generic div at dialog fourth-child selector: one identity review. Historical candidates grew 4→6, expanding input tokens 9,663→13,687. All candidates were blocked in both runs because the current control has no stableKey; the answer is independent. A deterministic “no compatible match, retain independent current occurrence” rule can avoid this request without merging identities or granting coverage.
- Wallet button: one control-risk plus one probe-risk. Click result remains interface=false, external=unknown; hover/focus remain unresolved. The generic probe is likewise unresolved. Neither is a successful action; missing evidence must remain pending.
- Page: all 20 selector+label pairs occurred among run4’s 21 page regions. Seventeen have identical selected label/role/actionKinds. Main menu grows 15→23 selected controls after Trade opens; header and bottom conversion table material change. All 20 are included, not classified as completed coverage. No claim of equivalence is based on labels/selectors alone.

The page pairs have **4 exact complete portable region bindings**, **10 differing only in structural-item stableKey**, **4 missing bindings on both sides**, and **2 old-only bindings**. The 10 differences retain identical owner/row ancestry, template, recordKey and slot, but stableKey embeds a capture-specific owner instance ID. This is a candidate for a versioned collector fix, not permission to strip arbitrary fields from old proofs. The four exact bindings are Crypto calculator, USD/BTC conversion tables, the “buying cryptocurrency” FAQ, and the first unnamed converter div. JSON lists every decision/source observation and differing path.

## Actual correspondence and invalidation

SDK classification reuse succeeded once for modal container record `8ee8edd7-6522-4184-8cdf-b149e7c71405`, from observation `51193a8f-2624-4d05-9284-67ed340d1eb7` to `fa2de9b5-dc16-47e6-bcc0-c50e513d1fcc`. Both the live event and pure module reconstruction report `equivalent_classification_conditions`; identity/execution/currentExecution are false. Generic interaction is excluded by the plugin prefilter and the SDK contract, not rejected for mismatched text or capture ID. See {src('packages/explorer-plugin/src/classification-reuse.ts',6)}, {src('packages/browser/src/control-classifications.ts',62)}, {src('packages/adapter-playwright/src/classification-correspondence.ts',9)}.

Frozen6 contains 18 region-review records; none has `reuse`/`reuseConditions`. The SDK’s actual candidate count is zero. Region reuse needs explicit same-URL/context business scope, complete portable anchors, unique matches, current membership, no critical gaps or active boundary, and a non-revoked source. Control classification and region partition are separate contracts. See {src('packages/browser/src/region-reuse.ts',14)} and {src('packages/browser/src/region-reviews.ts',140)}.

Run6 emits one `region.review_invalidated`: 23:12:48.286Z, modal review `91ef3346-c224-42f8-89a9-685473bfc35a`, after navigation to observation `964bc6b8-a59d-450e-8cdb-97f4c1993360`, `changedContext=true`. Two control classifications invalidate there too. **No region invalidation occurs during the four page batches.** Their incremental `baseReviewId` chain preserves 5→10→15→20 active regions. The 35 group invalidations are 34 `exploration_conditions_changed` and 1 `reviewed_region_changed`; they must not be conflated with 35 region re-reviews. Current local invalidation already retains unrelated regions; see {src('packages/browser/src/region-reviews.ts',13)} and {src('packages/browser/src/region-reviews.ts',63)}.

## Repeated work and safe next change

| Page batch | New JEV calls | Retained region total | Provider seconds | Record→next observation event seconds |
| --- | ---: | ---: | ---: | ---: |
{batchrows}

The page’s 20 provider calls total 11.436s; four mixed recapture/processing intervals after storing the region records total {sum(b['reviewRecordToObservationEventMs'] for b in a['runs']['6']['batches'][1:])/1000:.3f}s. The 7–8s gaps between batches also include scheduling/selection/persistence and cannot be reported as pure SQLite/CPU time. `reviewRegions` performs fresh preflight and captures after recording ({src('packages/browser/src/index.ts',485)}). The legacy loop flushes five new decisions per command, while only `observed-ui` can programmatically partition all regions ({src('packages/explorer-plugin/src/reviews.ts',99)}). There is no evidence that recapture invalidation itself caused these twenty repeated judgments.

The narrow improvement is to register verified reusable conditions **only on future fresh include judgments**, scoped to this task/rules, and consume SDK candidates before asking JEV again. Keep existing no-opt-in records and all unresolved debt unchanged. A versioned portable structural-item binding can replace the redundant capture owner token only after proving its exact relation to the full owner/row evidence and preserving record/local keys. New/changed/ambiguous/unavailable regions still require fresh review; a rejected reuse never becomes successful coverage. Actual savings require a subsequent visit after new opt-in evidence exists. Batching already-approved reusable partitions can reduce captures; enlarging fresh JEV batches alone would reduce capture overhead but not these model calls and increases stale-evidence exposure, so it needs separate bounded validation.

## Storage summary only

Run5→6 total increases 22,890,337B: engine +13,643,776B; plugin +1,933,312B; evidence manifests +445,426B; blobs +1,912,312B; runner/logs +4,955,511B. This report does not attribute SQLite page allocation, audit-export duplication or codec performance beyond those raw summary categories.

## Reproduce

Use Python 3 stdlib and the workspace’s existing Node24/pnpm/tsx dependencies. To reproduce exact SDK results, use source revision `{a['sourceRevision']}`; JSON source hashes must match. Run in this order from the repository, supplying a **new empty private temporary directory** (the extractor refuses existing copied directories):

```sh
python3 docs/experiments/storage-tiering-2026-10-17/evidence/real-okx-6/review-cost-tools/extract.py "$PWD" /tmp/okx-review-reproduction
python3 docs/experiments/storage-tiering-2026-10-17/evidence/real-okx-6/review-cost-tools/analyze.py /tmp/okx-review-reproduction
pnpm exec tsx --conditions=development docs/experiments/storage-tiering-2026-10-17/evidence/real-okx-6/review-cost-tools/sdk-readonly.ts "$PWD" /tmp/okx-review-reproduction
python3 docs/experiments/storage-tiering-2026-10-17/evidence/real-okx-6/review-cost-tools/report.py "$PWD" /tmp/okx-review-reproduction
```

`extract.py` rebuilds all temporary material from complete frozen-4/frozen-6 copies and verifies every manifest file; neither temporary DBs nor large material are archived. `analyze.py` joins real provider request IDs to retained decisions, groups recorded region batches and compares selected material. `sdk-readonly.ts` invokes only ControlClassifications/RegionReuse over in-memory private-copy JSON, with all write/event methods throwing. `report.py` combines outputs and source/script hashes. No active database is ever opened. Original evidence and original frozen inputs remain unchanged.
'''
(out/'review-cost-diagnosis.md').write_text(md);print(json.dumps({'jsonSha256':sha((out/'review-cost-diagnosis.json').read_bytes()),'mdSha256':sha((out/'review-cost-diagnosis.md').read_bytes()),'counts':a['comparisonCounts'],'sourceMatches':a['sourceAtDiagnosisMatchesRevision']},indent=2))
