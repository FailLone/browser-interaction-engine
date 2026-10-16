import { createServer } from 'node:http';
import { afterEach, expect, it, vi } from 'vitest';
import type { ActionAttempt, ActionCandidate } from '@interaction/browser';
import { act, pageOf, testEngine } from './helpers.js';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

async function fixture(count = 2, nested = false, records = Array.from({ length: count }, (_, i) => i)) {
  const html = `<main>${nested ? '<button id="open" type="button">Open routes</button>' : ''}<div id="routes" ${nested ? 'hidden' : ''}>${Array.from({ length: count }, (_, i) => `<button id="route${i}" type="button">Route ${i}</button>`).join('')}</div>
    <form id="work" hidden><label>Amount<input id="amount" value="1"></label></form></main>
    <script>
    window.failedRoutes = []; window.routeClicks = []; window.openClicks = 0;
    if (document.querySelector('#open')) document.querySelector('#open').onclick = () => { window.openClicks++; document.querySelector('#routes').hidden = false; };
    for (let i = 0; i < ${count}; i++) document.querySelector('#route' + i).onclick = () => {
      window.routeClicks.push(i);
      if (!window.failedRoutes.includes(i)) document.querySelector('#work').hidden = false;
    };
    </script>`;
  const server = createServer((_request, response) => { response.setHeader('content-type', 'text/html'); response.end(html); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  cleanup.push(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;
  const declarations = [...Array.from({ length: count }, (_, i) => ({ stableKey: `id:route${i}` })), { stableKey: 'id:open' }];
  const t = await testEngine(url, { contextRules: [], exploration: 'controls', interfaceActions: declarations, replayable: declarations });
  cleanup.push(t.close);
  const recorded: ActionAttempt[] = [], opens: ActionAttempt[] = [];
  const hide = async () => {
    await pageOf(t.engine).evaluate(nested => {
      (document.querySelector('#work') as HTMLElement).hidden = true;
      if (nested) (document.querySelector('#routes') as HTMLElement).hidden = true;
    }, nested);
    await t.engine.observe(t.sessionId);
  };
  let target: ActionCandidate | undefined;
  let checkpoint: Awaited<ReturnType<typeof t.engine.createCheckpoint>> | undefined;
  for (const i of records) {
    if (nested) opens.push(await act(t.engine, t.sessionId, 'Open routes'));
    const attempt = await act(t.engine, t.sessionId, `Route ${i}`);
    expect(attempt).toMatchObject({ status: 'succeeded', action: { replayable: true } });
    recorded.push(attempt);
    if (!target) {
      target = t.engine.actions(t.sessionId).find(action => action.label === 'Amount' && action.kind === 'fill')!;
      checkpoint = await t.engine.createCheckpoint(t.sessionId, 'ready amount');
    }
    await hide();
  }
  const source = t.engine.observation(t.sessionId);
  expect(t.engine.navigationPath(t.sessionId, source.stateId, checkpoint!.stateId,
    { fromObservationId: source.id, toObservationId: checkpoint!.observationId })).toEqual([...opens.slice(0, 1).map(attempt => attempt.id), recorded[0].id]);
  return { ...t, recorded, checkpoint: checkpoint!, target: target!,
    input: { checkpointId: checkpoint!.id, observationId: target!.observationId, actionIds: [target!.id] },
    async fail(routes: number[]) {
      await pageOf(t.engine).evaluate(routes => { Object.assign(window, { failedRoutes: routes, routeClicks: [], openClicks: 0 }); }, routes);
    },
    async clicks() { return pageOf(t.engine).evaluate(() => (window as unknown as { routeClicks: number[] }).routeClicks); },
  };
}

it.each(['target', 'checkpoint'] as const)('reaches %s through another recorded route after a known no-op', async mode => {
  const t = await fixture(); await t.fail([0]);
  const reached = mode === 'target'
    ? await t.engine.reachExplorationTarget(t.sessionId, t.input)
    : await t.engine.reachCheckpoint(t.sessionId, t.checkpoint.id);
  expect(reached.status, JSON.stringify(reached)).toBe(mode === 'target' ? 'TARGET_REACHED' : 'REACHED_VERIFIED');
  expect(await t.clicks()).toEqual([0, 1]);
  expect(reached.attemptIds).toHaveLength(2);
  expect(reached.diagnostics?.strategies).not.toContain('entry_replay');
  const attempts = reached.attemptIds.map(id => t.engine.store.require<ActionAttempt>('attempt', id));
  expect(attempts.every(attempt => attempt.status === 'succeeded' && attempt.purpose === 'recovery')).toBe(true);
  expect(t.engine.list<ActionAttempt>(t.sessionId, 'attempt').some(attempt => attempt.action.label === 'Amount')).toBe(false);
});

it.each(['target', 'checkpoint'] as const)('replans %s from the actual intermediate menu without reopening its successful prefix', async mode => {
  const t = await fixture(2, true); await t.fail([0]);
  const reached = mode === 'target'
    ? await t.engine.reachExplorationTarget(t.sessionId, t.input)
    : await t.engine.reachCheckpoint(t.sessionId, t.checkpoint.id);
  expect(reached.status, JSON.stringify(reached)).toBe(mode === 'target' ? 'TARGET_REACHED' : 'REACHED_VERIFIED');
  expect(await t.clicks()).toEqual([0, 1]);
  expect(await pageOf(t.engine).evaluate(() => (window as unknown as { openClicks: number }).openClicks)).toBe(1);
  expect(reached.attemptIds.map(id => t.engine.store.require<ActionAttempt>('attempt', id).action.label)).toEqual(['Open routes', 'Route 0', 'Route 1']);
});

it('does not physically retry the same failed operation through duplicate successful historical proofs', async () => {
  const t = await fixture(2, false, [0, 0, 1]); await t.fail([0]);
  const reached = await t.engine.reachExplorationTarget(t.sessionId, t.input);
  expect(reached.status, JSON.stringify(reached)).toBe('TARGET_REACHED');
  expect(await t.clicks()).toEqual([0, 1]);
  expect(reached.attemptIds).toHaveLength(2);
});

it('keeps the session action budget across alternative route plans', async () => {
  const t = await fixture(); await t.fail([0]);
  const session = t.engine.session(t.sessionId);
  t.engine.store.put('session', { ...session, options: { ...session.options, maxActions: session.actionCount + 1 } });
  const reached = await t.engine.reachExplorationTarget(t.sessionId, t.input);
  expect(reached.status).toBe('UNREACHABLE'); expect(reached.reason).toBe('BUDGET_EXHAUSTED');
  expect(await t.clicks()).toEqual([0]); expect(reached.attemptIds).toHaveLength(1);
});

it('does not try an alternate route when a dispatched result is unknown', async () => {
  const t = await fixture(); await t.fail([0]);
  const driver = (t.engine as unknown as { driver: { capture: (id: string, context?: { afterAction?: { action: ActionCandidate } }) => Promise<unknown> } }).driver;
  const capture = driver.capture.bind(driver);
  vi.spyOn(driver, 'capture').mockImplementation(async (id, context) => {
    if (context?.afterAction?.action.label === 'Route 0') throw new Error('Injected observation loss after an actual click');
    return capture(id, context);
  });
  const reached = await t.engine.reachExplorationTarget(t.sessionId, t.input);
  expect(reached.status).toBe('UNVERIFIED');
  expect(await t.clicks()).toEqual([0]);
  expect(reached.attemptIds).toHaveLength(1);
  expect(t.engine.store.require<ActionAttempt>('attempt', reached.attemptIds[0]).status).toBe('unknown');
});

it('does not turn an unavailable replay permission into an alternate route', async () => {
  const t = await fixture(); await t.fail([0]);
  const old = t.recorded[1];
  t.engine.store.put('attempt', { ...old, action: { ...old.action, replayable: false } });
  const reached = await t.engine.reachExplorationTarget(t.sessionId, t.input);
  expect(reached.status).toBe('UNREACHABLE');
  expect(await t.clicks()).toEqual([0]); expect(reached.attemptIds).toHaveLength(1);
  expect(reached.diagnostics?.strategies).not.toContain('entry_replay');
});

it('skips duplicate historical proofs rejected by current replay permission without consuming route plans', async () => {
  const t = await fixture(2, false, [0, 0, 0, 0, 0, 1]);
  const session = t.engine.session(t.sessionId);
  t.engine.store.put('session', { ...session, options: { ...session.options, replayable: [{ stableKey: 'id:route1' }], interfaceActions: [{ stableKey: 'id:route1' }] } });
  await t.engine.observe(t.sessionId); await t.fail([]);
  expect(t.engine.actions(t.sessionId).find(a => a.label === 'Route 0')?.replayable).toBe(false);
  const reached = await t.engine.reachExplorationTarget(t.sessionId, t.input);
  expect(reached.status, JSON.stringify(reached)).toBe('TARGET_REACHED');
  expect(await t.clicks()).toEqual([1]); expect(reached.attemptIds).toHaveLength(1);
});

it('strict checkpoint recovery respects withdrawn current replay permission and does not reopen entry', async () => {
  const t = await fixture();
  const session = t.engine.session(t.sessionId);
  t.engine.store.put('session', { ...session, options: { ...session.options, replayable: [{ stableKey: 'id:route0' }], interfaceActions: [{ stableKey: 'id:route0' }] } });
  await t.engine.observe(t.sessionId); await t.fail([0]);
  expect(t.engine.actions(t.sessionId).find(a => a.label === 'Route 1')?.replayable).toBe(false);
  const reached = await t.engine.reachCheckpoint(t.sessionId, t.checkpoint.id);
  expect(reached.status).toBe('UNREACHABLE');
  expect(await t.clicks()).toEqual([0]); expect(reached.attemptIds).toHaveLength(1);
  expect(reached.diagnostics?.strategies).not.toContain('entry_replay');
});

it('bounds recovery alternatives and preserves unreachable work without reopening entry', async () => {
  const t = await fixture(6); await t.fail([0, 1, 2, 3, 4, 5]);
  const reached = await t.engine.reachExplorationTarget(t.sessionId, t.input);
  expect(reached.status).toBe('UNREACHABLE');
  expect(await t.clicks()).toEqual([0, 1, 2, 3]);
  expect(reached.attemptIds).toHaveLength(4);
  expect(reached.diagnostics?.strategies).not.toContain('entry_replay');
  expect(t.engine.list<ActionAttempt>(t.sessionId, 'attempt').some(attempt => attempt.action.label === 'Amount')).toBe(false);
});
