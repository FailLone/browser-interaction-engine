import { afterAll, beforeAll, expect, it } from 'vitest';
import { SampledCrawler, type CrawlEvent } from '@interaction/crawler';
import {
  bindSentinelTarget,
  createSentinelRulePlugins,
  sentinelPlugin,
  type RulePage,
  type SentinelBinding,
} from '@interaction/rules';
import { fixtureServer, withFixture } from './rule-fixture.js';

let fixture: Awaited<ReturnType<typeof fixtureServer>>;
beforeAll(async () => {
  fixture = await fixtureServer();
});
afterAll(async () => {
  await fixture?.server.close();
});
const equivalent = {
  role: 'section-title',
  state: 'rest',
  variant: 'standard',
  density: 'normal',
  platform: 'desktop',
  breakpoint: 'wide',
  version: 'fixture-v1',
};
function node(p: RulePage, id: string) {
  const found = p.snapshot.dom!.nodes.filter(n => n.attributes?.id === id);
  if (found.length !== 1) throw new Error(`Fixture target is not unique: ${id}`);
  return found[0];
}
function bound(p: RulePage, ruleId: string, id: string, data: unknown): SentinelBinding {
  return {
    ruleId,
    target: bindSentinelTarget(p, node(p, id).id),
    applicability: 'yes',
    source: 'sentinel.html fixture contract v1',
    reason:
      'Controlled fixture: equivalent titles, and a selected tab whose sole selection cue is foreground/background.',
    evidence: [p.capture.id],
    data,
  };
}
const typography = (p: RulePage, target: string, peer: string) =>
  bound(p, 'UIK-R001', target, {
    context: equivalent,
    peers: [{ target: bindSentinelTarget(p, node(p, peer).id), context: equivalent }],
    allowedDifferences: [],
  });
function selection(p: RulePage) {
  const chosen = node(p, 'chosen'),
    unchosen = node(p, 'unchosen');
  // This is a fixture adapter with an explicit sole-cue contract, not a general CSS heuristic.
  const visible =
    chosen.styles!['background-color'] !== unchosen.styles!['background-color'] ||
    chosen.styles!.color !== unchosen.styles!.color;
  return bound(p, 'UIK-D007', 'chosen', {
    selectionKnown: true,
    selected: chosen.attributes!['aria-selected'] === 'true',
    selectionKey: 'fixture:extended-interval',
    neededForOrientation: true,
    cuesComplete: true,
    cues: [{ kind: 'background', visible, evidence: p.capture.id }],
  });
}

it('measures styles in Chromium and rejects evidence that predates a real rename/layout change', async () => {
  await withFixture(`${fixture.url}/sentinel.html`, async (f, first) => {
    const observed = typography(first, 'heading-main', 'heading-peer');
    const plugin = createSentinelRulePlugins({ rules: ['UIK-R001'], collect: () => [observed] })[0];
    expect(await plugin.create().run(first)).toMatchObject({ verdict: 'unknown', severity: 'warning' });
    await f.page.locator('#heading-peer').evaluate(el => {
      (el as HTMLElement).style.fontSize = '20px';
      el.textContent = 'Renamed section';
    });
    const current = await f.inspect();
    expect((await plugin.create().run(current)).checks[0].code).toBe('UIK_TARGET_STALE');
    const fresh = createSentinelRulePlugins({
      rules: ['UIK-R001'],
      collect: p => [typography(p, 'heading-main', 'heading-peer')],
    });
    expect((await fresh[0].create().run(current)).verdict).toBe('pass');
  });
});

it('finds a real hover regression without treating an alternate persistent cue as a failure', async () => {
  await withFixture(`${fixture.url}/sentinel.html`, async (f, initial) => {
    const plugin = createSentinelRulePlugins({ rules: ['UIK-D007'], collect: p => [selection(p)] })[0];
    expect((await plugin.create().run(initial)).verdict).toBe('pass');
    await f.page.locator('#chosen').hover();
    const hovered = await f.inspect();
    expect((await plugin.create().run(hovered)).verdict).toBe('fail');
    await f.page.locator('body').evaluate(el => {
      el.setAttribute('data-broken', 'false');
    });
    expect((await plugin.create().run(await f.inspect())).verdict).toBe('pass');
    expect(await f.page.locator('#chosen').getAttribute('aria-selected')).toBe('true');
  });
});

it('records actual keyboard focus separately from pointer focus', async () => {
  await withFixture(`${fixture.url}/sentinel.html`, async f => {
    await f.page.keyboard.press('Tab');
    const focused = await f.inspect();
    const chosen = node(focused, 'chosen');
    const active = focused.snapshot.dom!.page.activeNodeId === chosen.id;
    const indicator = /3px/.test(chosen.styles!.outline) && !chosen.styles!.outline.includes('none');
    expect(active).toBe(true);
    expect(indicator).toBe(true);
    const rules = createSentinelRulePlugins({
      rules: ['UIK-R010'],
      collect: p => [
        bound(p, 'UIK-R010', 'chosen', {
          styleChanged: true,
          keyboardFocusable: true,
          pathComplete: true,
          visits: [{ modality: 'keyboard', active, indicatorVisible: indicator, evidence: p.capture.id }],
        }),
      ],
    });
    expect((await rules[0].create().run(focused)).verdict).toBe('pass');
  });
});

it('checks static DOM targets on swept screens, attaches their screenshot, and keeps reviews unknown', async () => {
  const events: CrawlEvent[] = [];
  const shots: string[] = [];
  const plugin = sentinelPlugin({ rules: ['UIK-R001'], collect: p => [typography(p, 'below-title', 'below-peer')] });
  const readScrolls: number[] = [];
  await new SampledCrawler({
    url: `${fixture.url}/sentinel.html`,
    durationMs: 20000,
    maxActions: 1,
    settleMs: 100,
    viewport: { width: 800, height: 600 },
    plugins: [plugin],
    log: e => events.push(e),
    onScreenshot: id => void shots.push(id),
    onState: async (_state, livePage) => void readScrolls.push(await livePage.evaluate(() => scrollY)),
  }).run();
  const findings = events.filter((e): e is Extract<CrawlEvent, { type: 'finding' }> => e.type === 'finding');
  expect(findings).toHaveLength(1);
  expect(findings[0]).toMatchObject({
    plugin: 'sentinel',
    finding: {
      rule: 'UIK-R001',
      code: 'UIK_REVIEW_SUGGESTED',
      severity: 'warning',
      facts: { verdict: 'unknown' },
      target: { shot: expect.stringMatching(/^view:/) },
    },
  });
  expect(shots).toContain(findings[0].finding.target!.shot);
  const inspections = events.filter((e): e is Extract<CrawlEvent, { type: 'inspection' }> => e.type === 'inspection');
  expect(
    inspections.some(e => e.checks?.some(c => c.id === 'UIK-R001' && c.verdict === 'unknown' && c.targets === 1)),
  ).toBe(true);
  expect(inspections.flatMap(e => Object.keys(e.reasons ?? {}))).toContain('UIK_REVIEW_SUGGESTED');
  expect(events.filter(e => e.type === 'plugin_error')).toEqual([]);
  expect(readScrolls.every(y => y === 0)).toBe(true);
}, 60000);
