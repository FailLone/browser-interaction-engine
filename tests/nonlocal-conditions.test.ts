import { createServer } from 'node:http';
import { expect, it } from 'vitest';
import { BrowserEngine } from '@interaction/browser';
import { MemoryStore } from '@interaction/storage-memory';
import { ExplorerPlugin, ExplorerStore } from '@interaction/explorer-plugin';
import { browserBranchConditions } from '../packages/adapter-playwright/src/branch-conditions.js';
import { browserOperationKey, controlCase } from '../packages/adapter-playwright/src/exploration.js';
import { fakeProviders } from './explorer-plugin-helpers.js';
import { pageOf } from './helpers.js';

const options = { headless: true, exploration: 'controls', settleMs: 0, observeTimeoutMs: 1000,
  regionExploration: 'off', pageExploration: 'all', listExploration: 'all', interfaceActions: [{ kind: 'click' }] };

async function fixture(html: string) {
  // The page emits the branch actually invoked; coverage/queue claims are not
  // the oracle. Every test owns this server, memory stores and browser session.
  const events: string[] = [];
  const server = createServer((req, res) => {
    if (req.url?.startsWith('/oracle?')) {
      events.push(new URL(req.url, 'http://fixture').searchParams.get('branch')!);
      res.writeHead(204); res.end(); return;
    }
    res.setHeader('Content-Type', 'text/html');
    res.end(`<!doctype html><html><head><title>Observed cross-region modes</title></head><body>${html}
      <script>function record(branch){const x=new XMLHttpRequest();x.open('POST','/oracle?branch='+encodeURIComponent(branch),false);x.send();}</script></body></html>`);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;
  const host = new BrowserEngine({ persistence: new MemoryStore() }), providers = fakeProviders(url);
  const plugin = new ExplorerPlugin(host, new ExplorerStore(':memory:'), providers);
  return { url, host, plugin, providers, events, close: async () => {
    await plugin.close(); await host.close(); await new Promise<void>(resolve => server.close(() => resolve()));
  } };
}

for (const partition of ['forms', 'regions'] as const) for (const hidden of [false, true]) {
  it(`public exploration observes A and B once across ${partition}, with the mode ${hidden ? 'hidden' : 'visible'}`, async () => {
    const mode = `<label>Mode<select id="mode" ${hidden ? 'hidden' : ''}><option value="A">A</option><option value="B">B</option></select></label>`;
    const run = `<button id="run" type="button" onclick="const m=document.querySelector('#mode');record(m.value);m.value=m.value==='A'?'B':'A'">Run</button>`;
    const f = await fixture(partition === 'forms'
      ? `<form id="settings">${mode}</form><form id="commands">${run}</form>`
      : `<main><section aria-label="Settings">${mode}</section><section aria-label="Commands">${run}</section></main>`);
    try {
      const task = f.plugin.create({ url: f.url, budget: { rounds: 1, actions: 8 },
        sessionOptions: { headless: true, settleMs: 0, observeTimeoutMs: 1000 } });
      f.plugin.revise(task.id, { items: [{ title: 'Encountered click modes', scope: { url: f.url, kind: 'click' },
        prerequisites: [], completion: 'Observe encountered modes', required: true, reason: 'Fixture scope' }] });
      f.plugin.start(task.id); await f.plugin.waitForIdle(task.id);
      const done = f.plugin.store.task(task.id), sid = done.rounds.at(-1)!.sessionId!;
      expect(f.events, JSON.stringify({ status: done.status, reason: done.reason, calls: f.providers.calls.map(c => c.purpose),
        mode: await pageOf(f.host).locator('#mode').inputValue(), plan: done.plan.map(i => ({ scope: i.scope, status: i.status, reason: i.reason })) })).toEqual(['A', 'B']);
      expect(done.status).toBe('completed');
      expect(f.host.list(sid, 'attempt')).toHaveLength(2);
      expect(await pageOf(f.host).locator('#mode').inputValue()).toBe('A');
      const modeControl = f.host.observation(sid).controls.find(c => c.stableKey === 'id:mode')!;
      expect(modeControl.visible).toBe(!hidden);
      expect(f.providers.calls).toEqual([]);
    } finally { await f.close(); }
  });
}

it('keeps cross-form source samples finite across A/B/A, hidden mode changes, price ticks and unrelated text fills', async () => {
  const f = await fixture(`<form id="settings"><select id="mode" aria-label="Mode" hidden><option value="A">A</option><option value="B">B</option></select></form>
    <form id="commands"><input id="first" aria-label="First"><input id="second" aria-label="Second"><button id="run" type="button" onclick="record(document.querySelector('#mode').value)">Run</button></form>
    <input id="quote" aria-label="Price" readonly value="100">`);
  try {
    const session = await f.host.createSession({ ...options, url: f.url }), sid = session.id, page = pageOf(f.host);
    const action = (id: string, kind = 'click') => {
      const c = f.host.observation(sid).controls.find(c => c.stableKey === `id:${id}`)!;
      return f.host.actions(sid).find(a => a.localId === c.localId && a.kind === kind)!;
    };
    const source = f.host.observation(sid), initial = action('run'), key = browserOperationKey(initial, source);
    const fillKeys = ['first', 'second'].map(id => browserOperationKey(action(id, 'fill'), source));
    const attempt = await f.host.execute(sid, initial.id, 'mode-a');
    await f.host.execute(sid, action('first', 'fill').id, 'first-input', 'first sample');
    await f.host.execute(sid, action('second', 'fill').id, 'second-input', 'second sample');
    const filled = f.host.observation(sid);
    expect(['first', 'second'].map(id => browserOperationKey(action(id, 'fill'), filled))).toEqual(fillKeys);
    expect(browserOperationKey(action('run'), filled)).toBe(key);
    await page.evaluate(() => { (document.querySelector('#mode') as HTMLSelectElement).value = 'B'; });
    const changed = await f.host.observe(sid), current = action('run');
    expect(f.host.operationCorrespondence(sid, { observationId: changed.id, actionId: current.id,
      source: { sessionId: sid, attemptId: attempt.id } })).toMatchObject({ equivalent: false, reason: 'operation_conditions_changed' });
    expect(browserOperationKey(current, changed)).not.toBe(key);
    await f.host.execute(sid, current.id, 'mode-b');
    await page.evaluate(() => { (document.querySelector('#mode') as HTMLSelectElement).value = 'A'; });
    const returned = await f.host.observe(sid);
    expect(browserOperationKey(action('run'), returned)).toBe(key);
    expect(f.host.operationCorrespondence(sid, { observationId: returned.id, actionId: action('run').id,
      source: { sessionId: sid, attemptId: attempt.id } }).equivalent).toBe(true);
    const priceKeys = new Set<string>();
    for (let n = 1; n <= 12; n++) {
      await page.evaluate(n => { (document.querySelector('#quote') as HTMLInputElement).value = String(100 + n); }, n);
      const observed = await f.host.observe(sid); priceKeys.add(browserOperationKey(action('run'), observed));
    }
    expect(priceKeys).toEqual(new Set([key]));
    expect(f.events).toEqual(['A', 'B']);
  } finally { await f.close(); }
});

it('refuses coverage from missing hidden selector state without creating a retry key per price tick', async () => {
  const f = await fixture(`<section aria-label="Remote"><button id="mode" role="option" hidden>Mode</button></section>
    <section aria-label="Commands"><button id="run" type="button" onclick="record('run')">Run</button></section><output id="quote">100</output>`);
  try {
    const session = await f.host.createSession({ ...options, url: f.url }), sid = session.id;
    const action = () => f.host.actions(sid).find(a => a.label === 'Run' && a.kind === 'click')!;
    const before = f.host.observation(sid), first = action(), key = browserOperationKey(first, before);
    expect(browserBranchConditions(first, before)).toBeUndefined();
    expect(controlCase(first, before, true)).toBeUndefined();
    const attempt = await f.host.execute(sid, first.id, 'uncertain-mode');
    await pageOf(f.host).evaluate(() => { document.querySelector('#quote')!.textContent = '101'; });
    const after = await f.host.observe(sid), next = action();
    expect(browserOperationKey(next, after)).toBe(key);
    expect(f.host.operationCorrespondence(sid, { observationId: after.id, actionId: next.id,
      source: { sessionId: sid, attemptId: attempt.id } })).toMatchObject({ equivalent: false, reason: 'operation_conditions_unavailable', replayAuthorized: false, currentExecution: false });
    expect(f.events).toEqual(['run']);
  } finally { await f.close(); }
});
