# Stage 2: constrained scope and dependency-aware progress

Status: ACTIVE, implementation and validation unfinished. Started from clean HEAD 2c3d211 on codex/finite-coverage-loop. Goal created and read back on 2026-10-18 Asia/Shanghai, without token budget. Stage 1 completion does not satisfy this goal.

## Exact active objective

基于 codex/finite-coverage-loop 的已交付版本 2c3d211，在现有 Node/TypeScript 真实探索引擎中修复任务范围约束和探索调度，使局部未知或能力缺口阻止虚假的完整覆盖声明，但不阻止与其无关且已具备执行依据的任务继续探索。以 Crawljax 源码及 /Users/xietian/Experiments/crawljax-okx-20261018/v3 实验为持续技术依据，核对并采用状态归一化、图路径恢复、探索去重与必要恢复动作分离、重新定位及到达验证机制；保留不可变的原未完成子目标与真实执行回执。保持当前本地完整验收及独立复验通过，在每次 240 秒/80 次真实浏览器动作预算内，让当前真实插件在 OKX 公开页面自主建立至少一条严格的原未完成子目标重入续测链，并以冻结代码独立复验。不得通过缩小已约定覆盖范围、删除未知项或义务、伪造分类/执行证据、硬编码路线、放宽完整判据或扩大预算取得通过。交付代码、任务范围与覆盖账本一致性证据、局部未知与可继续探索的正反例、Crawljax 源码机制到 TS 实现及真实链证据的对应表、完整结果与可复现命令。未知项未解决时必须诚实保持整体未完成，不要求把整个 OKX 网站宣布穷尽。只有这些实现与验证交付实际完成才标 complete；真实外部阻塞按 goal 工具规定处理。

## Mandatory implementation and evidence

1. Caller coverage scope, authorized operations and exclusions must be program-checkable. A model may decompose within that contract, never silently expand or shrink it. Preserve the original public navigation evaluation scope; do not convert exhaustive requests to targeted ones to pass. Separately prove scope and scheduler fixes.
2. Separate progress from completeness. Retain local unknown/canvas/region/classification sources, scope and dependencies. Block a proposed action when dependent or independence is unproved; allow unrelated DOM work only with current execution authority, location and obstruction checks. No global unknown allowance, accepted capability limitation, deleted duties or blanket action whitelist.
3. Bound reviews, refresh and retries with observable reasons. Ready execution and difficult reviews must both receive opportunities. If nothing can run, report actual blockers rather than loop.
4. Navigation equivalence, target correspondence and immutable coverage duties remain separate. Fresh observations/locators, arrival and original-child receipts remain mandatory. Necessary restoration must survive exploration deduplication and cannot itself complete the child.
5. Use Crawljax source and v3 A's three strict chains as ongoing implementation evidence. Explain TS mismatch. Keep generic popup handling and obstruction/boundary order; no OKX labels, prescribed route, fabricated model output or FRAGGEN substitution.

## Validation gates (all outstanding for this stage)

- Targeted/exhaustive scope constraints; unrelated unknown canvas + executable DOM positive; unknown obstruction/coverage/prerequisite negative; retained unknown obligations; fair review/execution; missing dispatch/wrong instance/revoked review rejection.
- Frozen product local full acceptance and independent fresh-data confirmation, original independent 23 branches unchanged. Baseline: 37 verified obligation rows, 34 actions, 47.799/49.300 seconds, two strict chains, real process restart, zero remaining/redundant completions. Unknown-region regression is separate, never a replacement.
- Then OKX same entry https://www.okx.com/zh-hans/convert/usd-to-btc and same public-navigation authorization. Each run 240 seconds/80 actual commands including navigation/recovery/failure/waits; audit reserve declared before run. Real plugin/SDK/Playwright/SQLite/JEV/LLM, same providers; changes recorded beforehand. No login/trade/identity/region claims/access bypass.
- Strict OKX chain: originally unfinished child discovered, later absent, autonomous return selected, real entry/path execution, independent fresh observation and arrival validation, original child actual execution and durable receipt. Frozen-code fresh-data confirmation required. Open menu/increased actions/speed alone fail. Overall coverage may and must remain incomplete while unknowns remain.
- Keep every failed run immutable; diagnose, fix and start a new independently bounded run. Do not sum budgets or weaken auditors. Preserve baseline 45 regression failures and check affected suites for additions.
- Deliver code, scope/ledger consistency, positive/negative cases, concrete Crawljax-to-TS-to-real-chain table, all results and reproduction commands. Only actual completion permits goal complete. External blocked status requires repeated genuine blocker per goal rules.

## Starting evidence and next action

Stage 1 evidence/okx-1: 165.296 seconds, 2 actions, 43 JEV/2 LLM, no chain. Diagnosis records targeted intent, exhaustive LLM plan, global review work and UNSUPPORTED_CANVAS. Revalidate causal claims against raw timeline and runtime before fixing; distinguish observed sequence from unproved performance attribution. Original local archives and original refactor remain untouched. Never instantiate ExplorerStore against a live worker DB; use copies after exit.

Next: inspect plan initialization, scope schema, region/classification scheduling, candidate admission and finishRound capability handling; verify against raw prior trace and Crawljax sources, then add focused contract/dependency tests and implementation.


## Progress checkpoint: contract and direct-action foundation

Implemented (not final frozen delivery): caller `coverageContract` with exact semantic roots, declared mode, exclusions and allowed operation kinds; program initializes roots without model replacement. Followup proposals outside roots/exclusions/operation bounds are rejected. Contract persists in task and coverage ledger. Old tasks keep old behavior; contracted tasks cannot use legacy revise to erase authority. Disallowed in-scope operations remain required coverage gaps. Probes/direct actions check allowed kinds; full recovery-path contract verification remains to be completed.

Captured bounded `domAncestry` and per-unsupported-subtree `coverageScope` in real browser observations. `progress-dependencies.ts` is an additional finite direct-action scheduling gate: scoped unsupported contents can be structurally independent of a ready current DOM target, while same/ancestor/descendant targets, shared forms, linked/missing references, incomplete ancestry, critical gaps, and current obstruction still block. This is finite DOM independence only, never proof about arbitrary JavaScript or business effects. Unknowns and their sources remain in ledger. Review scheduling can yield after two review steps to an independently executable current action and resumes reviews after execution. No all-critical-gap bypass or capability acceptance was added.

Verification: stage2-focused-1.log has 70 passing tests (original 63 plus seven new); stage2-progress-2.log adds a real-plugin fairness case and has four passing dependency tests, giving 71 unique relevant tests checked. stage2-types-4.log typecheck passed. Source proof, missing/wrong dispatch/instance/conditions, revoked review and review recovery negatives still pass. No new full local acceptance or OKX run yet. These tests DO NOT prove final goal completion.

Causal recheck: original OKX trace logs canvas gap at 1792267775741, successful Close dispatch at 1792267805807, round audit at 1792267900914. Thus canvas did not globally prevent all direct execution: `finishRound` permanent-gap handling stopped continuation after reviews. `initializePlan` accepted LLM exhaustive despite targeted route; `finiteNeedsReview` includes all relevant unknown classifications, explaining ordering, but its exact performance contribution remains unmeasured. Read-only inspection used an extracted copy `.data/stage2-okx-offline`, never a live DB. The original first observation has 291 controls and 28 controls with captured header/navigation ancestry. Do not copy labels/routes into product rules.

Crawljax source rechecked: NormalizedFactory.Vertex equality/hash is graph indexing only; Surface independently captures arrival and validates actual candidate readiness; Recovery pending maps and A native replay preserve original children. A's first accepted chain has discovery 22.746s, absence 43.994s, independently matched return 51.685s and actual original-child execution 51.851s. TS prior run never reached a corresponding navigation child; merely reusing grouping/path APIs is insufficient. No site-specific route, B helper or FRAGGEN was added.

### Next required implementation work

1. Finish generic structurally grounded public-header/navigation scope expression (current contract supports existing exact Scope only). No hardcoded OKX labels. Preserve initial public navigation coverage and reachable authorized convert/spot pages, including original pending menu children and required popup exits; do not conflate whole-page root with restricted request.
2. Propagate contract/dependency checks through probes, SDK replay/recovery and all actual dispatch paths, not only plugin direct-action selection. Current extra dependency gate has not yet been proven on those paths. Critical observation gaps stay blocking. Keep current SDK receipt/arrival guards.
3. Replace `finishRound` unconditional permanent-gap stop with evidence-based continuation assessment; do not globally ignore critical/unknown outcomes. Distinguish available direct work, recoverable original work and true no-progress blockers. Keep retry/round budget bounded.
4. Retain localized unsupported obligations correctly for targeted structural scopes; current `retainHostLimitations` mainly handles page roots. Scope metadata is captured but structural-root scope and related gap bookkeeping still need implementation.
5. Run affected broad regression against disclosed 45-failure baseline; then freeze all implementation, run original full local acceptance and independent confirmation. Only after both passes run fresh bounded OKX strict-chain acceptance + frozen confirmation. Archive failures unchanged, diagnose/fix/new run. Existing harness/auditors have not been weakened or changed.

Goal remains ACTIVE. A foundation commit or local test pass is not completion. Do not mark complete until every original stage-2 gate is met.
