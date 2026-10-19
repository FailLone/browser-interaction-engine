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
  // Coverage: the tab panel's text was revealed by an action; most seen classes were executed.
  const page = summary.coverage.pages[0];
  expect(page.textBlocksRevealedByActions).toBeGreaterThan(0);
  expect(page.classesExecuted).toBeGreaterThan(0);
  expect(page.classCoverage).toBeGreaterThan(0.5);
  expect(summary.coverage.statesPerMinute.at(-1)).toBe(summary.states);
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

test('a mode group that only redraws a canvas is sampled once; one that switches content is fully explored', async () => {
  const html = `<!doctype html><title>Modes</title><main>
    <div role="tablist" id="range"><div role="tab" aria-selected="true">1h</div><div role="tab" onclick="draw()">1W</div><div role="tab" onclick="draw()">1M</div><div role="tab" onclick="draw()">1Y</div></div>
    <canvas id="chart" width="200" height="80"></canvas>
    <div role="tablist" id="sections"><div role="tab" aria-selected="true" onclick="show('About')">About</div><div role="tab" onclick="show('News')">News</div><div role="tab" onclick="show('Guides')">Guides</div></div>
    <section id="panel"><button>About action</button></section>
    <script>function draw(){const g=document.getElementById('chart').getContext('2d');g.fillRect(Math.random()*150,0,20,80);}
      function show(n){document.getElementById('panel').innerHTML='<button>'+n+' action</button>';}</script></main>`;
  const local = createServer((_req, res) => { res.setHeader('content-type', 'text/html'); res.end(html); });
  await new Promise<void>(resolve => local.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(local.address() as { port: number }).port}/`;
  try {
    const events: CrawlEvent[] = [];
    const summary = await new SampledCrawler({ url, durationMs: 30000, settleMs: 100, log: e => events.push(e) }).run();
    const labels = events.filter((e): e is Extract<CrawlEvent, { type: 'action' }> => e.type === 'action').map(a => a.step.label);
    expect(labels.filter(l => ['1W', '1M', '1Y'].includes(l))).toHaveLength(1);
    expect(labels).toEqual(expect.arrayContaining(['News', 'Guides', 'News action', 'Guides action']));
    expect(summary.modeGroups.flat).toBe(1);
  } finally { await new Promise<void>(resolve => local.close(() => resolve())); }
}, 120000);

test('backtracking from a finished page uses browser history instead of replaying from the entry', async () => {
  const pages: Record<string, string> = {
    '/': `<!doctype html><title>Home</title><main><a href="/a">Page A</a><a href="/b">Page B</a></main>`,
    '/a': `<!doctype html><title>A</title><main><button onclick="this.textContent='A done'">A action</button></main>`,
    '/b': `<!doctype html><title>B</title><main><button onclick="this.textContent='B done'">B action</button></main>`,
  };
  const local = createServer((req, res) => { res.setHeader('content-type', 'text/html'); res.end(pages[req.url || '/'] || pages['/']); });
  await new Promise<void>(resolve => local.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(local.address() as { port: number }).port}/`;
  try {
    const { defaultPolicy } = await import('@interaction/crawler');
    const policy = defaultPolicy(url); policy.allowedPaths.push(/^\/[ab]$/);
    const events: CrawlEvent[] = [];
    const summary = await new SampledCrawler({ url, policy, followNavigation: true, durationMs: 30000, settleMs: 100, log: e => events.push(e) }).run();
    const labels = events.filter((e): e is Extract<CrawlEvent, { type: 'action' }> => e.type === 'action').map(a => a.step.label);
    expect(labels).toEqual(expect.arrayContaining(['Page A', 'A action', 'Page B', 'B action']));
    expect(summary.historyBacks).toBeGreaterThan(0);
  } finally { await new Promise<void>(resolve => local.close(() => resolve())); }
}, 120000);

test('a covered control fails immediately instead of waiting for a click timeout', async () => {
  const html = `<!doctype html><title>Covered</title><main><button id="b" style="position:absolute;top:10px;left:10px">Hidden behind</button>
    <div style="position:absolute;top:0;left:0;width:300px;height:100px;background:#fff;z-index:2"></div><button style="position:absolute;top:150px">Visible</button></main>`;
  const local = createServer((_req, res) => { res.setHeader('content-type', 'text/html'); res.end(html); });
  await new Promise<void>(resolve => local.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(local.address() as { port: number }).port}/`;
  try {
    const events: CrawlEvent[] = [];
    const crawler = new SampledCrawler({ url, durationMs: 30000, settleMs: 100, log: e => events.push(e) });
    // Bypass the capture-time occlusion filter to exercise the dispatch-time check.
    const candidates = crawler.candidates.bind(crawler);
    crawler.candidates = (s, goal) => candidates({ ...s, controls: s.controls.map(c => ({ ...c, actionable: { ...c.actionable, occludedBy: undefined } })) }, goal);
    await crawler.run();
    const covered = events.find((e): e is Extract<CrawlEvent, { type: 'action' }> => e.type === 'action' && e.step.label === 'Hidden behind');
    expect(covered).toMatchObject({ outcome: 'failed' });
    expect(covered!.error).toContain('covered');
    const before = events[events.indexOf(covered!) - 1];
    expect(covered!.at - (before?.at ?? 0)).toBeLessThan(1500);
  } finally { await new Promise<void>(resolve => local.close(() => resolve())); }
}, 120000);

test('by default the crawler stays on the page: navigations are intercepted and recorded, route changes kept last', async () => {
  const home = `<!doctype html><title>Home</title><main>
    <input id="amount" value="5">
    <a href="/other">Plain link</a>
    <button onclick="location.href='/scripted'">Scripted jump</button>
    <button onclick="window.open('/popup')">Open popup</button>
    <a href="#details">Details anchor</a>
    <button onclick="history.pushState({},'','/spa-view');document.getElementById('view').textContent='SPA view'">SPA route</button>
    <button onclick="document.getElementById('view').textContent='Panel'">Local action</button>
    <p id="view"></p></main>`;
  let otherLoads = 0;
  const local = createServer((req, res) => {
    res.setHeader('content-type', 'text/html');
    if (req.url !== '/') otherLoads++;
    res.end(req.url === '/' ? home : '<title>Elsewhere</title><button>Elsewhere action</button>');
  });
  await new Promise<void>(resolve => local.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(local.address() as { port: number }).port}/`;
  try {
    const { defaultPolicy } = await import('@interaction/crawler');
    const policy = defaultPolicy(url); policy.allowedPaths.push(/^\/(other|scripted|popup|spa-view)$/);
    const events: CrawlEvent[] = [];
    const crawler = new SampledCrawler({ url, policy, durationMs: 30000, settleMs: 100, log: e => events.push(e) });
    const summary = await crawler.run();
    const actions = events.filter((e): e is Extract<CrawlEvent, { type: 'action' }> => e.type === 'action');
    const navigations = events.filter((e): e is Extract<CrawlEvent, { type: 'navigation' }> => e.type === 'navigation');
    // Never tested anything on another page, and never loaded one.
    expect(actions.map(a => a.step.label)).not.toContain('Elsewhere action');
    expect(actions.every(a => a.url.startsWith(url))).toBe(true);
    expect(otherLoads).toBe(0);
    // The plain link is recorded from its href without a click; scripted jumps and popups are intercepted.
    expect(actions.map(a => a.step.label)).not.toContain('Plain link');
    expect(navigations).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'document', to: `${url}other` }),
      expect.objectContaining({ kind: 'document', to: `${url}scripted`, action: 'Scripted jump' }),
      expect.objectContaining({ kind: 'popup', action: 'Open popup' }),
      expect.objectContaining({ kind: 'same-document', action: 'SPA route' }),
    ]));
    // An intercepted jump is not a failure, and the page keeps its state.
    expect(actions.find(a => a.step.label === 'Scripted jump')).toMatchObject({ outcome: expect.not.stringMatching('failed') });
    // The route change is undone when first seen, then re-run only after all other in-page work.
    const labels = actions.map(a => a.step.label);
    const spa = labels.map((l, i) => l === 'SPA route' ? i : -1).filter(i => i >= 0);
    expect(spa).toHaveLength(2);
    expect(labels.indexOf('Local action')).toBeLessThan(spa[1]);
    expect(actions[spa[1]].tier).toBe('route');
    expect(summary.navigations.sameDocument.length).toBeGreaterThan(0);
  } finally { await new Promise<void>(resolve => local.close(() => resolve())); }
}, 120000);

test('an open-then-close loop with no visible effect is dropped from the replay path; one that changed the page is kept', async () => {
  const html = `<!doctype html><title>Loops</title><main>
    <button aria-expanded="false" onclick="const m=document.getElementById('menu');m.hidden=!m.hidden;this.setAttribute('aria-expanded',String(!m.hidden))">Menu</button>
    <div id="menu" hidden><button onclick="document.getElementById('menu').hidden=true">Close menu</button></div>
    <button aria-expanded="false" onclick="const p=document.getElementById('lang');p.hidden=!p.hidden">Language</button>
    <div id="lang" hidden><button onclick="document.getElementById('cur').textContent='CNY';document.getElementById('lang').hidden=true">CNY</button></div>
    <p>Currency: <span id="cur">USD</span></p>
    <button onclick="document.getElementById('deep').hidden=false">Show deep</button>
    <section id="deep" hidden><button>Deep action</button></section></main>`;
  const local = createServer((_req, res) => { res.setHeader('content-type', 'text/html'); res.end(html); });
  await new Promise<void>(resolve => local.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(local.address() as { port: number }).port}/`;
  try {
    const crawler = new SampledCrawler({ url, durationMs: 30000, settleMs: 100 });
    const pushes: string[][] = [];
    const push = (crawler as unknown as { pushStep(step: { label: string }): void }).pushStep.bind(crawler);
    (crawler as unknown as { pushStep(step: { label: string }): void }).pushStep = step => { push(step); pushes.push((crawler as unknown as { path: { label: string }[] }).path.map(x => x.label)); };
    const summary = await crawler.run();
    expect(summary.prunedSteps).toBeGreaterThan(0);
    // After Menu > Close menu the path no longer contains the menu loop.
    const afterClose = pushes.find(p => p.length === 0 || !p.includes('Close menu'));
    expect(afterClose).toBeDefined();
    expect(pushes.some(p => p.includes('Close menu'))).toBe(false);
    // Language > CNY changed the visible currency: that loop stays in the path.
    expect(pushes.some(p => p.includes('CNY'))).toBe(true);
  } finally { await new Promise<void>(resolve => local.close(() => resolve())); }
}, 120000);
