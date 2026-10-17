# Same-snapshot carried-state audit

The first-audit CPU regression **does not persist on unchanged c11 material**. After retaining each version's actual first-audit task and event state, current d103's second and third audits take **50.404 ms and 45.861 ms**, versus baseline f6's **101.760 ms and 101.072 ms**. This is a static-snapshot repeated audit, not a resumed browser run or a promise that a newly captured observation will have the same cost.

Six new independent Node 24.22.0 processes ran serially in AB/AB/AB order, three per revision. Each constructs one task/plugin/host/sink and executes three audits. Current startup normalization occurs once before audit 1 (median **298.894 ms**). Task metadata is not cleared, and neither task nor plugin is reset between calls. The same exact c11 snapshot retains all 206 actions and all 204 pending facts each time; `completed` remains the original explicit empty set. All six processes and all 18 per-phase integrity checks pass. The preceding `audit-serial` evidence was rehashed and remains unchanged.

| Phase | Baseline median ms | Current median ms | Current / baseline | New rows baseline / current |
|---|---:|---:|---:|---:|
| Audit 1 | 124.110 | 363.279 | 2.927× | 174 / 47 |
| Audit 2 | 101.760 | 50.404 | 0.495× | 0 / 0 |
| Audit 3 | 101.072 | 45.861 | 0.454× | 0 / 0 |

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
