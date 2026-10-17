import { readOwnerGraph } from './owner-dependency-helpers.js';
import { createServer } from 'node:http';
import { afterEach, expect, it } from 'vitest';
import { BrowserEngine, type Observation, type OwnerDependencies, type OwnerDependencyLimits } from '@interaction/browser';
import { MemoryStore } from '@interaction/storage-memory';
import { collectOwnerDependencies } from '../packages/adapter-playwright/src/owner-dependencies.js';
import { browserBranchConditions } from '../packages/adapter-playwright/src/branch-conditions.js';
import { pageOf } from './helpers.js';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); });
async function fixture(html: string) {
  const site = createServer((_req, res) => { res.setHeader('Content-Type', 'text/html'); res.end(html); });
  await new Promise<void>(resolve => site.listen(0, '127.0.0.1', resolve));
  const engine = new BrowserEngine({ persistence: new MemoryStore() });
  cleanup.push(async () => { await engine.close(); await new Promise<void>(resolve => site.close(() => resolve())); });
  const session = await engine.createSession({ url: `http://127.0.0.1:${(site.address() as { port: number }).port}/`, headless: true,
    contextRules: [], exploration: 'controls', settleMs: 0, observeTimeoutMs: 100, evidence: { enabled: false } });
  const observe = async () => { await engine.observe(session.id); return engine.observation(session.id); };
  return { engine, sid: session.id, page: pageOf(engine), observe, current: () => engine.observation(session.id) };
}
function dependency(o: Observation, selector: string) {
  const c = o.controls.find(c => c.selector === selector)!, graph = readOwnerGraph(o);
  const root = graph.roots.find(root => root.localId === c.localId)!, closure = graph.closures.find(closure => closure.id === root.closureId)!;
  return { c, graph, root, closure, nodes: graph.nodes.filter(node => closure.nodeIds.includes(node.id)), refs: graph.references.filter((_, i) => closure.referenceIds.includes(i)) };
}
async function bounded(f: Awaited<ReturnType<typeof fixture>>, changes: Partial<OwnerDependencyLimits>) {
  const controls = f.current().controls, limits = { nodes: 512, references: 64, bytes: 131072, depth: 16, ...changes };
  return f.page.evaluate(`(() => { const __name = fn => fn; const tracker = window.__interactionEvidenceTracker;
    const controls = ${JSON.stringify(controls)}; const elements = [...document.querySelectorAll('*')];
    const instance = el => { if (!tracker.ids.has(el)) tracker.ids.set(el, tracker.documentId + ':' + ++tracker.counter); return tracker.ids.get(el); };
    return (${collectOwnerDependencies.toString()})(controls, controls.map(c => elements.find(el => tracker.ids.get(el) === c.instanceId)), instance, tracker.documentId, ${JSON.stringify(limits)});
  })()`) as Promise<OwnerDependencies>;
}

it('retains hidden parent data and sibling href rebinding without changing legacy control identity or portable refusal', async () => {
  const f = await fixture(`<style>ul{visibility:hidden}</style><ul><li data-record="A"><i id="mode-a" role="button" aria-label="Open sub-menu" aria-expanded="false"></i><a href="/record-A">Record</a></li><li data-record="C"><i id="mode-c" role="button" aria-label="Open sub-menu" aria-expanded="false"></i><a href="/record-C">Record</a></li></ul><section><button id="run">Run</button></section>`);
  const first = f.current(), saved = structuredClone(first), a = dependency(first, '#mode-a');
  expect(a.root.complete).toBe(true); expect(a.graph.inventoryComplete).toBe(true);
  expect(a.graph.selectorIds).toEqual(expect.arrayContaining([a.c.localId, dependency(first, '#mode-c').c.localId]));
  expect(a.nodes.find(n => n.id === a.root.ownerId)?.attributes['data-record']).toBe('A');
  expect(a.nodes.some(n => n.attributes.href === '/record-A')).toBe(true);
  await f.page.locator('li').first().evaluate(el => el.setAttribute('data-record', 'B'));
  const second = await f.observe(), b = dependency(second, '#mode-a');
  expect(b.c).toEqual(a.c); expect(b.nodes.find(n => n.id === b.root.ownerId)?.attributes['data-record']).toBe('B');
  await f.page.locator('li > a').first().evaluate(el => el.setAttribute('href', '/record-B'));
  const third = await f.observe(), c = dependency(third, '#mode-a');
  expect(c.c).toEqual(a.c); expect(c.nodes.some(n => n.attributes.href === '/record-B' && n.resolved?.href?.endsWith('/record-B'))).toBe(true);
  const run = f.engine.actions(f.sid).find(action => action.localId === dependency(third, '#run').c.localId)!;
  expect(browserBranchConditions(run, third)).toBeUndefined(); expect(first).toEqual(saved);
});

it('captures a plain parent subtree rather than assuming non-record sibling links are irrelevant', async () => {
  const f = await fixture('<div data-binding="A"><button id="mode" aria-expanded="false">Mode</button><a id="link" href="/A">Record</a></div>');
  const first = dependency(f.current(), '#mode'), link = dependency(f.current(), '#link');
  expect(first.root.complete).toBe(true); expect(first.root.closureId).toBe(link.root.closureId);
  expect(first.graph.closures).toHaveLength(1); expect(new Set(first.graph.nodes.map(n => n.id)).size).toBe(first.graph.nodes.length);
  await f.page.locator('#link').evaluate(el => el.setAttribute('href', '/B'));
  const next = dependency(await f.observe(), '#mode');
  expect(next.c.stableKey).toBe(first.c.stableKey); expect(next.c.identityId).toBe(first.c.identityId);
  expect(next.nodes.some(n => n.attributes.href === '/B')).toBe(true);
});

it('retains nested panel changes in raw dependencies while keeping parent record identity separate', async () => {
  const f = await fixture('<ul><li><a href="/service">Service</a><button id="open" aria-expanded="false">Open</button><div role="tabpanel" hidden><a id="child" href="/result-A">Result</a></div></li></ul>');
  const first = dependency(f.current(), '#open');
  await f.page.locator('#child').evaluate(el => el.setAttribute('href', '/result-B'));
  const next = dependency(await f.observe(), '#open');
  expect(next.root.complete).toBe(true); expect(next.c.stableKey).toBe(first.c.stableKey); expect(next.c.identityId).toBe(first.c.identityId);
  expect(first.nodes.some(n => n.attributes.href === '/result-A')).toBe(true); expect(next.nodes.some(n => n.attributes.href === '/result-B')).toBe(true);
});

it('captures transitive IDREF targets, text and cyclic references once with verifiable closure membership', async () => {
  const f = await fixture('<section><button id="mode" aria-expanded="false" aria-describedby="outer">Mode</button></section><span id="outer" aria-details="inner">First</span><span id="inner" aria-controls="mode" data-record="A">Second</span>');
  const first = dependency(f.current(), '#mode');
  expect(first.root.complete).toBe(true); expect(first.refs.map(ref => ref.token)).toEqual(expect.arrayContaining(['outer', 'inner', 'mode']));
  expect(first.refs.every(ref => ref.status === 'unique' && ref.targetIds.every(id => first.closure.nodeIds.includes(id)))).toBe(true);
  expect(first.closure.nodeIds).toEqual([...first.closure.nodeIds].sort());
  await f.page.locator('#inner').evaluate(el => { el.setAttribute('data-record', 'B'); el.textContent = 'Changed'; });
  const next = dependency(await f.observe(), '#mode');
  expect(next.nodes.find(n => n.attributes.id === 'inner')).toMatchObject({ attributes: { 'data-record': 'B' }, children: [{ text: 'Changed' }], childrenComplete: true });
});

it.each(['missing', 'duplicate'] as const)('records %s IDREF lookup without choosing an ambiguous target', async variant => {
  const f = await fixture(`<section><button id="mode" aria-expanded="false" aria-controls="panel">Mode</button></section>${variant === 'duplicate' ? '<div id="panel">A</div><div id="panel">B</div>' : ''}`);
  const { root, refs, closure } = dependency(f.current(), '#mode');
  expect(root.complete).toBe(variant === 'missing'); expect(closure.complete).toBe(variant === 'missing');
  expect(refs.find(ref => ref.token === 'panel')).toMatchObject({ status: variant === 'missing' ? 'missing' : 'ambiguous',
    lookup: { scope: 'document-light-dom', documentId: f.current().documentId, matches: variant === 'missing' ? 0 : 2 } });
  if (variant === 'missing') expect(root.reasons).toEqual([]);
  else expect(root.reasons).toContain('ambiguous_idref');
});

it('captures native property state and external form ownership when HTML attributes remain unchanged', async () => {
  const f = await fixture('<form id="external"><select id="choice"><option>A</option><option>B</option></select></form><section><input id="check" type="checkbox" form="external"><input id="text" value="A"><textarea id="area">A</textarea><button id="run">Run</button></section>');
  const first = dependency(f.current(), '#check'), originalMarkup = await f.page.locator('section').evaluate(el => el.innerHTML);
  expect(first.refs.some(ref => ref.attribute === 'native:form' && ref.status === 'unique')).toBe(true);
  await f.page.evaluate(() => {
    const check = document.querySelector<HTMLInputElement>('#check')!; check.checked = true; check.indeterminate = true;
    document.querySelector<HTMLInputElement>('#text')!.value = 'B'; document.querySelector<HTMLTextAreaElement>('#area')!.value = 'B';
    document.querySelector<HTMLSelectElement>('#choice')!.selectedIndex = 1;
  });
  expect(await f.page.locator('section').evaluate(el => el.innerHTML)).toBe(originalMarkup);
  const next = dependency(await f.observe(), '#check'); expect(next.root.complete).toBe(true);
  expect(next.nodes.find(n => n.attributes.id === 'check')?.live).toMatchObject({ checked: true, indeterminate: true });
  for (const id of ['text', 'area', 'choice']) expect(next.nodes.find(n => n.attributes.id === id)?.live?.value).toBe('B');
  expect(next.nodes.filter(n => n.tag === 'option').map(n => n.live?.selected)).toEqual([false, true]);
});

it('distinguishes a complete required closure from an unrelated broad body owner without losing the inventory', async () => {
  const f = await fixture('<section><button id="mode" aria-expanded="false">Mode</button></section><button id="broad">Broad</button>');
  const mode = dependency(f.current(), '#mode'), broad = dependency(f.current(), '#broad');
  expect(mode.root.complete).toBe(true); expect(broad.root.complete).toBe(false); expect(broad.root.reasons).toContain('broad_owner_scope');
  expect(mode.graph.complete).toBe(false); expect(mode.graph.inventoryComplete).toBe(true);
  expect(mode.graph.roots).toHaveLength(f.current().controls.length);
  const body = mode.nodes.find(n => n.tag === 'body')!; expect(body.childrenComplete).toBe(false); expect(body.children).toBeUndefined();
});

it('records complete native association inventories, including explicit absence and an external label edge', async () => {
  const f = await fixture('<section><input id="field"><button id="run">Run</button></section><label id="external" for="field">Field</label>');
  const field = dependency(f.current(), '#field'), run = dependency(f.current(), '#run');
  const node = field.nodes.find(n => n.id === field.c.instanceId)!;
  expect(node.associations).toMatchObject({ formId: '', labelIds: [expect.any(String)] });
  expect(field.refs.filter(ref => ref.attribute === 'native:label')).toEqual([{ sourceId: node.id, attribute: 'native:label', token: node.associations!.labelIds![0], status: 'unique', targetIds: node.associations!.labelIds }]);
  expect(run.nodes.find(n => n.id === run.c.instanceId)?.associations).toEqual({ formId: '', labelIds: [] });
  await f.page.locator('#external').evaluate(el => el.removeAttribute('for'));
  const next = dependency(await f.observe(), '#field');
  expect(next.nodes.find(n => n.id === next.c.instanceId)?.associations).toEqual({ formId: '', labelIds: [] });
  expect(next.refs.some(ref => ref.attribute === 'native:label')).toBe(false);
});

it('retains a legal __proto__ HTML attribute as raw evidence', async () => {
  const f = await fixture('<section __proto__="original"><button id="mode" aria-expanded="false">Mode</button></section>');
  const first = dependency(f.current(), '#mode'), node = first.nodes.find(n => n.id === first.root.ownerId)!;
  expect(Object.hasOwn(node.attributes, '__proto__')).toBe(true); expect(node.attributes.__proto__).toBe('original');
  await f.page.locator('section').evaluate(el => el.setAttribute('__proto__', 'changed'));
  const next = dependency(await f.observe(), '#mode'); expect(next.nodes.find(n => n.id === next.root.ownerId)?.attributes.__proto__).toBe('changed');
});

it.each([
  [{ nodes: 2 }, 'node_budget'], [{ references: 1 }, 'reference_budget'], [{ depth: 1 }, 'ancestor_depth'], [{ bytes: 2048 }, 'byte_budget'],
] as const)('reports bounded incomplete evidence for %s', async (limits, reason) => {
  const f = await fixture('<section><div><button id="mode" aria-expanded="false" aria-controls="one two">Mode</button><span>Raw text</span></div></section><span id="one">One</span><span id="two">Two</span>');
  const graph = await bounded(f, limits);
  expect(graph.complete).toBe(false); expect(graph.reasons).toContain(reason); expect(graph.roots.every(root => !root.complete)).toBe(true);
  expect(graph.limits).toMatchObject(limits); expect(Buffer.byteLength(JSON.stringify(graph))).toBeLessThanOrEqual(graph.limits.bytes);
});

it('retains formerly omitted native inputs as dependencies without changing the control inventory', async () => {
  const f = await fixture('<section><button id="mode" aria-expanded="false">Mode</button></section><div><input id="hidden-business" type="hidden" value="A"></div>');
  const before = f.current();
  expect(before.controls.some(c => c.selector === '#hidden-business')).toBe(false);
  expect(readOwnerGraph(before)).toMatchObject({ version: 'browser-owner-dependencies-v2', inventoryComplete: true, complete: true, reasons: [] });
  const graph = readOwnerGraph(before), hidden = graph.nodes.find(node => node.attributes.id === 'hidden-business')!;
  expect(graph.nativeInputIds).toContain(hidden.id); expect(graph.nativeRoots).toEqual([expect.objectContaining({ instanceId: hidden.id, complete: true })]);
  expect(hidden.live?.value).toBe('A');
  await f.page.locator('#hidden-business').evaluate(el => { (el as HTMLInputElement).value = 'B'; });
  const after = await f.observe();
  expect(after.controls).toEqual(before.controls);
  expect(readOwnerGraph(after).nodes.find(node => node.id === hidden.id)?.live?.value).toBe('B');
  expect(readOwnerGraph(after).nativeInputIds).toEqual(graph.nativeInputIds);
  expect(f.engine.actions(f.sid).some(action => action.localId === hidden.id)).toBe(false);
});
