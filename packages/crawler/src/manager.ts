import type { CrawlPlugin } from './plugin.js';
import type { ViewportOption } from './browser/viewport.js';
import type { Providers } from './providers.js';
import type { SessionProvider } from './session.js';
import { SampledCrawler, type CrawlOptions } from './crawler.js';
import { ModelJudge } from './judge.js';
import { metered } from './meter.js';
import { defaultPolicy } from './policy.js';
import { CrawlStore, type CrawlRun } from './store.js';

export interface StartCrawl {
  url: string;
  durationMs?: number;
  /** Screen to crawl on (default `desktop`); a resumed run keeps the viewport of the run it continues. */
  viewport?: ViewportOption;
  /** Extra same-origin pathname patterns (anchored regex sources); only used with followNavigation. */
  allowedPaths?: string[];
  followNavigation?: boolean;
  /** Use configured JEV/LLM providers for weak controls, effects and input kinds. */
  models?: boolean;
  /** Continue a previous run of the same URL: its tested classes and judgements are not repeated. */
  resumeFrom?: string;
  /** Names of host-registered plugins to run on every new state. */
  plugins?: string[];
  /**
   * Host-registered session providers and their options, e.g. a login plus an experiment variant.
   * A resumed run keeps its sessions unless others are given; providers that change what pages
   * show (experiments) must match the run it continues.
   */
  session?: SessionRequest | SessionRequest[];
}
export interface SessionRequest {
  provider: string;
  options?: Record<string, unknown>;
}

/** Plugins the host offers by name; each run gets fresh instances. */
export type PluginFactories = Record<string, () => CrawlPlugin>;
/** Session providers the host offers by name; options come from the run request and must be validated here. */
export type SessionFactories = Record<string, (options: Record<string, unknown>) => SessionProvider>;

/** Starts crawls in the background, one browser each, persisting every event and screenshot. */
export class CrawlManager {
  private readonly active = new Map<string, { controller: AbortController; done: Promise<void> }>();
  constructor(
    readonly store: CrawlStore,
    private readonly providers: Providers = {},
    readonly pluginFactories: PluginFactories = {},
    readonly sessionFactories: SessionFactories = {},
  ) {
    // A previous process may have exited mid-run; those runs can be resumed but not continued.
    store.markInterrupted();
  }

  start(input: StartCrawl): CrawlRun {
    const url = new URL(input.url).href;
    const resume = input.resumeFrom ? this.store.run(input.resumeFrom) : undefined;
    if (input.resumeFrom && (!resume || resume.url !== url))
      throw new Error('resumeFrom must name a run of the same URL');
    if (resume && this.active.has(resume.id)) throw new Error('The run to resume is still active');
    // States and tested classes depend on the layout, so a resumed run stays on the same screen.
    // Runs from before viewports were selectable ran at 1440x900.
    const viewport: ViewportOption = resume
      ? ((resume.options.viewport as ViewportOption | undefined) ?? { width: 1440, height: 900 })
      : (input.viewport ?? 'desktop');
    if (resume && input.viewport && JSON.stringify(input.viewport) !== JSON.stringify(viewport))
      throw new Error('resumeFrom must use the viewport of the run it continues');
    const unknown = (input.plugins ?? []).filter(name => !this.pluginFactories[name]);
    if (unknown.length) throw new Error(`Unknown plugins: ${unknown.join(', ')}`);
    const requests = [input.session ?? (resume?.options.session as StartCrawl['session'] | undefined) ?? []].flat();
    const missing = requests.filter(r => !this.sessionFactories[r.provider]).map(r => r.provider);
    if (missing.length) throw new Error(`Unknown session provider: ${missing.join(', ')}`);
    const sessions = requests.map(r => this.sessionFactories[r.provider]!(r.options ?? {}));
    const resumeKeys = sessions.flatMap(s => (s.resumeKey ? [s.resumeKey] : [])).sort();
    // Tested work from another variant's layout is not done for this one.
    if (
      resume &&
      JSON.stringify(resumeKeys) !== JSON.stringify((resume.options.sessionKeys as string[] | undefined) ?? [])
    )
      throw new Error('resumeFrom must use the experiment variants of the run it continues');
    const id = crypto.randomUUID();
    const run = this.store.createRun(id, url, {
      ...input,
      url,
      viewport,
      ...(requests.length ? { session: requests, sessionKeys: resumeKeys } : {}),
    });
    const policy = defaultPolicy(url);
    for (const pattern of input.allowedPaths || []) policy.allowedPaths.push(new RegExp(pattern));
    const models = input.models !== false && (this.providers.jev || this.providers.llm);
    const controller = new AbortController();
    const ledger = resume && this.store.ledger(resume.id);
    const options: CrawlOptions = {
      url,
      viewport,
      policy,
      signal: controller.signal,
      durationMs: input.durationMs ?? 240_000,
      maxActions: 2000,
      followNavigation: input.followNavigation ?? false,
      ...(ledger ? { ledger } : {}),
      plugins: [...new Set(input.plugins ?? [])].map(name => this.pluginFactories[name]()),
      ...(sessions.length ? { session: sessions } : {}),
      ...(models
        ? {
            judge: new ModelJudge({ jev: this.providers.jev, llm: this.providers.llm }),
            ...(this.providers.jev ? { inputJudge: metered(this.providers.jev) } : {}),
          }
        : {}),
      log: event => this.store.appendEvent(id, event),
      onScreenshot: (state, png) => this.store.saveScreenshot(id, state, png),
    };
    const crawler = new SampledCrawler(options);
    // Persist the ledger as work happens, so an interrupted run can still be resumed.
    const ledgerTimer = setInterval(() => this.store.saveLedger(id, crawler.ledger()), 5000);
    const done = crawler
      .run()
      .then(summary => {
        this.store.saveLedger(id, crawler.ledger());
        this.store.finish(id, 'finished', summary);
      })
      .catch(error => {
        this.store.saveLedger(id, crawler.ledger());
        this.store.finish(id, 'failed', undefined, String(error));
      })
      .finally(() => {
        clearInterval(ledgerTimer);
        this.active.delete(id);
      });
    this.active.set(id, { controller, done });
    return run;
  }

  /** Ask a running crawl to stop after its current action. */
  async stop(id: string) {
    const active = this.active.get(id);
    if (!active) return false;
    active.controller.abort();
    await active.done;
    return true;
  }

  async close() {
    for (const active of this.active.values()) active.controller.abort();
    await Promise.all([...this.active.values()].map(a => a.done));
    this.store.close();
  }
}
