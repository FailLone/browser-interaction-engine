# Independent explorer plugin

`@interaction/explorer-plugin` owns model routing, exploration scheduling, durable plans and follow-up rounds. It consumes the existing browser SDK's public methods. The SDK, core, browser adapter and existing client have no dependency on this plugin and are unchanged.

## Install and enable

The workspace supplies the package. Use Node 24 and `pnpm install`. The existing server loads it only when `EXPLORER_ENABLED=true`. Copy the values from `.env.explorer.example` into your server environment; the server does not automatically read `.env` files. Then run `pnpm dev`, or `pnpm build` followed by `pnpm start`.

Keep keys on the server. `/plugins/explorer/v1/status` exposes only provider names, model names, configured flags and host capabilities. A blank task and a written task that JEV recognizes as unrestricted current-page exhaustion can start with JEV alone. LLM configuration is required only when the task needs structured interpretation, new inputs or new planning; a missing provider then saves the task with `configuration_required`. There is no implicit mock provider.

JEV configuration uses `EXPLORER_JEV_PROVIDER=typesafe|openrouter`, `EXPLORER_JEV_ENDPOINT` (full URL), `EXPLORER_JEV_MODEL` and `EXPLORER_JEV_API_KEY`. LLM configuration uses `EXPLORER_LLM_ENDPOINT` (full chat/completions URL), `EXPLORER_LLM_MODEL` and `EXPLORER_LLM_API_KEY`. Custom local endpoints may omit a key. For OpenRouter, `EXPLORER_LLM_PROVIDER=openrouter` enables explicit routing; `EXPLORER_LLM_UPSTREAM_PROVIDER` pins the upstream with fallback disabled and parameter support required. `EXPLORER_LLM_REASONING_EFFORT` accepts none/low/medium/high; `EXPLORER_LLM_MAX_OUTPUT_TOKENS` sets the completion budget. The example matches ui-sentinel’s current Alibaba route with low reasoning and uses 8192 tokens for structured exploration plans. See [OpenRouter routing](https://openrouter.ai/docs/guides/routing/provider-selection). The LLM endpoint must support JSON-object responses. Responses are also validated locally; unsupported formats fail explicitly.

JEV uses typed Choice and Noul judgments according to [TypeSafe's API](https://docs.typesafe.ai/api). Its [confidence](https://docs.typesafe.ai/confidence) summarizes the option distribution; it is not measured correctness. Routing is versioned (`evidence-routing-v5`) and depends on the decision's consequences:

| Decision | Program policy |
| --- | --- |
| Task type | Blank input uses a program-created full-page root. Written instructions go to JEV first: confidently exhaustive creates the same root without LLM; confidently unsupported stops with a recorded reason; targeted/constraint-bearing or uncertain requests ask LLM for a strict structured task. The planning threshold applies to accepting a task classification. |
| Next action / sample / bounded probe / discovery target | Rank already offered candidates without a confidence cutoff; ties use stable order. Scope and host preflight still apply; other targets remain pending. |
| Region grouping | An `include` result groups observed controls without excluding any or granting permission. Uncertainty refreshes observation once, then remains a gap. |
| Scope reduction | `all` retains observed members. `sample` is accepted only with the user's explicit `coverageMode: representative` and no explicitly required individual target. `skip`, `defer`, or uncertain proposals cannot remove members: the program retains the group and the plan matcher limits actual execution. |
| Control classification | Possible interactions remain candidates. Display/container judgments require the classification threshold, complete subtree evidence and no contradictory supported interaction basis. Uncertainty refreshes once. If complete evidence still needs interpretation, one grounded LLM clarification can choose only structurally allowed classifications. A truncated subtree remains unresolved. |
| Identity | A merge needs the identity threshold and compatible captured structure. An explicit independent result needs no LLM. An unresolved compatible match refreshes once, then can ask LLM to cite both current and historical evidence. Incompatible matches are never offered; unresolved occurrences remain independent and never inherit historical execution success. |
| Operation risk | One JEV request asks independent Noul questions per available operation: evidence of an interface-only effect, and evidence of an external/business write. Program code requires a strong yes to the first and a strong no to the second. Ambiguous evidence refreshes once per target per round. If a captured structural relationship or observed controlled content exists, LLM can interpret the purpose with separate interface-only and external-write conclusions. A confident JEV veto is never overridden. Native element type, names, cursor styles and handler presence alone do not justify an LLM call or permission; unresolved effects remain required gaps. |
| Shared purpose / recovery | Uncertain or below-threshold results retain per-control review or a recovery gap, without automatic LLM fallback. |
| Round completion | Program execution evidence, observed candidates and outstanding gaps determine current-plan completion. A model confidence score cannot mark coverage complete. |
| New planning | JEV first checks whether new scopes/prerequisites are needed. Only a sufficiently supported `replan` result requests generation. Otherwise preserve existing gaps. |

`EXPLORER_CLASSIFICATION_THRESHOLD`, `EXPLORER_IDENTITY_THRESHOLD`, `EXPLORER_EVIDENCE_THRESHOLD`, and `EXPLORER_PLANNING_THRESHOLD` configure separate Choice gates. Until a labeled evaluation establishes better settings, their conservative initial value remains 0.8 (or the legacy `EXPLORER_CHOICE_THRESHOLD` default). These gates retain conservative acceptance behavior. Only the bounded semantic clarification paths above can request LLM after a refresh; ranking and grouping uncertainty alone never trigger LLM. Task-type classification separately requests structured interpretation when uncertain. `EXPLORER_GROUPING_THRESHOLD` is retired and ignored. Operation checks use `EXPLORER_OPERATION_NOUL_LOW/HIGH` (initially 0.1/0.9; legacy `EXPLORER_NOUL_LOW/HIGH` remain defaults). These are probability bounds and must straddle 0.5. None of these initial values is asserted to be optimal or calibrated.

Structured target plans, extracted constraints, new input samples and new purpose descriptions require LLM generation. Unrestricted exhaustive exploration does not need an initial LLM plan. Follow-up generation occurs only when JEV identifies missing planning. Traversal judgments do not switch to LLM merely because confidence is low. Purpose, classification and viable identity ambiguity can request one structured clarification per target and evidence set per round; the persisted ledger survives restart and ignores changing dispatch IDs. Missing LLM configuration pauses the task. Clarification returns a finite offered choice, evidence IDs, reason and independent effect conclusions; code verifies the references and required evidence, and the public host still validates the current binding before application. Reference validity is not proof that a semantic interpretation is correct. Invalid references, unoffered choices and unresolved effects are recorded as rejected; they confer no grant. Both the upstream JEV decision and downstream LLM input, output and validation/application effects are visible in the debug inspector. Pending identity hypotheses are included in the progress signature so resolving several identities does not falsely trigger the three-step no-progress stop. Task-type uncertainty explicitly requests structured interpretation; a JEV outage never switches providers. A JEV service failure saves and pauses the task; its 30-second circuit prevents immediate repeat calls. Unclassified custom router requests retain the legacy fallback contract. A request has a 60-second configurable deadline. Observation refreshes, batched questions, raw answers, actual model versions, policy versions, thresholds and program resolutions remain auditable. A batched risk check counts as one model request, with all returned numeric usage recorded. There is no hidden HTTP retry.

Tune gates against labeled examples of each judgment: missed in-scope controls, incorrect scope exclusions, incorrect operation permissions, ambiguity and changed observations. Track false exclusions, false grants, unresolved coverage, calls and actual cost on held-out examples; LLM agreement alone is not ground truth. Revalidate after changing model versions or prompts. Mock-provider regressions prove scheduling/guard behavior, not JEV accuracy.

## Embed

```ts
import { ExplorerPlugin, ExplorerStore, providersFromEnv } from '@interaction/explorer-plugin';
import { registerExplorer } from '@interaction/explorer-plugin/server';

const plugin = new ExplorerPlugin(engine,
  new ExplorerStore('.data/plugins/explorer.sqlite'), providersFromEnv());
await registerExplorer(app, plugin); // before app.listen()
// Existing app also keeps all standard engine routes.
```

The host is an injected `ExplorerHost` public-method interface. Inject a `Provider` implementing `decide(request, signal)` for an alternative service. Browser UI components are exported from `/ui`; `/client` exports a standalone HTTP client. Importing either browser entry does not load the server, SQLite or provider keys.

The plugin uses manual single-step execution, public review commands and checkpoint recovery. It does not invoke or patch the internal DFS loop. Application middleware owns the browser while a plugin run is active; competing writes are rejected. The standard pause/stop commands first pause the plugin. Read-only routes remain available. Embedders that bypass this middleware must provide equivalent single-writer ownership; direct SDK callers cannot be locked by an independent plugin.

## API

All endpoints are under `/plugins/explorer/v1`:

- `GET /status`, `GET /tasks`, `POST /tasks` (`url`, optional `goal`, `coverageMode`, `budget` and bounded `sessionOptions`). Omitted, empty or whitespace-only `goal` selects default exhaustive exploration with `coverageMode: all`.
- `GET /tasks/:id` returns the task, decisions and first event page.
- `GET /tasks/:id/events?after=0&limit=500` provides durable cursor pagination.
- `POST /tasks/:id/commands` accepts `start`, `resume`, `pause`, `stop`, `replan`, `continue-scope`, `extend-budget`.
- `replan` accepts a new goal or reviewed `items`, and an optional `coverageMode` (`all` by default, `representative` only by user choice). `continue-scope` accepts existing `itemIds` and forces full traversal of those selected targets so they cannot be sampled out again. Pause before changing a plan. Start/resume separately after inspecting changes. `extend-budget` explicitly adds an allowance to the existing totals; it never resets usage. The UI labels this action “追加上方预算”.

Plan scopes match exact URL, region label, control label, role, stable key, operation kind and optional value. Prerequisites use the same format. Ambiguous matches stay unresolved. A plan completion description is guidance; verification currently means successful supported interaction with a subsequent host observation, not arbitrary business assertions.

## Durable execution and coverage

Default totals are 3 rounds, 300 actions, 30 active minutes and 300 provider requests. Individual sessions default to 100 actions, capped by the task's remaining allowance. Recovery actions count through the host action ledger. Pauses do not consume duration; waiting for providers does. Already-dispatched host operations settle before ownership is released. A host recovery command may finish after the duration deadline; no further operation is dispatched afterwards.

Each new round rematches semantic scopes and obtains fresh reviews. Old successes may guide scheduling only when scope, declared context and captured dispatch bindings/constraints/options match. They retain their original session/attempt references and are never copied into the new engine audit. Missing or ambiguous targets remain unresolved. Unselected samples remain in the plan as untested, and do not automatically expand a later round. Users can select them explicitly for follow-up.

Tasks, rounds, decisions and correlated events are stored in a separate `explorer.sqlite`. Engine facts remain in the host's database. Model inputs and normalized results are persisted with observation references; relevant detailed evidence is pinned through the public evidence API and still subject to host storage limits. Keep both databases/evidence directories for historical inspection. An expired or missing artifact remains unavailable, rather than being replaced by current evidence.

On restart active tasks become paused, in-flight decisions become stale, and continuation observes again. A durable execute intent uses one request ID. Unknown outcomes are not replayed automatically. Missing public capabilities become explicit gaps. When the host exposes `boundaryExitMaterial`, the plugin can review an outside dismissal after current boundary work and normal exits are exhausted. Independent JEV Noul checks must support interface cancellation and reject external writes. The host binds the current point and preserves visible parent input/selection fields. `not_closed` leaves the boundary unresolved without retrying that point; `changed` or `unverified` blocks further dispatch, including after resume. A successful click alone never proves successful exit. Older hosts retain an explicit capability gap.

`create({url, evidenceBudget: {maxBytes, maxObservations}})` controls retained artifact capacity per session. Defaults are 1 GiB and 1,000 observations; the previous 128 MiB limit could stop large pages during review before meaningful traversal. Each model source observation remains protected, and capacity exhaustion is an explicit gap, never permission to delete protected evidence. Historical sessions keep their original quota; new rounds use the task setting or the new default. Action, time, round and model-request totals continue across all rounds.

The plugin gives observation a 10-second default window so a large page can produce multiple comparable captures. `sessionOptions.observeTimeoutMs` overrides it. This changes waiting time only: the host's stability checks and critical-gap gates remain in force.

A terminal unknown result from a supported, replayable native HTTP hyperlink in a clean session can be isolated into a fresh round. The original attempt remains unknown, its required scope remains unresolved, and the same source/destination pair cannot dispatch again, including after restart or plan edits. New rounds use new observations and reviews and share the original total budget. This continues independent work without claiming recovery or verifying the unknown navigation; other unknown operations, dirty sessions, missing outcomes and in-flight commands remain blocked. The timeline records `navigation.isolated` with the original evidence and destination. Action ranking includes the captured navigation destination so models can prefer in-page work before leaving it.

`completed` means the current observed plan is verified. `exhaustive` is always false. Discovery gaps, sampled-out members and unreachable states remain separately visible.

## Debug UI and validation

`ExplorerWorkspace` integrates goal, budget, task selection and execution controls into the host sidebar, alongside a switch to the existing manual controls. Pass the host's selected `sessionId` so opening a historical session automatically loads its owning task without switching to a newer round. The traversal displays only the selected round's events and JEV/LLM counts, with a shortcut to the latest call. `ExplorerPlan` shows unfinished ranges and evidence in the main workspace. User-facing controls use exploration terminology without exposing the package boundary. The traversal column interleaves program, JEV, LLM and engine events. Click a decision to inspect input, output, LLM escalation reasons and actual application effects in the right-hand `ExplorerInspector`. Safe request bodies and response content are persisted without authentication headers or provider reasoning text. HTTP error bodies remain excluded. Applied plan/review/action/recovery events distinguish decisions from actual execution results; older records do not gain invented effects. Truncated output is retained for diagnosis but cannot execute. The UI does not invent a prose explanation for a JEV choice.

Tests use explicitly injected mock providers and real local Playwright pages. No real key or paid service is required. Live-provider acceptance is a separate final check after credentials are configured.

Older tasks without `coverageMode` default to full traversal for future reviews; existing recorded untested samples remain untested. Old decision records are not rewritten. When resuming a paused round made under an older policy version, the plugin starts a fresh session for current reviews and permissions; total budgets are not reset. The debug sidebar exposes the coverage choice and the decision inspector separates the raw model answer from the actual program resolution.

Execution authority is separate from the unfinished ledger. Only program-created exhaustive roots or accepted initial/user-reviewed scopes have `dispatchScope: true`; discovered action rows, follow-up suggestions and gaps are records, not new grants. Selecting a gap explicitly for a later round grants that selected scope. Old tasks restore authority from the last persisted initial/revised plan snapshot, never from accumulated page-level gaps. If that snapshot is unavailable they require replanning. Reviews target controls relevant to authorized scopes or prerequisites. Once all explicit goals have execution evidence, the scheduler audits completion before attempting recovery; checkpoint matching uses semantic scopes and the source observation rather than exact equality of scope objects with different optional fields.

While a dialog, menu or other active boundary is open, review scheduling prioritizes that boundary as well as action execution. Background control/group reviews and page-wide discovery wait until exit; they are not marked reviewed or removed from the plan. Region grouping prefers the current boundary and uses the host's public incremental review contract when available. Models receive region semantics and control evidence; exact dispatch and reuse bindings stay with the host for validation instead of being duplicated in the grouping prompt.

An operation-only scope (for example `kind: select, value: IOC`) must bind to a current candidate before control review; it never implies page-wide scanning or scrolling. User-named future controls remain semantic targets with prerequisites until observed. Unique concrete operation scopes can complete immediately on successful dispatch and subsequent observation; broad scopes still require auditing all observed cases. Completed scopes no longer request unrelated reviews.

## Task intent and default exhaustion

`plugin.create({url})` needs no natural-language task and no initial model call. After observing the initial page (including redirects), the program creates the authoritative root `{url: observation.url}`. It covers new controls, menus and dialogs appearing at that same URL. This is current-page interaction exploration, not automatic whole-site navigation or visual-defect inspection. `exhaustive: false` still means that finishing the recorded scope is not a proof of absolute site exhaustion.

For nonempty instructions, the `task-intent` JEV Choice returns `exhaustive`, `targeted`, `unsupported` or `uncertain`. Only confident unrestricted `exhaustive` directly creates the root. Specific operations, regional scopes and explicit exclusions need a structured plan; unclear classifications also use this interpretation path. Unsupported classifications stop without executing. UI events preserve the JEV answer, routing choice, resulting intent, source and program-created scope. A natural-language classification can be mistaken; recorded intent is visible for review and these thresholds are provisional.

When needed, one LLM generation returns a strict discriminated schema (`initialTaskSchema`, exported by the plugin):

```json
{"mode":"exhaustive","boundary":"current-page","exclusions":[]}
```

```json
{"mode":"exhaustive","boundary":"current-page","exclusions":[{"scope":{"label":"Delete","kind":"click"},"instruction":"do not click Delete"}]}
```

```json
{"mode":"targeted","items":[{"title":"Open settings","scope":{"label":"Other settings","kind":"click"},"prerequisites":[],"completion":"Dialog appears","required":true,"reason":"Requested operation"}]}
```

The other variant is `{"mode":"unsupported","reason":"..."}`. Unknown variants/fields, empty target plans, page-wide exclusions and exclusion quotes absent from the user's instruction are rejected before execution. Exclusions are constraints, remain visibly untested, and override automatic navigation/exit candidates. A model cannot supply an `items` subset for an exhaustive root. Both exhaustive paths require full coverage mode; representative sampling must be an explicitly targeted task, not a silent interpretation of exhaustion.

The original goal remains unchanged (blank stays blank). `Task.intent` persists version 1, mode and source (`default`, `jev`, `llm` or `user`); exhaustive intent also carries its actual page URL and exclusions. Clearing the task and replanning restores the program default. Explicit plan edits or selected-range supplementation become targeted intent. Historical tasks retain their existing plans and do not gain invented intent metadata. All resumes and revisions preserve accumulated budgets.

The sidebar starts empty and explains its default. The timeline shows “判断任务类型”, “程序建立全页范围” and structured intent effects alongside model requests. “LLM 0 次” is accurate for JEV/program-only runs; input generation or shared-purpose descriptions may still require LLM later.

Task-type-triggered generation records `Decision.triggeredBy`, linking the LLM input/output back to the JEV classification. This is a deliberate generation request rather than the router's legacy confidence fallback. Starting a new task releases idle/paused sessions belonging to completed plugin tasks through public `stop`; ordinary and unfinished sessions remain protected.

Scope completion is audited even when the last permitted action just revealed a new dialog or control. Pending actions, classification/identity/operation reviews, region assignment, discovery limits and critical observation gaps prevent a broad scope from inheriting completion from one successful action. These checks emit `scope.audit`; newly observed unexecuted actions stay in the unfinished plan.

Repeated-record scopes use a plugin-owned semantic key from the captured record key, template, slot and control semantics. Document-local owner/row instance IDs are excluded. URL, region, label, operation and value constraints still apply, and colliding semantic scopes remain unresolved rather than selecting an arbitrary occurrence. This is a matching hint: every new occurrence still requires fresh host reviews and execution guards. Historical success remains linked to its original attempt, never a synthetic success in the new session. On resume, legacy scopes are converted only when retained original observations establish the exact old key and scope; missing or conflicting evidence leaves them unchanged. `scope.remapped` records the before/after constraints and source evidence. Existing per-document attempt caches, budgets and unknown-outcome quarantine are preserved.

When public observation reports a new document instance after reattachment, the round clears its old attempted-action cache along with traversal frames and review keys. The task ledger, unknown-outcome quarantine and aggregate budgets remain intact, so a reopened interface exit can be reviewed and executed again without replaying an unknown submission. Boundary-exit preservation counts actual inputs (including empty, unchecked and read-only fields), stateful ARIA controls and observed selections; the default `checked: null` and `selected: []` fields on ordinary links/buttons do not consume the 100-control preservation limit.
