import { afterAll, beforeAll, expect, it } from 'vitest';
import { BrowserEngine } from '@interaction/browser';
import { MemoryStore } from '@interaction/storage-memory';
import { ClippedControlTracker, ObservedOcclusionTracker, TextTruncationTracker } from '@interaction/rules';
import { fixtureServer } from './helpers.js';

let fixture: Awaited<ReturnType<typeof fixtureServer>>;
beforeAll(async () => { fixture = await fixtureServer(); });
afterAll(async () => { await fixture.server.close(); });
const trackers = () => [new ObservedOcclusionTracker(), new ClippedControlTracker(), new TextTruncationTracker()];
async function setup(fn: (e: BrowserEngine, sid: string) => Promise<void>, mode = 'healthy') {
  const e = new BrowserEngine({ persistence: new MemoryStore() });
  try {
    const s = await e.createSession({ url: `${fixture.url}/text-truncation.html?mode=${mode}`, headless: true,
      viewport: { width: 800, height: 600 }, settleMs: 60, inspection: {} });
    await fn(e, s.id);
  } finally { await e.close(); }
}

it('uses complete geometry despite unresolved conditional popup relations on a control or ancestor', async () => {
  await setup(async (e, sid) => {
    const task = e.listInspections(sid).items.at(-1)!, source = await e.captureDetails(sid, task.captureId);
    const c = source.details!.observation.controls.find(c => c.selector === '#target')!;
    const nodes = source.details!.snapshot!.dom!.nodes, n = nodes.find(n => n.id === c.localId)!;
    for (const node of [n, nodes.find(p => p.id === n.parentId)!]) {
      node.gaps.push({ code: 'UNRESOLVED_DOM_RELATION', message: 'aria-controls references missing #closed-popup' });
    }
    const before = structuredClone(source);
    for (const tracker of trackers()) {
      const report = await tracker.run({ captureDetails: async () => source }, task);
      expect(report.checks.find(check => check.target?.nodeId === c.localId)).toMatchObject({ verdict: 'pass' });
    }
    expect(source).toEqual(before);
  });
});

it.each(['FIELD_TRUNCATED', 'UNRECOGNIZED_EVIDENCE_GAP'])('retains unknown for relevant or unrecognized evidence failures: %s', async code => {
  await setup(async (e, sid) => {
    const task = e.listInspections(sid).items.at(-1)!, source = await e.captureDetails(sid, task.captureId);
    const c = source.details!.observation.controls.find(c => c.selector === '#target')!;
    source.details!.snapshot!.dom!.nodes.find(n => n.id === c.localId)!.gaps.push({ code, message: 'style:overflow-x exceeds budget' });
    for (const tracker of trackers()) {
      const report = await tracker.run({ captureDetails: async () => source }, task);
      expect(report.checks.find(check => check.target?.nodeId === c.localId)?.verdict).toBe('unknown');
    }
  });
});

it('does not certify a field label when its required label relation is unresolved', async () => {
  await setup(async (e, sid) => {
    const task = e.listInspections(sid).items.at(-1)!, source = await e.captureDetails(sid, task.captureId);
    const c = source.details!.observation.controls.find(c => c.selector === '#target')!;
    const n = source.details!.snapshot!.dom!.nodes.find(n => n.id === c.localId)!;
    n.gaps.push({ code: 'UNRESOLVED_DOM_RELATION', message: 'aria-labelledby references missing #label' });
    n.relations = { 'aria-labelledby': [] };
    const report = await new TextTruncationTracker().run({ captureDetails: async () => source }, task);
    expect(report.checks.find(check => check.target?.nodeId === c.localId)).toMatchObject({ verdict: 'unknown', code: 'TEXT_RECHECK_UNAVAILABLE', facts: { limitations: ['LABEL_RELATION_INCOMPLETE'] } });
  }, 'label');
});

it('checks the current capture even when logical identity cannot be shared across captures', async () => {
  await setup(async (e, sid) => {
    const task = e.listInspections(sid).items.at(-1)!, source = await e.captureDetails(sid, task.captureId);
    const c = source.details!.observation.controls.find(c => c.selector === '#target')!;
    c.hypothesisId = 'ambiguous';
    for (const tracker of trackers()) {
      const report = await tracker.run({ captureDetails: async () => source }, task);
      expect(report.checks.find(check => check.target?.nodeId === c.localId)).toMatchObject({ verdict: 'pass', facts: { tracking: 'current-capture-only', identityId: null } });
    }
  });
});
