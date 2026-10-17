import { chromium, type Browser } from 'playwright';
import { afterEach, expect, it } from 'vitest';
import type { OwnerDependencies, OwnerDependencySnapshot } from '@interaction/adapter-playwright';
import { collectOwnerDependencies } from '../packages/adapter-playwright/src/owner-dependencies.js';
import { createOwnerDependencyCodec } from '../packages/adapter-playwright/src/owner-dependency-codec.js';

const browsers: Browser[] = [];
afterEach(async () => { for (const browser of browsers.splice(0)) await browser.close(); });
async function capture(html: string, reference = true, setup?: string) {
  const browser = await chromium.launch({ headless: true }); browsers.push(browser);
  const page = await browser.newPage(); await page.setContent(`<!doctype html>${html}`);
  if (setup) await page.evaluate(setup);
  return await page.evaluate(`(() => { const __name = fn => fn;
    const collect = (${collectOwnerDependencies.toString()}), factory = (${createOwnerDependencyCodec.toString()});
    const documentId = '29bf5614-9dd5-4b6d-9caa-0be76239c708', ids = new WeakMap(); let next = 0;
    const instance = el => { if (!ids.has(el)) ids.set(el, documentId + ':' + ++next); return ids.get(el); };
    const elements = [...document.querySelectorAll('[data-control]')];
    const controls = elements.map(el => ({ localId: instance(el), instanceId: instance(el), tag: el.tagName.toLowerCase(),
      role: el.getAttribute('role') || (el instanceof HTMLInputElement && el.type === 'checkbox' ? 'checkbox' : 'button'),
      checked: el instanceof HTMLInputElement && el.type === 'checkbox' ? el.checked : null,
      pressed: null, expanded: el.hasAttribute('aria-expanded') ? el.getAttribute('aria-expanded') === 'true' : null,
      editable: el instanceof HTMLInputElement && el.type !== 'hidden' || el.isContentEditable }));
    const progress = { mutations: 0, maxWire: 0, maxExpanded: 0, failures: [] };
    const tracked = () => { const codec = factory(); return { ...codec, createBuilder(initial) {
      const builder = codec.createBuilder(initial); if (!builder) return;
      const observe = () => { const s = builder.stats(); progress.maxWire = Math.max(progress.maxWire, s.wireBytes + s.reservedBytes);
        progress.maxExpanded = Math.max(progress.maxExpanded, s.expandedBytes + s.reservedBytes);
        if (s.failure && !progress.failures.includes(s.failure)) progress.failures.push(s.failure); };
      observe(); return new Proxy(builder, { get(target, key) { const value = target[key];
        if (typeof value !== 'function' || key === 'stats') return value;
        return (...args) => { const result = value(...args); progress.mutations++; observe(); return result; };
      }});
    }}; };
    const limits = { nodes: 512, references: 64, bytes: 131072, depth: 16 };
    const raw = ${reference} ? collect(controls, elements, instance, documentId, { ...limits, bytes: 1048576 }) : undefined;
    const snapshot = collect(controls, elements, instance, documentId, limits, tracked);
    const decoded = factory().decode(snapshot);
    return { raw, snapshot, decoded, progress, controls: controls.map((c, i) => ({ localId: c.localId, id: elements[i].id })) };
  })()`) as { raw?: OwnerDependencies; snapshot: OwnerDependencySnapshot; decoded?: OwnerDependencies;
    progress: { mutations: number; maxWire: number; maxExpanded: number; failures: string[] }; controls: { localId: string; id: string }[] };
}
function bounds(result: Awaited<ReturnType<typeof capture>>) {
  expect(result.snapshot.version).toBe('browser-owner-dependencies-v3'); expect(result.decoded).toBeDefined();
  expect(Buffer.byteLength(JSON.stringify(result.snapshot))).toBeLessThanOrEqual(131072);
  expect(Buffer.byteLength(JSON.stringify(result.decoded))).toBeLessThanOrEqual(1048576);
  expect(result.progress.maxWire).toBeLessThanOrEqual(131072); expect(result.progress.maxExpanded).toBeLessThanOrEqual(1048576);
  expect(result.decoded!.nodes.length).toBeLessThanOrEqual(512); expect(result.decoded!.references.length).toBeLessThanOrEqual(64);
}
function root(result: Awaited<ReturnType<typeof capture>>, id: string) {
  const localId = result.controls.find(c => c.id === id)!.localId;
  return result.decoded!.roots.find(item => item.localId === localId)!;
}
function legacyFacts(graph: OwnerDependencies) {
  const { ancestry: _ancestry, ...facts } = graph;
  return { ...facts, references: graph.references.map(({ lookup: _lookup, ...ref }) => ref) };
}

it('incrementally retains a complete graph larger than the wire cap with exactly the same raw semantic facts', async () => {
  const rows = Array.from({ length: 120 }, (_, i) => `<li data-record="record-${i}"><button data-control id="mode-${i}" aria-expanded="false" ${i === 0 ? 'aria-describedby="external"' : ''}>Mode ${i}</button><span>Detail ${i}</span></li>`).join('');
  const result = await capture(`<main><ul>${rows}</ul><section><input type="hidden" value="A" aria-describedby="external"></section><span id="external">External state</span></main>`);
  bounds(result); expect(result.raw!.complete).toBe(true); expect(result.decoded!.complete).toBe(true);
  expect(Buffer.byteLength(JSON.stringify(result.raw))).toBeGreaterThan(131072);
  expect(legacyFacts(result.decoded!)).toEqual({ ...result.raw, limits: result.decoded!.limits });
  expect(result.progress.mutations).toBeGreaterThan(result.decoded!.nodes.length);
  expect(result.progress.failures).toEqual([]);
});

it('keeps complete native and editable roots when later optional compact payload exhausts the unchanged wire cap', async () => {
  const padding = Array.from({ length: 130 }, (_, i) => `<div data-padding="${'x'.repeat(2048)}">${i}</div>`).join('');
  const result = await capture(`<main><section><input data-control id="flag" type="checkbox"></section><section><input type="hidden" value="A"></section><button data-control id="optional">Optional</button>${padding}<section><input data-control id="field" value="A"></section><section><div data-control id="editor" contenteditable="true">A</div></section></main>`, false);
  bounds(result); expect(result.decoded!.inventoryComplete).toBe(true); expect(result.decoded!.complete).toBe(false);
  for (const id of ['flag', 'field', 'editor']) expect(root(result, id).complete, id).toBe(true);
  expect(result.decoded!.nativeRoots![0].complete).toBe(true);
  expect(root(result, 'optional')).toMatchObject({ complete: false, reasons: expect.arrayContaining(['byte_budget']) });
  expect(result.progress.failures).toContain('byte_budget');
});

it('rejects oversized raw candidate values without constructing an unbounded expanded graph first', async () => {
  const result = await capture(`<section><input type="hidden" value="${'x'.repeat(1048577)}"></section><section><button data-control id="mode" aria-expanded="false">Mode</button></section>`, false);
  bounds(result); expect(result.decoded!.complete).toBe(false);
  expect(result.decoded!.reasons).toContain('raw_byte_budget');
  expect(result.decoded!.nativeRoots![0]).toMatchObject({ complete: false, reasons: expect.arrayContaining(['raw_byte_budget']) });
  expect(result.progress.maxExpanded).toBeLessThan(100000);
});

it('records explicit negative light-DOM lookup while legacy absence remains unavailable', async () => {
  const result = await capture('<main><section><button data-control id="missing" aria-expanded="false" aria-controls="absent">Missing</button></section></main>');
  bounds(result);
  const legacyMissing = result.raw!.roots.find(item => item.localId === root(result, 'missing').localId)!;
  expect(legacyMissing).toMatchObject({ complete: false, reasons: expect.arrayContaining(['missing_idref']) });
  expect(root(result, 'missing')).toMatchObject({ complete: true, reasons: [] });
  expect(result.decoded!.references.find(ref => ref.token === 'absent')).toMatchObject({ status: 'missing', targetIds: [],
    lookup: { scope: 'document-light-dom', documentId: result.decoded!.documentId, matches: 0 } });
});

it('retains complete node-bounded ancestry while preserving subtree depth and total node limits', async () => {
  const nested = '<div>'.repeat(19), closing = '</div>'.repeat(19);
  const result = await capture(`<main>${nested}<button data-control id="deep" aria-expanded="false">Deep</button>${closing}<section><button data-control id="subtree" aria-expanded="false">Subtree</button>${nested}<span>Leaf</span>${closing}</section></main>`);
  bounds(result); expect(result.decoded!.ancestry).toBe('node-bounded-v1');
  const deep = root(result, 'deep');
  expect(result.raw!.roots.find(item => item.localId === deep.localId)).toMatchObject({ complete: false, reasons: expect.arrayContaining(['ancestor_depth']) });
  expect(deep).toMatchObject({ complete: true, reasons: [] });
  const closure = result.decoded!.closures.find(item => item.id === deep.closureId)!;
  let node = result.decoded!.nodes.find(item => item.id === deep.instanceId)!;
  const chain = [node];
  while (node.parentId) { node = result.decoded!.nodes.find(item => item.id === node.parentId)!; chain.push(node); }
  expect(chain.length).toBeGreaterThan(17); expect(node.tag).toBe('html');
  expect(chain.every(item => closure.nodeIds.includes(item.id))).toBe(true);
  expect(root(result, 'subtree')).toMatchObject({ complete: false, reasons: expect.arrayContaining(['dependency_depth']) });
  const over = await capture('<main id="chain"></main><button data-control id="over" aria-expanded="false">Over</button>', false,
    `(() => { let node = document.querySelector('#chain'); for (let i = 0; i < 513; i++) { const child = document.createElement('div'); node.append(child); node = child; } node.append(document.querySelector('#over')); })()`);
  bounds(over); expect(over.decoded!.inventoryComplete).toBe(true);
  expect(root(over, 'over')).toMatchObject({ complete: false, reasons: expect.arrayContaining(['node_budget']) });
});

it.each([
  ['failed-query', `(() => { const query = document.querySelectorAll.bind(document); document.querySelectorAll = selector => { if (selector === '#absent') throw Error('fixture query failure'); return query(selector); }; })()`, 'idref_lookup_failed'],
  ['inexact-NUL', `document.querySelector('#missing').setAttribute('aria-controls', '\\0')`, 'unsupported_idref_token'],
  ['shadow-source', `document.querySelector('#missing').attachShadow({mode: 'open'})`, 'unsupported_shadow_scope'],
] as const)('never records complete negative lookup for %s', async (_name, setup, reason) => {
  const result = await capture('<section><div data-control id="missing" role="button" aria-expanded="false" aria-controls="absent">Missing</div></section>', false, setup);
  bounds(result); expect(root(result, 'missing')).toMatchObject({ complete: false, reasons: expect.arrayContaining([reason]) });
  expect(result.decoded!.references.every(ref => !ref.lookup)).toBe(true);
});
