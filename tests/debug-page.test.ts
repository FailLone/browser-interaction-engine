import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { CrawlManager, CrawlStore, type Provider } from '@interaction/crawler';
import { DebugView, stateId } from '../apps/server/src/debug-view.js';
import { ModelCallLog } from '../apps/server/src/model-calls.js';
import { createServer } from '../apps/server/src/server.js';
import {
  actionBefore,
  buildActionTree,
  callTarget,
  markIn,
  modelSteps,
  pathTo,
  stateFindings,
} from '../apps/ui/src/debug/tree.js';
import type { Event } from '../apps/ui/src/debug/types.js';

let seq = 0;
const action = (label: string, state: string, extra: Partial<Extract<Event, { type: 'action' }>> = {}): Event => ({
  seq: ++seq,
  type: 'action',
  at: seq * 100,
  step: { kind: 'click', classKey: label, label, state },
  url: 'https://a.test/',
  tier: 'body',
  outcome: 'ok',
  newState: true,
  ...extra,
});
const backtrack = (): Event => ({ seq: ++seq, type: 'backtrack', at: seq * 100, reason: 'state_exhausted' });
const stateEvent = (key: string): Event => ({
  seq: ++seq,
  type: 'state',
  at: seq * 100,
  state: { key, url: 'https://a.test/', controls: 3 },
});

test('the action tree follows a walk to its end and branches where a backtrack lands', () => {
  seq = 0;
  const events: Event[] = [
    stateEvent('home'),
    action('Open menu', 'home'),
    stateEvent('menu'),
    action('Settings', 'menu'),
    stateEvent('settings'),
    action('Save', 'settings', { outcome: 'no_change', newState: false }),
    backtrack(),
    // Replayed back to the menu; the walk continues from there.
    action('Help', 'menu'),
    stateEvent('help'),
    action('Close', 'help', { newState: false }),
    // Closing returned to the entry page, which is already on the tree.
    action('Search', 'home'),
  ];
  const tree = buildActionTree(events);
  const label = (n: { event: { step: { label: string } } }) => n.event.step.label;
  expect(tree.root.state).toBe('home');
  expect(tree.root.children.map(label)).toEqual(['Open menu', 'Search']);
  const menu = tree.root.children[0];
  expect(menu.children.map(label)).toEqual(['Settings', 'Help']);
  expect(menu.children[0].children.map(label)).toEqual(['Save']);
  expect(menu.children[0].children[0].backtracks).toHaveLength(1);
  const close = menu.children[1].children[0];
  expect(label(close)).toBe('Close');
  expect(close.returned).toBe(true);
  expect(close.returnedTo).toBe('entry');
  // After the walk ended at Save, it went on from the state Open menu reached.
  expect(menu.children[0].children[0].resumedAt).toBe(menu);
  expect(pathTo(close).map(label)).toEqual(['Open menu', 'Help', 'Close']);
  // Screenshots taken right after an action belong to it; Close led to a state seen before, so none.
  expect(tree.shotAfter.get(menu.event.seq)).toBe('menu');
  expect(tree.shotAfter.get(menu.children[1].event.seq)).toBe('help');
  expect(tree.shotAfter.has(close.event.seq)).toBe(false);

  expect(tree.actions.map(n => n.index)).toEqual([1, 2, 3, 4, 5, 6]);
  // Links read from hrefs before an action are not navigations it set off.
  const nav = (action: string): Event => ({
    seq: ++seq,
    type: 'navigation',
    at: seq * 100,
    kind: 'document',
    to: `https://a.test/${action}`,
    action,
    outcome: 'intercepted',
  });
  const withLinks = buildActionTree([
    stateEvent('p'),
    nav('BTC to ZAR'),
    nav('BTC to QAR'),
    nav('Go'),
    action('Go', 'p'),
  ]);
  expect(withLinks.actions[0].triggered.map(n => n.action)).toEqual(['Go']);
  expect(withLinks.actions[0].linksSeen).toHaveLength(2);
  // A finding after "Help" was checked on the state Help reached.
  expect(label(actionBefore(tree, close.event.seq - 1)!)).toBe('Help');
});

test('the operated control is outlined only on a screenshot taken where the action happened', () => {
  const view = (y: number) => ({ scroll: { x: 0, y }, viewport: { width: 1280, height: 800 } });
  const target = { ...view(272), box: { x: 1047, y: 149, width: 144, height: 24 } };
  expect(markIn(target, view(272))?.box).toEqual(target.box);
  // Taken at another scroll position: sticky parts of a page do not move with it, so no outline.
  expect(markIn(target, view(0))).toBeUndefined();
  // Without a recorded scroll position the mark cannot be placed.
  expect(markIn(target, undefined)).toBeUndefined();
});

test('model calls are recorded per run with reason, input, output, cost and time, and served on demand', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'debug-'));
  const jev: Provider = {
    name: 'jev',
    model: 'jev-1',
    async decide(request) {
      const checks = Object.keys(request.checks ?? {});
      return {
        value: Object.fromEntries(checks.map(k => [k, 0.9])),
        model: 'jev-1',
        usage: { input_tokens: 120, output_tokens: 4, cost: 0.00002 },
      };
    },
  };
  const log = new ModelCallLog(join(dir, 'model-calls.sqlite'));
  const crawls = new CrawlManager(new CrawlStore(join(dir, 'crawls.sqlite')), log.wrap({ jev }));
  const app = await createServer(crawls, { modelCalls: log });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const api = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  const json = async (path: string) => (await fetch(`${api}${path}`)).json();
  try {
    // A call made inside a tracked start is attributed to that run; untracked calls are not recorded.
    const provider = log.wrap({ jev }).jev!;
    const run = log.track(() => {
      const created = crawls.store.createRun(crypto.randomUUID(), 'https://a.test/', {});
      void provider.decide(
        {
          id: '1',
          purpose: 'crawler-interactive',
          kind: 'checklist',
          instructions: '',
          state: {
            item0: { kind: 'interactive', control: { name: 'More', tag: 'div' } },
            item1: { kind: 'same-kind', role: 'link', members: ['BTC', 'ETH'] },
          },
          checks: { item0: { instructions: 'Is it clickable?' }, item1: { instructions: 'Same kind?' } },
        },
        AbortSignal.timeout(1000),
      );
      return created;
    });
    await provider.decide(
      { id: '2', purpose: 'x', kind: 'noul', instructions: '', state: {} },
      AbortSignal.timeout(1000),
    );
    await new Promise(r => setTimeout(r, 50));

    const list = await json(`/v1/crawls/${run.id}/debug/model-calls`);
    expect(list.recorded).toBe(true);
    expect(list.calls).toHaveLength(1);
    expect(list.calls[0]).toMatchObject({
      provider: 'jev',
      model: 'jev-1',
      purpose: 'crawler-interactive+same-kind',
      items: 2,
      subject: 'More；BTC / ETH',
      costUsd: 0.00002,
      inputTokens: 120,
    });
    // The list stays light; input and output come with the single call.
    expect(list.calls[0].request).toBeUndefined();
    const detail = await json(`/v1/crawls/${run.id}/debug/model-calls/${list.calls[0].id}`);
    expect(detail.request.state.item0.control.name).toBe('More');
    expect(detail.answer.value).toEqual({ item0: 0.9, item1: 0.9 });
  } finally {
    await app.close();
    await crawls.close();
    log.close();
  }
});

test('debug events leave out page signatures and finding facts, which load by sequence number', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'debug-'));
  const store = new CrawlStore(join(dir, 'crawls.sqlite'));
  const crawls = new CrawlManager(store);
  const app = await createServer(crawls);
  await app.listen({ host: '127.0.0.1', port: 0 });
  const api = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  const json = async (path: string) => (await fetch(`${api}${path}`)).json();
  try {
    const run = store.createRun(crypto.randomUUID(), 'https://a.test/', {});
    const key = JSON.stringify(['https://a.test/', '', Array.from({ length: 200 }, (_, i) => `control ${i}`)]);
    store.appendEvent(run.id, {
      type: 'state',
      at: 1,
      state: { key, url: 'https://a.test/', firstSeenAt: 1, controls: 200 },
      path: 0,
    });
    store.saveScreenshot(run.id, key, Buffer.from('RIFF\0\0\0\0WEBPVP8 ', 'latin1'));
    store.appendEvent(run.id, {
      type: 'action',
      at: 2,
      step: { kind: 'click', classKey: 'c', label: 'Open', state: key, sigBefore: 'x'.repeat(20000), sigAfter: 'y' },
      url: 'https://a.test/',
      tier: 'body',
      outcome: 'ok',
      newState: true,
      after: '/',
    });
    store.appendEvent(run.id, {
      type: 'finding',
      at: 3,
      plugin: 'rules',
      state: key,
      url: 'https://a.test/',
      finding: {
        rule: 'clip',
        severity: 'warning',
        selector: '#a',
        text: 'A',
        detail: 'clipped',
        facts: { big: 'z'.repeat(50000) },
      },
    });
    const events = await json(`/v1/crawls/${run.id}/debug/events`);
    expect(JSON.stringify(events).length).toBeLessThan(2000);
    expect(events[0].state.key).toBe(stateId(key));
    expect(events[1].step).toMatchObject({ label: 'Open', state: stateId(key) });
    expect(events[1].step.sigBefore).toBeUndefined();
    expect(events[2].finding).toMatchObject({ rule: 'clip', hasFacts: true });
    expect((await json(`/v1/crawls/${run.id}/debug/events/3`)).finding.facts.big).toHaveLength(50000);
    const shot = await fetch(`${api}/v1/crawls/${run.id}/debug/screenshot/${stateId(key)}`);
    expect(shot.headers.get('content-type')).toBe('image/webp');
    // Without a call log, the page is told calls were not recorded rather than shown none.
    expect(await json(`/v1/crawls/${run.id}/debug/model-calls`)).toEqual({ recorded: false, calls: [] });
  } finally {
    await app.close();
    await crawls.close();
  }
});

test('model calls past the retention window are deleted', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'debug-'));
  const log = new ModelCallLog(join(dir, 'model-calls.sqlite'), { retentionDays: 7 });
  const jev: Provider = { name: 'jev', model: 'j', decide: async () => ({ value: true, model: 'j' }) };
  const provider = log.wrap({ jev }).jev as Provider;
  try {
    log.track(() => {
      void provider.decide(
        { id: '1', purpose: 'p', kind: 'noul', instructions: '', state: {} },
        AbortSignal.timeout(1000),
      );
      return { id: 'run' };
    });
    await new Promise(r => setTimeout(r, 20));
    expect(log.prune(Date.now() + 6 * 86_400_000)).toBe(0);
    expect(log.calls('run')).toHaveLength(1);
    expect(log.prune(Date.now() + 8 * 86_400_000)).toBe(1);
    expect(log.calls('run')).toHaveLength(0);
  } finally {
    log.close();
  }
});

test('state ids are kept for the most recently viewed runs and rebuilt for others', () => {
  const dir = mkdtempSync(join(tmpdir(), 'debug-'));
  const store = new CrawlStore(join(dir, 'crawls.sqlite'));
  const view = new DebugView(store, 2);
  try {
    const runs = ['a', 'b', 'c'].map(name => {
      const run = store.createRun(crypto.randomUUID(), 'https://a.test/', {});
      store.appendEvent(run.id, {
        type: 'state',
        at: 1,
        state: { key: `key-${name}`, url: 'https://a.test/', firstSeenAt: 1, controls: 1 },
        path: 0,
      });
      view.events(run.id, 0, 10);
      return run.id;
    });
    const held = (view as unknown as { keys: Map<string, unknown> }).keys;
    expect([...held.keys()]).toEqual([runs[1], runs[2]]);
    // The evicted run still resolves, by reading its events again.
    expect(view.stateKey(runs[0], stateId('key-a'))).toBe('key-a');
    expect([...held.keys()]).toEqual([runs[2], runs[0]]);
  } finally {
    store.close();
  }
});

test('model questions are placed before the action they helped choose, or under the action they judged', () => {
  seq = 0;
  const tree = buildActionTree([
    stateEvent('home'),
    action('Open', 'home'),
    action('Type', 'home', { at: 900 } as never),
  ]);
  const call = (id: number, at: number, purpose: string) =>
    ({ id, at, ms: 300, provider: 'jev', model: 'j', purpose, kind: 'checklist', items: 1, subject: '' }) as const;
  const steps = modelSteps(tree, [
    call(1, 50, 'crawler-interactive+same-kind'),
    call(2, 150, 'crawler-effect'),
    call(3, 5000, 'crawler-interactive'),
  ]);
  const [open] = tree.actions;
  expect(steps.before.get(open.event.seq)?.map(s => s.kind === 'call' && s.call.id)).toEqual([1]);
  // The effect question is asked inside the action, before its event is written: it belongs to Open.
  expect(steps.during.get(open.event.seq)?.map(s => s.kind === 'call' && s.call.id)).toEqual([2]);
  expect(steps.before.get(tree.actions[1].event.seq)).toBeUndefined();
  expect(steps.after.map(s => s.kind === 'call' && s.call.id)).toEqual([3]);
  // The call dialog describes the same placement as the tree.
  expect(callTarget(tree, call(2, 150, 'crawler-effect'))).toMatchObject({ node: open, relation: 'effect' });
  expect(callTarget(tree, call(1, 50, 'crawler-interactive'))).toMatchObject({ node: open, relation: 'choosing' });
});

test('plugin checks hang under the action that reached the state, and point repeated findings at the first', () => {
  seq = 0;
  const inspection = (verdict: 'pass' | 'fail', repeated?: { finding: number; target?: typeof box }[]): Event => ({
    seq: ++seq,
    type: 'inspection',
    at: seq * 100,
    plugin: 'rules',
    ms: 12,
    checks: [{ id: 'clip', verdict, targets: 4, ms: 3 }],
    ...(repeated ? { repeated } : {}),
  });
  const box = {
    box: { x: 10, y: 20, width: 30, height: 40 },
    scroll: { x: 0, y: 0 },
    viewport: { width: 800, height: 600 },
  };
  const finding = (state: string): Event => ({
    seq: ++seq,
    type: 'finding',
    at: seq * 100,
    plugin: 'rules',
    state,
    url: 'https://a.test/',
    finding: { rule: 'clip', severity: 'warning', selector: 'button', text: 'Go', detail: 'clipped', target: box },
  });
  const events: Event[] = [
    { seq: ++seq, type: 'checks', at: 0, plugin: 'rules', checks: [{ id: 'clip', name: '控件裁切' }] },
    stateEvent('home'),
    finding('home'),
    inspection('fail'),
    action('Open menu', 'home'),
    stateEvent('menu'),
    // Seen again elsewhere on the page: the box is where it is in this state.
    inspection('fail', [{ finding: 0, target: { ...box, box: { ...box.box, y: 300 } } }]),
    action('Close', 'menu'),
  ];
  const tree = buildActionTree(events);
  expect(tree.checkNames.get('rules/clip')?.name).toBe('控件裁切');
  expect(tree.entryChecks.map(g => g.state)).toEqual(['home']);
  expect(tree.entryChecks[0].findings).toHaveLength(1);
  const open = tree.actions[0];
  const after = tree.checksAfter.get(open.event.seq);
  expect(after?.map(g => g.state)).toEqual(['menu']);
  expect(after?.[0].node).toBe(open);
  // Each state's problems are numbered for its screenshot; one seen again refers to the first report
  // but is outlined where it is now.
  expect(stateFindings(tree, tree.entryChecks[0])).toMatchObject([{ n: 1, earlier: false, target: box }]);
  const again = stateFindings(tree, after![0]);
  expect(again).toMatchObject([{ n: 1, earlier: true, target: { box: { y: 300 } } }]);
  expect(again[0].event.state).toBe('home');
  // Checks between a state and its action do not break which action the state led to.
  expect(tree.shotAfter.get(open.event.seq)).toBe('menu');
  expect(open.after).toBe('menu');
});
