import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { SampledCrawler, defaultChecks, maskVolatile, stateKey, type CrawlEvent } from '@interaction/crawler';

// One page with: a blocking modal on load, a long list of identical rows, a
// tab panel, a live price, an in-scope second page and an out-of-scope link.
const page = (price: string) => `<!doctype html><html><head><title>Rate ${price}</title></head><body>
<header><nav aria-label="Main"><a href="/other">Other page</a><a href="https://example.invalid/away">Away</a></nav></header>
<main>
  <p id="price">BTC ${price}</p>
  <div role="tablist"><button role="tab" aria-selected="true" aria-controls="p1" onclick="show(1)">Overview</button><button role="tab" aria-selected="false" aria-controls="p2" onclick="show(2)">Details</button></div>
  <section id="p1">Overview panel</section><section id="p2" hidden><button onclick="this.textContent='Done'">Inner action</button></section>
  <ul>${Array.from({ length: 30 }, (_, i) => `<li><button onclick="document.getElementById('picked').textContent='row ${i}'">Pair ${i}</button></li>`).join('')}</ul>
  <p id="picked"></p>
  <img src="/missing.png" alt="Broken logo" width="40" height="40">
  <button style="width:40px;overflow:hidden;white-space:nowrap">A very long clipped label</button>
</main>
<div id="backdrop" style="position:fixed;inset:0;background:#0006"></div>
<div role="dialog" aria-modal="true" aria-label="Notice" id="modal" style="position:fixed;top:30%;left:30%;background:#fff;padding:20px">
  <p>Regional notice</p><button onclick="document.getElementById('modal').remove();document.getElementById('backdrop').remove()">Close</button>
</div>
<script>function show(n){for(const i of [1,2]){document.getElementById('p'+i).hidden=i!==n;}document.querySelectorAll('[role=tab]').forEach((t,i)=>t.setAttribute('aria-selected',String(i+1===n)));}</script>
</body></html>`;

let server: Server, base = '';
let tick = 0;
beforeAll(async () => {
  server = createServer((req, res) => {
    res.setHeader('content-type', 'text/html');
    if (req.url === '/missing.png') { res.statusCode = 404; res.end(); return; }
    if (req.url === '/other') res.end('<!doctype html><title>Other</title><main><a href="/">Back home</a></main>');
    else res.end(page(`${60000 + tick++}.12`));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;
});
afterAll(() => new Promise<void>(resolve => server.close(() => resolve())));

test('live values do not change component or state identity', () => {
  expect(maskVolatile('BTC 60,001.12 (+1.3%)')).toBe(maskVolatile('BTC 59,870.40 (-0.2%)'));
  const control = (name: string) => ({ localId: name, visible: true, actions: ['click'], name, label: '', role: 'button', tag: 'button', displayedText: '' });
  const a = stateKey({ url: base, title: '', controls: [control('Pay 1.20 USD')] as never });
  const b = stateKey({ url: base, title: '', controls: [control('Pay 3.75 USD')] as never });
  expect(a).toBe(b);
});

test('crawls the entry page: modal first, lists sampled, out-of-scope links skipped', async () => {
  const events: CrawlEvent[] = [];
  const crawler = new SampledCrawler({ url: base, durationMs: 60000, settleMs: 100, checks: defaultChecks, log: e => events.push(e) });
  const summary = await crawler.run();
  const actions = events.filter((e): e is Extract<CrawlEvent, { type: 'action' }> => e.type === 'action');
  const labels = actions.map(a => a.step.label);

  // The blocking modal is handled before anything beneath it.
  expect(actions[0].overlay).toBeTruthy();
  expect(labels[0]).toBe('Close');
  // Thirty identical rows are one class: at most two samples.
  expect(labels.filter(l => /^Pair \d+$/.test(l)).length).toBeLessThanOrEqual(2);
  expect(labels.filter(l => /^Pair \d+$/.test(l)).length).toBeGreaterThanOrEqual(1);
  // Tabs are explored and reveal their panel's action.
  expect(labels).toContain('Details');
  expect(labels).toContain('Inner action');
  // Never leaves scope: neither the other page (not allowed by default) nor the external link.
  expect(labels).not.toContain('Away');
  expect(labels).not.toContain('Other page');
  expect(actions.every(a => a.url.startsWith(base))).toBe(true);
  expect(summary.onEntryPage).toBe(summary.actions);
  // Optional UI checks run on each new state and report each issue once.
  const findings = [...crawler.findings.values()];
  expect(findings.filter(f => f.rule === 'broken-image')).toHaveLength(1);
  expect(findings.filter(f => f.rule === 'clipped-text' && f.text.includes('clipped label'))).toHaveLength(1);
}, 120000);

test('one JEV checklist per batch; uncertain items are left to a trial, LLM only on request; counts and cost are exact', async () => {
  const { ModelJudge } = await import('@interaction/crawler');
  const calls: string[] = [];
  const jev = { name: 'jev', model: 'jev', async decide(request: { kind: string; checks?: Record<string, unknown>; state: unknown }) {
    calls.push(`jev:${request.kind}:${Object.keys(request.checks || {}).length}`);
    const state = request.state as Record<string, { control: { name: string } }>;
    return { model: 'jev', value: Object.fromEntries(Object.entries(state).map(([k, v]) => [k, v.control.name === 'Unsure' ? 0.5 : v.control.name === 'Total' ? 0.1 : 0.95])), usage: { input_tokens: 300, cost: 0.0000126 } };
  } };
  const llm = { name: 'llm', model: 'llm', async decide() { calls.push('llm'); return { model: 'llm', value: false, usage: { prompt_tokens: 100, cost: 0.00002 } }; } };
  const control = (name: string) => ({ kind: 'interactive' as const, control: { tag: 'div', role: 'generic', name, hints: ['pointer-cursor/v1'], text: name } });

  const judge = new ModelJudge({ jev, llm });
  const answers = await judge.askAll([control('Open menu'), control('Unsure'), control('Total')]);
  expect(answers.map(a => a.verdict)).toEqual(['yes', 'uncertain', 'no']);
  expect(await judge.ask(control('Open menu'))).toMatchObject({ verdict: 'yes', source: 'jev' });
  expect(calls).toEqual(['jev:checklist:3']);
  expect(judge.stats).toMatchObject({ questions: 4, cacheHits: 1, answeredByJev: 2, uncertain: 1, answeredByLlm: 0, yes: 1, no: 1 });
  expect(judge.stats.jev).toMatchObject({ calls: 1, judgments: 3, inputTokens: 300, costUsd: 0.0000126 });
  expect(judge.stats.llm).toMatchObject({ calls: 0, costUsd: 0 });

  const escalating = new ModelJudge({ jev, llm, escalate: q => q.kind === 'interactive' });
  expect(await escalating.ask(control('Unsure'))).toMatchObject({ verdict: 'no', source: 'llm' });
  expect(escalating.stats.llm).toMatchObject({ calls: 1, costUsd: 0.00002 });
});

test('a weak pointer-only control is crawled unless the judge rules it out', async () => {
  const { ModelJudge } = await import('@interaction/crawler');
  // Listener attached in script: the DOM only shows a pointer cursor, no click evidence.
  const weak = `<!doctype html><title>Weak</title><main><div id="weak" style="cursor:pointer;padding:8px">Show more rates</div>
    <section id="panel" hidden><button>Inner rate</button></section></main>
    <script>document.getElementById('weak').addEventListener('click',()=>{document.getElementById('panel').hidden=false;});</script>`;
  const local = createServer((_req, res) => { res.setHeader('content-type', 'text/html'); res.end(weak); });
  await new Promise<void>(resolve => local.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(local.address() as { port: number }).port}/`;
  const run = async (yes: boolean) => {
    const jev = { name: 'jev', model: 'jev', async decide(request: { state: unknown }) { return { model: 'jev', value: Object.fromEntries(Object.keys(request.state as object).map(k => [k, yes ? 0.95 : 0.05])) }; } };
    const judge = new ModelJudge({ jev });
    const events: CrawlEvent[] = [];
    await new SampledCrawler({ url, durationMs: 30000, settleMs: 100, checks: [], judge, log: e => events.push(e) }).run();
    return events.filter((e): e is Extract<CrawlEvent, { type: 'action' }> => e.type === 'action').map(a => a.step.label);
  };
  try {
    expect(await run(true)).toEqual(expect.arrayContaining(['Show more rates', 'Inner rate']));
    expect(await run(false)).not.toContain('Show more rates');
  } finally { await new Promise<void>(resolve => local.close(() => resolve())); }
}, 120000);

test('goal mode explores goal-relevant actions and prunes the rest', async () => {
  const { GoalRelevance } = await import('@interaction/crawler');
  // Fake JEV: only actions mentioning "Pair" or "Close" are relevant to the goal.
  const jev = { name: 'jev', model: 'jev', async decide(request: { checks?: Record<string, { instructions: string }> }) {
    return { model: 'jev', value: Object.fromEntries(Object.entries(request.checks || {}).map(([k, v]) => [k, /Pair|Close/.test(v.instructions) ? 0.9 : 0.05])) };
  } };
  const relevance = new GoalRelevance(jev, { goal: 'Pick a trading pair', allowedPaths: [], focus: ['pair list'], tasks: ['pick a pair'] });
  const events: CrawlEvent[] = [];
  await new SampledCrawler({ url: base, durationMs: 30000, settleMs: 100, relevance, log: e => events.push(e) }).run();
  const labels = events.filter((e): e is Extract<CrawlEvent, { type: 'action' }> => e.type === 'action').map(a => a.step.label);
  expect(labels[0]).toBe('Close');
  expect(labels.some(l => /^Pair \d+$/.test(l))).toBe(true);
  expect(labels).not.toContain('Details');
  expect(relevance.calls).toBeGreaterThan(0);
}, 120000);

test('mode selectors stay distinct while repeated records merge', async () => {
  const { controlClass } = await import('@interaction/crawler');
  const item = { ownerInstanceId: 'o', template: 't', slot: 's', rowInstanceId: 'r' };
  const control = (role: string, name: string) => ({ role, name, label: '', displayedText: '', tag: 'div', structuralItem: item }) as never;
  // Chart ranges and page tabs: each switches to different content.
  expect(new Set(['1h', '24h', '1W', '1M'].map(n => controlClass(control('tab', n)))).size).toBe(4);
  // Trading-pair links in one list are one kind of thing.
  expect(new Set(['BTC to PKR', 'BTC to EUR', 'BTC to CNY'].map(n => controlClass(control('link', n)))).size).toBe(1);
});

test('a page that reopens its dialog forever cannot keep the crawler busy', async () => {
  // Closing the dialog navigates back to a page that opens it again.
  const sticky = `<!doctype html><title>Sticky</title><main><p>Body</p></main>
    <div role="dialog" aria-modal="true" aria-label="Promo" style="position:fixed;inset:20%;background:#fff"><p>Promo</p>
    <button onclick="location.reload()">Dismiss</button></div>`;
  const local = createServer((_req, res) => { res.setHeader('content-type', 'text/html'); res.end(sticky); });
  await new Promise<void>(resolve => local.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(local.address() as { port: number }).port}/`;
  try {
    const events: CrawlEvent[] = [];
    const started = Date.now();
    await new SampledCrawler({ url, durationMs: 60000, settleMs: 100, log: e => events.push(e) }).run();
    expect(Date.now() - started).toBeLessThan(30000);
    expect(events.filter(e => e.type === 'action' && e.step.label === 'Dismiss')).toHaveLength(1);
    expect(events.at(-1)).toMatchObject({ type: 'stop' });
  } finally { await new Promise<void>(resolve => local.close(() => resolve())); }
}, 120000);

test('inputs are classified from structure and filled with kind-specific samples', async () => {
  const { classifyInput, inputSamples } = await import('@interaction/crawler');
  const facts = (o: object) => ({ type: 'text', inputmode: '', placeholder: '', pattern: '', autocomplete: '', ariaAutocomplete: '', ariaHaspopup: '', role: '', name: '', min: '', max: '', step: '', value: '', ...o });
  expect(classifyInput(facts({ type: 'number' }))).toBe('number');
  expect(classifyInput(facts({ inputmode: 'decimal' }))).toBe('number');
  expect(classifyInput(facts({ pattern: '\\d*\\.?\\d*' }))).toBe('number');
  expect(classifyInput(facts({ value: '0.00001237' }))).toBe('number');
  expect(classifyInput(facts({ type: 'search' }))).toBe('search');
  expect(classifyInput(facts({ role: 'combobox', ariaHaspopup: 'listbox' }))).toBe('search');
  expect(classifyInput(facts({ placeholder: 'Search crypto' }))).toBe('search');
  expect(classifyInput(facts({ type: 'email' }))).toBe('email');
  expect(classifyInput(facts({ placeholder: 'Your name' }))).toBeUndefined();
  const search = inputSamples('search', facts({}), 'Pairs: BTC ETH BTC SOL BTC');
  expect(search).toEqual([{ value: 'BTC', purpose: 'existing' }, { value: 'zzqx-no-result-7319', purpose: 'empty' }]);
  expect(inputSamples('number', facts({ max: '50' }), '').map(x => x.value)).toEqual(['100', '50', '0', 'abc']);
});

test('a search box is tried with a matching term and with one that exposes the empty state', async () => {
  const html = `<!doctype html><title>Search</title><main>
    <input type="search" placeholder="Search pairs" id="q"><ul id="r"></ul>
    <p>Pairs: BTC ETH SOL BTC BTC</p>
    <script>const pairs=['BTC/USDT','ETH/USDT','SOL/USDT'];document.getElementById('q').addEventListener('keydown',e=>{if(e.key!=='Enter')return;
      const hits=pairs.filter(p=>p.includes(e.target.value.toUpperCase()));document.getElementById('r').innerHTML=hits.length?hits.map(h=>'<li><button>'+h+'</button></li>').join(''):'<li role="status">No results</li>';});</script></main>`;
  const local = createServer((_req, res) => { res.setHeader('content-type', 'text/html'); res.end(html); });
  await new Promise<void>(resolve => local.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(local.address() as { port: number }).port}/`;
  try {
    const events: CrawlEvent[] = [];
    const crawler = new SampledCrawler({ url, durationMs: 30000, settleMs: 100, log: e => events.push(e) });
    const summary = await crawler.run();
    const fills = events.filter((e): e is Extract<CrawlEvent, { type: 'action' }> => e.type === 'action' && e.step.kind === 'fill');
    expect(fills.map(f => [f.step.purpose, f.step.value])).toEqual(expect.arrayContaining([['existing', 'BTC'], ['empty', 'zzqx-no-result-7319']]));
    expect(fills.every(f => f.newState)).toBe(true);
    expect(summary.inputs.kinds).toEqual({ 'search:structure': 1 });
  } finally { await new Promise<void>(resolve => local.close(() => resolve())); }
}, 120000);
