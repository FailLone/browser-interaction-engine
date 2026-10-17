# OKX run19: local actual execution, acceptance contract failure

Product `0bcfdcef891736f270ccdfa0f5785e0a9115c4d5`; one shared 240 s window, stopped at 84.37 s including process startup. Original result remains `not_accepted`.

- Local recovery passed in 42.085 s: same document/session, one verified Close, one recorded Trade, zero entry replay, historical USD source equivalent and live target valid.
- Guarded source-bound USD fill `2` actually succeeded; unique correspondence, current availability, receipt, saved value and independent live value all agree. The actual input was previously unattempted in the retained session.
- The extra assertion on `operationReceiptCondition.conditionVerified` failed with `identity_pending`. That API intentionally separates actual success from reusable condition coverage. Its rejection does not revoke the successful input; no reusable coverage was granted.
- First failure stopped the runner before global setup. This run provides **no result for global recovery or its timeout**.

Two independent code reviews agreed that requiring reusable condition coverage was an acceptance contract error for the fixed goal of actual recovery plus continuation. A later run may replace that assertion with exact durable receipt ownership/bindings, complete before/after facts and clean/no-unknown postconditions; all dispatch and correspondence gates remain. This run is not retroactively accepted.

See `audit.json` for measured counts and unchanged source/cleanup verification. Timing is not an identical-workload benchmark against run18 because continuation was added.
