import { afterAll, beforeAll, expect, it } from 'vitest';
import { type CrawlEvent, SampledCrawler } from '@interaction/crawler';
import { builtinRulePlugins, type RulePlugin, rulesPlugin } from '@interaction/rules';
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
}, 120000);
