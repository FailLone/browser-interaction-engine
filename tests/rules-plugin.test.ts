import { afterAll, beforeAll, expect, it } from 'vitest';
import { type CrawlEvent, SampledCrawler } from '@interaction/crawler';
import { builtinRulePlugins, type RulePlugin, ruleReasons, rulesPlugin } from '@interaction/rules';
import { fixtureServer } from './rule-fixture.js';

let fixture: Awaited<ReturnType<typeof fixtureServer>>;
beforeAll(async () => {
  fixture = await fixtureServer();
});
afterAll(async () => {
  await fixture.server.close();
});

it('reports the known defects while crawling, and one failing rule does not hide the others', async () => {
  const broken: RulePlugin = {
    id: 'broken',
    version: '1.0.0',
    name: 'Broken',
    description: 'Always fails',
    effects: 'read-history',
    create: () => ({
      run: async () => {
        throw new Error('BROKEN_RULE');
      },
    }),
  };
  const events: CrawlEvent[] = [];
  await new SampledCrawler({
    url: `${fixture.url}/rule-defects.html`,
    durationMs: 30000,
    settleMs: 100,
    plugins: [rulesPlugin({ rules: [broken, ...builtinRulePlugins] })],
    log: e => events.push(e),
  }).run();
  const findings = events.filter((e): e is Extract<CrawlEvent, { type: 'finding' }> => e.type === 'finding');
  const errors = events.filter((e): e is Extract<CrawlEvent, { type: 'plugin_error' }> => e.type === 'plugin_error');
  const found = new Set(findings.map(f => `${f.finding.rule} ${f.finding.selector}`));
  expect(found).toEqual(
    new Set([
      'observed-occlusion #blocked-button',
      // The clipped button's whole box is cut by its container: reported once, as clipping.
      'observed-clipping #clipped-button',
      'observed-text-truncation #truncated-button',
    ]),
  );
  expect(errors.length).toBeGreaterThan(0);
  expect(errors.every(e => e.plugin === 'rules' && e.error.startsWith('broken: Error: BROKEN_RULE'))).toBe(true);
  // Each finding says where its element is, as measured in the state's capture.
  for (const f of findings)
    expect(f.finding.target).toMatchObject({
      box: { width: expect.any(Number), height: expect.any(Number) },
      viewport: { width: expect.any(Number), height: expect.any(Number) },
    });
  expect(findings.every(f => f.finding.code && f.finding.detail.startsWith(`${f.finding.code}:`))).toBe(true);
  // Every state gets a summary of each rule; every code a summary gives is explained, once per run.
  const inspections = events.filter((e): e is Extract<CrawlEvent, { type: 'inspection' }> => e.type === 'inspection');
  expect(inspections.length).toBe(events.filter(e => e.type === 'state').length);
  expect(inspections[0].checks?.find(c => c.id === 'broken')).toMatchObject({
    verdict: 'unknown',
    codes: [{ code: 'RULE_ERROR', verdict: 'unknown', count: 1 }],
  });
  const codes = new Set(inspections.flatMap(i => i.checks ?? []).flatMap(c => (c.codes ?? []).map(r => r.code)));
  const explained = inspections.flatMap(i => Object.keys(i.reasons ?? {}));
  expect(new Set(explained)).toEqual(codes);
  expect(explained.length).toBe(codes.size);
}, 120000);

it('explains every result code a rule can give', async () => {
  const { readFileSync, readdirSync } = await import('node:fs');
  const dir = new URL('../packages/rules/src/', import.meta.url);
  // Codes are the quoted upper-case names in the rule sources, the reasons table aside.
  const codes = new Set(
    readdirSync(dir)
      .filter(f => f.endsWith('.ts') && f !== 'reasons.ts')
      .flatMap(f => [
        ...readFileSync(new URL(f, dir), 'utf8').matchAll(/'([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+|UNSUPPORTED)'/g),
      ])
      .map(m => m[1]),
  );
  // Names that are not result codes: thrown markers and outcomes that only mean a pass.
  for (const code of [
    'CONTROL_BOX_UNCLIPPED',
    'DOM_TEXT_BOXES_FIT',
    'IMAGE_ASPECT_RATIO_PRESERVED',
    'IMAGE_RESOURCE_AVAILABLE',
    'IMAGE_ASPECT_RATIO_RESTORED',
    'IMAGE_RESOURCE_RESTORED',
    'OBSERVED_POINT_REACHABLE',
    'SAMPLE_REACHABLE',
    'SAMPLE_INTERCEPTED',
    'OCCLUSION_RECOVERED_AFTER_SCROLL',
    'OCCLUSION_NO_LONGER_OBSERVED',
    'CLIPPING_NO_LONGER_OBSERVED',
    'TEXT_CLIPPING_NO_LONGER_OBSERVED',
    'TEXT_BACKGROUND_DISTINCT',
    'TEXT_BACKGROUND_RESTORED',
  ])
    codes.delete(code);
  expect([...codes].filter(code => !ruleReasons[code])).toEqual([]);
});

it('reports a page that overflows sideways once per crawl, on a phone, without acting on the page for it', async () => {
  const events: CrawlEvent[] = [];
  await new SampledCrawler({
    url: `${fixture.url}/horizontal-overflow.html?mode=okx`,
    viewport: 'mobile',
    durationMs: 30000,
    settleMs: 100,
    plugins: [rulesPlugin()],
    log: e => events.push(e),
  }).run();
  const findings = events.filter((e): e is Extract<CrawlEvent, { type: 'finding' }> => e.type === 'finding');
  expect(findings.filter(f => f.finding.rule === 'observed-horizontal-overflow')).toEqual([
    expect.objectContaining({
      finding: expect.objectContaining({
        severity: 'warning',
        detail: expect.stringMatching(/^CONTENT_UNREACHABLE_LEFT/),
        text: expect.stringContaining('криптопутешествие'),
      }),
    }),
  ]);
  // The rule reads the capture only: this page has nothing to act on, so the crawl takes no actions.
  expect(events.filter(e => e.type === 'action')).toEqual([]);
}, 120000);

it('scrolls each new state to the end, page and containers, stops at an infinite feed, and checks what it saw', async () => {
  const run = async (sweep?: false) => {
    const events: CrawlEvent[] = [];
    const shots: string[] = [];
    const scrolls: number[] = [];
    await new SampledCrawler({
      url: `${fixture.url}/below-fold.html`,
      viewport: { width: 800, height: 600 },
      durationMs: 20000,
      // One click on the first button at the top: a click scrolls its own control into view,
      // so more would bring far-down controls on screen without any sweep.
      maxActions: 1,
      settleMs: 100,
      ...(sweep === false ? { sweep } : {}),
      plugins: [rulesPlugin()],
      // Called once every plugin is done with a state: the page must be back where it was.
      onState: async (_, page) => void scrolls.push(await page.evaluate(() => scrollY)),
      onScreenshot: id => void shots.push(id),
      log: e => events.push(e),
    }).run();
    return { events, shots, scrolls };
  };
  type FindingEvent = Extract<CrawlEvent, { type: 'finding' }>;
  type SweepEvent = Extract<CrawlEvent, { type: 'sweep' }>;
  const findingsOf = (events: CrawlEvent[]) => events.filter((e): e is FindingEvent => e.type === 'finding');
  const names = (events: CrawlEvent[]) => findingsOf(events).map(f => `${f.finding.rule} ${f.finding.selector}`);

  // Without scrolling, the defects far down the page and deep in the list are never judged.
  const blind = await run(false);
  expect(names(blind.events)).toEqual([]);
  expect(blind.events.some(e => e.type === 'sweep')).toBe(false);

  const { events, shots, scrolls } = await run();
  const found = new Set(names(events));
  expect(found).toContain('observed-clipping #clipped-far');
  expect(found).toContain('observed-text-truncation #truncated-far');
  // The virtual list repeats one row template: it is sampled like a list, not scrolled to its end,
  // so a defect deep inside it (row 27) is accepted as unseen.
  expect(found).not.toContain('observed-text-truncation #row-27');
  // Each is outlined on a picture of the part of the page it is in.
  for (const f of findingsOf(events)) {
    const target = f.finding.target!;
    expect(target.shot).toMatch(/^view:/);
    expect(shots).toContain(target.shot);
    expect(target.box.y).toBeGreaterThanOrEqual(0);
    expect(target.box.y + target.box.height).toBeLessThanOrEqual(600);
  }
  const sweeps = events.filter((e): e is SweepEvent => e.type === 'sweep');
  const first = sweeps[0];
  // The page keeps growing at its end: recognised as an infinite feed, not scrolled forever.
  expect(first.surfaces.find(s => s.surface === 'page')).toMatchObject({ end: 'endless' });
  // Rows rendered only once scrolled to are read, until the list shows only more of the same.
  expect(first.surfaces.find(s => s.surface === '#virtual')).toMatchObject({ end: 'repeats' });
  expect(first.surfaces.find(s => s.surface === '#virtual')!.revealed).toBeGreaterThan(0);
  expect(first.revealed).toBeGreaterThan(0);
  // Once found endless, the feed is not scrolled again on this page.
  for (const later of sweeps.slice(1)) expect(later.surfaces.some(s => s.surface === 'page')).toBe(false);
  // No rule is left waiting for the page to scroll.
  const inspection = events.find(
    (e): e is Extract<CrawlEvent, { type: 'inspection' }> => e.type === 'inspection' && e.plugin === 'rules',
  );
  const codes = inspection?.checks?.flatMap(c => c.codes ?? []).map(r => r.code) ?? [];
  expect(codes).not.toContain('VIEWPORT_RECHECK_PENDING');
  expect(codes).not.toContain('TEXT_SCROLL_RECHECK_PENDING');
  expect(scrolls.every(y => y === 0)).toBe(true);
  // What scrolling loaded is a state of its own, checked like any other.
  expect(events.filter(e => e.type === 'state').length).toBeGreaterThan(1);
}, 120000);

it('after an action changes one part far down the page, scrolls only to that part, and still checks it', async () => {
  const events: CrawlEvent[] = [];
  await new SampledCrawler({
    url: `${fixture.url}/expanding.html`,
    viewport: { width: 800, height: 600 },
    durationMs: 20000,
    // "Show the answer", at the top, expands an answer far down the page; the answer's own button
    // is clicked next. Links elsewhere are recorded, not clicked.
    maxActions: 2,
    settleMs: 100,
    plugins: [rulesPlugin()],
    log: e => events.push(e),
  }).run();
  const sweeps = events.filter((e): e is Extract<CrawlEvent, { type: 'sweep' }> => e.type === 'sweep');
  const page = sweeps.map(s => s.surfaces.find(x => x.surface === 'page'));
  // The first state is read to the end of the page.
  expect(page[0]).toMatchObject({ end: 'end' });
  expect(page[0]!.screens).toBeGreaterThan(4);
  // After the answer opened, only the screens showing it are looked at, not the whole page again.
  expect(page[1]!.screens).toBeGreaterThan(0);
  expect(page[1]!.screens).toBeLessThan(page[0]!.screens);
  expect(sweeps[1].skipped).toContain('page');
  // The defect inside the answer is still found.
  expect(
    events.some(
      e => e.type === 'finding' && e.finding.rule === 'observed-text-truncation' && e.finding.selector === '#truncated',
    ),
  ).toBe(true);
}, 120000);

it('reads label backgrounds the color model cannot from screenshots, taken only where they help', async () => {
  const run = async (pixels: boolean) => {
    const events: CrawlEvent[] = [];
    const plugin = rulesPlugin({ pixels });
    // Count the captures the crawler asks about and those that get a screenshot.
    const asked = { all: 0, wanted: 0 };
    const wants = plugin.wantsPixels;
    if (wants)
      plugin.wantsPixels = capture => {
        const want = wants(capture);
        asked.all++;
        if (want) asked.wanted++;
        return want;
      };
    await new SampledCrawler({
      url: `${fixture.url}/text-background-pixels.html`,
      viewport: { width: 1000, height: 600 },
      durationMs: 20000,
      // The entry state and its sweep are what is checked; one action lets the crawl announce it.
      maxActions: 1,
      settleMs: 100,
      plugins: [plugin],
      log: e => events.push(e),
    }).run();
    const found = events
      .filter((e): e is Extract<CrawlEvent, { type: 'finding' }> => e.type === 'finding')
      .filter(e => e.finding.rule === 'observed-text-background')
      .map(e => e.finding.selector.match(/#([\w-]+)$/)?.[1] ?? e.finding.selector);
    return { found: found.sort(), asked };
  };
  // From styles alone none of these can be judged: shadows, gradients, big radii.
  expect((await run(false)).found).toEqual([]);
  const { found, asked } = await run(true);
  // Same-colored labels are found, on the first screen and on the swept screen far below it.
  expect(found).toEqual(['far-same', 'gradient-same', 'radius-same', 'shadow-same']);
  // Not judged: half of the label legible and half not, and a label under a veil.
  expect(found).not.toContain('half');
  expect(found).not.toContain('covered');
  // A screenshot is taken only for screens that hold such a label, not for every capture.
  expect(asked.wanted).toBeGreaterThan(0);
  expect(asked.wanted).toBeLessThan(asked.all);
}, 120000);
