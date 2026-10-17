import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { expect, it, vi } from 'vitest';
import { BrowserEngine, type Observation } from '@interaction/browser';
import { hash } from '@interaction/core';
import { BrowserAdapter } from '@interaction/adapter-playwright';
import { MemoryStore } from '@interaction/storage-memory';
import { browserBranchConditions } from '../packages/adapter-playwright/src/branch-conditions.js';
import { pageOf } from './helpers.js';

const sha = (value: string) => createHash('sha256').update(value).digest('hex');
function modeOwner(observation: Pick<Observation, 'controls' | 'ownerDependencies'>) {
  const mode = observation.controls.find(control => control.selector === '#mode')!;
  const graph = observation.ownerDependencies!;
  const root = graph.roots.find(root => root.localId === mode.localId)!;
  return graph.nodes.find(node => node.id === root.ownerId)!;
}

it('does not credit retained owner A when the real dispatch ran under changed owner B', async () => {
  const html = `<!doctype html><main><ul>
    <li data-record="target"><input id="flag" type="checkbox" aria-label="Flag"
      onchange="window.actualBranch=document.querySelector('#mode-owner').dataset.record">
      <a href="/target-record">Target record</a></li>
    <li id="mode-owner" data-record="A"><i id="mode" role="button" aria-label="Hidden mode"
      aria-expanded="false" hidden></i><a href="/mode-record">Mode record</a></li>
    </ul></main>`;
  const site = createServer((_req, response) => { response.setHeader('Content-Type', 'text/html'); response.end(html); });
  await new Promise<void>(resolve => site.listen(0, '127.0.0.1', resolve));
  const host = new BrowserEngine({ persistence: new MemoryStore() });
  try {
    const session = await host.createSession({ url: `http://127.0.0.1:${(site.address() as { port: number }).port}/`,
      headless: true, exploration: 'controls', settleMs: 0, observeTimeoutMs: 100, evidence: { enabled: false } });
    const initial = host.observation(session.id), flag = initial.controls.find(control => control.selector === '#flag')!;
    await host.reviewControls(session.id, { observationId: initial.id, source: 'owned-dispatch-witness-fixture', reviews: [
      { localId: flag.localId, kind: 'check', samples: [true], risk: 'interface', replayable: false,
        reason: 'Exercise the owned local checkbox', evidence: ['The local handler records the parent mode selected at actual dispatch'] },
    ] });
    const target = host.observation(session.id), targetAction = host.actions(session.id).find(action => action.localId === flag.localId && action.kind === 'check' && action.value === true)!;
    await host.observe(session.id);
    const before = host.observation(session.id), source = host.actions(session.id).find(action => action.localId === flag.localId && action.kind === 'check' && action.value === true)!;
    const beforeJson = JSON.stringify(before), page = pageOf(host);
    const driver = (host as unknown as { driver: BrowserAdapter }).driver;
    expect(target.id).not.toBe(before.id);
    expect(modeOwner(target).attributes['data-record']).toBe('A');
    expect(modeOwner(before).attributes['data-record']).toBe('A');
    expect(before.controls.find(control => control.selector === '#mode')).toMatchObject({ identityScope: 'instance', visible: false });
    expect(before.ownerDependencies?.inventoryComplete).toBe(true);
    expect(browserBranchConditions(source, before)).toBeUndefined();
    expect(host.list(session.id, 'hypothesis')).toEqual([]);

    // No new observation is captured. Only a non-control owner attribute changes;
    // the checkbox's real handler will read B when Playwright dispatches it.
    await page.locator('#mode-owner').evaluate(element => element.setAttribute('data-record', 'B'));
    const readDOM = driver.readDOM.bind(driver);
    let graphOnSnapshot: Awaited<ReturnType<BrowserAdapter['readDOM']>> | undefined;
    const graphOn = vi.spyOn(driver, 'readDOM').mockImplementation(async detailed => {
      const live = await readDOM(detailed, true); graphOnSnapshot = live; return live;
    });
    let preflightGraphOn;
    try { preflightGraphOn = await driver.preflight(before, source); } finally { graphOn.mockRestore(); }
    const preflightGraphOff = await driver.preflight(before, source);
    expect(modeOwner(graphOnSnapshot!).attributes['data-record']).toBe('B');
    expect(preflightGraphOn).toBe('valid');
    expect(preflightGraphOff).toBe('valid');
    expect(host.observation(session.id).id).toBe(before.id);

    const attempt = await host.execute(session.id, source.id, 'owned-dispatch-witness');
    const oracle = await page.evaluate(() => (window as unknown as { actualBranch: string }).actualBranch);
    const after = host.observation(session.id, attempt.afterId!);
    const proof = host.operationCorrespondence(session.id, { observationId: target.id, actionId: targetAction.id,
      source: { sessionId: session.id, attemptId: attempt.id } });
    const artifact = process.env.BIE_DISPATCH_GAP_EVIDENCE;
    if (artifact) {
      const sourceFiles = ['packages/core/src/engine.ts', 'packages/adapter-playwright/src/browser.ts',
        'packages/browser/src/document-coverage.ts', 'packages/browser/src/control-reviews.ts', 'tests/document-dispatch-witness.test.ts'];
      mkdirSync(dirname(resolve(artifact)), { recursive: true });
      writeFileSync(artifact, JSON.stringify({ fixture: 'owned-local-checkbox-hidden-owner', fixtureSha256: sha(html),
        sourceSha256: Object.fromEntries(sourceFiles.map(file => [file, sha(readFileSync(file, 'utf8'))])),
        preflightGraphOn, preflightGraphOff, actualOracle: oracle, attempt,
        target: { id: target.id, modeOwner: modeOwner(target), mode: target.controls.find(control => control.selector === '#mode') },
        before: { id: before.id, modeOwner: modeOwner(before), sha256: sha(beforeJson), retainedUnchanged: JSON.stringify(host.observation(session.id, before.id)) === beforeJson },
        graphOnLiveOwner: modeOwner(graphOnSnapshot!), after: { id: after.id, modeOwner: modeOwner(after) }, proof,
        expected: { actualOracle: 'B', beforeOwner: 'A', retainedCoverageEquivalent: false },
      }, null, 2) + '\n', { flag: 'wx' });
    }
    expect(attempt.status).toBe('succeeded');
    expect(oracle).toBe('B');
    expect(attempt.beforeId).toBe(before.id);
    expect(JSON.stringify(host.observation(session.id, before.id))).toBe(beforeJson);
    expect(modeOwner(after).attributes['data-record']).toBe('B');
    expect(host.list(session.id, 'attempt')).toHaveLength(1);
    // Safety oracle: the actual B receipt cannot complete the unexecuted A sample.
    expect(proof.equivalent).toBe(false);
  } finally {
    await host.close();
    await new Promise<void>(resolve => site.close(() => resolve()));
  }
});

class HookedEngine extends BrowserEngine {
  secondBeforeAction?: () => Promise<void>;
  beforeActionCalls = 0;
  protected override async beforeAction(sessionId: string) {
    await super.beforeAction(sessionId);
    if (this.secondBeforeAction && ++this.beforeActionCalls === 2) await this.secondBeforeAction();
  }
}
async function stableFixture(context = false, text = false) {
  const html = `<!doctype html><html><head><meta id="account" data-value="A"></head><body><main><ul>
    <li data-record="target"><input id="flag" type="${text ? 'text' : 'checkbox'}" aria-label="Flag"
      ${text ? 'oninput' : 'onchange'}="window.actualBranch=document.querySelector('#mode-owner').dataset.record;window.actualContext=document.querySelector('#account').dataset.value">
      <a href="/target-record">Target record</a></li>
    <li id="mode-owner" data-record="A"><i id="mode" role="button" aria-label="Hidden mode" aria-expanded="false" hidden></i><a href="/mode-record">Mode record</a></li>
    </ul></main></body></html>`;
  const site = createServer((_req, response) => { response.setHeader('Content-Type', 'text/html'); response.end(html); });
  await new Promise<void>(resolve => site.listen(0, '127.0.0.1', resolve));
  const host = new HookedEngine({ persistence: new MemoryStore() });
  const close = async () => { await host.close(); await new Promise<void>(resolve => site.close(() => resolve())); };
  try {
    const session = await host.createSession({ url: `http://127.0.0.1:${(site.address() as { port: number }).port}/`, headless: true,
      exploration: 'controls', settleMs: 0, observeTimeoutMs: 100, evidence: { enabled: false },
      ...(context ? { contextRules: [{ key: 'account', selector: '#account', attribute: 'data-value' }] } : {}) });
    const initial = host.observation(session.id), flag = initial.controls.find(control => control.selector === '#flag')!;
    const kind = text ? 'fill' as const : 'check' as const;
    await host.reviewControls(session.id, { observationId: initial.id, source: 'owned-stable-witness-fixture', reviews: [
      { localId: flag.localId, kind, samples: text ? ['A', 'B'] : [true, false], risk: 'interface', replayable: false, reason: 'Owned input', evidence: ['Local fixture'] },
    ] });
    const target = host.observation(session.id), targetAction = host.actions(session.id).find(action => action.localId === flag.localId && action.kind === kind && action.value === (text ? 'B' : true))!;
    await host.observe(session.id);
    const before = host.observation(session.id), source = host.actions(session.id).find(action => action.localId === flag.localId && action.kind === kind && action.value === (text ? 'A' : false))!;
    return { host, session, target, targetAction, before, source, page: pageOf(host), close };
  } catch (error) { await close(); throw error; }
}

it('binds a stable actual supplied value and rejects missing, changed, or borrowed witnesses', async () => {
  const f = await stableFixture(false, true);
  try {
    const attempt = await f.host.execute(f.session.id, f.source.id, 'supplied-value-witness', 'B');
    const after = f.host.observation(f.session.id, attempt.afterId!);
    const query = () => f.host.operationCorrespondence(f.session.id, { observationId: f.target.id, actionId: f.targetAction.id,
      source: { sessionId: f.session.id, attemptId: attempt.id } });
    expect(f.source.value).toBe('A'); expect(attempt.action.value).toBe('B'); expect(attempt.status).toBe('succeeded');
    expect(await f.page.locator('#flag').inputValue()).toBe('B');
    expect(await f.page.evaluate(() => (window as unknown as { actualBranch: string }).actualBranch)).toBe('A');
    expect(after.ownerDependencyDispatch).toMatchObject({ beforeId: f.before.id, actionId: f.source.id, actionKey: hash(attempt.action), graphKey: hash(f.before.ownerDependencies) });
    expect(after.ownerDependencyDispatch!.actionKey).not.toBe(hash(f.source));
    expect(query()).toMatchObject({ equivalent: true, policy: 'browser-document-coverage-v1', identityAuthorized: false, replayAuthorized: false, currentExecution: false });
    const variants = [undefined, { ...after.ownerDependencyDispatch!, beforeId: 'other' }, { ...after.ownerDependencyDispatch!, actionKey: hash(f.source) },
      { ...after.ownerDependencyDispatch!, graphKey: 'other' }, { ...after.ownerDependencyDispatch!, contextKey: 'other' },
      { ...after.ownerDependencyDispatch!, browserSessionId: 'other' }, { ...after.ownerDependencyDispatch!, capturedAt: '2000-01-01T00:00:00Z' }];
    const kinds = ['session', 'observation', 'action', 'attempt', 'frontier', 'identity', 'hypothesis', 'control-review', 'scope', 'continuation', 'boundary-exit-result', 'exploration-group'];
    for (const ownerDependencyDispatch of variants) {
      const store = new MemoryStore();
      for (const kind of kinds) for (const row of f.host.store.list<{ id: string; sessionId?: string }>(kind, f.session.id))
        store.put(kind, kind === 'observation' && row.id === after.id ? { ...after, ownerDependencyDispatch } : row);
      const clone = new BrowserEngine({ persistence: store });
      try { expect(clone.operationCorrespondence(f.session.id, { observationId: f.target.id, actionId: f.targetAction.id,
        source: { sessionId: f.session.id, attemptId: attempt.id } }).equivalent).toBe(false); }
      finally { await clone.close(); }
    }
    expect(query().equivalent).toBe(true);
    const driver = (f.host as unknown as { driver: BrowserAdapter }).driver;
    // The real after capture already consumed the sole witness. Reusing its
    // action/before coordinates on an additional capture must not borrow it.
    const repeated = await driver.capture('unrelated-after', { afterAction: { action: attempt.action, before: f.before } });
    expect(repeated.ownerDependencyDispatch).toBeUndefined();
    // Exercise each producer cleanup path with a fresh real native command.
    // These direct driver calls do not fabricate SDK attempts or grant coverage.
    for (const consume of ['ordinary', 'failed', 'missing-graph'] as const) {
      await f.host.observe(f.session.id);
      const current = f.host.observation(f.session.id), control = current.controls.find(control => control.selector === '#flag')!;
      const action = f.host.actions(f.session.id).find(action => action.localId === control.localId && action.kind === 'fill' && action.value === (control.value === 'A' ? 'B' : 'A'))!;
      expect(await driver.preflight(current, action)).toBe('valid');
      await driver.execute(action, control);
      if (consume === 'failed') {
        const page = driver.page; driver.page = undefined;
        try { await expect(driver.capture(`failed-${consume}`)).rejects.toMatchObject({ code: 'BROWSER_UNAVAILABLE' }); }
        finally { driver.page = page; }
      } else {
        const captured = await driver.capture(`consume-${consume}`, consume === 'missing-graph'
          ? { afterAction: { action, before: { ...current, ownerDependencies: undefined } } } : undefined);
        expect(captured.ownerDependencyDispatch).toBeUndefined();
      }
      expect((await driver.capture(`repeat-${consume}`, { afterAction: { action, before: current } })).ownerDependencyDispatch).toBeUndefined();
    }
  } finally { await f.close(); }
});

it('does not turn an actual-value witness into equivalence between different review/native bases', async () => {
  const f = await stableFixture();
  try {
    // Only true was a native candidate in the unchecked observation; the false
    // review sample was separately synthesized and lacks its native basis.
    const attempt = await f.host.execute(f.session.id, f.source.id, 'different-sample-bases', true);
    expect(attempt.status).toBe('succeeded'); expect(attempt.action.value).toBe(true);
    expect(f.host.observation(f.session.id, attempt.afterId!).ownerDependencyDispatch?.actionKey).toBe(hash(attempt.action));
    expect(f.host.operationCorrespondence(f.session.id, { observationId: f.target.id, actionId: f.targetAction.id,
      source: { sessionId: f.session.id, attemptId: attempt.id } })).toMatchObject({ equivalent: false, reason: 'operation_conditions_unavailable' });
  } finally { await f.close(); }
});

it.each(['owner', 'declared-context'] as const)('does not borrow preparation when the second beforeAction hook changes %s', async changed => {
  const f = await stableFixture(changed === 'declared-context');
  try {
    f.host.secondBeforeAction = async () => {
      if (changed === 'owner') await f.page.locator('#mode-owner').evaluate(element => element.setAttribute('data-record', 'B'));
      else await f.page.locator('#account').evaluate(element => element.setAttribute('data-value', 'B'));
    };
    const attempt = await f.host.execute(f.session.id, f.source.id, `hook-change-${changed}`, true);
    const after = f.host.observation(f.session.id, attempt.afterId!);
    expect(f.host.beforeActionCalls).toBe(2); expect(attempt.status).toBe('succeeded'); expect(attempt.beforeId).toBe(f.before.id);
    const oracle = await f.page.evaluate(() => ({ branch: (window as unknown as { actualBranch: string }).actualBranch, context: (window as unknown as { actualContext: string }).actualContext }));
    expect(changed === 'owner' ? oracle.branch : oracle.context).toBe('B');
    expect(after.ownerDependencyDispatch).toBeUndefined();
    expect(f.host.operationCorrespondence(f.session.id, { observationId: f.target.id, actionId: f.targetAction.id,
      source: { sessionId: f.session.id, attemptId: attempt.id } }).equivalent).toBe(false);
  } finally { await f.close(); }
});
