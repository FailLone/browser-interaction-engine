import { beforeAll, afterAll, expect, it } from 'vitest';
import type { Control, IdentityHypothesis } from '@interaction/browser';
import { fixtureServer, pageOf, testEngine } from './helpers.js';

let fixture: Awaited<ReturnType<typeof fixtureServer>>;
beforeAll(async () => { fixture = await fixtureServer(); });
afterAll(async () => { await fixture.server.close(); });
const edits = (controls: Control[]) => controls.filter(c => c.name === 'Edit');
const byRecord = (controls: Control[], record: string) => edits(controls).filter(c => c.stableKey?.includes(`\\"${record}\\"`) || c.stableKey?.includes(`Order ${record}`));

it.each(['keyed', 'semantic'])('recognizes %s list records after reorder, rebuild, insertion and return from a virtual viewport', async mode => {
  const t = await testEngine(`${fixture.url}/identity-lists.html?mode=${mode}`, { contextRules: [] });
  try {
    const first = t.engine.observation(t.sessionId);
    const a = byRecord(first.controls, 'A')[0]; const b = byRecord(first.controls, 'B')[0];
    expect(a).toBeDefined(); expect(b).toBeDefined();
    expect(a.identityId).not.toBe(b.identityId);
    expect(t.engine.list(t.sessionId, 'hypothesis')).toHaveLength(0);
    await pageOf(t.engine).evaluate(() => (window as any).renderRecords(['B', 'C', 'A']));
    const rebuilt = await t.engine.observe(t.sessionId);
    expect(byRecord(rebuilt.controls, 'A')[0].identityId).toBe(a.identityId);
    expect(byRecord(rebuilt.controls, 'B')[0].identityId).toBe(b.identityId);
    expect(byRecord(rebuilt.controls, 'A')[0].instanceId).not.toBe(a.instanceId);
    const c = byRecord(rebuilt.controls, 'C')[0];
    expect(c.identityId).not.toBe(a.identityId); expect(c.identityId).not.toBe(b.identityId);
    expect(t.engine.list(t.sessionId, 'hypothesis')).toHaveLength(0);
    await pageOf(t.engine).evaluate(() => (window as any).renderRecords(['D'], true));
    const recycled = await t.engine.observe(t.sessionId);
    const d = byRecord(recycled.controls, 'D')[0];
    expect(d.instanceId).toBe(byRecord(rebuilt.controls, 'B')[0].instanceId);
    expect(d.identityId).not.toBe(b.identityId);
    await pageOf(t.engine).evaluate(() => (window as any).renderRecords(['A'], true));
    const returned = await t.engine.observe(t.sessionId);
    expect(byRecord(returned.controls, 'A')[0].identityId).toBe(a.identityId);
    expect(byRecord(returned.controls, 'A')[0].instanceId).toBe(d.instanceId);
    expect(t.engine.observation(t.sessionId, first.id)).toEqual(first);
  } finally { await t.close(); }
});

it('keeps same-item duplicate buttons ambiguous and never transfers their decision to a recycled record', async () => {
  const t = await testEngine(`${fixture.url}/identity-lists.html?mode=duplicate`, { contextRules: [] });
  try {
    const first = t.engine.observation(t.sessionId);
    const a = byRecord(first.controls, 'A'); const b = byRecord(first.controls, 'B');
    const h = t.engine.list<IdentityHypothesis>(t.sessionId, 'hypothesis').find(h => h.localId === a[0].localId)!;
    expect(h.candidateIds).toEqual([a[1].identityId]);
    expect(h.candidateIds).not.toContain(b[0].identityId);
    await t.engine.resolveIdentity(t.sessionId, h.id, h.provisionalIdentityId, 'test-user', ['First action of record A']);
    await pageOf(t.engine).evaluate(() => (window as any).renderRecords(['C', 'B'], true));
    const recycled = await t.engine.observe(t.sessionId);
    const c = byRecord(recycled.controls, 'C');
    expect(c[0].instanceId).toBe(a[0].instanceId);
    expect(c.every(control => control.identityId !== a[0].identityId && control.hypothesisId !== h.id && control.hypothesisId)).toBe(true);
    expect(byRecord(recycled.controls, 'B').map(c => c.identityId)).toEqual(b.map(c => c.identityId));
    expect(t.engine.actions(t.sessionId).filter(action => c.some(control => control.identityId === action.controlId)).every(action => !action.preconditions.identityResolved)).toBe(true);
  } finally { await t.close(); }
});

it('distinguishes repeated local control keys in separate named lists and refuses duplicate declared record keys', async () => {
  const t = await testEngine(`${fixture.url}/identity-lists.html`, { contextRules: [] });
  try {
    await pageOf(t.engine).evaluate(() => {
      const list = document.querySelector('#orders')!;
      const copy = list.cloneNode(true) as HTMLElement; copy.id = 'archived-orders'; copy.setAttribute('aria-label', 'Archived records'); list.after(copy);
    });
    const both = await t.engine.observe(t.sessionId);
    expect(edits(both.controls)).toHaveLength(4);
    expect(new Set(edits(both.controls).map(c => c.identityId)).size).toBe(4);
    expect(edits(both.controls).every(c => !c.hypothesisId)).toBe(true);
    await pageOf(t.engine).evaluate(() => {
      const list = document.querySelector('#orders')!;
      list.append(list.firstElementChild!.cloneNode(true));
    });
    const duplicates = await t.engine.observe(t.sessionId);
    const ambiguous = edits(duplicates.controls).filter(c => c.hypothesisId);
    expect(ambiguous).toHaveLength(2);
    expect(new Set(ambiguous.map(c => c.stableKey)).size).toBe(1);
  } finally { await t.close(); }
});

it('does not mistake reusable slot IDs or repeated test IDs for business record keys when row evidence is missing', async () => {
  const t = await testEngine(`${fixture.url}/identity-lists.html?mode=indistinguishable`, { contextRules: [] });
  try {
    const first = t.engine.observation(t.sessionId);
    expect(edits(first.controls).every(c => !c.stableKey && c.hypothesisId)).toBe(true);
    await pageOf(t.engine).evaluate(() => (window as any).renderRecords(['C', 'D'], true));
    const next = await t.engine.observe(t.sessionId);
    expect(edits(next.controls).every(c => c.hypothesisId)).toBe(true);
    expect(t.engine.actions(t.sessionId).filter(a => a.label === 'Edit').every(a => !a.preconditions.identityResolved)).toBe(true);
  } finally { await t.close(); }
});

it('ignores editable values in row descriptions and rejects overlong labels instead of matching truncated prefixes', async () => {
  const t = await testEngine(`${fixture.url}/identity-lists.html?mode=semantic`, { contextRules: [] });
  try {
    const first = t.engine.observation(t.sessionId);
    await pageOf(t.engine).evaluate(() => {
      for (const item of document.querySelectorAll('li')) {
        const input = document.createElement('input'); input.value = '100'; input.setAttribute('aria-label', 'Amount'); item.append(input);
      }
    });
    const filled = await t.engine.observe(t.sessionId);
    expect(edits(filled.controls).map(c => c.identityId)).toEqual(edits(first.controls).map(c => c.identityId));
    await pageOf(t.engine).evaluate(() => {
      document.querySelectorAll('li').forEach((item, i) => item.setAttribute('aria-label', 'X'.repeat(501) + i));
    });
    const tooLong = await t.engine.observe(t.sessionId);
    expect(edits(tooLong.controls).every(c => !c.stableKey && c.hypothesisId)).toBe(true);
  } finally { await t.close(); }
});
