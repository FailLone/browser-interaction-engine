import { readOwnerGraph } from './owner-dependency-helpers.js';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { afterAll, afterEach, expect, it, vi } from 'vitest';
import { BrowserAdapter, BrowserEngine, type ActionCandidate, type Observation } from '@interaction/browser';
import { MemoryStore } from '@interaction/storage-memory';
import { collectOwnerDependencies } from '../packages/adapter-playwright/src/owner-dependencies.js';
import { exitCandidateKey } from '../packages/adapter-playwright/src/boundary-exit.js';

const cleanup: (() => Promise<void>)[] = [];
const diagnostics: unknown[] = [];
const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const sourceBefore = sha(readFileSync('packages/adapter-playwright/src/browser.ts'));
afterEach(async () => { vi.restoreAllMocks(); for (const close of cleanup.splice(0).reverse()) await close(); });
afterAll(() => {
  if (process.env.OWNER_VALIDATION_DIAGNOSTIC) writeFileSync(process.env.OWNER_VALIDATION_DIAGNOSTIC, JSON.stringify({
    purpose: 'One local diagnostic, not a timing benchmark or evidence of real-site speedup', node: process.version,
    sourceBefore, sourceAfter: sha(readFileSync('packages/adapter-playwright/src/browser.ts')), cases: diagnostics,
  }, null, 2) + '\n');
});
async function fixture(html: string, detailed = false) {
  const site = createServer((_req, res) => { res.setHeader('content-type', 'text/html'); res.end(`<!doctype html>${html}`); });
  await new Promise<void>(resolve => site.listen(0, '127.0.0.1', resolve));
  cleanup.push(() => new Promise<void>(resolve => site.close(() => resolve())));
  const engine = new BrowserEngine({ persistence: new MemoryStore() }); cleanup.push(() => engine.close());
  const session = await engine.createSession({ url: `http://127.0.0.1:${(site.address() as { port: number }).port}/`, headless: true,
    viewport: { width: 600, height: 400 }, exploration: 'controls', settleMs: 0, observeTimeoutMs: 1000, actionTimeoutMs: 1000,
    listExploration: 'all', pageExploration: 'all', evidence: { enabled: detailed, accessibility: false, styles: 'none' } });
  const driver = (engine as unknown as { driver: BrowserAdapter }).driver;
  return { engine, driver, sid: session.id, page: driver.page!, observation: () => engine.observation(session.id) };
}
function meter(driver: BrowserAdapter) {
  const source = collectOwnerDependencies.toString(), page = driver.page!, evaluate = page.evaluate.bind(page);
  // Test-only instrumentation of the actual serialized collector invocation.
  // It records counts/cost in an owned browser, without editing product files.
  vi.spyOn(page, 'evaluate').mockImplementation(((expression: unknown, arg: unknown) => {
    if (typeof expression === 'string' && expression.includes(source)) expression = expression.replace(source,
      `((...args) => { const t = performance.now(); const result = (${source})(...args); const stats = globalThis.__ownerDiagnostic ??= {calls:0,ms:0,bytes:0}; stats.calls++; stats.ms += performance.now()-t; stats.bytes += new TextEncoder().encode(JSON.stringify(result)).byteLength; return result; })`);
    return evaluate(expression as never, arg as never);
  }) as typeof page.evaluate);
  const original = driver.readDOM.bind(driver), calls: { detailed: boolean; requestedGraph: boolean; actualGraph: boolean; graphPresent: boolean; ms: number }[] = [];
  const state = { forceGraph: false };
  vi.spyOn(driver, 'readDOM').mockImplementation(async (detailed = false, ownerDependencies = true) => {
    const started = performance.now(), actualGraph = state.forceGraph || ownerDependencies;
    const result = await original(detailed, actualGraph);
    calls.push({ detailed, requestedGraph: ownerDependencies, actualGraph, graphPresent: !!result.ownerDependencies, ms: performance.now() - started });
    return result;
  });
  return { calls, state, stats: () => page.evaluate(() => ({ ...((globalThis as unknown as { __ownerDiagnostic?: { calls: number; ms: number; bytes: number } }).__ownerDiagnostic || { calls: 0, ms: 0, bytes: 0 }) })) };
}
const complete = '<main><section data-record="A"><button id="run" type="button">Run</button><input id="field" aria-label="Field" value="A"><button id="mode" aria-expanded="false">Mode</button></section></main>';
const complex = `<main><section data-record="large">${Array.from({ length: 200 }, (_, i) => `<button id="control-${i}" data-business="record-${i}" type="button">Control ${i}</button>`).join('')}</section></main>`;
const cases = [['complete', complete], ['200-controls', complex], ['unretained-native', complete + '<div><input type="hidden" id="business" value="A"></div>']] as const;
it.each(cases)('keeps all existing DOM facts identical and records graph work avoided for %s', async (name, html) => {
  const f = await fixture(html), m = meter(f.driver);
  const full = await f.driver.readDOM(), beforeCounter = await f.page.evaluate(() => (window as unknown as { __interactionEvidenceTracker: { counter: number } }).__interactionEvidenceTracker.counter);
  const thin = await f.driver.readDOM(false, false), afterCounter = await f.page.evaluate(() => (window as unknown as { __interactionEvidenceTracker: { counter: number } }).__interactionEvidenceTracker.counter);
  const { ownerDependencies: fullGraph, ...fullFacts } = full, { ownerDependencies: thinGraph, ...thinFacts } = thin;
  expect(thinGraph).toBeUndefined(); expect(thinFacts).toEqual(fullFacts); expect(afterCounter).toBe(beforeCounter);
  if (name === 'complete') expect(fullGraph?.complete).toBe(true);
  if (name === '200-controls') expect(full.controls).toHaveLength(200);
  if (name === 'unretained-native') {
    expect(fullGraph).toMatchObject({ version: 'browser-owner-dependencies-v2', inventoryComplete: true });
    expect(fullGraph!.nativeRoots).toHaveLength(1);
    expect(full.controls.some(c => c.selector === '#business')).toBe(false);
  }
  const validationStart = await m.stats(), start = m.calls.length;
  const normal = await f.driver.preflight(f.observation());
  const normalEnd = await m.stats();
  expect(m.calls.slice(start).every(c => !c.requestedGraph && !c.graphPresent)).toBe(true);
  m.state.forceGraph = true;
  const withGraph = await f.driver.preflight(f.observation());
  m.state.forceGraph = false; const forcedEnd = await m.stats();
  expect(normal).toBe('valid'); expect(withGraph).toEqual(normal); expect(normalEnd.calls - validationStart.calls).toBe(0); expect(forcedEnd.calls - normalEnd.calls).toBe(1);
  const captureStart = await m.stats(), captured = await f.engine.observe(f.sid), captureEnd = await m.stats();
  expect(captured.ownerDependencies).toBeDefined(); expect(captureEnd.calls - captureStart.calls).toBeGreaterThan(0);
  diagnostics.push({ fixture: name, fixtureSha256: sha(html), controls: full.controls.length,
    graph: { bytes: Buffer.byteLength(JSON.stringify(fullGraph)), complete: fullGraph?.complete, inventoryComplete: fullGraph?.inventoryComplete,
      reasons: fullGraph?.reasons, roots: fullGraph?.roots.length, closures: fullGraph?.closures.length, nodes: fullGraph?.nodes.length },
    readDOM: { withGraphBytes: Buffer.byteLength(JSON.stringify(full)), withoutGraphBytes: Buffer.byteLength(JSON.stringify(thin)), withGraphMs: m.calls[0].ms, withoutGraphMs: m.calls[1].ms, sameOtherFacts: true, sameInstanceCounter: true },
    preflight: { result: normal, withoutGraphCollectorCalls: normalEnd.calls - validationStart.calls, forcedGraphCollectorCalls: forcedEnd.calls - normalEnd.calls,
      avoidedGraphBytes: forcedEnd.bytes - normalEnd.bytes, forcedGraphCollectorMs: forcedEnd.ms - normalEnd.ms },
    capture: { collectorCalls: captureEnd.calls - captureStart.calls, graphBytes: Buffer.byteLength(JSON.stringify(captured.ownerDependencies)), observationBytes: Buffer.byteLength(JSON.stringify(captured)) },
    consumerBoundary: 'No consumer change or timing. Per-localId closure serialization and authority reads remain separate follow-up costs.' });
});

function action(o: Observation, kind: string, source: string, value?: ActionCandidate['value']): ActionCandidate {
  return { id: 'validation-action', sessionId: o.sessionId, observationId: o.id, stateId: o.stateId, kind, source, value, label: 'Validation only',
    preconditions: { context: o.context, visible: true, enabled: true, identityResolved: true }, basis: { status: 'supported', evidence: [] }, risk: 'interface', replayable: false, excluded: false, sampleValidity: 'known' };
}
it('all five validation paths retain their results with zero owner collection, including stale dismissal rejection', async () => {
  const f = await fixture(`<style>body{height:1600px}#safe{position:fixed;inset:0}section{position:relative;z-index:1}#panel{position:fixed;left:250px;top:100px;width:200px;height:150px;background:white;z-index:2}</style>
    <div id="safe"></div><section><button id="anchor">Anchor</button><input aria-label="Field" value="A"></section>
    <section><button aria-controls="panel">Open</button><div id="panel" role="listbox" hidden><button role="option">Choice</button></div></section>`);
  const m = meter(f.driver), current = f.observation(), container = current.scrollContainers!.find(c => c.root)!;
  expect(container.maxTop).toBeGreaterThan(0);
  const target = current.controls.find(c => c.selector === '#anchor')!;
  const position = { documentId: current.documentId, containerNodeId: container.nodeId, left: container.left, top: container.top + 1, expectedLeft: container.left, expectedTop: container.top };
  const traversal = action(current, 'scroll', 'scroll-traversal', { ...position, width: container.width, height: container.height, maxLeft: container.maxLeft, maxTop: container.maxTop });
  const controlled = { ...action(current, 'scroll', 'external-probe', position), localId: target.localId, controlId: target.identityId };
  const compare = async (name: string, operation: () => Promise<unknown>) => {
    const start = m.calls.length, before = await m.stats(); const normal = await operation(), without = await m.stats();
    expect(m.calls.slice(start).length).toBeGreaterThan(0); expect(m.calls.slice(start).every(c => !c.requestedGraph && !c.graphPresent)).toBe(true);
    expect(without.calls).toBe(before.calls); m.state.forceGraph = true;
    const forced = await operation(); m.state.forceGraph = false; const after = await m.stats();
    expect(forced).toEqual(normal); expect(after.calls - without.calls).toBe(1);
    diagnostics.push({ validation: name, result: normal ?? 'resolved', avoidedCollectorCalls: after.calls - without.calls, avoidedGraphBytes: after.bytes - without.bytes });
    return normal;
  };
  expect(await compare('discovery', () => f.driver.validateDiscoveryScan(current))).toBe(true);
  expect(await compare('preflight', () => f.driver.preflight(current))).toBe('valid');
  await compare('traversal-scroll', () => f.driver.validate(traversal));
  await compare('controlled-scroll', () => f.driver.validate(controlled, target));
  expect(await f.page.evaluate(() => scrollY)).toBe(0);
  await f.page.locator('#panel').evaluate(el => { (el as HTMLElement).hidden = false; });
  const open = await f.engine.observe(f.sid), candidate = open.boundaryExitCandidates!.find(c => c.selector === '#safe')!;
  expect(candidate).toBeDefined();
  const dismissal = action(open, 'dismiss', 'boundary-exit-review', candidate.id);
  dismissal.basis!.evidence = [{ source: 'local-validation-fixture', rule: 'reviewed-boundary-dismissal/v1', facts: {
    documentId: open.documentId, url: open.url, candidateId: candidate.id, binding: exitCandidateKey(candidate), preserved: [], boundaryKey: candidate.boundaryKey,
  } }];
  expect(await compare('dismissal', () => f.driver.validateDismissal(dismissal))).toEqual({ point: candidate.point, closedAfterMove: false });
  const stale = structuredClone(dismissal); stale.basis!.evidence[0].facts.documentId = 'other-document';
  await compare('stale-dismissal', () => f.driver.validateDismissal(stale).catch(error => ({ code: error.code })));
  expect(await f.page.locator('#panel').isVisible()).toBe(true);
});
it('capture keeps both sampling graphs and persists the graph belonging to its final detailed DOM sample', async () => {
  const f = await fixture(complete, true), original = f.driver.readDOM.bind(f.driver), reads: { detailed: boolean; enabled: boolean; record: string }[] = [];
  vi.spyOn(f.driver, 'readDOM').mockImplementation(async (detailed = false, ownerDependencies = true) => {
    if (detailed) await f.page.locator('section').evaluate(el => el.setAttribute('data-record', 'B'));
    const result = await original(detailed, ownerDependencies);
    reads.push({ detailed, enabled: ownerDependencies, record: readOwnerGraph(result).nodes.find(n => n.attributes['data-record'])!.attributes['data-record'] });
    return result;
  });
  const o = await f.engine.observe(f.sid);
  expect(reads.some(r => !r.detailed && r.record === 'A')).toBe(true); expect(reads.some(r => r.detailed && r.record === 'B')).toBe(true);
  expect(reads.every(r => r.enabled)).toBe(true);
  expect(readOwnerGraph(o).nodes.find(n => n.attributes['data-record'])?.attributes['data-record']).toBe('B');
  expect(f.engine.observation(f.sid, o.id).ownerDependencies).toEqual(o.ownerDependencies);
});
it('keeps owner collection disabled through discovery invalidation recursion', async () => {
  const f = await fixture(complete), current = f.observation(), m = meter(f.driver);
  f.driver.setDiscoveryScan({ requestId: 'local-plan', documentId: current.documentId, url: current.url, topologyKey: 'changed-topology', targetId: 'absent',
    budget: { offset: 0, elements: 100, templateNodes: 100, templateDepth: 8, collections: 300 } });
  const result = await f.driver.readDOM(false, false);
  expect(result.discoveryScan?.supplement?.status).toBe('invalidated'); expect(result.ownerDependencies).toBeUndefined();
  expect(m.calls).toHaveLength(2); expect(m.calls.every(c => !c.requestedGraph && !c.graphPresent)).toBe(true); expect((await m.stats()).calls).toBe(0);
  expect((await f.driver.readDOM()).ownerDependencies).toBeDefined();
});
