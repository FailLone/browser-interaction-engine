# Independent explorer plugin

`@interaction/explorer-plugin` owns model routing, exploration scheduling, durable plans and follow-up rounds. It consumes the existing browser SDK's public methods. The SDK, core, browser adapter and existing client have no dependency on this plugin and are unchanged.

## Install and enable

The workspace supplies the package. Use Node 24 and `pnpm install`. The existing server loads it only when `EXPLORER_ENABLED=true`. Copy the values from `.env.explorer.example` into your server environment; the server does not automatically read `.env` files. Then run `pnpm dev`, or `pnpm build` followed by `pnpm start`.

Keep keys on the server. `/plugins/explorer/v1/status` exposes only provider names, model names, configured flags and host capabilities. Without LLM configuration the UI remains available; planning stops with `configuration_required`. There is no implicit mock provider.

JEV configuration uses `EXPLORER_JEV_PROVIDER=typesafe|openrouter`, `EXPLORER_JEV_ENDPOINT` (full URL), `EXPLORER_JEV_MODEL` and `EXPLORER_JEV_API_KEY`. LLM configuration uses `EXPLORER_LLM_ENDPOINT` (full chat/completions URL), `EXPLORER_LLM_MODEL` and `EXPLORER_LLM_API_KEY`. Custom local endpoints may omit a key. For OpenRouter, `EXPLORER_LLM_PROVIDER=openrouter` enables explicit routing; `EXPLORER_LLM_UPSTREAM_PROVIDER` pins the upstream with fallback disabled and parameter support required. `EXPLORER_LLM_REASONING_EFFORT` accepts none/low/medium/high; `EXPLORER_LLM_MAX_OUTPUT_TOKENS` sets the completion budget. The example matches ui-sentinel’s current Alibaba route with low reasoning and uses 8192 tokens for structured exploration plans. See [OpenRouter routing](https://openrouter.ai/docs/guides/routing/provider-selection). The LLM endpoint must support JSON-object responses. Responses are also validated locally; unsupported formats fail explicitly.

JEV uses typed Choice and Noul judgments according to [TypeSafe's API](https://docs.typesafe.ai/api). Its [confidence](https://docs.typesafe.ai/confidence) is a routing signal, not a correctness guarantee. Choice defaults to 0.8; intermediate Noul probabilities (0.1, 0.9) fall back to the LLM. Generation goes directly to LLM. Failed JEV requests open a 30-second circuit; subsequent decisions use LLM. A request has a 60-second configurable deadline. No automatic HTTP retry hides additional calls from the budget. Actual returned model versions and numeric usage fields are recorded. JEV's experimental image features are not used; current decisions use structured captured evidence.

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

- `GET /status`, `GET /tasks`, `POST /tasks` (`goal`, `url`, optional `budget` and bounded `sessionOptions`).
- `GET /tasks/:id` returns the task, decisions and first event page.
- `GET /tasks/:id/events?after=0&limit=500` provides durable cursor pagination.
- `POST /tasks/:id/commands` accepts `start`, `resume`, `pause`, `stop`, `replan`, `continue-scope`, `extend-budget`.
- `replan` accepts a new goal or reviewed `items`. `continue-scope` accepts existing `itemIds`. Pause before changing a plan. Start/resume separately after inspecting changes. `extend-budget` explicitly adds an allowance to the existing totals; it never resets usage. The UI labels this action “追加上方预算”.

Plan scopes match exact URL, region label, control label, role, stable key, operation kind and optional value. Prerequisites use the same format. Ambiguous matches stay unresolved. A plan completion description is guidance; verification currently means successful supported interaction with a subsequent host observation, not arbitrary business assertions.

## Durable execution and coverage

Default totals are 3 rounds, 300 actions, 30 active minutes and 300 provider requests. Individual sessions default to 100 actions, capped by the task's remaining allowance. Recovery actions count through the host action ledger. Pauses do not consume duration; waiting for providers does. Already-dispatched host operations settle before ownership is released. A host recovery command may finish after the duration deadline; no further operation is dispatched afterwards.

Each new round rematches semantic scopes and obtains fresh reviews. Old successes may guide scheduling only when scope, declared context and captured dispatch bindings/constraints/options match. They retain their original session/attempt references and are never copied into the new engine audit. Missing or ambiguous targets remain unresolved. Unselected samples remain in the plan as untested, and do not automatically expand a later round. Users can select them explicitly for follow-up.

Tasks, rounds, decisions and correlated events are stored in a separate `explorer.sqlite`. Engine facts remain in the host's database. Model inputs and normalized results are persisted with observation references; relevant detailed evidence is pinned through the public evidence API and still subject to host storage limits. Keep both databases/evidence directories for historical inspection. An expired or missing artifact remains unavailable, rather than being replaced by current evidence.

On restart active tasks become paused, in-flight decisions become stale, and continuation observes again. A durable execute intent uses one request ID. Unknown outcomes are not replayed automatically. Missing public capabilities become explicit gaps. In particular, this version of the host may not expose a reviewed outside-boundary dismissal operation; failed normal/checkpoint exits remain blocked.

`completed` means the current observed plan is verified. `exhaustive` is always false. Discovery gaps, sampled-out members and unreachable states remain separately visible.

## Debug UI and validation

`ExplorerWorkspace` integrates goal, budget, task selection and execution controls into the host sidebar, alongside a switch to the existing manual controls. `ExplorerPlan` shows unfinished ranges and evidence in the main workspace. User-facing controls use exploration terminology without exposing the package boundary. The traversal column interleaves program, JEV, LLM and engine events. Click a decision to inspect input, output and actual application effects in the right-hand `ExplorerInspector`. Safe request bodies and response content are persisted without authentication headers or provider reasoning text. HTTP error bodies remain excluded. Applied plan/review/action/recovery events distinguish decisions from actual execution results; older records do not gain invented effects. Truncated output is retained for diagnosis but cannot execute. The UI does not invent a prose explanation for a JEV choice.

Tests use explicitly injected mock providers and real local Playwright pages. No real key or paid service is required. Live-provider acceptance is a separate final check after credentials are configured.
