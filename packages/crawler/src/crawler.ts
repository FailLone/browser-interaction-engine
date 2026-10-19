import { BrowserAdapter, PlaywrightAdapter, type ActionCandidate, type Control } from '@interaction/adapter-playwright';
import { MemoryEvidenceStore } from '@interaction/storage-memory';
import { activeOverlay, controlClass, maskVolatile, modeGroup, modeSiblings, pagePath, pageTemplate, stateKey, type Snapshot } from './abstraction.js';
import { allowed, defaultPolicy, linkTarget, placement, type CrawlKind, type CrawlPolicy } from './policy.js';
import { findingKey, type Finding, type PageCheck } from './checks.js';
import type { Judge, Question } from './judge.js';
import type { GoalRelevance } from './goal.js';
import type { ProviderMeter } from './meter.js';
import { classifyInput, inputSamples, judgeInputKind, readInputFacts, type InputKind } from './inputs.js';
import type { Provider } from '@interaction/explorer-plugin';

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
  /** Model plugin for questions the program cannot settle (weak controls, invisible effects). */
  judge?: Judge;
  /** JEV used to classify input fields whose structure does not settle their kind. */
  inputJudge?: Provider;
  /** Goal mode: JEV prunes action classes irrelevant to the goal; relevant ones run first. */
  relevance?: GoalRelevance;
  /** Optional UI checks run once per newly discovered abstract state (off by default; traversal comes first). */
  checks?: PageCheck[];
  /** Called once per newly discovered abstract state, after checks. */
  onState?: (state: CrawlState, page: import('playwright').Page) => Promise<void> | void;
  log?: (event: CrawlEvent) => void;
}

export interface CrawlState { key: string; url: string; overlay?: string; firstSeenAt: number; controls: number }
export interface Step { kind: CrawlKind; classKey: string; label: string; value?: string; purpose?: string;
  /** Page the step was taken on; used to rewind past a whole page when backtracking. */
  from?: string;
  /** Page after the step; differs from `from` when the step navigated. */
  to?: string }
export type CrawlEvent =
  | { type: 'state'; at: number; state: CrawlState; path: number }
  | { type: 'action'; at: number; step: Step; url: string; overlay?: string; tier: string; outcome: 'ok' | 'failed' | 'no_change'; error?: string; newState: boolean; after: string }
  | { type: 'backtrack'; at: number; reason: string; url: string }
  | { type: 'finding'; at: number; finding: Finding; state: string; url: string }
  | { type: 'judgement'; at: number; question: string; label: string; verdict: 'yes' | 'no' | 'uncertain'; source: string; probability?: number; detail?: string }
  | { type: 'stop'; at: number; reason: string };

interface Candidate { control: Control; kind: CrawlKind; classKey: string; tier: number; tierName: string; value?: string; relevance?: number;
  /** For fill: which sample of the input's kind (e.g. existing / empty search). */
  purpose?: string }

// Everything that stays on the current page (including site-chrome menus) runs
// before any navigation; otherwise the entry page's own UI waits behind other pages.
const TIERS = ['overlay', 'body', 'in-page-disclosure', 'chrome', 'navigate'] as const;

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
  /**
   * Mode groups (tab rows, radio groups) whose first sampled member revealed
   * nothing new: the rest only redraw something we cannot inspect (e.g. a canvas chart).
   */
  readonly flatModeGroups = new Set<string>();
  /** Mode groups with at least one member executed. */
  private readonly sampledModeGroups = new Map<string, boolean>();
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
  /** Backtracks served by browser history instead of replay. */
  private historyBacks = 0;
  /** Backtracks that loaded the last page by URL and replayed only its in-page steps. */
  private directLoads = 0;
  /** Page text at the last dispatch, used to pick search terms that should match. */
  private lastText = '';
  /** True from dispatch until the post-action settle completes. */
  private dispatching = false;
  private readonly started = Date.now();
  private readonly options: Required<Omit<CrawlOptions, 'onState' | 'log' | 'judge' | 'relevance' | 'inputJudge'>> & Pick<CrawlOptions, 'onState' | 'log' | 'judge' | 'relevance' | 'inputJudge'>;
  /** Weak controls the judge confirmed as interactive, by component class. */
  private readonly confirmed = new Set<string>();
  /** Input kind per input component class: structural, judged by JEV, or defaulted. */
  readonly inputKinds = new Map<string, { kind: InputKind; source: 'structure' | 'jev' | 'default' }>();
  /** Action classes JEV judged irrelevant to the goal. */
  private readonly pruned = new Set<string>();
  /** Weak control classes already asked about. */
  private readonly asked = new Set<string>();

  constructor(options: CrawlOptions) {
    this.options = { headless: true, durationMs: 240_000, maxActions: 200, samples: 1, listSamples: 2, pageSamples: 2, pageActions: 20, settleMs: 600,
      policy: defaultPolicy(options.url), checks: [], ...options };
  }

  private emit(event: CrawlEvent) { this.events.push(event); this.options.log?.(event); }
  private now() { return Date.now() - this.started; }
  private get page() { return this.adapter.page!; }

  async run() {
    const sessionOptions = new PlaywrightAdapter().parseOptions({ url: this.options.url, headless: this.options.headless, listExploration: 'review', actionTimeoutMs: 2000 });
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
    let actions = 0, idleBacktracks = 0, stop = 'budget_exhausted';
    try {
      await this.settle();
      while (this.now() < this.options.durationMs && actions < this.options.maxActions) {
        if (!this.page.url().startsWith('http')) { await this.page.goto(this.options.url, { waitUntil: 'domcontentloaded' }).catch(() => {}); await this.settle(); this.path = []; }
        const snapshot = await this.snapshot();
        await this.visit(snapshot);
        await this.reviewWeakControls(snapshot);
        await this.assessRelevance(snapshot);
        const candidate = this.choose(snapshot);
        if (!candidate) {
          // Every action spends class budget, so action loops end; backtracks spend none.
          // A page that keeps reopening an overlay or redirecting must not spin until the deadline.
          // Each backtrack rewinds the path, so a run of them ends at the entry page; the cap
          // only guards pages that keep reopening an overlay or redirecting.
          if (++idleBacktracks <= 8 && await this.backtrack(snapshot, 'state_exhausted')) continue;
          stop = idleBacktracks > 8 ? 'no_progress' : 'scope_exhausted'; break;
        }
        actions++; idleBacktracks = 0;
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
      historyBacks: this.historyBacks,
      directLoads: this.directLoads,
      judge: this.options.judge?.stats,
      models: modelCost([this.options.judge?.stats.jev, this.options.relevance?.meter], [this.options.judge?.stats.llm]),
      weakControlsConfirmed: this.confirmed.size,
      inputs: { classes: this.inputKinds.size, kinds: Object.fromEntries([...this.inputKinds.values()].reduce((m, k) => m.set(`${k.kind}:${k.source}`, (m.get(`${k.kind}:${k.source}`) || 0) + 1), new Map<string, number>())),
        filled: actions.filter(a => a.step.kind === 'fill').map(a => ({ label: a.step.label, purpose: a.step.purpose, value: a.step.value?.slice(0, 20), outcome: a.outcome, newState: a.newState })) },
      hovers: actions.filter(a => a.step.kind === 'hover').length,
      modeGroups: { sampled: this.sampledModeGroups.size, flat: this.flatModeGroups.size },
      coverage: this.coverageReport(),
      goal: this.options.relevance && { plan: this.options.relevance.plan, jevCalls: this.options.relevance.calls, prunedClasses: this.pruned.size },
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
    return { url: dom.url, title: dom.title, text: dom.text, controls: dom.controls as Control[], overlays: dom.overlays, regions: dom.regions };
  }

  /** A page is worth entering if it is the entry, already known, or its template has budget left. */
  private pageAllowed(url: string) {
    if (pagePath(url) === pagePath(this.options.url)) return true;
    const pages = this.templatePages.get(pageTemplate(url));
    return !pages || pages.has(pagePath(url)) || pages.size < this.options.pageSamples;
  }

  /**
   * Coverage per page: every actionable component class ever seen (visible), and
   * every text block ever shown, versus what was executed / revealed by actions.
   */
  private readonly coverage = new Map<string, { seen: Set<string>; text: Set<string>; initialText: Set<string> }>();

  private observeCoverage(s: Snapshot) {
    const page = pagePath(s.url);
    let row = this.coverage.get(page);
    const blocks = textBlocks(s.text || '');
    if (!row) { row = { seen: new Set(), text: new Set(), initialText: new Set(blocks) }; this.coverage.set(page, row); }
    for (const c of s.controls) if (c.visible && (c.actions.length || this.confirmed.has(controlClass(c)))) for (const kind of kindsFor(c, this.confirmed)) row.seen.add(`${kind}|${controlClass(c)}`);
    for (const b of blocks) row.text.add(b);
  }

  /** Per-page coverage and the discovery curve (new states per minute). */
  coverageReport() {
    const executed = new Map<string, Set<string>>();
    for (const e of this.events) if (e.type === 'action' && e.outcome !== 'failed') {
      const set = executed.get(pagePath(e.url)) || new Set(); set.add(e.step.kind === 'fill' ? e.step.classKey.slice(0, e.step.classKey.lastIndexOf('|')) : e.step.classKey); executed.set(pagePath(e.url), set);
    }
    const pages = [...this.coverage.entries()].map(([page, row]) => {
      const done = executed.get(page) || new Set();
      const sampledLists = [...row.seen].filter(k => k.includes('|list:')).length;
      const executedClasses = [...row.seen].filter(k => done.has(k)).length;
      return { page, classesSeen: row.seen.size, classesExecuted: executedClasses, classCoverage: row.seen.size ? +(executedClasses / row.seen.size).toFixed(2) : 0, listClasses: sampledLists,
        textBlocksSeen: row.text.size, textBlocksRevealedByActions: [...row.text].filter(t => !row.initialText.has(t)).length };
    });
    const minutes = Math.max(1, Math.ceil(this.now() / 60000));
    const curve = Array.from({ length: minutes }, (_, m) => [...this.states.values()].filter(st => st.firstSeenAt < (m + 1) * 60000).length);
    const last = [...this.states.values()].reduce((t, st) => Math.max(t, st.firstSeenAt), 0);
    return { pages, statesPerMinute: curve, lastNewStateAtMs: last };
  }

  private async visit(s: Snapshot) {
    const template = pageTemplate(s.url), pages = this.templatePages.get(template) || new Set<string>();
    pages.add(pagePath(s.url)); this.templatePages.set(template, pages);
    this.observeCoverage(s);
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

  /** Ask the judge about visible controls that only have weak interaction hints. */
  private async reviewWeakControls(s: Snapshot) {
    const judge = this.options.judge;
    if (!judge) return;
    const overlay = activeOverlay(s), scope = overlay && new Set(overlay.controlIds);
    const batch: { cls: string; label: string; question: Question }[] = [];
    for (const c of s.controls) {
      if (!c.visible || c.actions.length || !c.interactionHints?.length || c.actionable.occludedBy || (scope && !scope.has(c.localId))) continue;
      const name = c.name || c.displayedText;
      if (!name || this.options.policy.forbiddenLabel.test(name)) continue;
      const cls = controlClass(c);
      if (this.asked.has(cls)) continue;
      this.asked.add(cls);
      batch.push({ cls, label: name.slice(0, 60), question: { kind: 'interactive', control: { tag: c.tag, role: c.role, name: maskVolatile(name), hints: c.interactionHints.map(h => h.rule), text: maskVolatile(c.displayedText || ''), context: [c.landmark, s.regions?.find(r => r.key === c.region)?.label].filter(Boolean).map(x => maskVolatile(String(x))).join(' / ') || undefined } } });
    }
    if (!batch.length) return;
    const answers = judge.askAll ? await judge.askAll(batch.map(b => b.question)) : await Promise.all(batch.map(b => judge.ask(b.question)));
    batch.forEach(({ cls, label }, i) => {
      const answer = answers[i];
      this.emit({ type: 'judgement', at: this.now(), question: 'interactive', label, verdict: answer.verdict, source: answer.source, probability: answer.probability });
      // Uncertain weak controls are tried once: a click is cheaper and more accurate than an LLM.
      if (answer.verdict !== 'no') this.confirmed.add(cls);
    });
  }

  private budget(classKey: string) { return classKey.startsWith('list:') ? this.options.listSamples : this.options.samples; }

  /** All currently executable, still-unsampled candidates, ranked by tier. */
  candidates(s: Snapshot, applyGoal = true): Candidate[] {
    const overlay = activeOverlay(s);
    const scope = overlay ? new Set(overlay.controlIds) : undefined;
    const siblings = modeSiblings(s);
    const rows: Candidate[] = [];
    for (const c of s.controls) {
      if (!c.visible || (!c.actions.length && !this.confirmed.has(controlClass(c)))) continue;
      // An open overlay masks the page beneath it: never fight the backdrop.
      if (scope && !scope.has(c.localId)) continue;
      if (!scope && c.actionable.occludedBy) continue;
      const where = placement(c, s.url, this.options.url, this.options.policy);
      if (where === 'outside') continue;
      if (where === 'navigate' && !this.pageAllowed(linkTarget(c, s.url)!)) continue;
      for (const kind of kindsFor(c, this.confirmed)) {
        if (!allowed(c, kind, this.options.policy)) continue;
        const classKey = `${kind}|${controlClass(c)}`;
        if (classKey.includes('|list:')) { const seen = this.listMembers.get(classKey) || new Set(); seen.add(`${pagePath(s.url)}|${c.name}`); this.listMembers.set(classKey, seen); }
        if (kind !== 'fill' && (this.failedClasses.has(classKey) || (this.classCounts.get(classKey) || 0) >= this.budget(classKey))) continue;
        const group = kind === 'click' ? modeGroup(c, s.url, siblings) : undefined;
        if (group && this.flatModeGroups.has(group)) continue;
        const disclosure = c.expanded !== null || ['tab', 'menuitem', 'option', 'combobox'].includes(c.role) || kind === 'hover' || kind === 'fill';
        const tierName = scope ? 'overlay' : where === 'navigate' ? 'navigate' : c.landmark ? 'chrome' : disclosure ? 'in-page-disclosure' : 'body';
        const relevance = applyGoal ? this.options.relevance : undefined;
        // An open overlay must still be handled even when its contents are off-goal.
        if (relevance && !scope && !relevance.relevant(classKey)) continue;
        const row = { control: c, kind, classKey, tier: TIERS.indexOf(tierName), tierName, value: kind === 'check' ? String(!c.checked) : undefined, relevance: relevance?.score(classKey) };
        if (kind !== 'fill') { rows.push(row); continue; }
        // Each sample purpose of an input is its own class; its kind is settled at first use.
        const inputKind = this.inputKinds.get(controlClass(c))?.kind;
        for (const purpose of inputKind ? inputSamples(inputKind, emptyFacts, '').map(x => x.purpose) : ['first']) {
          const sampleKey = `${classKey}|${purpose}`;
          if (this.failedClasses.has(sampleKey) || (this.classCounts.get(sampleKey) || 0) >= 1) continue;
          rows.push({ ...row, classKey: sampleKey, purpose });
        }
      }
    }
    // Stable ranking: tier, then reading order (top-left first).
    // Within a mode group, try an unselected member first: it is the one that can switch content.
    const isSelected = (r: Candidate) => Number(r.control.selected.length > 0 || r.control.checked === true || r.control.pressed === true);
    // Goal mode ranks by relevance inside the overlay-first rule; otherwise tier then reading order.
    const goal = (r: Candidate) => r.tierName === 'overlay' ? 2 : r.relevance ?? 0.5;
    return rows.sort((a, b) => (applyGoal && this.options.relevance ? goal(b) - goal(a) : 0) || a.tier - b.tier || isSelected(a) - isSelected(b) || a.control.rect.y - b.control.rect.y || a.control.rect.x - b.control.rect.x);
  }

  /** Goal mode: score this state's new action classes in one JEV batch. */
  private async assessRelevance(s: Snapshot) {
    const relevance = this.options.relevance;
    if (!relevance) return;
    const rows = this.candidates(s, false);
    await relevance.assess(rows.map(r => ({ classKey: r.classKey, description: `${r.kind} ${r.control.role} "${maskVolatile(r.control.name || r.control.label)}"${r.control.landmark ? ` in site ${r.control.landmark}` : ''}` })));
    for (const r of rows) if (!relevance.relevant(r.classKey) && !this.pruned.has(r.classKey)) {
      this.pruned.add(r.classKey);
      this.emit({ type: 'judgement', at: this.now(), question: 'relevance', label: r.control.name.slice(0, 60), verdict: 'no', source: 'jev', probability: relevance.score(r.classKey) });
    }
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
    this.lastText = before.text || '';
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
    // Fill resolves its sample (value, purpose, class key) during dispatch; count the final key.
    this.classCounts.set(c.classKey, (this.classCounts.get(c.classKey) || 0) + 1);
    const step: Step = { kind: c.kind, classKey: c.classKey, label: (c.control.name || c.control.label || c.control.role).slice(0, 60), value: c.value, purpose: c.purpose, from: pagePath(before.url) };
    // Set asynchronously by the route/popup handlers during dispatch.
    const refused = this.blockedNavigation as string | undefined;
    if (refused) { outcome = 'failed'; error = `navigation outside scope refused: ${refused.slice(0, 120)}`; this.failedClasses.add(c.classKey); }
    // An aborted navigation can leave an error document; restore the source state.
    if (!this.page.url().startsWith('http')) {
      // The source document is the previous history entry: one step back usually restores it.
      const back = await this.page.goBack({ waitUntil: 'domcontentloaded', timeout: 5000 }).catch(() => null);
      if (back && pagePath(this.page.url()) === pagePath(before.url)) { await this.settle(); this.historyBacks++; this.emit({ type: 'backtrack', at: this.now(), reason: 'navigation_refused:history', url: before.url }); }
      else await this.backtrack(before, 'navigation_refused', true);
      return;
    }
    let after: Snapshot;
    try { after = await this.snapshot(); } catch { await this.backtrack(before, 'capture_failed', true); return; }
    let afterKey = stateKey(after);
    // An input's effect is usually on other fields' values (a conversion result), not on structure.
    if (outcome === 'ok' && afterKey === beforeKey && c.kind === 'fill') {
      const values = (x: Snapshot) => x.controls.filter(k => k.visible && k.localId !== c.control.localId && ['input', 'textarea'].includes(k.tag)).map(k => k.value).join('\u0000');
      if (values(before) !== values(after)) afterKey = `${afterKey}|value:${c.classKey}`;
    }
    if (outcome === 'ok' && afterKey === beforeKey) {
      outcome = 'no_change';
      // Structure is unchanged; content may not be (chart range, panel text). Ask once per action class.
      const textBefore = before.text || '', textAfter = after.text || '';
      if (textBefore && maskVolatile(textBefore, Infinity) !== maskVolatile(textAfter, Infinity)) {
        // Without a judge, a text change beyond live numbers (e.g. an empty-result message) is new content.
        let changed = true;
        if (this.options.judge) {
          const answer = await this.options.judge.ask({ kind: 'effect', action: `${c.kind} ${step.label}`, before: excerpt(textBefore, textAfter), after: excerpt(textAfter, textBefore) });
          this.emit({ type: 'judgement', at: this.now(), question: 'effect', label: step.label, verdict: answer.verdict, source: answer.source, probability: answer.probability });
          changed = answer.verdict === 'yes';
        }
        if (changed) { outcome = 'ok'; afterKey = `${afterKey}|content:${c.classKey}`; }
      }
    }
    step.to = pagePath(after.url);
    if (outcome === 'ok') this.path.push(step);
    const isNew = !this.states.has(afterKey);
    // The first member of a mode group decides whether the rest are worth sampling.
    const group = c.kind === 'click' ? modeGroup(c.control, before.url, modeSiblings(before)) : undefined;
    // Clicking the already-selected member proves nothing about the others.
    const selected = c.control.selected.length > 0 || c.control.checked === true || c.control.pressed === true;
    if (group && !selected && !this.sampledModeGroups.has(group)) {
      this.sampledModeGroups.set(group, isNew);
      if (!isNew && outcome !== 'failed') this.flatModeGroups.add(group);
    }
    if (isNew && /\|(content|value):/.test(afterKey)) this.states.set(afterKey, { key: afterKey, url: after.url, firstSeenAt: this.now(), controls: after.controls.filter(x => x.visible).length });
    this.emit({ type: 'action', at: this.now(), step, url: before.url, overlay: overlay && `${overlay.kind}:${maskVolatile(overlay.name)}`, tier: c.tierName, outcome, error, newState: isNew, after: pagePath(after.url) });
    // Left the allowed scope (script navigation, redirect): never repeat this class, return to entry.
    if (placementOfUrl(after.url, this.options) === 'outside') { this.failedClasses.add(c.classKey); await this.backtrack(after, 'left_scope'); }
  }

  private async dispatch(c: Candidate) {
    await this.ensureActionable(c.control);
    if (c.kind === 'fill') return this.fill(c);
    const action = { id: `crawl:${this.now()}`, kind: c.kind, value: c.kind === 'check' ? c.value === 'true' : c.kind === 'press' ? 'Escape' : undefined } as unknown as ActionCandidate;
    await this.adapter.execute(action, c.control);
  }

  /**
   * Fail in milliseconds instead of waiting for Playwright's actionability timeout when
   * the target is hidden, zero-sized, or covered at its click point by another element.
   */
  private async ensureActionable(control: Control) {
    const target = this.page.locator(control.selector);
    if (await target.count() !== 1) throw new Error('Target is no longer unique');
    await target.scrollIntoViewIfNeeded({ timeout: 1000 }).catch(() => {});
    const blocker = await target.evaluate(hitTestInPage).catch(() => 'detached');
    if (blocker) throw new Error(`Target not actionable: ${blocker}`);
  }

  /** Classify the input (structure first, then JEV once per input class) and type one sample. */
  private async fill(c: Candidate) {
    const facts = await readInputFacts(this.page, c.control);
    if (!facts) throw new Error('Input target is no longer unique');
    const cls = controlClass(c.control);
    let known = this.inputKinds.get(cls);
    if (!known) {
      const structural = classifyInput(facts);
      if (structural) known = { kind: structural, source: 'structure' };
      else if (this.options.inputJudge) {
        try { known = { kind: await judgeInputKind(this.options.inputJudge, facts, maskVolatile(c.control.displayedText || this.lastText.slice(0, 400))), source: 'jev' }; }
        catch { known = { kind: 'text', source: 'default' }; }
      } else known = { kind: 'text', source: 'default' };
      this.inputKinds.set(cls, known);
      this.emit({ type: 'judgement', at: this.now(), question: 'input-kind', label: (facts.placeholder || facts.name || c.control.name).slice(0, 60), verdict: 'yes', source: known.source, probability: undefined, detail: known.kind });
    }
    const samples = inputSamples(known.kind, facts, this.lastText);
    const sample = samples.find(x => x.purpose === c.purpose) || samples[0];
    c.value = sample.value; c.purpose = sample.purpose;
    // Re-key the first sample under its real purpose so the remaining samples stay pending.
    if (c.classKey.endsWith('|first')) c.classKey = c.classKey.replace(/\|first$/, `|${sample.purpose}`);
    const target = this.page.locator(c.control.selector);
    await target.click({ timeout: 2000 });
    await target.fill(sample.value, { timeout: 2000 });
    // Search boxes commonly need Enter; only searches are submitted.
    if (known.kind === 'search') await target.press('Enter', { timeout: 2000 });
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
    // Restoring replays the whole path back to `current`. Otherwise drop the last step; on a
    // secondary page with nothing left, drop every step taken on it and the step that entered it,
    // so the replay does not land on the same exhausted page again.
    let replay = restore ? this.path : this.path.slice(0, -1);
    const page = pagePath(current.url);
    if (!restore && page !== pagePath(this.options.url)) {
      let end = this.path.length;
      while (end > 0 && this.path[end - 1].from === page) end--;
      replay = this.path.slice(0, Math.max(0, end - 1));
    }
    this.emit({ type: 'backtrack', at: this.now(), reason, url: current.url });
    // Fast path: the replay target ends where an earlier page was entered and nothing was done
    // on that page since, so the browser history already holds it. Go back instead of replaying.
    if (await this.historyBack(replay)) return true;
    // Every page here was reached by an ordinary link, so its URL loads it directly. Start the
    // replay from the last page boundary in the kept path; only that page's in-page steps remain.
    let start = replay.length;
    while (start > 0 && replay[start - 1].to === replay[start - 1].from) start--;
    const resume = start > 0 ? replay[start - 1].to! : pagePath(this.options.url);
    await this.page.goto(start > 0 ? resume : this.options.url, { waitUntil: 'domcontentloaded' }).catch(() => {});
    await this.settle();
    if (start > 0 && pagePath(this.page.url()) !== resume) {
      // Redirected or blocked: fall back to the full replay from the entry.
      start = 0; await this.page.goto(this.options.url, { waitUntil: 'domcontentloaded' }).catch(() => {}); await this.settle();
    }
    if (start > 0) this.directLoads++;
    this.path = replay.slice(0, start);
    for (const step of replay.slice(start)) {
      const s = await this.snapshot();
      const target = this.candidatesForReplay(s, step);
      if (!target) break;
      try { await this.dispatch(target); await this.settle(); this.path.push(step); } catch { break; }
    }
    return true;
  }

  /**
   * Browser back replaces replay when the dropped steps only left the target page: one
   * history entry per navigating step, and in-page steps on pages being left need no undo.
   * Leaving drops in-page state on the target too, so the kept path is trimmed to match.
   * The landing page is verified; anything unexpected falls back to replay from the entry.
   */
  private async historyBack(replay: Step[]): Promise<boolean> {
    const dropped = this.path.slice(replay.length);
    const target = replay.length ? replay.at(-1)!.to : pagePath(this.options.url);
    const navigations = dropped.filter(step => step.to && step.to !== step.from).length;
    if (!target || !navigations || navigations > 3 || dropped.some(step => !step.to)) return false;
    // A dropped in-page step on the target itself would be state that back cannot undo.
    if (dropped.some(step => step.from === target && step.to === target)) return false;
    for (let i = 0; i < navigations; i++) {
      const ok = await this.page.goBack({ waitUntil: 'domcontentloaded', timeout: 5000 }).then(r => !!r).catch(() => false);
      if (!ok) return false;
    }
    await this.settle();
    if (pagePath(this.page.url()) !== target) return false;
    let kept = replay.length;
    while (kept > 0 && replay[kept - 1].from === target && replay[kept - 1].to === target) kept--;
    this.path = replay.slice(0, kept);
    this.historyBacks++;
    return true;
  }

  private candidatesForReplay(s: Snapshot, step: Step): Candidate | undefined {
    for (const c of s.controls) {
      if (!c.visible) continue;
      // Fill keys carry a sample purpose suffix; replay types the recorded sample again.
      const base = step.kind === 'fill' ? step.classKey.slice(0, step.classKey.lastIndexOf('|')) : step.classKey;
      for (const kind of kindsFor(c, this.confirmed)) if (kind === step.kind && `${kind}|${controlClass(c)}` === base && (c.name || c.label || c.role).slice(0, 60) === step.label)
        return { control: c, kind, classKey: step.classKey, tier: 0, tierName: 'replay', value: step.value, purpose: step.purpose };
    }
  }
}

// Built with new Function so the bundler cannot inject helpers into the serialized source.
const hitTestInPage = new Function('el', `const r = el.getBoundingClientRect(), s = getComputedStyle(el);
  if (r.width < 1 || r.height < 1 || s.visibility === 'hidden' || s.display === 'none') return 'hidden';
  const x = Math.min(innerWidth - 1, Math.max(0, r.left + r.width / 2)), y = Math.min(innerHeight - 1, Math.max(0, r.top + r.height / 2));
  const hit = document.elementFromPoint(x, y);
  if (!hit || el === hit || el.contains(hit) || hit.contains(el)) return '';
  return 'covered by ' + hit.tagName.toLowerCase() + (hit.className && typeof hit.className === 'string' ? '.' + hit.className.split(' ')[0] : '');`) as (el: Element) => string;

const emptyFacts = { type: '', inputmode: '', placeholder: '', pattern: '', autocomplete: '', ariaAutocomplete: '', ariaHaspopup: '', role: '', name: '', min: '', max: '', step: '', value: '' };

function kindsFor(c: Control, confirmed?: ReadonlySet<string>): CrawlKind[] {
  const basis = c.actionBasis || {} as NonNullable<Control['actionBasis']>;
  const kinds: CrawlKind[] = [];
  if (c.actions.includes('fill') && c.editable && ['input', 'textarea'].includes(c.tag)) return ['fill'];
  if (c.actions.includes('check')) kinds.push('check');
  else if (c.actions.includes('click') || confirmed?.has(controlClass(c))) kinds.push('click');
  // Hover only where the page declares a hover-driven disclosure.
  // Hover where the page declares or hints at a hover-driven disclosure (menus, tooltips).
  const popup = c.reviewBinding?.attributes['aria-haspopup'] || c.reviewBinding?.attributes['aria-describedby'] || c.reviewBinding?.attributes.title;
  if (c.actions.includes('hover') && (basis.hover?.status === 'supported' || c.expanded !== null || c.controls || popup || basis.hover?.status === 'tentative' && c.landmark)) kinds.push('hover');
  return kinds;
}

function placementOfUrl(url: string, options: { url: string; policy: CrawlPolicy }) {
  try {
    const u = new URL(url), e = new URL(options.url);
    if (pagePath(url) === pagePath(options.url)) return 'stay';
    return u.origin === e.origin && options.policy.allowedPaths.some(p => p.test(u.pathname)) ? 'navigate' : 'outside';
  } catch { return 'outside'; }
}

/** The differing middle of two page texts, bounded for a model question. */
function excerpt(text: string, other: string, size = 600) {
  let start = 0; while (start < text.length && text[start] === other[start]) start++;
  return text.slice(Math.max(0, start - 100), start - 100 + size);
}

/** Combined JEV / LLM spend for the run summary (planning calls are added by the host). */
function modelCost(jev: (ProviderMeter | undefined)[], llm: (ProviderMeter | undefined)[]) {
  const sum = (meters: (ProviderMeter | undefined)[]) => meters.filter((m): m is ProviderMeter => !!m).reduce((t, m) => ({
    calls: t.calls + m.calls, failures: t.failures + m.failures, judgments: t.judgments + m.judgments, inputTokens: t.inputTokens + m.inputTokens,
    outputTokens: t.outputTokens + m.outputTokens, costUsd: t.costUsd + m.costUsd, unpricedCalls: t.unpricedCalls + m.unpricedCalls,
    avgMs: 0, elapsedMs: t.elapsedMs + m.elapsedMs,
  }), { calls: 0, failures: 0, judgments: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, unpricedCalls: 0, avgMs: 0, elapsedMs: 0 });
  const withAvg = (t: ReturnType<typeof sum>) => ({ ...t, avgMs: t.calls ? Math.round(t.elapsedMs / t.calls) : 0 });
  return { jev: withAvg(sum(jev)), llm: withAvg(sum(llm)) };
}

/** Visible text split into comparable blocks, live numbers masked, tiny fragments dropped. */
function textBlocks(text: string) {
  return [...new Set(text.split(/\n+/).map(line => maskVolatile(line, 200)).filter(line => line.length >= 3))];
}
