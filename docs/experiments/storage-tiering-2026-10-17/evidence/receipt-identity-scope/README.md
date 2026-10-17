# Receipt coverage: unrelated identity debt must not reject a complete operation proof

Base: `72b1e5aa1779d2dea01938625092b9adcb91a3e4`, owned layered-refactor worktree. This patch supports one conclusion: the two successful run20 inputs can retain their verified operation conditions without granting identity, replay, arrival or execution authority.

## Diagnosis on saved real records

The isolated diagnostic copy contains 274 pending identity hypotheses. For each receipt, the USD input target has one logical identity occurrence, no hypothesis, and no intersection with pending provisional identities or candidate IDs. All 28 captured mode controls also have no such intersection. The completed portable branch proof already exists (`browser-branch-conditions-v4`); all 29 references are independently checked against the saved pre-patch diagnostic.

Three navigation modes are instance-bound. Complete captured structure establishes their mode references; it does not resolve their logical identity. The old core nevertheless rejected the portable receipt whenever *any* session hypothesis was pending. This was unrelated historical debt, not missing proof for these two targets/modes.

See `diagnosis.json`, produced from the independently copied engine database in `ownership.json`. No browser was attached, task database opened, or source record edited.

## Contract

- The default browser adapter explicitly opts into `captured-operation-controls-v1`. Overriding its correspondence callback disables that default capability.
- A completed branch projection supplies a separate conflict scope containing the target and every captured mode, including hidden and nonlocal modes. Local IDs never enter portable operation keys.
- Core narrows an **existing** global rejection only with that complete declaration. Each reference must exist uniquely; target identity and non-instance dependency identities must remain unique. Pending target/dependency hypotheses, candidate/provisional references, alias chains/cycles and incomplete identity evidence still reject.
- Instance-bound modes retain their structural-proof semantics. They cannot become operation targets through this scope.
- Without both declarations, old behavior remains. An identity-rejected portable sample cannot fall through to a document success. Unknown, dirty, authority, timing and observation-integrity checks remain.
- The scope is bounded by the existing operation policy. It does not infer arbitrary JavaScript independence or remove the requirement to declare unobserved context/free-text dependencies.

## Verification and limits

Both real receipts now return `actualSuccess=true`, `conditionVerified=true`, `status=portable`. Their operation key/policy remain identical to the original diagnostic. All four authority flags remain false, and queries make zero record writes. `verification.json` stores the full result once; `final-checkpoint.json` verifies exact equality after the compatibility correction.

The initial integration run passed 115/116 tests. One old portable instance-target case with no identity conflict was incorrectly rejected by the first version. The correction limits new scoping to an existing global rejection, preserving the old unblocked policy; the affected 16-test file then passed. The original failure is retained in `integration.log`, the justified rerun in `compatibility-fix.json`. Six other files were not rerun. The new pure conflict-scope suite passed 26/26, covering positive and adversarial identity/alias/scope cases without a browser. Root and core type checks passed; `types.json` records their separate results.

This is saved-record coverage proof, not a new live execution or proof that the plugin has selected and completed a recovery route. That automatic loop is the next independent acceptance checkpoint. No performance or storage benefit is claimed here.
