import { createServer } from 'node:http';
import { writeFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { act, pageOf, testEngine } from '/Users/xietian/.codex/worktrees/exploration-layered-refactor/browser-interaction-engine/tests/helpers.ts';

async function main() {
  const html = `<!doctype html><main>
    <button type="button" id="direct">Direct</button>
    <button type="button" id="open">Open routes</button>
    <div id="routes" hidden><button type="button" id="via">Via menu</button></div>
    <form id="work" hidden><label>Amount<input id="amount" value="1"></label></form>
    </main><script>
      window.clicks = [];
      document.querySelector('#direct').onclick = () => { window.clicks.push('direct'); document.querySelector('#work').hidden = false; };
      document.querySelector('#open').onclick = () => { window.clicks.push('open'); document.querySelector('#routes').hidden = false; };
      document.querySelector('#via').onclick = () => { window.clicks.push('via'); document.querySelector('#routes').hidden = true; document.querySelector('#work').hidden = false; };
    </script>`;
  const server = createServer((_req, response) => { response.setHeader('content-type', 'text/html'); response.end(html); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const declarations = ['id:direct', 'id:open', 'id:via'].map(stableKey => ({ stableKey }));
  const t = await testEngine(`http://127.0.0.1:${(server.address() as { port: number }).port}/`, {
    contextRules: [], exploration: 'controls', interfaceActions: declarations, replayable: declarations,
  });
  try {
    const page = pageOf(t.engine);
    const reset = async () => {
      await page.evaluate(() => {
        (document.querySelector('#work') as HTMLElement).hidden = true;
        (document.querySelector('#routes') as HTMLElement).hidden = true;
        (window as any).clicks = [];
      });
      await t.engine.observe(t.sessionId);
    };
    const clicks = () => page.evaluate(() => (window as any).clicks as string[]);
    const direct = await act(t.engine, t.sessionId, 'Direct');
    assert.equal(direct.status, 'succeeded');
    const checkpoint = await t.engine.createCheckpoint(t.sessionId, 'Both paths reach Amount');
    const amount = t.engine.actions(t.sessionId).find(a => a.label === 'Amount' && a.kind === 'fill')!;
    await reset();
    const open = await act(t.engine, t.sessionId, 'Open routes');
    const via = await act(t.engine, t.sessionId, 'Via menu');
    assert.equal(open.status, 'succeeded'); assert.equal(via.status, 'succeeded');
    assert.equal(t.engine.observation(t.sessionId).canonical, t.engine.observation(t.sessionId, checkpoint.observationId).canonical);
    await reset();
    const input = { checkpointId: checkpoint.id, observationId: amount.observationId, actionIds: [amount.id] };
    const recover = () => t.engine.reachExplorationTarget(t.sessionId, input);
    const durations: { attemptId: string; observedDurationMs: number; injectedDurationMs: number; action: string }[] = [];
    const injectDuration = (attemptId: string, durationMs: number) => {
      const a = t.engine.store.require<any>('attempt', attemptId);
      assert.equal(a.status, 'succeeded'); assert.equal(a.purpose, 'recovery'); assert.equal(a.recoverySegment?.outcome, 'matched');
      durations.push({ attemptId, observedDurationMs: a.recoverySegment.durationMs, injectedDurationMs: durationMs, action: a.action.label });
      // Deliberate cost-only injection. Actual dispatch, observations, condition
      // keys, outcomes, correspondence and recorded route IDs are untouched.
      t.engine.store.put('attempt', { ...a, recoverySegment: { ...a.recoverySegment, durationMs } });
    };
    const first = await recover();
    assert.equal(first.status, 'TARGET_REACHED'); assert.deepEqual(await clicks(), ['direct']);
    assert.equal(first.attemptIds.length, 1); injectDuration(first.attemptIds[0], 10_000);
    await reset();
    const second = await recover();
    assert.equal(second.status, 'TARGET_REACHED'); assert.deepEqual(await clicks(), ['open', 'via']);
    assert.equal(second.attemptIds.length, 2); second.attemptIds.forEach(a => injectDuration(a, 1));
    await reset();
    const before = t.engine.session(t.sessionId);
    t.engine.store.put('session', { ...before, options: { ...before.options, maxActions: before.actionCount + 1 } });
    const weighted = await recover();
    const weightedClicks = await clicks();
    const weightedVisible = await page.locator('#amount').isVisible();
    // Counterfactual control: same actual recorded direct path, same one-action
    // remainder; only disable the two-hop path's current replay permission.
    await reset();
    const controlSession = t.engine.session(t.sessionId);
    t.engine.store.put('session', { ...controlSession, options: { ...controlSession.options,
      maxActions: controlSession.actionCount + 1, replayable: [{ stableKey: 'id:direct' }], interfaceActions: [{ stableKey: 'id:direct' }],
    } });
    await t.engine.observe(t.sessionId);
    assert.equal(t.engine.actions(t.sessionId).find(a => a.label === 'Open routes')?.replayable, false);
    const control = await recover();
    const controlClicks = await clicks();
    const summary = {
      note: 'Isolated real-browser proof; only recovery segment durations are synthetic. Both paths actually recorded and exact checkpoint canonical matched. No timing performance claim.',
      durations,
      weighted: { status: weighted.status, reason: weighted.reason, attemptCount: weighted.attemptIds.length, clicks: weightedClicks, amountVisible: weightedVisible, remainingActionsBefore: 1 },
      directOnlyControl: { status: control.status, reason: control.reason, attemptCount: control.attemptIds.length, clicks: controlClicks, amountVisible: await page.locator('#amount').isVisible(), remainingActionsBefore: 1 },
    };
    writeFileSync('/tmp/recovery-route-budget-proof.json', JSON.stringify(summary, null, 2) + '\n');
    console.log(JSON.stringify(summary, null, 2));
    assert.equal(control.status, 'TARGET_REACHED'); assert.deepEqual(controlClicks, ['direct']);
    assert.equal(weighted.status, 'TARGET_REACHED', 'A permitted one-step route exists within the remaining action budget');
  } finally {
    await t.close();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
