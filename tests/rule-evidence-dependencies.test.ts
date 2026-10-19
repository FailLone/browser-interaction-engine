import { afterAll, beforeAll, expect, it } from 'vitest';
import { ClippedControlTracker, ObservedOcclusionTracker, TextTruncationTracker, type RulePage } from '@interaction/rules';
import { fixtureServer, withFixture } from './rule-fixture.js';

let fixture: Awaited<ReturnType<typeof fixtureServer>>;
beforeAll(async () => { fixture = await fixtureServer(); });
afterAll(async () => { await fixture.server.close(); });
const trackers = () => [new ObservedOcclusionTracker(), new ClippedControlTracker(), new TextTruncationTracker()];
async function setup(fn: (source: RulePage) => Promise<void>, mode = 'healthy') {
  await withFixture(`${fixture.url}/text-truncation.html?mode=${mode}`, async (_f, page) => fn(page));
}

it('uses complete geometry despite unresolved conditional popup relations on a control or ancestor', async () => {
  await setup(async source => {
    const c = source.observation.controls.find(c => c.selector === '#target')!;
    const nodes = source.snapshot.dom!.nodes, n = nodes.find(n => n.id === c.localId)!;
    for (const node of [n, nodes.find(p => p.id === n.parentId)!]) {
      node.gaps.push({ code: 'UNRESOLVED_DOM_RELATION', message: 'aria-controls references missing #closed-popup' });
    }
    const before = structuredClone(source);
    for (const tracker of trackers()) {
      const report = await tracker.run(source);
      expect(report.checks.find(check => check.target?.nodeId === c.localId)).toMatchObject({ verdict: 'pass' });
    }
    expect(source).toEqual(before);
  });
});

it.each(['FIELD_TRUNCATED', 'UNRECOGNIZED_EVIDENCE_GAP'])('retains unknown for relevant or unrecognized evidence failures: %s', async code => {
  await setup(async source => {
    const c = source.observation.controls.find(c => c.selector === '#target')!;
    source.snapshot.dom!.nodes.find(n => n.id === c.localId)!.gaps.push({ code, message: 'style:overflow-x exceeds budget' });
    for (const tracker of trackers()) {
      const report = await tracker.run(source);
      expect(report.checks.find(check => check.target?.nodeId === c.localId)?.verdict).toBe('unknown');
    }
  });
});

it('does not certify a field label when its required label relation is unresolved', async () => {
  await setup(async source => {
    const c = source.observation.controls.find(c => c.selector === '#target')!;
    const n = source.snapshot.dom!.nodes.find(n => n.id === c.localId)!;
    n.gaps.push({ code: 'UNRESOLVED_DOM_RELATION', message: 'aria-labelledby references missing #label' });
    n.relations = { 'aria-labelledby': [] };
    const report = await new TextTruncationTracker().run(source);
    expect(report.checks.find(check => check.target?.nodeId === c.localId)).toMatchObject({ verdict: 'unknown', code: 'TEXT_RECHECK_UNAVAILABLE', facts: { limitations: ['LABEL_RELATION_INCOMPLETE'] } });
  }, 'label');
});

it('checks the current capture even when logical identity cannot be shared across captures', async () => {
  await setup(async source => {
    const c = source.observation.controls.find(c => c.selector === '#target')!;
    c.hypothesisId = 'ambiguous';
    for (const tracker of trackers()) {
      const report = await tracker.run(source);
      expect(report.checks.find(check => check.target?.nodeId === c.localId)).toMatchObject({ verdict: 'pass', facts: { tracking: 'current-capture-only', identityId: null } });
    }
  });
});
