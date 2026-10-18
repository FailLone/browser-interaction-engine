import { BrowserAdapter, PlaywrightAdapter, type ActionCandidate, type Control } from '@interaction/adapter-playwright';
import { MemoryEvidenceStore } from '@interaction/storage-memory';
import { activeOverlay, controlClass, maskVolatile, pagePath, pageTemplate, stateKey, type Snapshot } from './abstraction.js';
import { allowed, defaultPolicy, linkTarget, placement, type CrawlKind, type CrawlPolicy } from './policy.js';
import { defaultChecks, findingKey, type Finding, type PageCheck } from './checks.js';

export interface CrawlOptions {
  url: string;
  headless?: boolean;
  durationMs?: number;
  maxActions?: number;
  /** Samples per action class; list members default to `listSamples`. */
  samples?: number;
  listSamples?: number;
  /** Distinct pages visited per page template (e.g. /convert/*). */
  pageSamples?: number;
  /** Actions spent on any non-entry page before it is left for other work. */
  pageActions?: number;
  settleMs?: number;
  policy?: CrawlPolicy;
  /** UI checks run on the live page once per newly discovered abstract state. */
  checks?: PageCheck[];
  /** Called once per newly discovered abstract state, after checks. */
  onState?: (state: CrawlState, page: import('playwright').Page) => Promise<void> | void;
  log?: (event: CrawlEvent) => void;
}

export interface CrawlState { key: string; url: string; overlay?: string; firstSeenAt: number; controls: number }
export interface Step { kind: CrawlKind; classKey: string; label: string; value?: string }
export type CrawlEvent =
  | { type: 'state'; at: number; state: CrawlState; path: number }
  | { type: 'action'; at: number; step: Step; url: string; overlay?: string; tier: string; outcome: 'ok' | 'failed' | 'no_change'; error?: string; newState: boolean; after: string }
  | { type: 'backtrack'; at: number; reason: string; url: string }
  | { type: 'finding'; at: number; finding: Finding; state: string; url: string }
  | { type: 'stop'; at: number; reason: string };

interface Candidate { control: Control; kind: CrawlKind; classKey: string; tier: number; tierName: string; value?: string }

const TIERS = ['overlay', 'body', 'in-page-disclosure', 'navigate', 'chrome'] as const;

/**
 * Crawljax-style sampled crawler: abstract states, action classes sampled k
 * times, overlays first, in-scope pages only, backtracking by replay from the
 * entry URL. No per-action proofs; an action that fails is recorded and skipped.
 */
export class SampledCrawler {
  readonly states = new Map<string, CrawlState>();
  /** Executions per action class (state independent): the sampling budget. */
  readonly classCounts = new Map<string, number>();
  readonly failedClasses = new Set<string>();
  /** Distinct concrete pages entered per page template. */
  readonly templatePages = new Map<string, Set<string>>();
  /** Actions executed per concrete page. */
  readonly pageCounts = new Map<string, number>();
  /** Distinct visible members seen per list class, to show how much sampling skipped. */
  readonly listMembers = new Map<string, Set<string>>();
  readonly events: CrawlEvent[] = [];
  readonly findings = new Map<string, Finding & { url: string; state: string }>();
  private adapter!: BrowserAdapter;
  private path: Step[] = [];
  private blockedNavigation?: string;
  /** True from dispatch until the post-action settle completes. */
  private dispatching = false;
  private readonly started = Date.now();
  private readonly options: Required<Omit<CrawlOptions, 'onState' | 'log'>> & Pick<CrawlOptions, 'onState' | 'log'>;

  constructor(options: CrawlOptions) {
    this.options = { headless: true, durationMs: 240_000, maxActions: 200, samples: 1, listSamples: 2, pageSamples: 2, pageActions: 20, settleMs: 600,
      policy: defaultPolicy(options.url), checks: defaultChecks, ...options };
  }

  private emit(event: CrawlEvent) { this.events.push(event); this.options.log?.(event); }
  private now() { return Date.now() - this.started; }
  private get page() { return this.adapter.page!; }

  async run() {
    const sessionOptions = new PlaywrightAdapter().parseOptions({ url: this.options.url, headless: this.options.headless, listExploration: 'review', actionTimeoutMs: 5000 });
    this.adapter = new BrowserAdapter(sessionOptions, new MemoryEvidenceStore());
    await this.adapter.start();
    // Script-driven navigation (buttons, redirects) is refused before it leaves scope.
    await this.page.route('**/*', async route => {
      const request = route.request();
      if (request.isNavigationRequest() && request.frame() === this.page.mainFrame() && placementOfUrl(request.url(), this.options) === 'outside') {
        if (this.dispatching) this.blockedNavigation = request.url();
        await route.abort('blockedbyclient');
      } else await route.continue();
    });
    // Popups opened by window.open/target=_blank are closed immediately.
    this.adapter.context!.on('page', popup => { if (popup === this.page) return; if (this.dispatching) this.blockedNavigation = popup.url(); void popup.close(); });
    let actions = 0, stop = 'budget_exhausted';
    try {
      await this.settle();
      while (this.now() < this.options.durationMs && actions < this.options.maxActions) {
        if (!this.page.url().startsWith('http')) { await this.page.goto(this.options.url, { waitUntil: 'domcontentloaded' }).catch(() => {}); await this.settle(); this.path = []; }
        const snapshot = await this.snapshot();
        await this.visit(snapshot);
        const candidate = this.choose(snapshot);
        if (!candidate) {
          if (await this.backtrack(snapshot, 'state_exhausted')) continue;
          stop = 'scope_exhausted'; break;
        }
        actions++;
        await this.act(snapshot, candidate);
      }
    } finally {
      this.emit({ type: 'stop', at: this.now(), reason: stop });
      await this.adapter.close();
    }
    return this.summary();
  }

  summary() {
    const actions = this.events.filter((e): e is Extract<CrawlEvent, { type: 'action' }> => e.type === 'action');
    const entry = pagePath(this.options.url);
    return {
      elapsedMs: this.now(), actions: actions.length, states: this.states.size,
      onEntryPage: actions.filter(a => pagePath(a.url) === entry).length,
      inOverlay: actions.filter(a => a.overlay).length,
      failed: actions.filter(a => a.outcome === 'failed').length,
      byTier: Object.fromEntries(TIERS.map(t => [t, actions.filter(a => a.tier === t).length])),
      maxPerClass: Math.max(0, ...this.classCounts.values()),
      backtracks: this.events.filter(e => e.type === 'backtrack').length,
      lists: { classes: this.listMembers.size, membersSeen: [...this.listMembers.values()].reduce((n, m) => n + m.size, 0),
        executed: [...this.listMembers.keys()].reduce((n, k) => n + (this.classCounts.get(k) || 0), 0) },
      pages: [...new Set([...this.states.values()].map(st => pagePath(st.url)))].length,
      findings: Object.fromEntries([...new Set([...this.findings.values()].map(f => f.rule))].map(rule => [rule, [...this.findings.values()].filter(f => f.rule === rule).length])),
    };
  }

  private async settle() {
    await this.page.waitForLoadState('domcontentloaded').catch(() => {});
    await this.page.waitForTimeout(this.options.settleMs);
  }

  private async snapshot(): Promise<Snapshot> {
    const dom = await this.adapter.readDOM(false, false);
    return { url: dom.url, title: dom.title, controls: dom.controls as Control[], overlays: dom.overlays };
  }

  /** A page is worth entering if it is the entry, already known, or its template has budget left. */
  private pageAllowed(url: string) {
    if (pagePath(url) === pagePath(this.options.url)) return true;
    const pages = this.templatePages.get(pageTemplate(url));
    return !pages || pages.has(pagePath(url)) || pages.size < this.options.pageSamples;
  }

  private async visit(s: Snapshot) {
    const template = pageTemplate(s.url), pages = this.templatePages.get(template) || new Set<string>();
    pages.add(pagePath(s.url)); this.templatePages.set(template, pages);
    const key = stateKey(s);
    if (this.states.has(key)) return false;
    const overlay = activeOverlay(s);
    const state: CrawlState = { key, url: s.url, overlay: overlay && `${overlay.kind}:${maskVolatile(overlay.name)}`, firstSeenAt: this.now(), controls: s.controls.filter(c => c.visible).length };
    this.states.set(key, state);
    this.emit({ type: 'state', at: this.now(), state, path: this.path.length });
    for (const check of this.options.checks) {
      let found: Finding[] = [];
      try { found = await check(this.page); } catch { continue; }
      for (const finding of found) {
        const key = findingKey(finding);
        if (this.findings.has(key)) continue;
        this.findings.set(key, { ...finding, url: s.url, state: state.key });
        this.emit({ type: 'finding', at: this.now(), finding, state: state.key, url: s.url });
      }
    }
    await this.options.onState?.(state, this.page);
    return true;
  }

  private budget(classKey: string) { return classKey.startsWith('list:') ? this.options.listSamples : this.options.samples; }

  /** All currently executable, still-unsampled candidates, ranked by tier. */
  candidates(s: Snapshot): Candidate[] {
    const overlay = activeOverlay(s);
    const scope = overlay ? new Set(overlay.controlIds) : undefined;
    const rows: Candidate[] = [];
    for (const c of s.controls) {
      if (!c.visible || !c.actions.length) continue;
      // An open overlay masks the page beneath it: never fight the backdrop.
      if (scope && !scope.has(c.localId)) continue;
      if (!scope && c.actionable.occludedBy) continue;
      const where = placement(c, s.url, this.options.url, this.options.policy);
      if (where === 'outside') continue;
      if (where === 'navigate' && !this.pageAllowed(linkTarget(c, s.url)!)) continue;
      for (const kind of kindsFor(c)) {
        if (!allowed(c, kind, this.options.policy)) continue;
        const classKey = `${kind}|${controlClass(c)}`;
        if (classKey.includes('|list:')) { const seen = this.listMembers.get(classKey) || new Set(); seen.add(`${pagePath(s.url)}|${c.name}`); this.listMembers.set(classKey, seen); }
        if (this.failedClasses.has(classKey) || (this.classCounts.get(classKey) || 0) >= this.budget(classKey)) continue;
        const disclosure = c.expanded !== null || ['tab', 'menuitem', 'option', 'combobox'].includes(c.role) || kind === 'hover';
        const tierName = scope ? 'overlay' : c.landmark ? 'chrome' : where === 'navigate' ? 'navigate' : disclosure ? 'in-page-disclosure' : 'body';
        rows.push({ control: c, kind, classKey, tier: TIERS.indexOf(tierName), tierName, value: kind === 'check' ? String(!c.checked) : undefined });
      }
    }
    // Stable ranking: tier, then reading order (top-left first).
    return rows.sort((a, b) => a.tier - b.tier || a.control.rect.y - b.control.rect.y || a.control.rect.x - b.control.rect.x);
  }

  private choose(s: Snapshot): Candidate | undefined {
    // A secondary page with its budget spent: only overlays (to close them) or a way back.
    const page = pagePath(s.url), spent = page !== pagePath(this.options.url) && (this.pageCounts.get(page) || 0) >= this.options.pageActions;
    if (spent && !activeOverlay(s)) return;
    const rows = this.candidates(s);
    const overlay = activeOverlay(s);
    // Inside an overlay, explore its content before its exits so it is not dismissed early.
    if (overlay) {
      const exits = new Set(overlay.exitControlIds);
      return rows.find(r => !exits.has(r.control.localId)) || rows[0];
    }
    return rows[0];
  }

  private async act(before: Snapshot, c: Candidate) {
    const step: Step = { kind: c.kind, classKey: c.classKey, label: (c.control.name || c.control.label || c.control.role).slice(0, 60), value: c.value };
    this.classCounts.set(c.classKey, (this.classCounts.get(c.classKey) || 0) + 1);
    this.pageCounts.set(pagePath(before.url), (this.pageCounts.get(pagePath(before.url)) || 0) + 1);
    const beforeKey = stateKey(before), overlay = activeOverlay(before);
    let outcome: 'ok' | 'failed' | 'no_change' = 'ok', error: string | undefined;
    this.blockedNavigation = undefined;
    this.dispatching = true;
    try {
      await this.dispatch(c);
      await this.settle();
    } catch (e) {
      outcome = 'failed'; error = String(e).slice(0, 200);
      this.failedClasses.add(c.classKey);
    } finally { this.dispatching = false; }
    // Set asynchronously by the route/popup handlers during dispatch.
    const refused = this.blockedNavigation as string | undefined;
    if (refused) { outcome = 'failed'; error = `navigation outside scope refused: ${refused.slice(0, 120)}`; this.failedClasses.add(c.classKey); }
    // An aborted navigation can leave an error document; restore the source state.
    if (!this.page.url().startsWith('http')) { await this.backtrack(before, 'navigation_refused', true); return; }
    let after: Snapshot;
    try { after = await this.snapshot(); } catch { await this.backtrack(before, 'capture_failed', true); return; }
    const afterKey = stateKey(after);
    if (outcome === 'ok' && afterKey === beforeKey) outcome = 'no_change';
    if (outcome === 'ok') this.path.push(step);
    const isNew = !this.states.has(afterKey);
    this.emit({ type: 'action', at: this.now(), step, url: before.url, overlay: overlay && `${overlay.kind}:${maskVolatile(overlay.name)}`, tier: c.tierName, outcome, error, newState: isNew, after: pagePath(after.url) });
    // Left the allowed scope (script navigation, redirect): never repeat this class, return to entry.
    if (placementOfUrl(after.url, this.options) === 'outside') { this.failedClasses.add(c.classKey); await this.backtrack(after, 'left_scope'); }
  }

  private async dispatch(c: Candidate) {
    const action = { id: `crawl:${this.now()}`, kind: c.kind, value: c.kind === 'check' ? c.value === 'true' : c.kind === 'press' ? 'Escape' : undefined } as unknown as ActionCandidate;
    await this.adapter.execute(action, c.control);
  }

  /** Return to the entry page and replay the recorded path minus its last step. */
  private async backtrack(current: Snapshot, reason: string, restore = false): Promise<boolean> {
    // An open overlay with nothing left: close it in place first.
    if (!restore && activeOverlay(current)) {
      await this.page.keyboard.press('Escape').catch(() => {});
      await this.settle();
      const after = await this.snapshot();
      if (stateKey(after) !== stateKey(current)) { this.path.pop(); this.emit({ type: 'backtrack', at: this.now(), reason: `${reason}:escape`, url: current.url }); return true; }
    }
    if (!restore && !this.path.length && pagePath(current.url) === pagePath(this.options.url)) return false;
    // Restoring replays the whole path back to `current`; otherwise drop its last step.
    const replay = restore ? this.path : this.path.slice(0, -1);
    this.emit({ type: 'backtrack', at: this.now(), reason, url: current.url });
    await this.page.goto(this.options.url, { waitUntil: 'domcontentloaded' }).catch(() => {});
    await this.settle();
    this.path = [];
    for (const step of replay) {
      const s = await this.snapshot();
      const target = this.candidatesForReplay(s, step);
      if (!target) break;
      try { await this.dispatch(target); await this.settle(); this.path.push(step); } catch { break; }
    }
    return true;
  }

  private candidatesForReplay(s: Snapshot, step: Step): Candidate | undefined {
    for (const c of s.controls) {
      if (!c.visible) continue;
      for (const kind of kindsFor(c)) if (kind === step.kind && `${kind}|${controlClass(c)}` === step.classKey && (c.name || c.label || c.role).slice(0, 60) === step.label)
        return { control: c, kind, classKey: step.classKey, tier: 0, tierName: 'replay', value: step.value };
    }
  }
}

function kindsFor(c: Control): CrawlKind[] {
  const basis = c.actionBasis || {} as NonNullable<Control['actionBasis']>;
  const kinds: CrawlKind[] = [];
  if (c.actions.includes('check')) kinds.push('check');
  else if (c.actions.includes('click')) kinds.push('click');
  // Hover only where the page declares a hover-driven disclosure.
  if (c.actions.includes('hover') && (basis.hover?.status === 'supported' || c.expanded !== null || c.controls)) kinds.push('hover');
  return kinds;
}

function placementOfUrl(url: string, options: { url: string; policy: CrawlPolicy }) {
  try {
    const u = new URL(url), e = new URL(options.url);
    if (pagePath(url) === pagePath(options.url)) return 'stay';
    return u.origin === e.origin && options.policy.allowedPaths.some(p => p.test(u.pathname)) ? 'navigate' : 'outside';
  } catch { return 'outside'; }
}
