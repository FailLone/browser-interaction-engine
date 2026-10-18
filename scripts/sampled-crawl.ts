// Run the sampled crawler against a real page and write events + summary.
// Usage: tsx --conditions=development scripts/sampled-crawl.ts OUT_DIR [URL] [DURATION_MS]
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { SampledCrawler, defaultPolicy } from '@interaction/crawler';

const out = process.argv[2] || 'work/sampled-crawl';
const url = process.argv[3] || 'https://www.okx.com/convert/usd-to-btc';
const durationMs = Number(process.argv[4] || 240000);
// Optional anchored pathname pattern for other in-scope pages (same origin as the entry).
const scope = process.argv[5];
const policy = defaultPolicy(url);
if (scope) policy.allowedPaths.push(new RegExp(scope));
mkdirSync(out, { recursive: true });
const crawler = new SampledCrawler({
  url, durationMs, policy,
  log: event => {
    appendFileSync(join(out, 'events.jsonl'), JSON.stringify(event) + '\n');
    const t = (event.at / 1000).toFixed(1);
    if (event.type === 'action') console.log(t, event.tier.padEnd(18), event.step.kind.padEnd(5), event.outcome.padEnd(9), event.newState ? 'NEW' : '   ', JSON.stringify(event.step.label), event.overlay || '', event.error || '');
    else if (event.type === 'state') console.log(t, 'state', event.state.url, event.state.overlay || '', event.state.controls);
    else if (event.type === 'finding') console.log(t, 'finding', event.finding.rule, JSON.stringify(event.finding.text), event.finding.detail);
    else console.log(t, event.type, event.reason);
  },
});
const summary = await crawler.run();
writeFileSync(join(out, 'summary.json'), JSON.stringify(summary, null, 2));
writeFileSync(join(out, 'findings.json'), JSON.stringify([...crawler.findings.values()], null, 2));
console.log(JSON.stringify(summary, null, 2));
