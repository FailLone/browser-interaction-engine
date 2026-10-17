import json,pathlib,hashlib,statistics,shutil
root=pathlib.Path('/Users/xietian/.codex/worktrees/exploration-layered-refactor/browser-interaction-engine');e=root/'docs/experiments/storage-tiering-2026-10-17/evidence/real-okx-6';sdir=e/'audit-steady';pdir=e/'audit-profile';sha=lambda p:hashlib.sha256(pathlib.Path(p).read_bytes()).hexdigest();s=json.loads((sdir/'summary.json').read_text());c=json.loads((pdir/'hotspots.json').read_text())
rows=[]
for index in range(3):
 a=s['baseline']['phases'][index];b=s['current']['phases'][index]
 rows.append(f"| Audit {index+1} | {a['timingsMs']['audit']['median']:.3f} | {b['timingsMs']['audit']['median']:.3f} | {s['auditMedianRatios'][index]:.3f}× | {a['stableResult']['newRows']} / {b['stableResult']['newRows']} |")
checks=[]
for f in sorted(sdir.glob('pair-*.json')):
 r=json.loads(f.read_text());checks.append({'file':f.name,'noTaskMutationInAudits2and3':all(x['inputTaskSha256']==x['outputTaskSha256'] for x in r['phases'][1:]),'consecutiveStateHashesMatch':all(r['phases'][i]['inputTaskSha256']==r['phases'][i-1]['outputTaskSha256'] for i in [1,2]),'all204Emitted':all(x['pendingActions']=={'recorded':204,'emitted':204,'omitted':[]} for x in r['phases'])})
assert all(all(v for k,v in r.items() if k!='file') for r in checks)
(sdir/'carry-forward-verification.json').write_text(json.dumps(checks,indent=2)+'\n')
(sdir/'report.md').write_text(f'''# Same-snapshot carried-state audit

The first-audit CPU regression **does not persist on unchanged c11 material**. After retaining each version's actual first-audit task and event state, current d103's second and third audits take **50.404 ms and 45.861 ms**, versus baseline f6's **101.760 ms and 101.072 ms**. This is a static-snapshot repeated audit, not a resumed browser run or a promise that a newly captured observation will have the same cost.

Six new independent Node 24.22.0 processes ran serially in AB/AB/AB order, three per revision. Each constructs one task/plugin/host/sink and executes three audits. Current startup normalization occurs once before audit 1 (median **298.894 ms**). Task metadata is not cleared, and neither task nor plugin is reset between calls. The same exact c11 snapshot retains all 206 actions and all 204 pending facts each time; `completed` remains the original explicit empty set. All six processes and all 18 per-phase integrity checks pass. The preceding `audit-serial` evidence was rehashed and remains unchanged.

| Phase | Baseline median ms | Current median ms | Current / baseline | New rows baseline / current |
|---|---:|---:|---:|---:|
{chr(10).join(rows)}

Each revision's stage 2 and stage 3 input task hash equals its preceding output hash. Within stages 2 and 3, the complete task JSON hash is unchanged. No new row is appended; every old scope, status, attempt, source, prerequisite, original key, result, round and route/scheduling debt is preserved, and old row order/pending dispatch are additionally checked. No phase resets or edits a retained attempt or outcome.

| Per-stage behavior | Baseline audit 1 | Current audit 1 | Baseline audits 2 / 3 | Current audits 2 / 3 |
|---|---:|---:|---:|---:|
| observation / actions / attempt-list calls | 4 / 0 / 0 | 3 / 1 / 1 | 4 / 0 / 0 | 3 / 0 / 1 |
| New scope rows | 174 | 47 | 0 | 0 |
| operation.scheduling_normalized events during audit | 0 | 114 | 0 | 0 |
| scope.availability_updated events | 0 | 128 | 0 | 0 |
| scope.audit events | 1 | 1 | 1 | 1 |
| Final task JSON | 973,285 B | 1,174,260 B | 973,285 B | 1,174,260 B |
| Task JSON growth in stage | 160,951 B | 361,926 B including startup | 0 B | 0 B |
| Event JSON in stage | 108,240 B | 331,014 B including startup | 108,240 B | 108,240 B |
| Save sink calls | 1 | 1 | 1 | 1 |

The first current phase has 115 total normalization events: one startup batch plus 114 audit-internal changes. Subsequent identical audits add one event each, so cumulative event counts are baseline 1/2/3 and current 244/245/246. Repeated event growth remains even when task JSON is stable. Every `bytes`/call/event/result field matches across the three independent processes of each revision. The serialized empty `addedRows` array is 2 bytes (`[]`); this does not represent two added rows.

The original integrity-oracle block remains byte-identical (`3eaac2dd8cd1bcc7345f48e58f966facaff8251808abf27254c5539e32e13a24`). Each phase runs it against the task entering that phase and a slice of that phase's **actually accumulated** events. The cumulative host/sink arrays themselves are retained. `carry-forward-verification.json` independently checks state hashes and all 204 emitted facts from the saved reports. The real fixture has no nonempty unknown action/route flag; its existing four unverified, one unreachable and one verified route outcomes are unchanged. No synthetic unknown scenario is claimed.

The memory host is sufficient for this narrow calculation: these calls consume frozen observations/actions/attempts and current task state; they do not reload persisted events or decisions. The recording sink intentionally matches the prior oracle and does not emulate SQL/CAS or `ExplorerStore.save`'s `updatedAt` mutation. `auditRemainingScopes`/normalization do not branch on `updatedAt`; therefore no artificial task reset or missing store feedback explains the repeated-audit result. This does **not** benchmark production persistence, TaskWriter flushing, new captures, provider work, full startup or end-to-end performance.

`runner.py`, `worker.ts`, `make-worker.py`, and `oracle-equivalence.json` are archived. The runner uses the same immutable full f6/d103 archives, private material copy and read-only dependency links recorded in `../audit-serial/preparation.json`; `setup.json` captures those references and hashes. Its only archive writes are separate worker/config files under `.data`. All archived product sources/material hashes remain unchanged. Source changes in the development worktree, authorized after the isolated run began, cannot enter these archives.

To reproduce, retain/recreate the first experiment's exact full archives/material, copy these scripts to a new owned directory, select a new evidence destination in the copied runner and invoke it once in an approved CPU window. It refuses to overwrite this evidence. Each `pair-*.json` retains all three phases; `summary.json` includes every raw timing sample. `execution.json` records the six PIDs and zero exit codes. No SDK/database/browser/provider was constructed. These medians exclude the separately profiled diagnostic in `../audit-profile`.
''')
(pdir/'report.md').write_text(f'''# Audit normalization CPU sample

One additional d103 process ran the identical carried-state worker under Node's CPU sampler after the six-process comparison. It is **excluded from all timing medians**. The archived d103 source and fixed material remained unchanged; no product instrumentation, SDK instance, DB, browser or provider was used.

The sampled call chain supports the proposed narrow normalization reuse work. Across all three audit calls, `auditRemainingScopes` has **445.040 ms** of inclusive sampled time; `audit → gap → normalizeScheduling → normalizeOperationScheduling` accounts for **312.749 ms (70.27%)**. `actionScope` is **247.958 ms** inclusive, `browserControlBindingKey` **130.497 ms**, and `browserControlCorrespondence` **116.127 ms**. These frames overlap, so their times must not be summed. Startup normalization is a separate **298.333 ms** of samples.

The largest sampled stack follows:

`auditRemainingScopes → gap → normalizeScheduling → normalizeOperationScheduling → source-record callbacks → actionScope → browserControlBindingKey / browserControlCorrespondence → canonicalization`

The two most frequent exact product stack strings in `hotspots.json` account for 82.247 ms and 57.125 ms. This profile identifies where computation occurs; it **does not measure an exact number of SourceRecord constructions or scope projections**. The 114 audit normalization events are independently recorded by the worker. The static observation that each constructs a source scope map is consistent with these sampled stacks, but a speedup from a future factory must be measured on its own frozen source.

The sample includes startup plus three audit calls; `analyze-profile.py` categorizes samples by their `auditRemainingScopes` / `normalizeScheduling` ancestors. It does not use product changes or monkey patches. Import, material loading/parsing, report/oracle checks and logical-byte serialization account for 4,175.794 ms outside these method categories. Because the profile covers the entire process, those costs must not be described as audit cost. Raw V8 source coordinates reflect TSX-transformed source (often line 0), so `hotspots.json` does not present them as original TypeScript line numbers.

The raw profile is `{c['profile']}` (SHA-256 `{c['profileSha256']}`). `worker-result.json` retains all semantic assertions and the profiled phase timings, which are diagnostic only. `execution.json` records the exact command, requested 1,000 µs sample interval, zero exit code and source/material checks. `worker.ts` is byte-identical to the carried-state worker; `profile.py` and `analyze-profile.py` make the diagnostic reproducible. Use a fresh evidence destination for another explicitly authorized run; do not overwrite this result.
''')
for p in [sdir,pdir]:
 shutil.copy2(__file__,p/'finish-reports.py')
 files=[{'path':f.name,'bytes':f.stat().st_size,'sha256':sha(f)} for f in sorted(p.iterdir()) if f.is_file() and f.name!='artifact-manifest.json']
 (p/'artifact-manifest.json').write_text(json.dumps(files,indent=2)+'\n')
print(json.dumps({str(p.name):{f:sha(p/f) for f in ['report.md','artifact-manifest.json',('summary.json' if p==sdir else 'hotspots.json')]} for p in [sdir,pdir]},indent=2))
