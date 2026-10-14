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

it('keeps parent and tab identities when an unowned floating child panel loads, updates or filters its content', async () => {
  const t = await testEngine(`${fixture.url}/identity-lists.html?mode=semantic`, { contextRules: [], exploration: 'controls' });
  try {
    await pageOf(t.engine).setContent(`<ul aria-label="Products"><li style="position:relative;width:260px;height:50px">
      <span id="record">Product A</span><button aria-expanded="false" onclick="panel.hidden=false;this.setAttribute('aria-expanded','true')">Open details</button>
      <div id="panel" hidden style="position:absolute;left:280px;top:0;width:250px;height:200px">
        <button role="tab">Overview</button><button role="tab">History</button><div id="results">Loading</div>
      </div></li></ul>`);
    const initial = await t.engine.observe(t.sessionId);
    const opener = initial.controls.find(c => c.name === 'Open details')!;
    const action = t.engine.actions(t.sessionId).find(a => a.label === 'Open details')!;
    await t.engine.execute(t.sessionId, action.id, 'open-product');
    const opened = t.engine.observation(t.sessionId);
    const tabs = opened.controls.filter(c => c.role === 'tab');
    expect(opened.controls.find(c => c.name === 'Open details')!.identityId).toBe(opener.identityId);
    for (const content of ['Quote 12.34, change +1.5%', 'Quote 56.78, change -2%', 'No matching records']) {
      await pageOf(t.engine).locator('#results').evaluate((el, text) => { el.textContent = text; }, content);
      const next = await t.engine.observe(t.sessionId);
      expect(next.controls.find(c => c.name === 'Open details')!.identityId).toBe(opener.identityId);
      expect(next.controls.filter(c => c.role === 'tab').map(c => c.identityId)).toEqual(tabs.map(c => c.identityId));
      expect(next.controls.filter(c => c.role === 'tab').every(c => !c.hypothesisId)).toBe(true);
      expect(next.text).toContain(content); // Full evidence still contains the changing panel.
    }
    expect(t.engine.getFrontier(t.sessionId).filter(f => f.action.label === 'Open details')).toHaveLength(1);
    await pageOf(t.engine).locator('#record').evaluate(el => { el.textContent = 'Product B'; });
    const rebound = await t.engine.observe(t.sessionId);
    expect(rebound.controls.find(c => c.name === 'Open details')!.instanceId).toBe(opener.instanceId);
    expect(rebound.controls.find(c => c.name === 'Open details')!.identityId).not.toBe(opener.identityId);
    expect(rebound.controls.filter(c => c.role === 'tab').every(c => !tabs.some(old => old.identityId === c.identityId))).toBe(true);
    expect(t.engine.observation(t.sessionId, initial.id)).toEqual(initial);
  } finally { await t.close(); }
});

it('separates nested record descriptions while retaining their complete parent binding', async () => {
  const t = await testEngine(`${fixture.url}/identity-lists.html`, { contextRules: [] });
  try {
    await pageOf(t.engine).setContent(`<ul aria-label="Categories"><li><span>Category A</span><button id="parent">Edit category</button>
      <ul aria-label="Products"><li><span id="child">Product A</span><button>Edit product</button></li></ul>
    </li></ul>`);
    const first = await t.engine.observe(t.sessionId);
    const parent = first.controls.find(c => c.name === 'Edit category')!, child = first.controls.find(c => c.name === 'Edit product')!;
    await pageOf(t.engine).locator('#child').evaluate(el => { el.textContent = 'Product B'; });
    const next = await t.engine.observe(t.sessionId);
    expect(next.controls.find(c => c.name === 'Edit category')!.identityId).toBe(parent.identityId);
    expect(next.controls.find(c => c.name === 'Edit product')!.identityId).not.toBe(child.identityId);
    expect(next.controls.find(c => c.name === 'Edit product')!.stableKey).toContain('Category A');
    expect(next.controls.find(c => c.name === 'Edit product')!.stableKey).toContain('Product B');
  } finally { await t.close(); }
});

it('retains an ordinary positioned record label instead of treating every positioned node as a popup', async () => {
  const t = await testEngine(`${fixture.url}/identity-lists.html`, { contextRules: [] });
  try {
    await pageOf(t.engine).setContent(`<ul><li style="position:relative;width:250px;height:70px">
      <span id="record" style="position:absolute;top:0;left:0"><b>Record A</b></span>
      <button aria-expanded="false" style="position:absolute;top:30px">Edit</button></li></ul>`);
    const first = await t.engine.observe(t.sessionId); const control = first.controls.find(c => c.name === 'Edit')!;
    expect(control.stableKey).toContain('Record A');
    await pageOf(t.engine).locator('#record').evaluate(el => { el.textContent = 'Record B'; });
    const next = await t.engine.observe(t.sessionId);
    expect(next.controls.find(c => c.name === 'Edit')!.identityId).not.toBe(control.identityId);
    expect(next.controls.find(c => c.name === 'Edit')!.stableKey).toContain('Record B');
  } finally { await t.close(); }
});
