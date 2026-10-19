// Run the sampled crawler against a real page and write events + summary.
// Usage: tsx --conditions=development scripts/sampled-crawl.ts OUT_DIR [URL] [DURATION_MS] [PATH_PATTERN] [GOAL]
// Model plugin and goal mode use the existing EXPLORER_JEV_* / EXPLORER_LLM_* variables.
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { GoalRelevance, ModelJudge, SampledCrawler, defaultChecks, defaultPolicy, metered, planGoal, providersFromEnv } from '@interaction/crawler';
import { BrowserAdapter, PlaywrightAdapter } from '@interaction/adapter-playwright';
import { MemoryEvidenceStore } from '@interaction/storage-memory';

const out = process.argv[2] || 'work/sampled-crawl';
const url = process.argv[3] || 'https://www.okx.com/convert/usd-to-btc';
const durationMs = Number(process.argv[4] || 240000);
// Longer runs can spend more per secondary page and visit more pages per template:
// CRAWL_PAGE_ACTIONS (default 20), CRAWL_PAGE_SAMPLES (default 2).
// Optional UI checks as a side observation (not an acceptance target): CRAWL_CHECKS=1.
// Optional anchored pathname pattern for other in-scope pages (same origin as the entry).
const scope = process.argv[5] || undefined;
const policy = defaultPolicy(url);
if (scope) policy.allowedPaths.push(new RegExp(scope));
mkdirSync(out, { recursive: true });
// Optional model plugin: configured through the existing EXPLORER_JEV_* / EXPLORER_LLM_* variables.
const providers = providersFromEnv();
const judge = providers.jev || providers.llm ? new ModelJudge({ jev: providers.jev, llm: providers.llm }) : undefined;
const inputJudge = providers.jev && metered(providers.jev);
console.log('model judge', judge ? `jev=${providers.jev?.model ?? 'none'} llm=${providers.llm?.model ?? 'none'}` : 'not configured');
// Goal mode: the LLM plans scope from the entry page's controls; JEV prunes off-goal actions.
const goal = process.argv[6];
let relevance: GoalRelevance | undefined;
let planning: import('@interaction/crawler').ProviderMeter | undefined;
if (goal) {
  if (!providers.llm || !providers.jev) throw new Error('Goal mode needs both EXPLORER_JEV_* and EXPLORER_LLM_*');
  const adapter = new BrowserAdapter(new PlaywrightAdapter().parseOptions({ url, headless: true }), new MemoryEvidenceStore());
  await adapter.start(); await adapter.page!.waitForTimeout(1500);
  const dom = await adapter.readDOM(false, false); await adapter.close();
  const planner = metered(providers.llm);
  const plan = await planGoal(planner, goal, url, dom.controls.filter(c => c.visible));
  planning = planner.meter;
  for (const pattern of plan.allowedPaths) policy.allowedPaths.push(new RegExp(pattern));
  relevance = new GoalRelevance(providers.jev, plan);
  console.log('goal plan', JSON.stringify(plan));
}
const crawler = new SampledCrawler({
  url, durationMs, policy, judge, relevance, inputJudge, maxActions: 2000, ...(process.env.CRAWL_CHECKS ? { checks: defaultChecks } : {}),
  ...(process.env.CRAWL_PAGE_ACTIONS ? { pageActions: Number(process.env.CRAWL_PAGE_ACTIONS) } : {}), ...(process.env.CRAWL_PAGE_SAMPLES ? { pageSamples: Number(process.env.CRAWL_PAGE_SAMPLES) } : {}),
  log: event => {
    appendFileSync(join(out, 'events.jsonl'), JSON.stringify(event) + '\n');
    const t = (event.at / 1000).toFixed(1);
    if (event.type === 'action') console.log(t, event.tier.padEnd(18), event.step.kind.padEnd(5), event.outcome.padEnd(9), event.newState ? 'NEW' : '   ', JSON.stringify(event.step.label), event.overlay || '', event.error || '');
    else if (event.type === 'state') console.log(t, 'state', event.state.url, event.state.overlay || '', event.state.controls);
    else if (event.type === 'finding') console.log(t, 'finding', event.finding.rule, JSON.stringify(event.finding.text), event.finding.detail);
    else if (event.type === 'judgement') console.log(t, 'judge', event.question, event.source, event.verdict, event.probability ?? '', JSON.stringify(event.label));
    else if (event.type === 'navigation') console.log(t, 'navigation', event.kind, event.outcome, event.to, JSON.stringify(event.action));
    else console.log(t, event.type, event.reason);
  },
});
const summary = { ...await crawler.run(), ...(planning ? { goalPlanning: planning } : {}), ...(inputJudge ? { inputClassification: inputJudge.meter } : {}) };
const inputCost = inputJudge?.meter.costUsd || 0, inputCalls = inputJudge?.meter.calls || 0;
const total = (planning?.costUsd || 0) + inputCost + (summary.models.jev.costUsd + summary.models.llm.costUsd);
console.log(`model spend: JEV ${summary.models.jev.calls + inputCalls} calls $${(summary.models.jev.costUsd + inputCost).toFixed(6)}, LLM ${summary.models.llm.calls + (planning?.calls || 0)} calls $${(summary.models.llm.costUsd + (planning?.costUsd || 0)).toFixed(6)}, total $${total.toFixed(6)}`);
writeFileSync(join(out, 'summary.json'), JSON.stringify(summary, null, 2));
writeFileSync(join(out, 'findings.json'), JSON.stringify([...crawler.findings.values()], null, 2));
console.log(JSON.stringify(summary, null, 2));
