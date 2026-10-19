import type { Providers } from './providers.js';
import { SampledCrawler, type CrawlOptions } from './crawler.js';
import { ModelJudge } from './judge.js';
import { metered } from './meter.js';
import { defaultPolicy } from './policy.js';
import { CrawlStore, type CrawlRun } from './store.js';

export interface StartCrawl {
  url: string;
  durationMs?: number;
  /** Extra same-origin pathname patterns (anchored regex sources); only used with followNavigation. */
  allowedPaths?: string[];
  followNavigation?: boolean;
  /** Use configured JEV/LLM providers for weak controls, effects and input kinds. */
  models?: boolean;
  /** Continue a previous run of the same URL: its tested classes and judgements are not repeated. */
  resumeFrom?: string;
}

/** Starts crawls in the background, one browser each, persisting every event and screenshot. */
export class CrawlManager {
  private readonly active = new Map<string, { controller: AbortController; done: Promise<void> }>();
  constructor(readonly store: CrawlStore, private readonly providers: Providers = {}) {
    // A previous process may have exited mid-run; those runs can be resumed but not continued.
    store.markInterrupted();
  }

  start(input: StartCrawl): CrawlRun {
    const url = new URL(input.url).href;
    const resume = input.resumeFrom ? this.store.run(input.resumeFrom) : undefined;
    if (input.resumeFrom && (!resume || resume.url !== url)) throw new Error('resumeFrom must name a run of the same URL');
    if (resume && this.active.has(resume.id)) throw new Error('The run to resume is still active');
    const id = crypto.randomUUID();
    const run = this.store.createRun(id, url, { ...input, url });
    const policy = defaultPolicy(url);
    for (const pattern of input.allowedPaths || []) policy.allowedPaths.push(new RegExp(pattern));
    const models = input.models !== false && (this.providers.jev || this.providers.llm);
    const controller = new AbortController();
    const ledger = resume && this.store.ledger(resume.id);
    const options: CrawlOptions = {
      url, policy, signal: controller.signal, durationMs: input.durationMs ?? 240_000, maxActions: 2000,
      followNavigation: input.followNavigation ?? false, ...(ledger ? { ledger } : {}),
      ...(models ? { judge: new ModelJudge({ jev: this.providers.jev, llm: this.providers.llm }), ...(this.providers.jev ? { inputJudge: metered(this.providers.jev) } : {}) } : {}),
      log: event => this.store.appendEvent(id, event),
      onScreenshot: (state, png) => this.store.saveScreenshot(id, state, png),
    };
    const crawler = new SampledCrawler(options);
    // Persist the ledger as work happens, so an interrupted run can still be resumed.
    const ledgerTimer = setInterval(() => this.store.saveLedger(id, crawler.ledger()), 5000);
    const done = crawler.run()
      .then(summary => { this.store.saveLedger(id, crawler.ledger()); this.store.finish(id, 'finished', summary); })
      .catch(error => { this.store.saveLedger(id, crawler.ledger()); this.store.finish(id, 'failed', undefined, String(error)); })
      .finally(() => { clearInterval(ledgerTimer); this.active.delete(id); });
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
