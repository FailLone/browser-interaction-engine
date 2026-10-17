import { readOwnerGraph, mutableOwnerGraph } from './owner-dependency-helpers.js';
import { createServer } from 'node:http';
import { afterEach, expect, it } from 'vitest';
import { hash } from '@interaction/core';
import { BrowserEngine, type ActionAttempt, type Observation, type OwnerDependencies } from '@interaction/browser';
import { MemoryStore } from '@interaction/storage-memory';
import { documentCoverageReader } from '../packages/browser/src/document-coverage.js';
import { collectOwnerDependencies } from '../packages/adapter-playwright/src/owner-dependencies.js';
import { pageOf } from './helpers.js';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function fixture() {
  const html = '<!doctype html><main><ul><li data-record="flag"><input id="flag" type="checkbox" aria-label="Flag"><a href="/flag">Flag record</a></li><li data-record="mode"><i id="mode" role="button" aria-label="Hidden mode" aria-expanded="false" hidden></i><a href="/mode">Mode record</a></li></ul><section data-owner="nonlocal"><input id="business" type="hidden" value="A" aria-describedby="external"></section><span id="external" data-record="external-A">External meaning</span></main>';
  const site = createServer((_req, res) => { res.setHeader('content-type', 'text/html'); res.end(html); });
  await new Promise<void>(resolve => site.listen(0, '127.0.0.1', resolve));
  cleanup.push(() => new Promise<void>(resolve => site.close(() => resolve())));
  const host = new BrowserEngine({ persistence: new MemoryStore() }); cleanup.push(() => host.close());
  const s = await host.createSession({url: `http://127.0.0.1:${(site.address() as {port: number}).port}/`, headless: true, exploration: 'controls', settleMs: 0, observeTimeoutMs: 100, evidence: {enabled: false}});
  const o = host.observation(s.id), flag = o.controls.find(c => c.selector === '#flag')!;
  const action = host.actions(s.id).find(a => a.localId === flag.localId && a.kind === 'check' && a.value === true)!;
  const attempt = await host.execute(s.id, action.id, 'native-field-receipt');
  expect(attempt.status).toBe('succeeded');
  const before = host.observation(s.id, attempt.beforeId), after = host.observation(s.id, attempt.afterId!);
  const proof = () => host.operationReceiptCondition(s.id, {attemptId: attempt.id});
  const compare = (target: Observation, source = before, result = after, receipt = attempt) => documentCoverageReader((a, _o, old) => ({source: old.action, target: a, evidence: ['native-fixture']}))(
    {...action, observationId: target.id, stateId: target.stateId}, target, receipt, source, result);
  return {host, sid: s.id, page: pageOf(host), before, after, attempt, action, compare, proof};
}

it('proves a stable complete real receipt while retaining hidden native fields outside all action and identity inventories', async () => {
  const f = await fixture(), graph = readOwnerGraph(f.before), hidden = graph.nodes.find(node => node.attributes.id === 'business')!;
  expect(graph.version).toBe('browser-owner-dependencies-v2'); expect(graph.inventoryComplete).toBe(true);
  expect(graph.nativeInputIds).toContain(hidden.id); expect(graph.nativeRoots).toEqual([expect.objectContaining({instanceId: hidden.id, complete: true})]);
  expect(graph.references.some(ref => ref.sourceId === hidden.id && ref.token === 'external' && ref.status === 'unique')).toBe(true);
  expect(hidden.live?.value).toBe('A'); expect(f.before.controls.some(c => c.instanceId === hidden.id)).toBe(false);
  expect(f.host.actions(f.sid).some(a => a.localId === hidden.id)).toBe(false);
  expect(f.host.list<{occurrences?: {localId: string}[]}>(f.sid, 'identity').some(identity => identity.occurrences?.some(item => item.localId === hidden.id))).toBe(false);
  expect(f.after.ownerDependencyDispatch?.graphKey).toBe(hash(f.before.ownerDependencies));
  expect(f.proof()).toMatchObject({actualSuccess: true, conditionVerified: true, status: 'document', identityAuthorized: false, replayAuthorized: false, currentExecution: false, arrivalVerified: false});
});

it('rejects a changed nonlocal hidden value or IDREF binding while identical retained A evidence remains usable', async () => {
  const f = await fixture(); expect(f.compare(f.before)).toBeDefined();
  await f.page.locator('#flag').uncheck(); // Restore the action's own visible condition before changing its nonlocal input.
  await f.page.locator('#business').evaluate(el => { (el as HTMLInputElement).value = 'B'; });
  const b = await f.host.observe(f.sid);
  expect(b.controls.find(c => c.selector === '#flag')?.checked).toBe(false);
  expect(readOwnerGraph(b).nodes.find(n => n.attributes.id === 'business')?.live?.value).toBe('B');
  expect(f.compare(b)).toBeUndefined();
  await f.page.locator('#business').evaluate(el => { (el as HTMLInputElement).value = 'A'; });
  await f.page.locator('#external').evaluate(el => el.setAttribute('data-record', 'external-B'));
  expect(f.compare(await f.host.observe(f.sid))).toBeUndefined();
  expect(f.compare(f.before)).toBeDefined(); // Historical evidence is immutable; it was not relabeled as B.
});

it('rejects absent, omitted or malformed v2 native proof even when both sides claim completeness', async () => {
  const f = await fixture();
  for (const change of ['missing-inventory', 'missing-root', 'missing-live', 'missing-reference', 'incomplete-root'] as const) {
    const before = structuredClone(f.before), after = structuredClone(f.after), graph = mutableOwnerGraph(before);
    const root = graph.nativeRoots![0], hidden = graph.nodes.find(node => node.id === root.instanceId)!;
    if (change === 'missing-inventory') delete graph.nativeInputIds;
    if (change === 'missing-root') graph.nativeRoots = [];
    if (change === 'missing-live') delete hidden.live!.value;
    if (change === 'missing-reference') graph.references = [];
    if (change === 'incomplete-root') root.complete = false;
    after.ownerDependencyDispatch!.graphKey = hash(graph); // Isolate reader validation; this does not edit stored evidence.
    expect(f.compare(before, before, after), change).toBeUndefined();
  }
  const legacy = structuredClone(f.before); legacy.ownerDependencies = { ...readOwnerGraph(legacy), version: 'browser-owner-dependencies-v1', inventoryComplete: false,
    nativeInputIds: undefined, nativeRoots: undefined, roots: [], closures: [], nodes: [], references: [], complete: false, reasons: ['unretained_native_input'] };
  expect(f.compare(legacy)).toBeUndefined();
});

it('keeps shared node/byte limits and refuses a truncated native dependency instead of waiving it', async () => {
  const f = await fixture();
  for (const limits of [{nodes: 2, references: 64, bytes: 131072, depth: 16}, {nodes: 512, references: 64, bytes: 2048, depth: 16}]) {
    const graph = await f.page.evaluate(`(() => { const __name = fn => fn; const tracker = window.__interactionEvidenceTracker;
      const controls = ${JSON.stringify(f.after.controls)}, all = [...document.querySelectorAll('*')];
      const instance = el => { if (!tracker.ids.has(el)) tracker.ids.set(el, tracker.documentId + ':' + ++tracker.counter); return tracker.ids.get(el); };
      return (${collectOwnerDependencies.toString()})(controls, controls.map(c => all.find(el => tracker.ids.get(el) === c.instanceId)), instance, tracker.documentId, ${JSON.stringify(limits)});
    })()`) as OwnerDependencies;
    expect(graph.complete).toBe(false); expect(graph.reasons).toContain(limits.nodes === 2 ? 'node_budget' : 'byte_budget');
    expect(Buffer.byteLength(JSON.stringify(graph))).toBeLessThanOrEqual(limits.bytes);
    const before = {...structuredClone(f.before), ownerDependencies: graph}, after = structuredClone(f.after);
    after.ownerDependencyDispatch!.graphKey = hash(graph);
    expect(f.compare(before, before, after)).toBeUndefined();
  }
});
