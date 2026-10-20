import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, expect, test } from 'vitest';
import {
  BrowserDriver,
  ModelJudge,
  SampledCrawler,
  trimReplay,
  maskVolatile,
  stateKey,
  type CrawlEvent,
  type CrawlPlugin,
} from '@interaction/crawler';

/**
 * A fake JEV: checklist items get `item(question)`; effect questions, a JEV choice of their own,
 * get the `effect` distribution over yes / no / unrelated.
 */
function fakeJev(
  item: (question: { kind: string; members?: string[]; control?: { name: string } }) => number,
  effect: Record<'yes' | 'no' | 'unrelated', number> = { yes: 0.9, no: 0.05, unrelated: 0.05 },
) {
  return {
    name: 'jev',
    model: 'jev',
    async decide(request: { kind: string; state: unknown }) {
      if (request.kind === 'choice') {
        const choice = Object.entries(effect).sort((a, b) => b[1] - a[1])[0][0];
        return { model: 'jev', value: choice, probabilities: effect };
      }
      const state = request.state as Record<string, { kind: string; members?: string[]; control?: { name: string } }>;
      return { model: 'jev', value: Object.fromEntries(Object.entries(state).map(([k, q]) => [k, item(q)])) };
    },
  };
}

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

let server: Server,
  base = '';
let tick = 0;
beforeAll(async () => {
  server = createServer((req, res) => {
    res.setHeader('content-type', 'text/html');
    if (req.url === '/missing.png') {
      res.statusCode = 404;
      res.end();
      return;
    }
    if (req.url === '/other') res.end('<!doctype html><title>Other</title><main><a href="/">Back home</a></main>');
    else res.end(page(`${60000 + tick++}.12`));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;
});
afterAll(() => new Promise<void>(resolve => server.close(() => resolve())));

test('live values do not change component or state identity', () => {
  expect(maskVolatile('BTC 60,001.12 (+1.3%)')).toBe(maskVolatile('BTC 59,870.40 (-0.2%)'));
  const control = (name: string) => ({
    localId: name,
    visible: true,
    actions: ['click'],
    name,
    label: '',
    role: 'button',
    tag: 'button',
    displayedText: '',
  });
  const a = stateKey({ url: base, title: '', controls: [control('Pay 1.20 USD')] as never });
  const b = stateKey({ url: base, title: '', controls: [control('Pay 3.75 USD')] as never });
  expect(a).toBe(b);
});

test('crawls the entry page: modal first, lists sampled, out-of-scope links skipped', async () => {
  const events: CrawlEvent[] = [];
  // A plugin sees every new state once; the same finding on many states is reported once.
  const seen: string[] = [];
  const plugin: CrawlPlugin = {
    id: 'probe',
    onState: ({ state, snapshot }) => {
      seen.push(state);
      return [
        { rule: 'title', severity: 'warning', selector: 'title', text: maskVolatile(snapshot.title), detail: '' },
      ];
    },
  };
  const crawler = new SampledCrawler({
    url: base,
    durationMs: 60000,
    settleMs: 100,
    plugins: [plugin],
    log: e => events.push(e),
  });
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
  expect(new Set(seen).size).toBe(seen.length);
  expect(seen.length).toBeGreaterThan(1);
  expect(seen.length).toBeLessThanOrEqual(summary.states);
  expect(events.filter(e => e.type === 'finding')).toHaveLength(1);
}, 120000);

test('one JEV checklist per batch; uncertain items are left to a trial, LLM only on request; counts and cost are exact', async () => {
  const { ModelJudge } = await import('@interaction/crawler');
  const calls: string[] = [];
  const jev = {
    name: 'jev',
    model: 'jev',
    async decide(request: { kind: string; checks?: Record<string, unknown>; state: unknown }) {
      calls.push(`jev:${request.kind}:${Object.keys(request.checks || {}).length}`);
      const state = request.state as Record<string, { control: { name: string } }>;
      return {
        model: 'jev',
        value: Object.fromEntries(
          Object.entries(state).map(([k, v]) => [
            k,
            v.control.name === 'Unsure' ? 0.5 : v.control.name === 'Total' ? 0.1 : 0.95,
          ]),
        ),
        usage: { input_tokens: 300, cost: 0.0000126 },
      };
    },
  };
  const llm = {
    name: 'llm',
    model: 'llm',
    async decide() {
      calls.push('llm');
      return { model: 'llm', value: false, usage: { prompt_tokens: 100, cost: 0.00002 } };
    },
  };
  const control = (name: string) => ({
    kind: 'interactive' as const,
    control: { tag: 'div', role: 'generic', name, hints: ['pointer-cursor/v1'], text: name },
  });

  const judge = new ModelJudge({ jev, llm });
  const answers = await judge.askAll([control('Open menu'), control('Unsure'), control('Total')]);
  expect(answers.map(a => a.verdict)).toEqual(['yes', 'uncertain', 'no']);
  expect(await judge.ask(control('Open menu'))).toMatchObject({ verdict: 'yes', source: 'jev' });
  expect(calls).toEqual(['jev:checklist:3']);
  expect(judge.stats).toMatchObject({
    questions: 4,
    cacheHits: 1,
    answeredByJev: 2,
    uncertain: 1,
    answeredByLlm: 0,
    yes: 1,
    no: 1,
  });
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
  const local = createServer((_req, res) => {
    res.setHeader('content-type', 'text/html');
    res.end(weak);
  });
  await new Promise<void>(resolve => local.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(local.address() as { port: number }).port}/`;
  const run = async (yes: boolean) => {
    const judge = new ModelJudge({ jev: fakeJev(() => (yes ? 0.95 : 0.05)) });
    const events: CrawlEvent[] = [];
    await new SampledCrawler({ url, durationMs: 30000, settleMs: 100, judge, log: e => events.push(e) }).run();
    return events
      .filter((e): e is Extract<CrawlEvent, { type: 'action' }> => e.type === 'action')
      .map(a => a.step.label);
  };
  try {
    expect(await run(true)).toEqual(expect.arrayContaining(['Show more rates', 'Inner rate']));
    expect(await run(false)).not.toContain('Show more rates');
  } finally {
    await new Promise<void>(resolve => local.close(() => resolve()));
  }
}, 120000);

test('goal mode explores goal-relevant actions and prunes the rest', async () => {
  const { GoalRelevance } = await import('@interaction/crawler');
  // Fake JEV: only actions mentioning "Pair" or "Close" are relevant to the goal.
  const jev = {
    name: 'jev',
    model: 'jev',
    async decide(request: { checks?: Record<string, { instructions: string }> }) {
      return {
        model: 'jev',
        value: Object.fromEntries(
          Object.entries(request.checks || {}).map(([k, v]) => [k, /Pair|Close/.test(v.instructions) ? 0.9 : 0.05]),
        ),
      };
    },
  };
  const relevance = new GoalRelevance(jev, {
    goal: 'Pick a trading pair',
    stayOnPage: true,
    allowedPaths: [],
    areas: [],
    focus: ['pair list'],
    tasks: ['pick a pair'],
    question: '',
  });
  const events: CrawlEvent[] = [];
  await new SampledCrawler({ url: base, durationMs: 30000, settleMs: 100, relevance, log: e => events.push(e) }).run();
  const labels = events
    .filter((e): e is Extract<CrawlEvent, { type: 'action' }> => e.type === 'action')
    .map(a => a.step.label);
  expect(labels[0]).toBe('Close');
  expect(labels.some(l => /^Pair \d+$/.test(l))).toBe(true);
  expect(labels).not.toContain('Details');
  expect(relevance.calls).toBeGreaterThan(0);
}, 120000);

test('goal scope leaves the header, navigation and footer alone unless the goal names them', async () => {
  const { GoalRelevance } = await import('@interaction/crawler');
  const html = `<!doctype html><title>Scope</title>
    <header><button onclick="this.textContent='Searched'">Search site</button></header>
    <nav aria-label="Menu"><button onclick="this.textContent='Opened'">Products</button></nav>
    <main><button onclick="document.getElementById('out').textContent='EUR'">Pick EUR</button><p id="out"></p></main>
    <footer><button onclick="document.getElementById('lang').hidden=false">Language</button>
      <div id="lang" role="dialog" aria-modal="true" aria-label="Languages" hidden><button onclick="this.parentElement.hidden=true">Close languages</button></div></footer>`;
  const local = createServer((_req, res) => {
    res.setHeader('content-type', 'text/html');
    res.end(html);
  });
  await new Promise<void>(resolve => local.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(local.address() as { port: number }).port}/`;
  // Every class is relevant: only the area scope decides.
  const jev = {
    name: 'jev',
    model: 'jev',
    async decide(request: { checks?: Record<string, unknown> }) {
      return { model: 'jev', value: Object.fromEntries(Object.keys(request.checks || {}).map(k => [k, 0.9])) };
    },
  };
  const run = async (areas: ('banner' | 'navigation' | 'contentinfo')[]) => {
    const relevance = new GoalRelevance(jev, {
      goal: 'Switch currency',
      stayOnPage: true,
      allowedPaths: [],
      areas,
      focus: [],
      tasks: [],
      question: '',
    });
    const events: CrawlEvent[] = [];
    const summary = await new SampledCrawler({
      url,
      durationMs: 30000,
      settleMs: 100,
      relevance,
      log: e => events.push(e),
    }).run();
    const labels = events
      .filter((e): e is Extract<CrawlEvent, { type: 'action' }> => e.type === 'action')
      .map(a => a.step.label);
    return { labels, summary };
  };
  try {
    const page = await run([]);
    expect(page.labels).toContain('Pick EUR');
    for (const off of ['Search site', 'Products', 'Language', 'Close languages'])
      expect(page.labels).not.toContain(off);
    expect(page.summary.goal).toMatchObject({
      excludedAreas: ['banner', 'navigation', 'contentinfo'],
      offAreaClasses: 3,
    });
    // A goal about the footer brings it, and the overlay it opens, into scope.
    const footer = await run(['contentinfo']);
    expect(footer.labels).toEqual(expect.arrayContaining(['Pick EUR', 'Language', 'Close languages']));
    expect(footer.labels).not.toContain('Search site');
    expect(footer.labels).not.toContain('Products');
  } finally {
    await new Promise<void>(resolve => local.close(() => resolve()));
  }
}, 120000);

test('a goal question is pursued into hidden content and the crawl stops once the page answers it', async () => {
  const { GoalPursuit } = await import('@interaction/crawler');
  // The answer sits in the third collapsed FAQ; other sections are distractions.
  const html = `<!doctype html><title>FAQ</title><main>
    <div><button onclick="document.getElementById('a1').hidden=false">How do I convert?</button><p id="a1" hidden>Pick two currencies.</p></div>
    <div><button onclick="document.getElementById('a2').hidden=false">Is it safe?</button><p id="a2" hidden>We use cold storage.</p></div>
    <div><button onclick="document.getElementById('a3').hidden=false">What does it cost?</button><p id="a3" hidden>The trading fee is 0.1% per conversion.</p></div>
    <div><button onclick="this.textContent='Liked'">Like</button></div></main>`;
  const local = createServer((_req, res) => {
    res.setHeader('content-type', 'text/html');
    res.end(html);
  });
  await new Promise<void>(resolve => local.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(local.address() as { port: number }).port}/`;
  // Fake LLM: answers once the fee text was shown; otherwise picks a cost-looking action, or none.
  const seen: string[] = [];
  const llm = {
    name: 'llm',
    model: 'llm',
    async decide(request: { state: unknown }) {
      const state = request.state as { newText: string; actions: string[]; history: string[] };
      seen.push(state.newText);
      if (seen.join('\n').includes('trading fee'))
        return {
          model: 'llm',
          value: { answered: true, found: true, answer: 'Yes: "The trading fee is 0.1%"', next: -1, reason: 'shown' },
        };
      const i = state.actions.findIndex(a => /cost/i.test(a));
      return { model: 'llm', value: { answered: false, answer: '', next: i, reason: 'look for fees' } };
    },
  };
  const plan = {
    goal: 'Can a user find the trading fee?',
    stayOnPage: true,
    allowedPaths: [],
    areas: [],
    focus: [],
    tasks: [],
    question: 'Does the page explain the trading fee?',
  };
  try {
    const pursuit = new GoalPursuit(llm, plan);
    const events: CrawlEvent[] = [];
    const summary = await new SampledCrawler({
      url,
      durationMs: 30000,
      settleMs: 100,
      pursuit,
      log: e => events.push(e),
    }).run();
    const labels = events
      .filter((e): e is Extract<CrawlEvent, { type: 'action' }> => e.type === 'action')
      .map(a => a.step.label);
    expect(labels).toEqual(['What does it cost?']);
    expect(summary.stopReason).toBe('goal_answered');
    expect(summary.pursuit).toMatchObject({ answered: true, steeredActions: 1, llmCalls: 2 });
    expect(summary.pursuit?.result?.answer).toContain('0.1%');
    // Later looks only send text that is new since the last one.
    expect(seen[1]).toContain('trading fee');
    expect(seen[1]).not.toContain('How do I convert?');

    // When the LLM sees no promising action, the crawler explores until the answer shows up.
    // (A list of FAQ items is sampled, not exhausted: there only the LLM's pick reaches a member.)
    const single = `<!doctype html><title>Pricing</title><main>
      <div><button onclick="this.textContent='Liked'">Like</button></div>
      <div><button aria-expanded="false" onclick="document.getElementById('p').hidden=false">More</button><p id="p" hidden>The trading fee is 0.1% per conversion.</p></div></main>`;
    const other = createServer((_req, res) => {
      res.setHeader('content-type', 'text/html');
      res.end(single);
    });
    await new Promise<void>(resolve => other.listen(0, '127.0.0.1', resolve));
    const blind = new GoalPursuit(
      {
        ...llm,
        async decide(request: { state: unknown }) {
          const state = request.state as { newText: string };
          return state.newText.includes('trading fee')
            ? { model: 'llm', value: { answered: true, found: true, answer: '0.1%', next: -1, reason: 'shown' } }
            : { model: 'llm', value: { answered: false, answer: '', next: -1, reason: 'nothing obvious' } };
        },
      },
      plan,
    );
    try {
      const explored = await new SampledCrawler({
        url: `http://127.0.0.1:${(other.address() as { port: number }).port}/`,
        durationMs: 30000,
        settleMs: 100,
        pursuit: blind,
      }).run();
      expect(explored.stopReason).toBe('goal_answered');
      expect(explored.pursuit).toMatchObject({ answered: true, settled: true, steeredActions: 0 });

      // "Not on the page" is only provisional: the crawl explores the rest before it stands,
      // and text revealed later overturns it.
      const hasty = (reveals: boolean) =>
        new GoalPursuit(
          {
            ...llm,
            async decide(request: { state: unknown }) {
              const state = request.state as { newText: string };
              return reveals && state.newText.includes('trading fee')
                ? { model: 'llm', value: { answered: true, found: true, answer: '0.1%', next: -1, reason: 'shown' } }
                : {
                    model: 'llm',
                    value: { answered: true, found: false, answer: 'No fee is shown', next: -1, reason: 'none seen' },
                  };
            },
          },
          plan,
        );
      const crawl = (pursuit: InstanceType<typeof GoalPursuit>) =>
        new SampledCrawler({
          url: `http://127.0.0.1:${(other.address() as { port: number }).port}/`,
          durationMs: 30000,
          settleMs: 100,
          pursuit,
        }).run();
      const overturned = await crawl(hasty(true));
      expect(overturned.stopReason).toBe('goal_answered');
      expect(overturned.pursuit?.result).toMatchObject({ found: true, provisional: false, answer: '0.1%' });
      const absent = await crawl(hasty(false));
      expect(absent.stopReason).toBe('scope_exhausted');
      expect(absent.actions).toBeGreaterThan(0);
      expect(absent.pursuit).toMatchObject({
        answered: true,
        settled: true,
        result: { found: false, provisional: true },
      });
    } finally {
      await new Promise<void>(resolve => other.close(() => resolve()));
    }
  } finally {
    await new Promise<void>(resolve => local.close(() => resolve()));
  }
}, 120000);

test('a goal plan stays on the page unless it asks for other pages, and maps named areas', async () => {
  const { planGoal } = await import('@interaction/crawler');
  const llm = (value: unknown) => ({
    name: 'llm',
    model: 'llm',
    async decide() {
      return { model: 'llm', value };
    },
  });
  const controls = [{ role: 'button', name: 'USD' }];
  const onPage = await planGoal(
    llm({ stayOnPage: true, allowedPaths: ['^/convert/[^/]+$'], areas: [], focus: ['x'], tasks: ['y'] }),
    'switch currency',
    'https://example.com/convert/usd-to-btc',
    controls,
  );
  expect(onPage).toMatchObject({ stayOnPage: true, allowedPaths: [], areas: [] });
  const pages = await planGoal(
    llm({
      stayOnPage: false,
      allowedPaths: ['^/convert/[^/]+$', '/no-anchor', '^(bad'],
      areas: ['footer', 'header', 'sidebar'],
      focus: [],
      tasks: [],
    }),
    'compare pairs',
    'https://example.com/convert/usd-to-btc',
    controls,
  );
  expect(pages).toMatchObject({
    stayOnPage: false,
    allowedPaths: ['^/convert/[^/]+$'],
    areas: ['contentinfo', 'banner'],
  });
  // Leaving the page with nowhere valid to go is staying.
  const nowhere = await planGoal(
    llm({ stayOnPage: false, allowedPaths: ['/x'], areas: [], focus: [], tasks: [] }),
    'g',
    'https://example.com/',
    controls,
  );
  expect(nowhere).toMatchObject({ stayOnPage: true, allowedPaths: [], question: '' });
});

test('safety is structural: form submits are never clicked, whatever the wording', async () => {
  const html = `<!doctype html><meta charset="utf-8"><title>Safety</title><main>
    <div><button aria-expanded="false" onclick="document.getElementById('a').hidden=false">I just bought Bitcoin. How do I sell?</button><p id="a" hidden>Answer shown</p></div>
    <form action="/never" onsubmit="document.title='SUBMITTED';return false">
      <input name="q" placeholder="Amount">
      <button onclick="document.getElementById('o').textContent='opened'" type="button">Подтвердить</button><p id="o"></p>
      <button>Send</button>
      <button type="submit">Confirm</button>
      <input type="submit" value="Go">
      <input type="image" alt="Pay" src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" width="20" height="20">
    </form></main>`;
  const local = createServer((_req, res) => {
    res.setHeader('content-type', 'text/html');
    res.end(html);
  });
  await new Promise<void>(resolve => local.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(local.address() as { port: number }).port}/`;
  try {
    const events: CrawlEvent[] = [];
    const summary = await new SampledCrawler({ url, durationMs: 30000, settleMs: 100, log: e => events.push(e) }).run();
    const labels = events
      .filter((e): e is Extract<CrawlEvent, { type: 'action' }> => e.type === 'action')
      .map(a => a.step.label);
    // Words like "bought", "sell" or a Russian "confirm" no longer block anything.
    expect(labels).toEqual(expect.arrayContaining(['I just bought Bitcoin. How do I sell?', 'Подтвердить']));
    for (const submit of ['Send', 'Confirm', 'Go', 'Pay']) expect(labels).not.toContain(submit);
    // The summary lists the rules and what each one held back, for reviewers.
    const rule = summary.safety.find(r => r.id === 'form-submit');
    expect(rule?.skipped).toEqual(expect.arrayContaining(['Send', 'Confirm', 'Go', 'Pay']));
  } finally {
    await new Promise<void>(resolve => local.close(() => resolve()));
  }
}, 120000);

test('mode selectors stay distinct while repeated records merge', async () => {
  const { controlClass } = await import('@interaction/crawler');
  const item = { ownerInstanceId: 'o', template: 't', slot: 's', rowInstanceId: 'r' };
  const control = (role: string, name: string) =>
    ({ role, name, label: '', displayedText: '', tag: 'div', structuralItem: item }) as never;
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
  const local = createServer((_req, res) => {
    res.setHeader('content-type', 'text/html');
    res.end(sticky);
  });
  await new Promise<void>(resolve => local.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(local.address() as { port: number }).port}/`;
  try {
    const events: CrawlEvent[] = [];
    const started = Date.now();
    await new SampledCrawler({ url, durationMs: 60000, settleMs: 100, log: e => events.push(e) }).run();
    expect(Date.now() - started).toBeLessThan(30000);
    expect(events.filter(e => e.type === 'action' && e.step.label === 'Dismiss')).toHaveLength(1);
    expect(events.at(-1)).toMatchObject({ type: 'stop' });
  } finally {
    await new Promise<void>(resolve => local.close(() => resolve()));
  }
}, 120000);

test('inputs are classified from structure and filled with kind-specific samples', async () => {
  const { classifyInput, inputSamples } = await import('@interaction/crawler');
  const facts = (o: object) => ({
    type: 'text',
    inputmode: '',
    placeholder: '',
    pattern: '',
    autocomplete: '',
    ariaAutocomplete: '',
    ariaHaspopup: '',
    role: '',
    name: '',
    min: '',
    max: '',
    step: '',
    value: '',
    ...o,
  });
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
  expect(search).toEqual([
    { value: 'BTC', purpose: 'existing' },
    { value: 'zzqx-no-result-7319', purpose: 'empty' },
  ]);
  // The box's own items win over the page-wide favourite.
  expect(inputSamples('search', facts({}), 'BTC BTC BTC', ['English', 'Español'])[0].value).toBe('English');
  expect(inputSamples('number', facts({ max: '50' }), '').map(x => x.value)).toEqual(['100', '50', '0', 'abc']);
});

test('each search box is tried with a term from the items it filters, not the page-wide favourite', async () => {
  // Both panels sit under the same "USD" heavy page; only the currency list contains USD.
  const html = `<!doctype html><title>Settings</title><main>
    <p>USD USD USD USD rates in USD</p>
    <div class="panel"><div>Language</div><input placeholder="Search" data-list="lang"><ul id="lang"><li><a href="#en">English</a></li><li><a href="#zh">简体中文</a></li><li><a href="#es">Español</a></li></ul></div>
    <div class="panel"><div>Local currency</div><input placeholder="Search" data-list="cur"><ul id="cur"><li><a href="#usd">USD</a></li><li><a href="#cny">CNY</a></li><li><a href="#eur">EUR</a></li></ul></div>
    <script>for (const q of document.querySelectorAll('input')) q.addEventListener('keydown', e => { if (e.key !== 'Enter') return;
      const ul = document.getElementById(q.dataset.list);
      for (const li of ul.querySelectorAll('li')) li.hidden = !li.textContent.toLowerCase().includes(q.value.toLowerCase());
      ul.dataset.hits = [...ul.querySelectorAll('li')].filter(li => !li.hidden).length; });</script></main>`;
  const local = createServer((_req, res) => {
    res.setHeader('content-type', 'text/html');
    res.end(html);
  });
  await new Promise<void>(resolve => local.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(local.address() as { port: number }).port}/`;
  try {
    const events: CrawlEvent[] = [];
    const crawler = new SampledCrawler({ url, durationMs: 30000, settleMs: 100, log: e => events.push(e) });
    await crawler.run();
    const existing = events
      .filter((e): e is Extract<CrawlEvent, { type: 'action' }> => e.type === 'action' && e.step.kind === 'fill')
      .filter(f => f.step.purpose === 'existing')
      .map(f => [f.step.classKey.split('|')[4], f.step.value]);
    expect(existing).toEqual(
      expect.arrayContaining([
        ['Search@Language', 'English'],
        ['Search@Local currency', 'USD'],
      ]),
    );
  } finally {
    await new Promise<void>(resolve => local.close(() => resolve()));
  }
});

test('a search box is tried with a matching term and with one that exposes the empty state', async () => {
  const html = `<!doctype html><title>Search</title><main>
    <input type="search" placeholder="Search pairs" id="q"><ul id="r"></ul>
    <p>Pairs: BTC ETH SOL BTC BTC</p>
    <script>const pairs=['BTC/USDT','ETH/USDT','SOL/USDT'];document.getElementById('q').addEventListener('keydown',e=>{if(e.key!=='Enter')return;
      const hits=pairs.filter(p=>p.includes(e.target.value.toUpperCase()));document.getElementById('r').innerHTML=hits.length?hits.map(h=>'<li><button>'+h+'</button></li>').join(''):'<li role="status">No results</li>';});</script></main>`;
  const local = createServer((_req, res) => {
    res.setHeader('content-type', 'text/html');
    res.end(html);
  });
  await new Promise<void>(resolve => local.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(local.address() as { port: number }).port}/`;
  try {
    const events: CrawlEvent[] = [];
    const crawler = new SampledCrawler({ url, durationMs: 30000, settleMs: 100, log: e => events.push(e) });
    const summary = await crawler.run();
    const fills = events.filter(
      (e): e is Extract<CrawlEvent, { type: 'action' }> => e.type === 'action' && e.step.kind === 'fill',
    );
    expect(fills.map(f => [f.step.purpose, f.step.value])).toEqual(
      expect.arrayContaining([
        ['existing', 'BTC'],
        ['empty', 'zzqx-no-result-7319'],
      ]),
    );
    expect(fills.every(f => f.newState)).toBe(true);
    expect(summary.inputs.kinds).toEqual({ 'search:structure': 1 });
  } finally {
    await new Promise<void>(resolve => local.close(() => resolve()));
  }
}, 120000);

test('a mode group that only redraws a canvas is sampled once; one that switches content is fully explored', async () => {
  const html = `<!doctype html><title>Modes</title><main>
    <div role="tablist" id="range"><div role="tab" aria-selected="true">1h</div><div role="tab" onclick="draw()">1W</div><div role="tab" onclick="draw()">1M</div><div role="tab" onclick="draw()">1Y</div></div>
    <canvas id="chart" width="200" height="80"></canvas>
    <div role="tablist" id="sections"><div role="tab" aria-selected="true" onclick="show('About')">About</div><div role="tab" onclick="show('News')">News</div><div role="tab" onclick="show('Guides')">Guides</div></div>
    <section id="panel"><button>About action</button></section>
    <script>function draw(){const g=document.getElementById('chart').getContext('2d');g.fillRect(Math.random()*150,0,20,80);}
      function show(n){document.getElementById('panel').innerHTML='<button>'+n+' action</button>';}</script></main>`;
  const local = createServer((_req, res) => {
    res.setHeader('content-type', 'text/html');
    res.end(html);
  });
  await new Promise<void>(resolve => local.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(local.address() as { port: number }).port}/`;
  try {
    const events: CrawlEvent[] = [];
    const summary = await new SampledCrawler({ url, durationMs: 30000, settleMs: 100, log: e => events.push(e) }).run();
    const labels = events
      .filter((e): e is Extract<CrawlEvent, { type: 'action' }> => e.type === 'action')
      .map(a => a.step.label);
    expect(labels.filter(l => ['1W', '1M', '1Y'].includes(l))).toHaveLength(1);
    expect(labels).toEqual(expect.arrayContaining(['News', 'Guides', 'News action', 'Guides action']));
    expect(summary.modeGroups.flat).toBe(1);
  } finally {
    await new Promise<void>(resolve => local.close(() => resolve()));
  }
}, 120000);

test('backtracking from a finished page uses browser history instead of replaying from the entry', async () => {
  const pages: Record<string, string> = {
    '/': `<!doctype html><title>Home</title><main><a href="/a">Page A</a><a href="/b">Page B</a></main>`,
    '/a': `<!doctype html><title>A</title><main><button onclick="this.textContent='A done'">A action</button></main>`,
    '/b': `<!doctype html><title>B</title><main><button onclick="this.textContent='B done'">B action</button></main>`,
  };
  const local = createServer((req, res) => {
    res.setHeader('content-type', 'text/html');
    res.end(pages[req.url || '/'] || pages['/']);
  });
  await new Promise<void>(resolve => local.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(local.address() as { port: number }).port}/`;
  try {
    const { defaultPolicy } = await import('@interaction/crawler');
    const policy = defaultPolicy(url);
    policy.allowedPaths.push(/^\/[ab]$/);
    const events: CrawlEvent[] = [];
    const summary = await new SampledCrawler({
      url,
      policy,
      followNavigation: true,
      durationMs: 30000,
      settleMs: 100,
      log: e => events.push(e),
    }).run();
    const labels = events
      .filter((e): e is Extract<CrawlEvent, { type: 'action' }> => e.type === 'action')
      .map(a => a.step.label);
    expect(labels).toEqual(expect.arrayContaining(['Page A', 'A action', 'Page B', 'B action']));
    expect(summary.historyBacks).toBeGreaterThan(0);
  } finally {
    await new Promise<void>(resolve => local.close(() => resolve()));
  }
}, 120000);

test('a covered control fails immediately instead of waiting for a click timeout', async () => {
  const html = `<!doctype html><title>Covered</title><main><button id="b" style="position:absolute;top:10px;left:10px">Hidden behind</button>
    <div style="position:absolute;top:0;left:0;width:300px;height:100px;background:#fff;z-index:2"></div><button style="position:absolute;top:150px">Visible</button></main>`;
  const local = createServer((_req, res) => {
    res.setHeader('content-type', 'text/html');
    res.end(html);
  });
  await new Promise<void>(resolve => local.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(local.address() as { port: number }).port}/`;
  try {
    const events: CrawlEvent[] = [];
    const crawler = new SampledCrawler({ url, durationMs: 30000, settleMs: 100, log: e => events.push(e) });
    // Bypass the capture-time occlusion filter to exercise the dispatch-time check.
    const candidates = crawler.candidates.bind(crawler);
    crawler.candidates = (s, goal) =>
      candidates(
        { ...s, controls: s.controls.map(c => ({ ...c, actionable: { ...c.actionable, occludedBy: undefined } })) },
        goal,
      );
    await crawler.run();
    const covered = events.find(
      (e): e is Extract<CrawlEvent, { type: 'action' }> => e.type === 'action' && e.step.label === 'Hidden behind',
    );
    expect(covered).toMatchObject({ outcome: 'failed' });
    expect(covered!.error).toContain('covered');
    const before = events[events.indexOf(covered!) - 1];
    expect(covered!.at - (before?.at ?? 0)).toBeLessThan(1500);
  } finally {
    await new Promise<void>(resolve => local.close(() => resolve()));
  }
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
    const policy = defaultPolicy(url);
    policy.allowedPaths.push(/^\/(other|scripted|popup|spa-view)$/);
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
    expect(navigations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'document', to: `${url}other` }),
        expect.objectContaining({ kind: 'document', to: `${url}scripted`, action: 'Scripted jump' }),
        expect.objectContaining({ kind: 'popup', action: 'Open popup' }),
        expect.objectContaining({ kind: 'same-document', action: 'SPA route' }),
      ]),
    );
    // An intercepted jump is not a failure, and the page keeps its state.
    expect(actions.find(a => a.step.label === 'Scripted jump')).toMatchObject({
      outcome: expect.not.stringMatching('failed'),
    });
    // The route change is undone when first seen, then re-run only after all other in-page work.
    const labels = actions.map(a => a.step.label);
    const spa = labels.map((l, i) => (l === 'SPA route' ? i : -1)).filter(i => i >= 0);
    expect(spa).toHaveLength(2);
    expect(labels.indexOf('Local action')).toBeLessThan(spa[1]);
    expect(actions[spa[1]].tier).toBe('route');
    expect(summary.navigations.sameDocument.length).toBeGreaterThan(0);
  } finally {
    await new Promise<void>(resolve => local.close(() => resolve()));
  }
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
  const local = createServer((_req, res) => {
    res.setHeader('content-type', 'text/html');
    res.end(html);
  });
  await new Promise<void>(resolve => local.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(local.address() as { port: number }).port}/`;
  try {
    const crawler = new SampledCrawler({ url, durationMs: 30000, settleMs: 100 });
    const pushes: string[][] = [];
    const push = (crawler as unknown as { pushStep(step: { label: string }): void }).pushStep.bind(crawler);
    (crawler as unknown as { pushStep(step: { label: string }): void }).pushStep = step => {
      push(step);
      pushes.push((crawler as unknown as { path: { label: string }[] }).path.map(x => x.label));
    };
    const summary = await crawler.run();
    expect(summary.prunedSteps).toBeGreaterThan(0);
    // After Menu > Close menu the path no longer contains the menu loop.
    const afterClose = pushes.find(p => p.length === 0 || !p.includes('Close menu'));
    expect(afterClose).toBeDefined();
    expect(pushes.some(p => p.includes('Close menu'))).toBe(false);
    // Language > CNY changed the visible currency: that loop stays in the path.
    expect(pushes.some(p => p.includes('CNY'))).toBe(true);
  } finally {
    await new Promise<void>(resolve => local.close(() => resolve()));
  }
}, 120000);

test('a replay leaves out steps that only revealed text and values typed over before the next step', () => {
  const step = (kind: string, label: string, classKey: string, extra: object = {}) =>
    ({ kind, label, classKey, ...extra }) as Parameters<typeof trimReplay>[0][number];
  const steps = [
    step('click', 'Open', 'click|open'),
    step('click', '24h low', 'click|tip', { textOnly: true }),
    step('fill', '0', 'fill|amount|normal'),
    step('fill', '0', 'fill|amount|boundary'),
    step('fill', '0', 'fill|amount|zero'),
    step('click', 'Convert', 'click|convert'),
    step('click', 'Market cap', 'click|tip2', { textOnly: true }),
  ];
  // The last fill is the value the field holds when Convert is clicked; the final step always stays.
  expect(trimReplay(steps).map(s => `${s.label}:${s.classKey}`)).toEqual([
    'Open:click|open',
    '0:fill|amount|zero',
    'Convert:click|convert',
    'Market cap:click|tip2',
  ]);
});

test('a choice the site remembers is undone before a reload, so a replay starts from the same page', async () => {
  // The page shows the currency it finds in a cookie or localStorage; nothing is stored at first.
  const html = `<!doctype html><title>Remember</title><main><p id="cur"></p></main>
    <script>
      const eur = document.cookie.includes('cur=EUR') || localStorage.getItem('cur') === 'EUR' || sessionStorage.getItem('cur') === 'EUR';
      document.getElementById('cur').textContent = eur ? 'EUR' : 'USD';
    </script>`;
  const local = createServer((_req, res) => {
    res.setHeader('content-type', 'text/html');
    res.end(html);
  });
  await new Promise<void>(resolve => local.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(local.address() as { port: number }).port}/`;
  try {
    const crawler = new SampledCrawler({ url, durationMs: 5000, settleMs: 100 });
    const internals = crawler as unknown as {
      page: import('playwright').Page;
      restoreInitialStorage(): Promise<void>;
      choose(): undefined;
    };
    // Stop right after the start, with the page open and the initial storage saved.
    let shown: string[] = [];
    internals.choose = () => undefined;
    const backtrack = (crawler as unknown as { backtrack: () => Promise<boolean> }).backtrack;
    (crawler as unknown as { backtrack: () => Promise<boolean> }).backtrack = async () => {
      const page = internals.page;
      const read = () => page.locator('#cur').textContent();
      shown.push((await read()) ?? '');
      // The site remembers a choice in every place it can.
      await page.evaluate(() => {
        document.cookie = 'cur=EUR;path=/';
        localStorage.setItem('cur', 'EUR');
        sessionStorage.setItem('cur', 'EUR');
      });
      await page.reload();
      shown.push((await read()) ?? '');
      // What a backtrack does before it reloads.
      await internals.restoreInitialStorage();
      await page.reload();
      shown.push((await read()) ?? '');
      return false;
    };
    const summary = await crawler.run();
    void backtrack;
    expect(shown).toEqual(['USD', 'EUR', 'USD']);
    expect(summary.storageRestores).toBe(1);
    shown = [];
  } finally {
    await new Promise<void>(resolve => local.close(() => resolve()));
  }
}, 120000);

test('a target covered on the first try is retried once later, ranked last, in another state', async () => {
  // A banner covers Next whenever the click is aimed at it, until Dismiss removes the banner and
  // shows Done (a new state). The cover is applied in the crawler's own pre-click check.
  const html = `<!doctype html><title>Cover</title><main>
    <button id="next" onclick="document.getElementById('p2').hidden=false">Next</button>
    <p id="p2" hidden>Page two</p>
    <button onclick="window.dismissed=true;document.getElementById('done').hidden=false">Dismiss</button>
    <button id="done" hidden>Done</button></main>`;
  const local = createServer((_req, res) => {
    res.setHeader('content-type', 'text/html');
    res.end(html);
  });
  await new Promise<void>(resolve => local.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(local.address() as { port: number }).port}/`;
  try {
    const events: CrawlEvent[] = [];
    const crawler = new SampledCrawler({ url, durationMs: 30000, settleMs: 100, log: e => events.push(e) });
    // Stand-in for a cover that arrives between capture and click: Next is covered until dismissed.
    const internals = crawler as unknown as {
      ensureActionable(c: { name: string }): Promise<void>;
      page: { evaluate(f: string): Promise<unknown> };
    };
    const check = internals.ensureActionable.bind(crawler);
    internals.ensureActionable = async c => {
      if (c.name === 'Next' && !(await internals.page.evaluate('window.dismissed')))
        throw new Error('Target not actionable: covered by div.banner');
      return check(c);
    };
    await crawler.run();
    const actions = events.filter((e): e is Extract<CrawlEvent, { type: 'action' }> => e.type === 'action');
    const next = actions.filter(a => a.step.label === 'Next');
    expect(next.map(a => [a.outcome, !!a.step.retry])).toEqual([
      ['failed', false],
      ['ok', true],
    ]);
    // The retry waited for the rest of its state: Done was tried before Next came back.
    const order = actions.map(a => a.step.label);
    expect(order.indexOf('Done')).toBeLessThan(order.lastIndexOf('Next'));
    // Retried once: a second cover would have been final.
    expect(next).toHaveLength(2);
  } finally {
    await new Promise<void>(resolve => local.close(() => resolve()));
  }
}, 120000);

test('text the page shows by itself while an action runs is not credited to the action', async () => {
  // Clicking the checkbox does nothing visible; a chart finishes loading at the same moment.
  const html = `<!doctype html><title>Load</title><main>
    <label><input type="checkbox" onclick="setTimeout(()=>document.getElementById('c').textContent='USD/BTC close: 0.0000121 BTC',50)">Don't show for 7 days</label>
    <p id="c">USD/BTC close: --</p></main>`;
  const local = createServer((_req, res) => {
    res.setHeader('content-type', 'text/html');
    res.end(html);
  });
  await new Promise<void>(resolve => local.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(local.address() as { port: number }).port}/`;
  const crawl = async (effect: Record<'yes' | 'no' | 'unrelated', number>) => {
    const events: CrawlEvent[] = [];
    await new SampledCrawler({
      url,
      durationMs: 30000,
      settleMs: 200,
      judge: new ModelJudge({ jev: fakeJev(() => 0.9, effect) }),
      log: e => events.push(e),
    }).run();
    const check = events.find(
      (e): e is Extract<CrawlEvent, { type: 'action' }> => e.type === 'action' && /show for 7 days/.test(e.step.label),
    );
    const judged = events.find(
      (e): e is Extract<CrawlEvent, { type: 'judgement' }> => e.type === 'judgement' && e.question === 'effect',
    );
    return { check, judged };
  };
  try {
    // JEV is sure the text is unrelated to the click: no new state.
    const unrelated = await crawl({ yes: 0.1, no: 0.02, unrelated: 0.88 });
    expect(unrelated.judged).toMatchObject({ verdict: 'no', unrelated: 0.88 });
    expect(unrelated.check).toMatchObject({ outcome: 'no_change', newState: false });
    // A close call between yes and unrelated keeps the text: real content is never dropped on a guess.
    const close = await crawl({ yes: 0.5, no: 0.07, unrelated: 0.43 });
    expect(close.judged?.verdict).toBe('yes');
    expect(close.check).toMatchObject({ outcome: 'ok', newState: true });
  } finally {
    await new Promise<void>(resolve => local.close(() => resolve()));
  }
}, 120000);

test('a state an action revealed as text gets a screenshot, and each action says where its target was', async () => {
  const html = `<!doctype html><title>Tip</title><main>
    <div style="height:900px">Intro</div>
    <button onclick="document.getElementById('t').hidden=false">24h low</button>
    <p id="t" hidden>The lowest price in 24 hours</p></main>`;
  const local = createServer((_req, res) => {
    res.setHeader('content-type', 'text/html');
    res.end(html);
  });
  await new Promise<void>(resolve => local.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(local.address() as { port: number }).port}/`;
  try {
    const events: CrawlEvent[] = [];
    const shots = new Map<string, Buffer>();
    await new SampledCrawler({
      url,
      viewport: { width: 800, height: 600 },
      durationMs: 30000,
      settleMs: 100,
      log: e => events.push(e),
      onScreenshot: (state, image) => void shots.set(state, image),
    }).run();
    const states = events.filter((e): e is Extract<CrawlEvent, { type: 'state' }> => e.type === 'state');
    const tip = events.find(
      (e): e is Extract<CrawlEvent, { type: 'action' }> => e.type === 'action' && e.step.label === '24h low',
    );
    // The tooltip is a state of its own, announced with a screenshot like any other.
    const revealed = states.find(s => s.state.key.includes('|content:'));
    expect(revealed).toBeDefined();
    expect(shots.has(revealed!.state.key)).toBe(true);
    // Screenshots are WebP.
    expect(shots.get(revealed!.state.key)!.subarray(8, 12).toString('latin1')).toBe('WEBP');
    // The button sat below the fold: it was scrolled to before the click, and both positions are kept.
    expect(tip?.target?.scroll.y).toBeGreaterThan(0);
    expect(tip?.target?.box.width).toBeGreaterThan(0);
    // The page's own screenshot is from the top, where the button is not visible: the moment of the
    // click was captured as well, so the button can be shown.
    expect(tip?.shot).toBeDefined();
    expect(shots.has(tip!.shot!)).toBe(true);
    expect(revealed!.view?.viewport).toEqual({ width: 800, height: 600 });
  } finally {
    await new Promise<void>(resolve => local.close(() => resolve()));
  }
}, 120000);

test('a tooltip revealed inside its trigger is a new state, and the trigger is not taken for a new control', async () => {
  const html = `<!doctype html><title>Tips</title><main>
    <div style="cursor:pointer" onclick="this.querySelector('span').hidden=false">24h low<span hidden>The lowest price in 24 hours</span></div>
    <div style="cursor:pointer" onclick="this.querySelector('span').hidden=false">All-time high<span hidden>Data is collected from platforms</span></div>
    <button>Plain</button></main>`;
  const local = createServer((_req, res) => {
    res.setHeader('content-type', 'text/html');
    res.end(html);
  });
  await new Promise<void>(resolve => local.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(local.address() as { port: number }).port}/`;
  try {
    const { ModelJudge } = await import('@interaction/crawler');
    // Weak triggers are uncertain to JEV, so they are tried; revealed text counts as new content.
    const jev = fakeJev(() => 0.5);
    const events: CrawlEvent[] = [];
    await new SampledCrawler({
      url,
      durationMs: 30000,
      settleMs: 100,
      judge: new ModelJudge({ jev }),
      log: e => events.push(e),
    }).run();
    const actions = events.filter((e): e is Extract<CrawlEvent, { type: 'action' }> => e.type === 'action');
    const tips = actions.filter(a => /24h low|All-time high/.test(a.step.label));
    expect(tips.map(a => a.step.label)).toEqual(['24h low', 'All-time high']);
    expect(tips.every(a => a.newState)).toBe(true);
  } finally {
    await new Promise<void>(resolve => local.close(() => resolve()));
  }
}, 120000);

test('a list of different functions is split and each member sampled; a list of records stays merged', async () => {
  const links = (items: string[]) =>
    items
      .map(
        n => `<li><a href="#" onclick="document.getElementById('out').textContent='${n}';return false">${n}</a></li>`,
      )
      .join('');
  const html = `<!doctype html><title>Lists</title><main>
    <ul>${links(['Official website', 'White paper', 'Github', 'Block explorer'])}</ul>
    <ul>${links(['BTC to PKR', 'BTC to EUR', 'BTC to CNY', 'BTC to VND', 'BTC to TRY'])}</ul>
    <p id="out"></p></main>`;
  const local = createServer((_req, res) => {
    res.setHeader('content-type', 'text/html');
    res.end(html);
  });
  await new Promise<void>(resolve => local.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(local.address() as { port: number }).port}/`;
  try {
    const { ModelJudge } = await import('@interaction/crawler');
    const asked: string[][] = [];
    const jev = fakeJev(q => {
      if (q.kind !== 'same-kind') return 0.9;
      asked.push(q.members!);
      return q.members!.includes('Github') ? 0.05 : 0.95;
    });
    const events: CrawlEvent[] = [];
    const summary = await new SampledCrawler({
      url,
      durationMs: 30000,
      settleMs: 100,
      judge: new ModelJudge({ jev }),
      log: e => events.push(e),
    }).run();
    const labels = events
      .filter((e): e is Extract<CrawlEvent, { type: 'action' }> => e.type === 'action')
      .map(a => a.step.label);
    // The pair list shares words, so it is never asked about.
    expect(asked).toHaveLength(1);
    expect(summary.splitLists).toBe(1);
    expect(labels).toEqual(expect.arrayContaining(['Official website', 'White paper', 'Github', 'Block explorer']));
    expect(labels.filter(l => l.startsWith('BTC to')).length).toBeLessThanOrEqual(2);
  } finally {
    await new Promise<void>(resolve => local.close(() => resolve()));
  }
}, 120000);

test('a control the user cannot see is not clicked; once a button reveals it, it is tested', async () => {
  // Like OKX's header: the real search input sits in a transparent zero-size wrapper, parked
  // off the page, until its button opens it. A skip button is clipped to nothing until focused,
  // and a screen-reader-only close label sits in a 1px clipping box.
  const html = `<!doctype html><title>Hidden search</title><main>
    <button style="position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0,0,0,0)">Skip to main content</button>
    <button onclick="document.getElementById('wrap').style.cssText='';document.getElementById('q').style.cssText=''">Open search</button>
    <div id="wrap" style="opacity:0;width:0;height:0;overflow:hidden"><input id="q" placeholder="Search coins" style="position:absolute;left:-9999px;top:-9999px"></div>
    <span style="position:absolute;width:1px;height:1px;overflow:hidden"><span role="button" tabindex="0" onclick="">Close</span></span>
    <section><button>Plain action</button></section></main>`;
  const local = createServer((_req, res) => {
    res.setHeader('content-type', 'text/html');
    res.end(html);
  });
  await new Promise<void>(resolve => local.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(local.address() as { port: number }).port}/`;
  try {
    const driver = new BrowserDriver({ url });
    await driver.start();
    const visible = async () => (await driver.readDOM()).controls.filter(c => c.visible).map(c => c.name);
    expect(await visible()).toEqual(['Open search', 'Plain action']);
    await driver.page!.getByText('Open search').click();
    expect(await visible()).toEqual(['Open search', 'Search coins', 'Plain action']);
    await driver.close();

    const events: CrawlEvent[] = [];
    await new SampledCrawler({ url, durationMs: 30000, settleMs: 100, log: e => events.push(e) }).run();
    const actions = events.filter((e): e is Extract<CrawlEvent, { type: 'action' }> => e.type === 'action');
    expect(actions.filter(a => a.outcome === 'failed')).toEqual([]);
    expect(actions.some(a => a.step.label === 'Skip to main content')).toBe(false);
    const open = actions.findIndex(a => a.step.label === 'Open search');
    const fills = actions.filter(a => a.step.kind === 'fill');
    expect(open).toBeGreaterThanOrEqual(0);
    expect(fills.length).toBeGreaterThan(0);
    expect(actions.indexOf(fills[0])).toBeGreaterThan(open);
  } finally {
    await new Promise<void>(resolve => local.close(() => resolve()));
  }
}, 120000);

const serve = async (html: string) => {
  const local = createServer((_req, res) => {
    res.setHeader('content-type', 'text/html');
    res.end(html);
  });
  await new Promise<void>(resolve => local.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${(local.address() as { port: number }).port}/`,
    close: () => new Promise<void>(resolve => local.close(() => resolve())),
  };
};
const actionsOf = (events: CrawlEvent[]) =>
  events.filter((e): e is Extract<CrawlEvent, { type: 'action' }> => e.type === 'action');

test('an unnamed info icon is hovered to reveal its tooltip; many alike icons are tried once', async () => {
  const icons = Array.from(
    { length: 20 },
    (_, i) =>
      `<li>Row ${i} <i class="icon icon-copy" style="display:inline-block;width:12px;height:12px;cursor:pointer"></i></li>`,
  ).join('');
  const site = await serve(`<!doctype html><title>Icons</title><main>
    <p>1 USD = 0.00001 BTC <i class="icon icon-info" style="display:inline-block;width:12px;height:12px;cursor:pointer"
      onmouseenter="document.getElementById('tip').hidden=false" onmouseleave="document.getElementById('tip').hidden=true"></i></p>
    <div id="tip" hidden>Last updated just now</div><ul>${icons}</ul></main>`);
  try {
    const events: CrawlEvent[] = [];
    await new SampledCrawler({ url: site.url, durationMs: 30000, settleMs: 100, log: e => events.push(e) }).run();
    const hovers = actionsOf(events).filter(a => a.step.kind === 'hover');
    expect(hovers.filter(a => a.step.classKey.includes('icon-info'))).toEqual([
      expect.objectContaining({ outcome: 'ok', newState: true }),
    ]);
    // Twenty copy icons in a list: one kind, so only a sample is hovered, never all of them.
    expect(hovers.filter(a => a.step.classKey.includes('icon-copy')).length).toBeLessThanOrEqual(2);
    expect(hovers.length).toBeLessThanOrEqual(3);
  } finally {
    await site.close();
  }
}, 120000);

test('two amount fields with the same placeholder are both filled; one field per list row is sampled', async () => {
  const rows = Array.from(
    { length: 8 },
    (_, i) =>
      `<li><span>Item ${i}</span><input placeholder="Qty" oninput="document.getElementById('total').textContent='changed ${i}'"></li>`,
  ).join('');
  const site = await serve(`<!doctype html><title>Fields</title><main>
    <div><button>USD</button><input id="from" placeholder="0"></div>
    <div><button>BTC</button><input id="to" placeholder="0"></div>
    <ul>${rows}</ul><p id="total"></p></main>`);
  try {
    const events: CrawlEvent[] = [];
    await new SampledCrawler({ url: site.url, durationMs: 60000, settleMs: 100, log: e => events.push(e) }).run();
    const fills = actionsOf(events).filter(a => a.step.kind === 'fill');
    const amount = new Set(fills.filter(a => a.step.label === '0').map(a => a.step.classKey.replace(/\|[^|]*$/, '')));
    expect(amount.size).toBe(2);
    const qtyRows = new Set(
      fills.filter(a => a.step.label === 'Qty').map(a => a.step.classKey.replace(/\|[^|]*$/, '')),
    );
    expect(qtyRows.size).toBeLessThanOrEqual(2);
  } finally {
    await site.close();
  }
}, 120000);

test('a mobile sheet with no dialog semantics or backdrop is an overlay: its content first, the page beneath never', async () => {
  // A fixed bottom bar and a floating help button stay on the page; the help button opens a
  // full-screen sheet after a delay (an API call), a plain fixed div with nothing saying "dialog".
  const site = await serve(`<!doctype html><title>Download</title><main style="padding-bottom:80px">
    ${Array.from({ length: 6 }, (_, i) => `<p><button onclick="this.textContent='Picked ${i}'">Platform ${i}</button></p>`).join('')}
  </main>
  <nav style="position:fixed;left:0;right:0;bottom:0;height:56px;background:#fff"><button>Home</button><button>Markets</button></nav>
  <button id="help" style="position:fixed;right:12px;bottom:70px" onclick="setTimeout(()=>document.getElementById('sheet').style.display='block',300)">Help</button>
  <div id="sheet" style="display:none;position:fixed;inset:0;background:#fff;z-index:10">
    <p>How can we help?</p><button onclick="document.getElementById('topic').hidden=false">Deposits</button>
    <p id="topic" hidden>Deposit answers</p>
    <button onclick="document.getElementById('sheet').style.display='none'">Close</button>
  </div>`);
  try {
    const events: CrawlEvent[] = [];
    await new SampledCrawler({
      url: site.url,
      durationMs: 30000,
      settleMs: 500,
      viewport: 'mobile',
      log: e => events.push(e),
    }).run();
    const actions = actionsOf(events);
    const deposits = actions.find(a => a.step.label === 'Deposits');
    expect(deposits).toMatchObject({ outcome: 'ok' });
    expect(deposits!.overlay).toMatch(/^modal:/);
    // Nothing was clicked through the sheet while it was open.
    expect(actions.filter(a => a.outcome === 'failed')).toEqual([]);
    // The bottom bar and the help button are page chrome, not overlays.
    const help = actions.find(a => a.step.label === 'Help');
    expect(help?.overlay).toBeUndefined();
  } finally {
    await site.close();
  }
}, 120000);

test('an action that shows it is loading is waited for; a pulse already running on the page is not', async () => {
  // The price pulses forever from the start. The help button disables itself and shows a
  // spinner while "the API" answers, then opens its sheet well after the settle time.
  const site = await serve(`<!doctype html><title>Loading</title>
  <style>@keyframes spin{to{transform:rotate(360deg)}}@keyframes pulse{50%{opacity:.5}}</style>
  <main><p style="animation:pulse 1s infinite">BTC 60,000</p>
    <button id="help" onclick="load()">Help</button><span id="spinner" hidden style="display:inline-block;width:10px;height:10px;animation:spin 1s linear infinite"></span>
    <button onclick="this.textContent='Other done'">Other</button>
  </main>
  <div id="panel" hidden><p>Support topics</p><button onclick="this.textContent='Opened'">Topic</button></div>
  <script>function load(){const b=document.getElementById('help'),s=document.getElementById('spinner');b.disabled=true;s.hidden=false;
    setTimeout(()=>{s.hidden=true;b.disabled=false;document.getElementById('panel').hidden=false},1200);}</script>`);
  try {
    const events: CrawlEvent[] = [];
    await new SampledCrawler({ url: site.url, durationMs: 30000, settleMs: 300, log: e => events.push(e) }).run();
    const actions = actionsOf(events);
    const help = actions.find(a => a.step.label === 'Help');
    expect(help).toMatchObject({ outcome: 'ok', newState: true });
    expect(help!.busyMs).toBeGreaterThan(500);
    // Actions with no loading sign keep the plain settle: the pulse does not count.
    expect(actions.filter(a => a.busyMs).map(a => a.step.label)).toEqual(['Help']);
  } finally {
    await site.close();
  }
}, 120000);
