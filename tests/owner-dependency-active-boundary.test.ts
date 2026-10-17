import { chromium } from 'playwright';
import { expect, it } from 'vitest';
import { BrowserAdapter } from '../packages/adapter-playwright/src/browser.js';
import { sessionSchema } from '../packages/adapter-playwright/src/schema.js';
import { collectOwnerDependencies } from '../packages/adapter-playwright/src/owner-dependencies.js';
import { createOwnerDependencyCodec } from '../packages/adapter-playwright/src/owner-dependency-codec.js';
import type { OwnerDependencySnapshot } from '@interaction/adapter-playwright';

it('retains ordinary active-boundary targets before optional payload while preserving global dependencies', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    const padding = Array.from({ length: 80 }, (_, i) => `<div data-padding="${'x'.repeat(4096)}">${i}</div>`).join('');
    const html = `<!doctype html><main><section><input type="hidden" value="A"></section><section><button id="background">Background</button>${padding}</section><aside><div role="dialog" aria-modal="true" aria-label="Current panel" style="position:fixed;inset:20px;width:300px;height:150px"><section data-owner-binding="${'y'.repeat(9000)}"><button id="target">Proceed</button></section><section><button id="exit">Close</button></section></div></aside><section><input id="global-mode" type="checkbox" aria-label="Global mode"></section></main>`;
    // A secure fixture origin supplies the normal crypto API; every request is
    // fulfilled in memory, without starting a service or reaching a website.
    await page.route('**/*', route => route.fulfill({ status: 200, contentType: 'text/html', body: html }));
    await page.goto('https://fixture.invalid/');
    const driver = new BrowserAdapter(sessionSchema.parse({ url: 'https://fixture.invalid/', exploration: 'controls', evidence: { enabled: false } }),
      { put: async () => { throw Error('Fixture must not persist evidence'); }, get: async () => undefined });
    driver.page = page;
    const dom = await driver.readDOM(), codec = createOwnerDependencyCodec(), graph = codec.decode(dom.ownerDependencies)!;
    const target = dom.controls.find(control => control.selector === '#target')!;
    const global = dom.controls.find(control => control.selector === '#global-mode')!;
    const exit = dom.controls.find(control => control.selector === '#exit')!;
    const active = dom.overlays.at(-1)!;
    expect(dom.controls.indexOf(global)).toBeGreaterThan(dom.controls.indexOf(target));
    expect(active.key).toBe(dom.boundaries.at(-1)?.key); expect(active.controlIds).toContain(target.localId);
    expect(active.exitControlIds).not.toContain(target.localId); // Priority is not a Close-name special case.
    expect(active.exitControlIds).toContain(exit.localId);
    expect(graph.selectorIds).not.toContain(target.localId); expect(target.editable).toBe(false);
    // Same DOM and control inventory, with only the former absence of explicit
    // boundary priority. No old observation or retained graph is modified.
    const legacy = await page.evaluate(`(() => { const __name = fn => fn;
      const tracker = window.__interactionEvidenceTracker, controls = ${JSON.stringify(dom.controls)}, all = [...document.querySelectorAll('*')];
      const instance = el => { if (!tracker.ids.has(el)) tracker.ids.set(el, tracker.documentId + ':' + ++tracker.counter); return tracker.ids.get(el); };
      return (${collectOwnerDependencies.toString()})(controls, controls.map(c => all.find(el => tracker.ids.get(el) === c.instanceId)), instance, tracker.documentId,
        undefined, (${createOwnerDependencyCodec.toString()}));
    })()`) as OwnerDependencySnapshot;
    const old = codec.decode(legacy)!;
    expect(old.roots.find(root => root.localId === target.localId)).toMatchObject({ complete: false, reasons: expect.arrayContaining(['byte_budget']) });
    for (const current of [graph, old]) {
      expect(current.inventoryComplete).toBe(true);
      expect(current.roots.find(root => root.localId === global.localId)?.complete).toBe(true);
      expect(current.nativeRoots).toHaveLength(1); expect(current.nativeRoots![0].complete).toBe(true);
      expect(current.nativeInputIds).toEqual(graph.nativeInputIds);
      expect(current.selectorIds).toEqual(graph.selectorIds);
      expect(current.limits).toEqual({ nodes: 768, references: 64, bytes: 196608, depth: 16 });
      expect(current.nodes.length).toBeLessThanOrEqual(768); expect(current.references.length).toBeLessThanOrEqual(64);
    }
    const root = graph.roots.find(root => root.localId === target.localId)!;
    expect(root.complete).toBe(true);
    const exitRoot = graph.roots.find(root => root.localId === exit.localId)!, globalRoot = graph.roots.find(root => root.localId === global.localId)!;
    expect(exitRoot.complete).toBe(true);
    const capturedAt = (closureId: string) => graph.closures.findIndex(closure => closure.id === closureId);
    expect(capturedAt(globalRoot.closureId)).toBeLessThan(capturedAt(exitRoot.closureId));
    expect(capturedAt(exitRoot.closureId)).toBeLessThan(capturedAt(root.closureId));
    expect(graph.closures.find(closure => closure.id === root.closureId)).toMatchObject({ complete: true, nodeIds: expect.arrayContaining([target.instanceId]) });
    const background = dom.controls.find(control => control.selector === '#background')!;
    expect(graph.roots.find(root => root.localId === background.localId)).toMatchObject({ complete: false, reasons: expect.arrayContaining(['byte_budget']) });
    const wireBytes = Buffer.byteLength(JSON.stringify(dom.ownerDependencies));
    expect(wireBytes).toBeLessThanOrEqual(131072); expect(Buffer.byteLength(JSON.stringify(graph))).toBeLessThanOrEqual(1048576);
    console.log(JSON.stringify({ target: 'ordinary non-selector active-boundary button', oldTargetComplete: false, newTargetComplete: true,
      globalSelectorComplete: true, nativeInventoryPreserved: true, optionalOwnerComplete: false, wireBytes,
      nodes: graph.nodes.length, limits: graph.limits, scope: 'One isolated in-memory HTTPS fixture; no retained OKX graph was recaptured or upgraded.' }));
  } finally { await browser.close(); }
});
