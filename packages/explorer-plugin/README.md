# Independent explorer plugin

`@interaction/explorer-plugin` owns model routing, exploration scheduling, durable plans and follow-up rounds. It consumes the existing browser SDK's public methods. The SDK, core, browser adapter and existing client have no dependency on this plugin and are unchanged.

## Install and enable

The workspace supplies the package. Use Node 24 and `pnpm install`. The existing server loads it only when `EXPLORER_ENABLED=true`. Copy the values from `.env.explorer.example` into your server environment; the server does not automatically read `.env` files. Then run `pnpm dev`, or `pnpm build` followed by `pnpm start`.

Keep keys on the server. `/plugins/explorer/v1/status` exposes only provider names, model names, configured flags and host capabilities. Without LLM configuration the UI remains available; planning stops with `configuration_required`. There is no implicit mock provider.

JEV configuration uses `EXPLORER_JEV_PROVIDER=typesafe|openrouter`, `EXPLORER_JEV_ENDPOINT` (full URL), `EXPLORER_JEV_MODEL` and `EXPLORER_JEV_API_KEY`. LLM configuration uses `EXPLORER_LLM_ENDPOINT` (full chat/completions URL), `EXPLORER_LLM_MODEL` and `EXPLORER_LLM_API_KEY`. Custom local endpoints may omit a key. For OpenRouter, `EXPLORER_LLM_PROVIDER=openrouter` enables explicit routing; `EXPLORER_LLM_UPSTREAM_PROVIDER` pins the upstream with fallback disabled and parameter support required. `EXPLORER_LLM_REASONING_EFFORT` accepts none/low/medium/high; `EXPLORER_LLM_MAX_OUTPUT_TOKENS` sets the completion budget. The example matches ui-sentinel’s current Alibaba route with low reasoning and uses 8192 tokens for structured exploration plans. See [OpenRouter routing](https://openrouter.ai/docs/guides/routing/provider-selection). The LLM endpoint must support JSON-object responses. Responses are also validated locally; unsupported formats fail explicitly.

JEV uses typed Choice and Noul judgments according to [TypeSafe's API](https://docs.typesafe.ai/api). Its [confidence](https://docs.typesafe.ai/confidence) summarizes the option distribution; it is not measured correctness. Routing is versioned (`evidence-routing-v3`) and depends on the decision's consequences:

| Decision | Program policy |
| --- | --- |
| Next action / sample / bounded probe / discovery target | Rank already offered candidates without a confidence cutoff; ties use stable order. Scope and host preflight still apply; other targets remain pending. |
| Region grouping | An `include` result groups observed controls without excluding any or granting permission. Uncertainty refreshes observation once, then remains a gap. |
| Scope reduction | `all` retains observed members. `sample` is accepted only with the user's explicit `coverageMode: representative` and no explicitly required individual target. `skip`, `defer`, or uncertain proposals cannot remove members: the program retains the group and the plan matcher limits actual execution. |
| Control classification | Possible interactions remain candidates. Display/container judgments require the classification threshold, complete subtree evidence and no contradictory supported interaction basis. Uncertainty refreshes once, then remains unresolved. |
| Identity | A merge needs the identity threshold and compatible captured structure. Otherwise keep the current occurrence independent. |
| Operation risk | One JEV request asks independent Noul questions per available operation: evidence of an interface-only effect, and evidence of an external/business write. Program code requires a strong yes to the first and a strong no to the second. Ambiguous evidence refreshes once per target per round, then remains a required gap. Native element type alone is insufficient. |
| Shared purpose / recovery | Uncertain or below-threshold results retain per-control review or a recovery gap, without automatic LLM fallback. |
| Round completion | Program execution evidence, observed candidates and outstanding gaps determine current-plan completion. A model confidence score cannot mark coverage complete. |
| New planning | JEV first checks whether new scopes/prerequisites are needed. Only a sufficiently supported `replan` result requests generation. Otherwise preserve existing gaps. |

`EXPLORER_CLASSIFICATION_THRESHOLD`, `EXPLORER_IDENTITY_THRESHOLD`, `EXPLORER_EVIDENCE_THRESHOLD`, and `EXPLORER_PLANNING_THRESHOLD` configure separate Choice gates. Until a labeled evaluation establishes better settings, their conservative initial value remains 0.8 (or the legacy `EXPLORER_CHOICE_THRESHOLD` default). These gates now control conservative acceptance/defer behavior, **not escalation to LLM**. `EXPLORER_GROUPING_THRESHOLD` is retired and ignored. Operation checks use `EXPLORER_OPERATION_NOUL_LOW/HIGH` (initially 0.1/0.9; legacy `EXPLORER_NOUL_LOW/HIGH` remain defaults). These are probability bounds and must straddle 0.5. None of these initial values is asserted to be optimal or calibrated.

Initial plans, new input samples and new purpose descriptions still require LLM generation. Follow-up generation occurs only when JEV identifies missing planning. Built-in typed decisions never switch to LLM just because confidence is low, evidence is missing, or JEV is unavailable. A JEV service failure saves and pauses the task; its 30-second circuit prevents immediate repeat calls. Unclassified custom router requests retain the legacy fallback contract. A request has a 60-second configurable deadline. Observation refreshes, batched questions, raw answers, actual model versions, policy versions, thresholds and program resolutions remain auditable. A batched risk check counts as one model request, with all returned numeric usage recorded. There is no hidden HTTP retry.

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

- `GET /status`, `GET /tasks`, `POST /tasks` (`goal`, `url`, optional `coverageMode`, `budget` and bounded `sessionOptions`).
- `GET /tasks/:id` returns the task, decisions and first event page.
- `GET /tasks/:id/events?after=0&limit=500` provides durable cursor pagination.
- `POST /tasks/:id/commands` accepts `start`, `resume`, `pause`, `stop`, `replan`, `continue-scope`, `extend-budget`.
- `replan` accepts a new goal or reviewed `items`, and an optional `coverageMode` (`all` by default, `representative` only by user choice). `continue-scope` accepts existing `itemIds` and forces full traversal of those selected targets so they cannot be sampled out again. Pause before changing a plan. Start/resume separately after inspecting changes. `extend-budget` explicitly adds an allowance to the existing totals; it never resets usage. The UI labels this action “追加上方预算”.

Plan scopes match exact URL, region label, control label, role, stable key, operation kind and optional value. Prerequisites use the same format. Ambiguous matches stay unresolved. A plan completion description is guidance; verification currently means successful supported interaction with a subsequent host observation, not arbitrary business assertions.

## Durable execution and coverage

Default totals are 3 rounds, 300 actions, 30 active minutes and 300 provider requests. Individual sessions default to 100 actions, capped by the task's remaining allowance. Recovery actions count through the host action ledger. Pauses do not consume duration; waiting for providers does. Already-dispatched host operations settle before ownership is released. A host recovery command may finish after the duration deadline; no further operation is dispatched afterwards.

Each new round rematches semantic scopes and obtains fresh reviews. Old successes may guide scheduling only when scope, declared context and captured dispatch bindings/constraints/options match. They retain their original session/attempt references and are never copied into the new engine audit. Missing or ambiguous targets remain unresolved. Unselected samples remain in the plan as untested, and do not automatically expand a later round. Users can select them explicitly for follow-up.

Tasks, rounds, decisions and correlated events are stored in a separate `explorer.sqlite`. Engine facts remain in the host's database. Model inputs and normalized results are persisted with observation references; relevant detailed evidence is pinned through the public evidence API and still subject to host storage limits. Keep both databases/evidence directories for historical inspection. An expired or missing artifact remains unavailable, rather than being replaced by current evidence.

On restart active tasks become paused, in-flight decisions become stale, and continuation observes again. A durable execute intent uses one request ID. Unknown outcomes are not replayed automatically. Missing public capabilities become explicit gaps. In particular, this version of the host may not expose a reviewed outside-boundary dismissal operation; failed normal/checkpoint exits remain blocked.

`completed` means the current observed plan is verified. `exhaustive` is always false. Discovery gaps, sampled-out members and unreachable states remain separately visible.

## Debug UI and validation

`ExplorerWorkspace` integrates goal, budget, task selection and execution controls into the host sidebar, alongside a switch to the existing manual controls. Pass the host's selected `sessionId` so opening a historical session automatically loads its owning task without switching to a newer round. The traversal displays only the selected round's events and JEV/LLM counts, with a shortcut to the latest call. `ExplorerPlan` shows unfinished ranges and evidence in the main workspace. User-facing controls use exploration terminology without exposing the package boundary. The traversal column interleaves program, JEV, LLM and engine events. Click a decision to inspect input, output, LLM escalation reasons and actual application effects in the right-hand `ExplorerInspector`. Safe request bodies and response content are persisted without authentication headers or provider reasoning text. HTTP error bodies remain excluded. Applied plan/review/action/recovery events distinguish decisions from actual execution results; older records do not gain invented effects. Truncated output is retained for diagnosis but cannot execute. The UI does not invent a prose explanation for a JEV choice.

Tests use explicitly injected mock providers and real local Playwright pages. No real key or paid service is required. Live-provider acceptance is a separate final check after credentials are configured.

Older tasks without `coverageMode` default to full traversal for future reviews; existing recorded untested samples remain untested. Old decision records are not rewritten. When resuming a paused round made under an older policy version, the plugin starts a fresh session for current reviews and permissions; total budgets are not reset. The debug sidebar exposes the coverage choice and the decision inspector separates the raw model answer from the actual program resolution.

Execution authority is separate from the unfinished ledger. Only accepted initial/user-reviewed scopes have `dispatchScope: true`; discovered action rows, follow-up suggestions and gaps are records, not new grants. Selecting a gap explicitly for a later round grants that selected scope. Old tasks restore authority from the last persisted initial/revised plan snapshot, never from accumulated page-level gaps. If that snapshot is unavailable they require replanning. Reviews target controls relevant to authorized scopes or prerequisites. Once all explicit goals have execution evidence, the scheduler audits completion before attempting recovery; checkpoint matching uses semantic scopes and the source observation rather than exact equality of scope objects with different optional fields.

An operation-only scope (for example `kind: select, value: IOC`) must bind to a current candidate before control review; it never implies page-wide scanning or scrolling. User-named future controls remain semantic targets with prerequisites until observed. Unique concrete operation scopes can complete immediately on successful dispatch and subsequent observation; broad scopes still require auditing all observed cases. Completed scopes no longer request unrelated reviews.
