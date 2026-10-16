import { createServer } from 'node:http';
import { afterEach, expect, it, vi } from 'vitest';
import type { ActionAttempt, ActionCandidate } from '@interaction/browser';
import { act, pageOf, testEngine } from './helpers.js';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const close of cleanup.splice(0).reverse()) await close();
});

type Mode = 'A' | 'B';
type RecoveryMode = 'target' | 'checkpoint';

/** All path proofs and recovery outcomes come from this test's own browser.
 * Changing fixture state between runs is setup, never recovery evidence. */
async function fixture(options: { nested?: boolean; modes?: boolean; count?: number } = {}) {
  const nested = options.nested ?? false;
  const count = options.count ?? 2;
  const html = `<!doctype html><main>
    ${options.modes ? '<form><label>Mode<select id="mode"><option>A</option><option>B</option></select></label></form>' : ''}
    ${nested ? '<button id="open" type="button">Open routes</button>' : ''}
    <div id="routes" ${nested ? 'hidden' : ''}>
      ${Array.from({ length: count }, (_, route) => `<button id="route${route}" type="button">Route ${route}</button>`).join('')}
    </div>
    <form id="work" hidden><label>Amount<input id="amount" value="1"></label></form>
    </main><script>
      window.failedRoutes = []; window.routeClicks = []; window.openClicks = 0; window.fillEvents = [];
      if (document.querySelector('#open')) document.querySelector('#open').onclick = () => {
        window.openClicks++; document.querySelector('#routes').hidden = false;
      };
      for (let i = 0; i < ${count}; i++) document.querySelector('#route' + i).onclick = () => {
        window.routeClicks.push(i);
        if (!window.failedRoutes.includes(i)) document.querySelector('#work').hidden = false;
      };
      document.querySelector('#amount').oninput = event => window.fillEvents.push(event.target.value);
    </script>`;
  const server = createServer((_request, response) => {
    response.setHeader('content-type', 'text/html'); response.end(html);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  cleanup.push(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;
  const declarations = [...Array.from({ length: count }, (_, route) => `id:route${route}`), 'id:open'].map(stableKey => ({ stableKey }));
  const t = await testEngine(url, {
    contextRules: [], exploration: 'controls', interfaceActions: declarations, replayable: declarations,
  });
  cleanup.push(t.close);
  const page = pageOf(t.engine);
  const reset = async (failedRoutes: number[] = [], mode: Mode = 'A') => {
    await page.evaluate(({ nested, failedRoutes, mode }) => {
      (document.querySelector('#work') as HTMLElement).hidden = true;
      (document.querySelector('#amount') as HTMLInputElement).value = '1';
      const select = document.querySelector<HTMLSelectElement>('#mode');
      if (select) select.value = mode;
      if (nested) (document.querySelector('#routes') as HTMLElement).hidden = true;
      Object.assign(window, { failedRoutes, routeClicks: [], openClicks: 0, fillEvents: [] });
    }, { nested, failedRoutes, mode });
    await t.engine.observe(t.sessionId);
  };
  type Destination = {
    checkpoint: Awaited<ReturnType<typeof t.engine.createCheckpoint>>;
    target: ActionCandidate;
    recorded: ActionAttempt[];
  };
  const destinations = new Map<Mode, Destination>();
  for (const mode of options.modes ? ['A', 'B'] as const : ['A'] as const) {
    const recorded: ActionAttempt[] = [];
    let destination: Destination | undefined;
    for (let route = 0; route < count; route++) {
      await reset([], mode);
      if (nested) await act(t.engine, t.sessionId, 'Open routes');
      const attempt = await act(t.engine, t.sessionId, `Route ${route}`);
      expect(attempt).toMatchObject({ status: 'succeeded', action: { replayable: true } });
      recorded.push(attempt);
      if (!destination) {
        const target = t.engine.actions(t.sessionId).find(action => action.label === 'Amount' && action.kind === 'fill')!;
        destination = { target, checkpoint: await t.engine.createCheckpoint(t.sessionId, `Amount at ${mode}`), recorded };
      }
    }
    destinations.set(mode, destination!);
  }
  await reset();
  const recover = (recoveryMode: RecoveryMode = 'target', mode: Mode = 'A') => {
    const { checkpoint, target } = destinations.get(mode)!;
    return recoveryMode === 'target'
      ? t.engine.reachExplorationTarget(t.sessionId, { checkpointId: checkpoint.id, observationId: target.observationId, actionIds: [target.id] })
      : t.engine.reachCheckpoint(t.sessionId, checkpoint.id);
  };
  return { ...t, page, reset, recover, destinations,
    async clicks() { return page.evaluate(() => (window as unknown as { routeClicks: number[] }).routeClicks); },
    attempts(ids: string[]) { return ids.map(id => t.engine.store.require<ActionAttempt>('attempt', id)); },
    async fill(value: string) {
      const beforeId = t.engine.observation(t.sessionId).id;
      const filled = await act(t.engine, t.sessionId, 'Amount', 'fill', value);
      expect(filled).toMatchObject({ status: 'succeeded', beforeId, action: { value } });
      expect(await page.locator('#amount').inputValue()).toBe(value);
      expect(await page.evaluate(() => (window as unknown as { fillEvents: string[] }).fillEvents)).toEqual([value]);
    },
  };
}

it.each(['target', 'checkpoint'] as const)('learns a failed %s route from actual recovery and reuses the working route on the next call', async mode => {
  const t = await fixture();
  await t.reset([0]);
  const first = await t.recover(mode);
  expect(first.status, JSON.stringify(first)).toBe(mode === 'target' ? 'TARGET_REACHED' : 'REACHED_VERIFIED');
  expect(await t.clicks()).toEqual([0, 1]);
  const segments = t.attempts(first.attemptIds).map(attempt => attempt.recoverySegment);
  expect(segments).toMatchObject([
    { recordedAttemptId: t.destinations.get('A')!.recorded[0].id, outcome: 'no_progress', mode },
    { recordedAttemptId: t.destinations.get('A')!.recorded[1].id, outcome: 'matched', mode },
  ]);
  expect(segments.every(segment => !!segment?.conditionKey && Number.isFinite(segment.durationMs) && segment.durationMs >= 0)).toBe(true);
  await t.reset([0]);
  const second = await t.recover(mode);
  expect(second.status, JSON.stringify(second)).toBe(mode === 'target' ? 'TARGET_REACHED' : 'REACHED_VERIFIED');
  expect(await t.clicks()).toEqual([1]);
  expect(second.attemptIds).toHaveLength(1);
  expect(second.diagnostics?.strategies).not.toContain('entry_replay');
  expect(t.engine.list<ActionAttempt>(t.sessionId, 'attempt').some(attempt => attempt.action.label === 'Amount')).toBe(false);
  await t.fill('42');
});

it.each(['target', 'checkpoint'] as const)('retains a nested successful prefix while learning %s route costs', async mode => {
  const t = await fixture({ nested: true });
  await t.reset([0]);
  const first = await t.recover(mode);
  expect(first.status, JSON.stringify(first)).toBe(mode === 'target' ? 'TARGET_REACHED' : 'REACHED_VERIFIED');
  expect(t.attempts(first.attemptIds).map(attempt => attempt.action.label)).toEqual(['Open routes', 'Route 0', 'Route 1']);
  expect(await t.page.evaluate(() => (window as unknown as { openClicks: number }).openClicks)).toBe(1);
  await t.reset([0]);
  const second = await t.recover(mode);
  expect(second.status, JSON.stringify(second)).toBe(mode === 'target' ? 'TARGET_REACHED' : 'REACHED_VERIFIED');
  expect(t.attempts(second.attemptIds).map(attempt => attempt.action.label)).toEqual(['Open routes', 'Route 1']);
  expect(await t.page.evaluate(() => (window as unknown as { openClicks: number }).openClicks)).toBe(1);
  expect(second.diagnostics?.strategies).not.toContain('entry_replay');
  await t.fill('43');
});

it('reaches a previously untried fifth route on the next call without increasing the four-plan limit', async () => {
  const t = await fixture({ count: 5 });
  await t.reset([0, 1, 2, 3]);
  const first = await t.recover();
  expect(first.status, JSON.stringify(first)).toBe('UNREACHABLE');
  expect(await t.clicks()).toEqual([0, 1, 2, 3]);
  expect(first.attemptIds).toHaveLength(4);
  expect(first.diagnostics?.strategies).not.toContain('entry_replay');
  await t.reset([0, 1, 2, 3]);
  const second = await t.recover();
  const secondClicks = await t.clicks();
  expect(second.status, JSON.stringify({ reason: second.reason, firstAttempts: first.attemptIds.length, secondClicks })).toBe('TARGET_REACHED');
  expect(secondClicks).toEqual([4]);
  expect(second.attemptIds).toHaveLength(1);
  expect(second.diagnostics?.strategies).not.toContain('recorded_path_alternative');
  expect(second.diagnostics?.strategies).not.toContain('entry_replay');
  await t.fill('45');
});

it('does not transfer failure penalties from mode A to an independently recorded mode B', async () => {
  const t = await fixture({ modes: true });
  await t.reset([0], 'A');
  const first = await t.recover('target', 'A');
  expect(first.status, JSON.stringify(first)).toBe('TARGET_REACHED');
  expect(await t.clicks()).toEqual([0, 1]);
  const failedA = t.attempts(first.attemptIds)[0];
  await t.reset([], 'B');
  const second = await t.recover('target', 'B');
  expect(second.status, JSON.stringify(second)).toBe('TARGET_REACHED');
  expect(await t.clicks()).toEqual([0]);
  const succeededB = t.attempts(second.attemptIds)[0];
  expect(succeededB.action.controlId).toBe(failedA.action.controlId);
  expect(succeededB.recoverySegment?.conditionKey).toBeTruthy();
  expect(succeededB.recoverySegment?.conditionKey).not.toBe(failedA.recoverySegment?.conditionKey);
  expect(succeededB.recoverySegment?.outcome).toBe('matched');
  await t.reset([0], 'A');
  const third = await t.recover('target', 'A');
  expect(third.status, JSON.stringify(third)).toBe('TARGET_REACHED');
  expect(await t.clicks()).toEqual([1]);
  expect(t.attempts(third.attemptIds)[0].recoverySegment?.conditionKey).toBe(t.attempts(first.attemptIds)[1].recoverySegment?.conditionKey);
  await t.fill('44');
});

it('rechecks current replay permission even when the withdrawn route has learned the lowest cost', async () => {
  const t = await fixture();
  await t.reset([0]);
  const first = await t.recover();
  expect(first.status, JSON.stringify(first)).toBe('TARGET_REACHED');
  expect(await t.clicks()).toEqual([0, 1]);
  const session = t.engine.session(t.sessionId);
  t.engine.store.put('session', { ...session, options: { ...session.options,
    replayable: [{ stableKey: 'id:route0' }], interfaceActions: [{ stableKey: 'id:route0' }],
  } });
  await t.reset([0]);
  expect(t.engine.actions(t.sessionId).find(action => action.label === 'Route 1')?.replayable).toBe(false);
  const second = await t.recover();
  expect(second.status).toBe('UNREACHABLE');
  expect(await t.clicks()).toEqual([0]);
  expect(second.attemptIds).toHaveLength(1);
  expect(second.diagnostics?.strategies).not.toContain('entry_replay');
});

it('keeps an unknown outcome on the learned cheapest route unresolved and does not try alternatives', async () => {
  const t = await fixture();
  await t.reset([0]);
  const first = await t.recover();
  expect(first.status, JSON.stringify(first)).toBe('TARGET_REACHED');
  expect(await t.clicks()).toEqual([0, 1]);
  await t.reset([]);
  const driver = (t.engine as unknown as { driver: { capture: (id: string, context?: { afterAction?: { action: ActionCandidate } }) => Promise<unknown> } }).driver;
  const capture = driver.capture.bind(driver);
  vi.spyOn(driver, 'capture').mockImplementation(async (id, context) => {
    if (context?.afterAction?.action.label === 'Route 1') throw new Error('Fixture observation loss after actual learned-route click');
    return capture(id, context);
  });
  const second = await t.recover();
  expect(second.status).toBe('UNVERIFIED');
  expect(await t.clicks()).toEqual([1]);
  expect(second.attemptIds).toHaveLength(1);
  expect(t.attempts(second.attemptIds)[0]).toMatchObject({ status: 'unknown', recoverySegment: { outcome: 'unknown' } });
  expect(second.diagnostics?.strategies).not.toContain('recorded_path_alternative');
  expect(second.diagnostics?.strategies).not.toContain('entry_replay');
  const blocked = await t.recover();
  expect(blocked.status).toBe('UNVERIFIED');
  expect(blocked.attemptIds).toHaveLength(0);
  expect(await t.clicks()).toEqual([1]);
});
