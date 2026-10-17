# Checkpoint recovery candidate API release

Fixed product commit: `c3a7d1a5cf08de45900b28d3aa134fbf9c600768`.

One isolated Git archive passed build, published declarations, and compiled API checks. `checkpointRecoveryCandidates` is present on the emitted core and browser classes; its published input/result types retain the four false authority flags and required dispatch revalidation. The query itself was not invoked. All 639 output artifacts are hashed, and archived source hashes were unchanged during the checks.

`runner.py` references the prior run9 release runner and its existing helpers by SHA, removes the already-completed root/core source typecheck, and substitutes this API-only smoke. No old receipt or experiment input was copied. Internal workspace dependencies resolved inside the new archive; external dependencies were borrowed. See `reference.json`, `wrapper-inputs.json`, `validation.json`, and `compiled-smoke.json` for exact inputs and results.

The owned temporary archive was deleted after success; `cleanup.json` records the path and removal. Borrowed dependencies were retained. No browser, service, persistent task database, receipt, protocol, behavior test, or performance check ran. This checkpoint proves publication availability only, not successful live recovery or additional coverage. No main-branch merge or commit was performed by this release runner.
