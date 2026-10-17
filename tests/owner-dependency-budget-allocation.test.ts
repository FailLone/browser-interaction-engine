import { readOwnerGraph, mutableOwnerGraph, compactOwnerGraph } from './owner-dependency-helpers.js';
import { createServer } from 'node:http';
import { afterEach, expect, it } from 'vitest';
import { hash } from '@interaction/core';
import { BrowserEngine, type Observation, type OwnerDependencies, type OwnerDependencyLimits } from '@interaction/browser';
import { MemoryStore } from '@interaction/storage-memory';
import { collectOwnerDependencies } from '../packages/adapter-playwright/src/owner-dependencies.js';
import { documentCoverageReader } from '../packages/browser/src/document-coverage.js';
import { pageOf } from './helpers.js';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function fixture(large = true) {
  const padding = large ? Array.from({ length: 130 }, (_, i) => `<div data-padding="${'x'.repeat(2048)}">${i}</div>`).join('') : '';
  const later = large ? Array.from({ length: 80 }, (_, i) => `<section><button id="later-${i}">Later ${i}</button></section>`).join('') : '';
  // The optional owner is also a required root's ancestor. Text and editable
  // fields intentionally occur after the large optional owner in DOM order.
  const html = `<!doctype html><main id="shared"><ul><li data-record="flag"><input id="flag" type="checkbox" aria-label="Flag"><a href="/flag">Flag record</a></li><li data-record="mode"><i id="mode" role="button" aria-label="Hidden mode" aria-expanded="false" hidden></i><a href="/mode">Mode record</a></li></ul><section><input id="business" type="hidden" value="A"></section><button id="optional">Optional</button>${padding}<section><input id="field" value="A" aria-label="Field"></section><section><div id="editor" contenteditable="true" role="textbox" aria-label="Editor">A</div></section>${later}</main>`;
  const site = createServer((_req, res) => { res.setHeader('content-type', 'text/html'); res.end(html); });
  await new Promise<void>(resolve => site.listen(0, '127.0.0.1', resolve));
  cleanup.push(() => new Promise<void>(resolve => site.close(() => resolve())));
  const host = new BrowserEngine({ persistence: new MemoryStore() }); cleanup.push(() => host.close());
  const session = await host.createSession({ url: `http://127.0.0.1:${(site.address() as { port: number }).port}/`, headless: true,
    exploration: 'controls', settleMs: 0, observeTimeoutMs: 100, evidence: { enabled: false } });
  const observation = host.observation(session.id), flag = observation.controls.find(c => c.selector === '#flag')!;
  const action = host.actions(session.id).find(a => a.localId === flag.localId && a.kind === 'check' && a.value === true)!;
  const attempt = await host.execute(session.id, action.id, 'allocation-receipt');
  expect(attempt.status).toBe('succeeded');
  const before = host.observation(session.id, attempt.beforeId), after = host.observation(session.id, attempt.afterId!);
  const compare = (current: Observation, source = before, result = after) => documentCoverageReader((a, _o, old) => ({ source: old.action, target: a, evidence: ['allocation-fixture'] }))(
    { ...action, observationId: current.id, stateId: current.stateId }, current, attempt, source, result);
  const bounded = async (changes: Partial<OwnerDependencyLimits>, mismatch = false) => {
    const controls = structuredClone(host.observation(session.id).controls);
    if (mismatch) controls[controls.length - 1].instanceId = 'not-the-retained-element';
    return await pageOf(host).evaluate(`(() => { const __name = fn => fn; const tracker = window.__interactionEvidenceTracker;
      const controls = ${JSON.stringify(controls)}, all = [...document.querySelectorAll('*')];
      const instance = el => { if (!tracker.ids.has(el)) tracker.ids.set(el, tracker.documentId + ':' + ++tracker.counter); return tracker.ids.get(el); };
      return (${collectOwnerDependencies.toString()})(controls, controls.map(c => all.find(el => tracker.ids.get(el) === c.instanceId)), instance, tracker.documentId,
        ${JSON.stringify({ nodes: 512, references: 64, bytes: 131072, depth: 16, ...changes })});
    })()`) as OwnerDependencies;
  };
  return { host, sid: session.id, before, after, attempt, compare, bounded };
}
function rootFor(o: Observation, selector: string) {
  const control = o.controls.find(c => c.selector === selector)!;
  return readOwnerGraph(o).roots.find(root => root.localId === control.localId)!;
}
function withinBudget(graph: OwnerDependencies) {
  expect(Buffer.byteLength(JSON.stringify(graph))).toBeLessThanOrEqual(graph.limits.bytes);
  expect(graph.nodes.length).toBeLessThanOrEqual(graph.limits.nodes);
  expect(graph.references.length).toBeLessThanOrEqual(graph.limits.references);
}

it('preserves complete required roots and a real receipt proof after a large later optional owner exhausts bytes', async () => {
  const f = await fixture(), graph = readOwnerGraph(f.before);
  expect(graph).toMatchObject({ inventoryComplete: true, complete: false, reasons: expect.arrayContaining(['byte_budget']) });
  expect(graph.roots.map(root => root.localId).sort()).toEqual(f.before.controls.map(control => control.localId).sort());
  expect(graph.nativeRoots).toHaveLength(1); expect(graph.nativeRoots![0].complete).toBe(true);
  for (const selector of ['#flag', '#mode', '#field', '#editor']) expect(rootFor(f.before, selector).complete, selector).toBe(true);
  expect(rootFor(f.before, '#optional')).toMatchObject({ complete: false, reasons: expect.arrayContaining(['byte_budget']) });
  expect(rootFor(f.before, '#later-79').complete).toBe(false);
  expect(f.before.controls.find(c => c.selector === '#field')?.checked).toBeNull();
  expect(f.before.controls.find(c => c.selector === '#editor')?.editable).toBe(true);
  expect(Buffer.byteLength(JSON.stringify(f.before.ownerDependencies))).toBeLessThanOrEqual(graph.limits.bytes);
  expect(f.after.ownerDependencyDispatch?.graphKey).toBe(hash(f.before.ownerDependencies));
  expect(f.host.operationReceiptCondition(f.sid, { attemptId: f.attempt.id })).toMatchObject({
    actualSuccess: true, conditionVerified: true, status: 'document', identityAuthorized: false,
    replayAuthorized: false, currentExecution: false, arrivalVerified: false,
  });
});

it('does not change required proof when a later optional owner expands a shared ancestor before failing', async () => {
  const f = await fixture(), graph = readOwnerGraph(f.before), main = graph.nodes.find(node => node.attributes.id === 'shared')!;
  expect(main.children?.length).toBeGreaterThan(100); // The optional collection really did upgrade this ancestor.
  const required = graph.closures.find(closure => closure.id === rootFor(f.before, '#flag').closureId)!;
  expect(required.nodeIds).toContain(main.id); expect(required.subtreeIds).not.toContain(main.id);
  const proof = f.compare(f.before); expect(proof).toBeDefined();
  // Reader-only comparison with the earlier ancestor-only representation. The
  // clones and witness below are synthetic and never written to the host store.
  const earlier = structuredClone(f.before), earlierMain = mutableOwnerGraph(earlier).nodes.find(node => node.id === main.id)!;
  delete earlierMain.children; earlierMain.childrenComplete = false; compactOwnerGraph(earlier);
  const witness = structuredClone(f.after); witness.ownerDependencyDispatch!.graphKey = hash(earlier.ownerDependencies);
  expect(f.compare(f.before, earlier, witness)).toEqual(proof);
  const reordered = structuredClone(f.before); mutableOwnerGraph(reordered).roots.reverse(); compactOwnerGraph(reordered);
  witness.ownerDependencyDispatch!.graphKey = hash(reordered.ownerDependencies);
  expect(f.compare(reordered, reordered, witness)).toEqual(proof); // Root inventory order is not condition semantics.
  expect(hash(f.host.observation(f.sid, f.before.id).ownerDependencies)).toBe(hash(f.before.ownerDependencies));
});

it.each([{ nodes: 3 }, { bytes: 2048 }] as const)('still denies required or inventory exhaustion under %s', async limits => {
  const f = await fixture(false), graph = await f.bounded(limits);
  expect(graph.complete).toBe(false); expect(graph.reasons).toContain('nodes' in limits ? 'node_budget' : 'byte_budget');
  withinBudget(graph);
  const before = { ...structuredClone(f.before), ownerDependencies: graph }, after = structuredClone(f.after);
  after.ownerDependencyDispatch!.graphKey = hash(graph);
  expect(f.compare(before, before, after)).toBeUndefined();
});

it('checks the entire retained-control mapping before committing any dependency payload', async () => {
  const f = await fixture(false), graph = await f.bounded({}, true);
  expect(graph).toMatchObject({ inventoryComplete: false, complete: false, reasons: ['control_element_mismatch'], roots: [], nativeRoots: [], nodes: [], closures: [], references: [] });
  withinBudget(graph);
});
