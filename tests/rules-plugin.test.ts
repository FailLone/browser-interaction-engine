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
