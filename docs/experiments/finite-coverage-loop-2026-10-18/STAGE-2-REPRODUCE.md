# Stage 2 reproduction and status

Stage 2 is active and incomplete. The frozen implementation tested here is `3698f0522f145c3f08869c848f6df8948fc7b11a`. Evidence-only commits do not change that implementation. Worktree: `/Users/xietian/.codex/worktrees/finite-coverage-loop/browser-interaction-engine`.

Use Node 24.22.0 and the existing provider environment without printing it. Do not reuse any previous run folder. The commands below create fresh independently budgeted runs; they do not resume, sum budgets or overwrite archives.

```sh
export PATH=/Users/xietian/.local/share/fnm/node-versions/v24.22.0/installation/bin:$PATH
pnpm typecheck
pnpm exec vitest run tests/explorer-identity-review-progress.test.ts tests/finite-coverage-contract.test.ts tests/explorer-review-ledger-sources.test.ts tests/explorer-target-review.test.ts tests/explorer-review-recovery.test.ts tests/execution-boundary.test.ts tests/explorer-coverage-contract.test.ts tests/explorer-progress-dependencies.test.ts
node --env-file=/Users/xietian/.codex/worktrees/autonomous-exploration/browser-interaction-engine/.env.explorer.local scripts/local-loop-acceptance.mjs .data/stage2-local-fresh
node --env-file=/Users/xietian/.codex/worktrees/autonomous-exploration/browser-interaction-engine/.env.explorer.local scripts/local-loop-acceptance.mjs .data/stage2-local-fresh-confirmation
```

Compare both `source.json` file maps and empty `source.diff`, inspect both full `result.json`/`audit.json` and persisted evidence. The committed runs stage2-local-7/8-confirmation pass all original local checks: 23 branches, 37/37 duties, two strict chains, real process restart, no remaining work or duplicated completed-condition attempts. No independent auditor or local branch list was changed.

Only after both local gates pass on the same frozen code:

```sh
node --env-file=/Users/xietian/.codex/worktrees/autonomous-exploration/browser-interaction-engine/.env.explorer.local scripts/finite-okx-acceptance.mjs .data/stage2-okx-fresh
```

Each run retains the 240-second/80-command cap and stops cooperatively at 210 seconds for durable audit. Exit code 2 means strict-chain acceptance failed, even if controls executed successfully. An accepted OKX run still requires a fresh-data frozen-code confirmation. The currently archived stage2-okx-1, stage2-okx-2 and stage2-okx-3 failed with zero chains and cannot satisfy either OKX gate.

The protocol's caller URL language equals the original effective public navigation guard; see stage2-scope-consistency.json (168 checked path cases and literal expression equality). It does not prescribe a route or normalize observation/receipt URLs. Unknown and forbidden operation obligations remain. Task status `paused` in this bounded OKX run came from its protocol timer calling the pause API; it is not a human request to pause the active goal.

Expanded regression: 251 tests, 206 passed and the same 45 historical failure names, with no added names. See stage2-broad-summary-5.json and compressed raw report. Full repository green status is not claimed. Failed Stage 2 local runs 1/2 and OKX runs 1/2/3 are immutable archived evidence; their source/receipt failures have not been relabeled or discarded.
