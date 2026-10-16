import { createServer } from 'node:http';
import { afterEach, expect, it, vi } from 'vitest';
import { BrowserAdapter, BrowserEngine, type ActionAttempt } from '@interaction/browser';
import { MemoryStore } from '@interaction/storage-memory';
import { pageOf } from './helpers.js';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const close of cleanup.splice(0).reverse()) await close(); });

async function fixture() {
  const server = createServer((_req, res) => {
    res.setHeader('content-type', 'text/html');
    res.end(`<!doctype html><title>Observation windows</title>
      <button id="open" type="button" onclick="window.opens++;document.querySelector('#dialog').showModal()">Open panel</button>
      <dialog id="dialog" aria-label="Panel"><form id="work"><label>Target<input id="target"></label></form>
        <button id="noise" type="button">Background mode</button><form method="dialog"><button>Close</button></form></dialog>
      <form id="quote-form"><label>Quote<input readonly id="quote" value="100"></label></form>
      <script>window.opens=0</script>`);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  cleanup.push(() => new Promise<void>(resolve => server.close(() => resolve())));
  const engine = new BrowserEngine({ persistence: new MemoryStore(), hooks: { samples: () => ['sample'] } });
  cleanup.push(() => engine.close());
  const session = await engine.createSession({ url: `http://127.0.0.1:${(server.address() as { port: number }).port}/`,
    headless: true, exploration: 'controls', settleMs: 60, observeTimeoutMs: 600, actionTimeoutMs: 1500,
    contextRules: [], listExploration: 'all', pageExploration: 'all', regionExploration: 'off',
    interfaceActions: [{ stableKey: 'id:open' }], replayable: [{ stableKey: 'id:open' }] });
  const driver = (engine as unknown as { driver: BrowserAdapter }).driver;
  const execute = (label: string, kind: string) => {
    const actions = engine.actions(session.id).filter(a => a.label === label && a.kind === kind);
    expect(actions).toHaveLength(1);
    return engine.execute(session.id, actions[0].id, crypto.randomUUID(), undefined,
      { profile: 'interface-exploration', observationId: engine.observation(session.id).id });
  };
  return { engine, driver, sid: session.id, page: pageOf(engine), execute };
}

function afterDispatch(driver: BrowserAdapter) {
  let dispatched = false;
  const original = driver.execute.bind(driver);
  vi.spyOn(driver, 'execute').mockImplementation(async (...args) => { await original(...args); dispatched = true; });
  return () => dispatched;
}

it('does not let time spent processing the first sample prematurely finish a modal-opening action', async () => {
  const f = await fixture(), original = f.driver.readDOM.bind(f.driver);
  const dispatched = afterDispatch(f.driver);
  let samples = 0, stalls = 0;
  vi.spyOn(f.driver, 'readDOM').mockImplementation(async detailed => {
    const dom = await original(detailed);
    if (!detailed && dispatched()) {
      samples++;
      if (samples === 1) {
        // Simulate one scheduler pause while processing a captured snapshot.
        // The original controls array is directly mapped by the global stability
        // projection. Form projections map freshly filtered arrays, so this pause
        // lies after their window was started in the baseline implementation.
        // No browser fact, action outcome, readiness flag, or clock is fabricated.
        Object.defineProperty(dom.controls, 'map', { configurable: true, value(callback: unknown, thisArg: unknown) {
          if (!stalls) { stalls++; Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 90); }
          return Array.prototype.map.call(this, callback as never, thisArg);
        } });
      }
    }
    return dom;
  });
  const attempt = await f.execute('Open panel', 'click');
  expect(stalls).toBe(1);
  expect(attempt.status, JSON.stringify({ status: attempt.status, reason: attempt.reason, samples,
    gaps: f.engine.observation(f.sid).gaps })).toBe('succeeded');
  expect(samples).toBeGreaterThanOrEqual(2);
  expect(await f.page.locator('#dialog').evaluate((d: HTMLDialogElement) => d.open)).toBe(true);
  expect(await f.page.evaluate(() => (window as unknown as { opens: number }).opens)).toBe(1);
});

it('keeps observing a modal activation until its changing global dependencies settle', async () => {
  const f = await fixture(), original = f.driver.readDOM.bind(f.driver);
  const dispatched = afterDispatch(f.driver);
  let samples = 0;
  vi.spyOn(f.driver, 'readDOM').mockImplementation(async detailed => {
    if (!detailed && dispatched()) {
      samples++;
      // The unrelated input is already locally ready while this independent
      // button remains in a short, controlled sequence of visible changes.
      await f.page.locator('#noise').evaluate((button, text) => { button.textContent = text; },
        samples <= 4 ? `Background mode ${samples}` : 'Background mode settled');
    }
    return original(detailed);
  });
  const attempt = await f.execute('Open panel', 'click');
  expect(attempt.status, JSON.stringify({ status: attempt.status, reason: attempt.reason, samples })).toBe('succeeded');
  expect(samples).toBeGreaterThan(4);
  expect(await f.page.locator('#noise').textContent()).toBe('Background mode settled');
  expect(await f.page.evaluate(() => (window as unknown as { opens: number }).opens)).toBe(1);
});

it('keeps a genuinely unsettled modal activation unknown and blocks further dispatch without repeating it', async () => {
  const f = await fixture(), original = f.driver.readDOM.bind(f.driver);
  const dispatched = afterDispatch(f.driver);
  let samples = 0;
  vi.spyOn(f.driver, 'readDOM').mockImplementation(async detailed => {
    if (!detailed && dispatched()) await f.page.locator('#noise').evaluate((button, n) => { button.textContent = `Background mode ${n}`; }, ++samples);
    return original(detailed);
  });
  const attempt = await f.execute('Open panel', 'click');
  // The final DOM read may itself hit the observation deadline while the page
  // keeps changing. Both paths must preserve unknown and block dispatch; the
  // diagnostic wording depends on whether that last read finished in time.
  expect(samples).toBeGreaterThanOrEqual(2);
  expect(attempt.status).toBe('unknown');
  expect(f.engine.observation(f.sid).gaps.some(gap => gap.code === 'UNSTABLE')).toBe(true);
  expect(f.engine.recoveryAssessment(f.sid).unknownAttempts.map(a => a.id)).toContain(attempt.id);
  expect(await f.page.locator('#target').isEditable()).toBe(true);
  await expect(f.execute('Target', 'fill')).rejects.toMatchObject({ code: 'UNKNOWN_ACTION_OUTCOME' });
  expect(f.engine.list<ActionAttempt>(f.sid, 'attempt')).toHaveLength(1);
  expect(await f.page.evaluate(() => (window as unknown as { opens: number }).opens)).toBe(1);
});

it('preserves native field progress while passive quote values change in every sample', async () => {
  const f = await fixture();
  expect((await f.execute('Open panel', 'click')).status).toBe('succeeded');
  const original = f.driver.readDOM.bind(f.driver); let quote = 100;
  vi.spyOn(f.driver, 'readDOM').mockImplementation(async detailed => {
    if (!detailed) await f.page.locator('#quote').evaluate((input: HTMLInputElement, value) => { input.value = String(value); }, ++quote);
    return original(detailed);
  });
  const observation = await f.engine.observe(f.sid);
  expect(observation.stable).toBe(false);
  expect(observation.gaps.some(g => g.critical)).toBe(false);
  expect((await f.execute('Target', 'fill')).status).toBe('succeeded');
  expect(await f.page.locator('#target').inputValue()).toBe('sample');
  expect(f.engine.recoveryAssessment(f.sid).unknownAttempts).toEqual([]);
});

it('allows a native field action to use its own ready scope while an independent button keeps changing', async () => {
  const f = await fixture();
  expect((await f.execute('Open panel', 'click')).status).toBe('succeeded');
  const original = f.driver.readDOM.bind(f.driver); let samples = 0;
  const dispatched = afterDispatch(f.driver);
  vi.spyOn(f.driver, 'readDOM').mockImplementation(async detailed => {
    if (!detailed && dispatched()) await f.page.locator('#noise').evaluate((button, n) => { button.textContent = `Background mode ${n}`; }, ++samples);
    return original(detailed);
  });
  expect((await f.execute('Target', 'fill')).status).toBe('succeeded');
  expect(f.engine.observation(f.sid).gaps.some(g => g.code === 'PARTIAL_INTERACTION_READY')).toBe(true);
  expect(await f.page.locator('#target').inputValue()).toBe('sample');
  expect(f.engine.recoveryAssessment(f.sid).unknownAttempts).toEqual([]);
});
