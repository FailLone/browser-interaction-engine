import { createServer } from 'node:http';
import { expect, it, vi } from 'vitest';
import type { ActionAttempt, Observation } from '@interaction/browser';
import { act, pageOf, testEngine } from './helpers.js';

async function fixture(html: string, options: Parameters<typeof testEngine>[1] = {}) {
  const server = createServer((_req, res) => { res.setHeader('Content-Type', 'text/html'); res.end(html); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const t = await testEngine(`http://127.0.0.1:${(server.address() as { port: number }).port}`, {
      contextRules: [], exploration: 'controls', settleMs: 120, observeTimeoutMs: 1600, maxActions: 30, ...options,
    });
    return { ...t, close: async () => { await t.close(); await new Promise<void>(resolve => server.close(() => resolve())); } };
  } catch (error) { server.close(); throw error; }
}
const market = (variant: boolean) => `<style>td {width:240px} a {display:inline-block;width:220px} canvas {width:100px;height:25px}</style>
<table><tbody>${(variant ? ['Cedar', 'Birch'] : ['Orion', 'Lyra']).map((name, i) => `<tr>
<td><a href="/records/${i}">${name} <span class="readout">$10.00</span></a></td>
<td class="readout">1.00%</td><td><button>Pin ${name}</button></td></tr>`).join('')}</tbody></table>
<canvas></canvas><button aria-pressed="false">Day</button><button aria-pressed="false">Week</button>
<script>
window.calls=[];window.ticks=0;
document.addEventListener('click', e=>{const t=e.target.closest('a,button');if(t){e.preventDefault();window.calls.push(t.tagName+':'+(t.getAttribute('href')||t.textContent));}});
setInterval(()=>{window.ticks++;document.querySelectorAll('.readout').forEach((el,i)=>el.textContent='$'+(10+window.ticks/100+i).toFixed(2));
const c=document.querySelector('canvas').getContext('2d');c.clearRect(0,0,300,150);c.fillRect(window.ticks%200,0,2,100);},10);
</script>`;

it.each([false, true])('finishes finite control traversal while quotes and canvas never settle (variant %s)', async variant => {
  const t = await fixture(market(variant));
  try {
    const initial = t.engine.observation(t.sessionId);
    expect(initial.stable).toBe(false);
    expect(initial.gaps.some(g => g.critical)).toBe(false);
    const links = initial.controls.filter(c => c.tag === 'a');
    expect(links.every(c => ['live-navigation-readout/v1', 'formatted-navigation-readout/v1'].includes(c.liveContent?.evidence[0].rule || ''))).toBe(true);
    const ticksBefore = await pageOf(t.engine).evaluate(() => (window as any).ticks);
    await t.engine.explore(t.sessionId); await t.engine.waitForIdle();
    const report = t.engine.report(t.sessionId);
    expect(report.session.stopReason).toBe('known_frontier_exhausted');
    expect(report.controlCoverage.counts).toMatchObject({ actionable: 6, covered: 6, incomplete: 0 });
    const attempts = t.engine.list<ActionAttempt>(t.sessionId, 'attempt');
    expect(attempts).toHaveLength(6);
    expect(attempts.every(a => a.status === 'succeeded')).toBe(true);
    expect(await pageOf(t.engine).evaluate(() => (window as any).calls.length)).toBe(6);
    expect(await pageOf(t.engine).evaluate(() => (window as any).ticks)).toBeGreaterThan(ticksBefore);
    const observations = t.engine.list<Observation>(t.sessionId, 'observation');
    for (const link of links) {
      const versions = observations.map(o => o.controls.find(c => c.instanceId === link.instanceId)!);
      expect(new Set(versions.map(c => c.identityId)).size).toBe(1);
      expect(new Set(versions.map(c => c.displayedText)).size).toBeGreaterThan(1);
    }
    expect(observations.every(o => o.evidence?.artifacts.details && o.screenshot)).toBe(true);
    expect(observations.some(o => o.gaps.some(g => g.code === 'UNSUPPORTED_CANVAS'))).toBe(true);
    // Raw state evidence is not weakened into a claim of business equivalence.
    expect(new Set(observations.map(o => o.canonical)).size).toBeGreaterThan(1);
  } finally { await t.close(); }
});

it('keeps a row binding through changing passive cells and reorder, but invalidates a recycled record', async () => {
  const t = await fixture(market(false));
  try {
    const first = t.engine.observation(t.sessionId).controls.find(c => c.name === 'Pin Orion')!;
    await pageOf(t.engine).evaluate(() => { const rows = document.querySelector('tbody')!; rows.append(rows.firstElementChild!); });
    await t.engine.observe(t.sessionId);
    const reordered = t.engine.observation(t.sessionId).controls.find(c => c.name === 'Pin Orion')!;
    expect(reordered.identityId).toBe(first.identityId);
    const action = t.engine.actions(t.sessionId).find(a => a.label === 'Pin Orion')!;
    await pageOf(t.engine).evaluate(() => { const row = document.querySelector('tbody')!.lastElementChild!; row.querySelector('a')!.setAttribute('href', '/records/recycled'); });
    await expect(t.engine.execute(t.sessionId, action.id, 'recycled')).rejects.toMatchObject({ code: 'STALE_OBSERVATION' });
    expect(t.engine.observation(t.sessionId).controls.find(c => c.name === 'Pin Orion')!.identityId).not.toBe(first.identityId);
    expect(await pageOf(t.engine).evaluate(() => (window as any).calls.length)).toBe(0);
  } finally { await t.close(); }
});

it('does not infer record identity from links shared by multiple rows', async () => {
  const t = await fixture('<ul><li>First <a href="/help">Help</a><button>Pin</button></li><li>Second <a href="/help">Help</a><button>Pin</button></li></ul>');
  try {
    const pins = t.engine.observation(t.sessionId).controls.filter(c => c.name === 'Pin');
    expect(pins).toHaveLength(2);
    expect(pins.every(c => !c.hypothesisId)).toBe(true);
    expect(pins[0].stableKey).not.toBe(pins[1].stableKey);
  } finally { await t.close(); }
});

it.each(['button', 'input', 'label'])('does not suppress autonomous changes in %s semantics', async kind => {
  const html = kind === 'button' ? '<button>Buy <span id="change">10</span></button>'
    : kind === 'input' ? '<input id="change" aria-label="Quantity" value="10">'
    : '<a aria-label="Product 10" href="/record"><span id="change">10</span></a>';
  const t = await fixture(`${html}<script>let n=10;setInterval(()=>{n++;const el=document.querySelector('#change');${kind === 'input' ? 'el.value=String(n)' : kind === 'label' ? "el.parentElement.setAttribute('aria-label','Product '+n)" : 'el.textContent=String(n)'}},10)</script>`, { observeTimeoutMs: 450 });
  try {
    expect(t.engine.observation(t.sessionId).gaps.some(g => g.critical)).toBe(true);
    await t.engine.explore(t.sessionId); await t.engine.waitForIdle();
    expect(t.engine.session(t.sessionId).actionCount).toBe(0);
    await t.engine.observe(t.sessionId);
    expect(t.engine.session(t.sessionId)).toMatchObject({ stopReason: 'OBSERVATION_NO_PROGRESS', observationFailures: { count: 3, kind: 'incomplete' } });
  } finally { await t.close(); }
});

it('rechecks declared business context even when the same readout qualifies as live display', async () => {
  const t = await fixture(market(false), { contextRules: [{ key: 'quote', selector: 'tr:first-child a .readout', required: true }] });
  try {
    // A unique live readout remains the caller's explicit business precondition.
    const action = t.engine.actions(t.sessionId).find(a => a.label === 'Day')!;
    await expect(t.engine.execute(t.sessionId, action.id, 'context')).rejects.toMatchObject({ code: 'PRECONDITIONS_CHANGED' });
    expect(t.engine.session(t.sessionId).actionCount).toBe(0);
  } finally { await t.close(); }
});

it('keeps strict stateful sampling strict on a perpetually changing link', async () => {
  const t = await fixture(market(false), { exploration: 'stateful', observeTimeoutMs: 450 });
  try {
    expect(t.engine.observation(t.sessionId).controls.every(c => !c.liveContent)).toBe(true);
    expect(t.engine.observation(t.sessionId).gaps.some(g => g.code === 'UNSTABLE' && g.critical)).toBe(true);
  } finally { await t.close(); }
});

it('stops repeated preflight invalidations across resume, then recovers after a successful action', async () => {
  const t = await fixture('<button>Run</button>');
  try {
    const driver = (t.engine as any).driver;
    const preflight = vi.spyOn(driver, 'preflight').mockResolvedValue('stale');
    await t.engine.explore(t.sessionId); await t.engine.waitForIdle();
    expect(t.engine.session(t.sessionId)).toMatchObject({ stopReason: 'OBSERVATION_NO_PROGRESS', actionCount: 0, observationFailures: { count: 3, kind: 'stale' } });
    expect(preflight).toHaveBeenCalledTimes(3);
    await t.engine.observe(t.sessionId);
    await t.engine.explore(t.sessionId); await t.engine.waitForIdle();
    expect(preflight).toHaveBeenCalledTimes(4);
    expect(t.engine.session(t.sessionId).observationFailures?.count).toBe(4);
    preflight.mockRestore();
    await t.engine.explore(t.sessionId); await t.engine.waitForIdle();
    expect(t.engine.session(t.sessionId)).toMatchObject({ stopReason: 'known_frontier_exhausted', actionCount: 1 });
    expect(t.engine.session(t.sessionId).observationFailures).toBeUndefined();
  } finally { vi.restoreAllMocks(); await t.close(); }
});

it('ignores unrelated layout movement but validates target layout and occlusion', async () => {
  const t = await fixture('<button id="target">Target</button><button id="other" style="position:absolute;left:300px">Other</button>');
  try {
    await pageOf(t.engine).evaluate(() => { document.querySelector<HTMLElement>('#other')!.style.left = '400px'; });
    expect((await act(t.engine, t.sessionId, 'Target')).status).toBe('succeeded');
    await pageOf(t.engine).evaluate(() => { document.querySelector<HTMLElement>('#target')!.style.marginLeft = '50px'; });
    await expect(act(t.engine, t.sessionId, 'Target')).rejects.toMatchObject({ code: 'STALE_OBSERVATION' });
    await pageOf(t.engine).evaluate(() => { const el = document.createElement('div'); el.style.cssText = 'position:fixed;inset:0;background:white;z-index:100'; document.body.append(el); });
    await expect(act(t.engine, t.sessionId, 'Target')).rejects.toMatchObject({ code: 'STALE_OBSERVATION' });
    expect(t.engine.session(t.sessionId).actionCount).toBe(1);
  } finally { await t.close(); }
});

it('revokes a learned live projection when a numeric readout becomes meaningful text', async () => {
  const t = await fixture(market(false));
  try {
    const driver = (t.engine as any).driver;
    const initial = t.engine.observation(t.sessionId);
    expect(initial.controls.find(c => c.tag === 'a')!.liveContent).toBeDefined();
    // Change just before the real preflight read, independently of timer scheduling.
    const read = driver.readDOM.bind(driver);
    vi.spyOn(driver, 'readDOM').mockImplementation(async (detailed: unknown) => {
      await pageOf(t.engine).evaluate(() => { document.querySelector('a .readout')!.classList.remove('readout'); document.querySelector('a span')!.textContent = 'Unavailable'; });
      return read(detailed);
    });
    const action = t.engine.actions(t.sessionId).find(a => a.label === 'Day')!;
    await expect(t.engine.execute(t.sessionId, action.id, 'meaningful-text')).rejects.toMatchObject({ code: 'STALE_OBSERVATION' });
    expect(t.engine.observation(t.sessionId).controls.find(c => c.tag === 'a')!.liveContent).toBeUndefined();
    expect(t.engine.session(t.sessionId).actionCount).toBe(0);
  } finally { vi.restoreAllMocks(); await t.close(); }
});

it('traverses records with no links or declared keys while formatted display cells keep updating', async () => {
  const t = await fixture(`<table><tr><td>North</td><td class="quote">$10</td><td>record-1</td><td><button>Inspect</button></td></tr>
<tr><td>South</td><td class="quote">$20</td><td>record-2</td><td><button>Inspect</button></td></tr></table>
<script>window.calls=0;document.addEventListener('click',e=>{if(e.target.matches('button'))window.calls++});let n=10;setInterval(()=>{n++;document.querySelectorAll('.quote').forEach(el=>el.textContent='$'+n)},10)</script>`);
  try {
    const before = t.engine.observation(t.sessionId).controls.filter(c => c.tag === 'button');
    expect(before.every(c => c.stableKey?.includes('item-description'))).toBe(true);
    await t.engine.explore(t.sessionId); await t.engine.waitForIdle();
    expect(t.engine.report(t.sessionId).controlCoverage.counts).toMatchObject({ actionable: 2, covered: 2 });
    expect(await pageOf(t.engine).evaluate(() => (window as any).calls)).toBe(2);
    expect(t.engine.session(t.sessionId).stopReason).toBe('known_frontier_exhausted');
    // A textual business discriminator still changes the record binding.
    await pageOf(t.engine).locator('tr').first().locator('td').nth(2).evaluate(el => { el.textContent = 'record-3'; });
    await t.engine.observe(t.sessionId);
    expect(t.engine.observation(t.sessionId).controls.find(c => c.instanceId === before[0].instanceId)!.identityId).not.toBe(before[0].identityId);
  } finally { await t.close(); }
});

it('does not merge duplicate projected descriptions or remove numeric record identifiers', async () => {
  const t = await fixture('<table><tr><td>Same</td><td>$10</td><td><button>Inspect</button></td></tr><tr><td>Same</td><td>$20</td><td><button>Inspect</button></td></tr></table><ul><li>Product <span>123</span><button>Open</button></li></ul>');
  try {
    const buttons = t.engine.observation(t.sessionId).controls.filter(c => c.name === 'Inspect');
    expect(buttons.every(c => !c.stableKey?.includes('item-description'))).toBe(true);
    expect(buttons[0].identityId).not.toBe(buttons[1].identityId);
    const old = t.engine.observation(t.sessionId).controls.find(c => c.name === 'Open')!;
    await pageOf(t.engine).locator('li span').evaluate(el => { el.textContent = '456'; });
    await t.engine.observe(t.sessionId);
    expect(t.engine.observation(t.sessionId).controls.find(c => c.name === 'Open')!.identityId).not.toBe(old.identityId);
  } finally { await t.close(); }
});

it('does not reset preflight failures when their fresh captures alternate between complete and incomplete', async () => {
  const t = await fixture('<button>Run</button>');
  try {
    const driver = (t.engine as any).driver;
    const capture = driver.capture.bind(driver); let afterFailure = false;
    const preflight = vi.spyOn(driver, 'preflight').mockImplementation(async () => { afterFailure = true; return 'stale'; });
    vi.spyOn(driver, 'capture').mockImplementation(async (id: unknown) => {
      const observation = await capture(id);
      if (afterFailure) { afterFailure = false; observation.gaps.push({ code: 'TRANSIENT_CAPTURE', message: 'Incomplete after invalidation', critical: true }); }
      return observation;
    });
    for (let i = 0; i < 3; i++) { await t.engine.explore(t.sessionId); await t.engine.waitForIdle(); }
    expect(preflight).toHaveBeenCalledTimes(3);
    expect(t.engine.session(t.sessionId)).toMatchObject({ actionCount: 0, stopReason: 'OBSERVATION_NO_PROGRESS', observationFailures: { count: 3, kind: 'stale' } });
  } finally { vi.restoreAllMocks(); await t.close(); }
});

it('tolerates a slow formatted readout without waiting for two ticks, while retaining exact link semantics', async () => {
  const t = await fixture('<style>a {display:inline-block;width:200px}</style><a href="/record">Record <span>$10</span></a><button>Run</button>');
  try {
    const link = t.engine.observation(t.sessionId).controls.find(c => c.tag === 'a')!;
    expect(link.liveContent?.evidence[0].rule).toBe('formatted-navigation-readout/v1');
    await pageOf(t.engine).locator('a span').evaluate(el => { el.textContent = '$11'; });
    expect((await act(t.engine, t.sessionId, 'Run')).status).toBe('succeeded');
    await pageOf(t.engine).locator('a').evaluate(el => { el.setAttribute('href', '/another-record'); });
    await expect(act(t.engine, t.sessionId, 'Run')).rejects.toMatchObject({ code: 'STALE_OBSERVATION' });
  } finally { await t.close(); }
});

it('records chart-period toggles and rejects changed selection before another action', async () => {
  const t = await fixture('<button aria-pressed="false" onclick="this.setAttribute(\'aria-pressed\',\'true\')">Period</button><button>Run</button>');
  try {
    const attempt = await act(t.engine, t.sessionId, 'Period');
    expect(attempt.diff?.changes).toContainEqual(expect.objectContaining({ field: 'pressed', before: false, after: true }));
    await pageOf(t.engine).locator('[aria-pressed]').evaluate(el => { el.setAttribute('aria-pressed', 'false'); });
    await expect(act(t.engine, t.sessionId, 'Run')).rejects.toMatchObject({ code: 'STALE_OBSERVATION' });
  } finally { await t.close(); }
});

it('validates the chosen weak target even when passive controls are excluded from global settling', async () => {
  const t = await fixture('<div tabindex="0" onclick="window.calls=(window.calls||0)+1">Probe</div>');
  try {
    const action = t.engine.actions(t.sessionId).find(a => a.label === 'Probe')!;
    expect(action.basis?.status).toBe('tentative');
    await pageOf(t.engine).locator('[tabindex]').evaluate(el => { el.textContent = 'Different operation'; });
    await expect(t.engine.execute(t.sessionId, action.id, 'weak-target')).rejects.toMatchObject({ code: 'STALE_OBSERVATION' });
    expect(t.engine.session(t.sessionId).actionCount).toBe(0);
  } finally { await t.close(); }
});

it.each(['description', 'shared-destination'])('does not inherit coverage after rebuilding a row with only inferred %s identity', async binding => {
  const row = (price: number) => `<li>Package <span>$${price}</span>${binding === 'shared-destination' ? '<a href="/help">Details</a>' : ''}<button>Inspect</button></li>`;
  const t = await fixture(`<ul>${row(10)}</ul>`, { listExploration: 'all' });
  try {
    const first = t.engine.observation(t.sessionId).controls.find(c => c.name === 'Inspect')!;
    expect(first.identityScope).toBe('instance');
    expect((await act(t.engine, t.sessionId, 'Inspect')).status).toBe('succeeded');
    await pageOf(t.engine).locator('ul').evaluate((el, html) => { el.innerHTML = html; }, row(20));
    await t.engine.observe(t.sessionId);
    const next = t.engine.observation(t.sessionId).controls.find(c => c.name === 'Inspect')!;
    expect(next.identityId).not.toBe(first.identityId);
    const action = t.engine.actions(t.sessionId).find(a => a.label === 'Inspect')!;
    expect(action.target?.instanceId).toBe(next.instanceId);
    expect(action.replayable).toBe(false);
    expect(t.engine.getFrontier(t.sessionId).find(f => f.action.controlId === next.identityId)?.status).toBe('pending');
    expect((await act(t.engine, t.sessionId, 'Inspect')).status).toBe('succeeded');
  } finally { await t.close(); }
});

it('retains coverage for an explicitly keyed record after rebuilding its price display', async () => {
  const t = await fixture('<ul><li data-row-key="package-1">Package <span>$10</span><button>Inspect</button></li></ul>');
  try {
    const first = t.engine.observation(t.sessionId).controls.find(c => c.name === 'Inspect')!;
    await act(t.engine, t.sessionId, 'Inspect');
    await pageOf(t.engine).locator('li').evaluate(el => { el.outerHTML = '<li data-row-key="package-1">Package <span>$20</span><button>Inspect</button></li>'; });
    await t.engine.observe(t.sessionId);
    const next = t.engine.observation(t.sessionId).controls.find(c => c.name === 'Inspect')!;
    expect(next.identityId).toBe(first.identityId);
    expect(next.identityScope).toBeUndefined();
    expect(t.engine.getFrontier(t.sessionId).filter(f => f.action.label === 'Inspect')).toHaveLength(1);
  } finally { await t.close(); }
});

it('validates native field operations against their form while preserving other forms in evidence', async () => {
  const t = await fixture('<form id="first"><input aria-label="Target"></form><form id="second"><input aria-label="Other" value="10"></form>');
  try {
    await pageOf(t.engine).getByLabel('Other').fill('20');
    expect((await act(t.engine, t.sessionId, 'Target', 'fill', 'ok')).status).toBe('succeeded');
    expect(t.engine.observation(t.sessionId).controls.find(c => c.name === 'Other')!.value).toBe('20');
    await pageOf(t.engine).getByLabel('Other').evaluate(el => { el.setAttribute('form', 'first'); });
    await expect(act(t.engine, t.sessionId, 'Target', 'fill', 'again')).rejects.toMatchObject({ code: 'STALE_OBSERVATION' });
    expect(await pageOf(t.engine).getByLabel('Target').inputValue()).toBe('ok');
  } finally { await t.close(); }
});

it.each(['sibling-value', 'external-associated-field', 'form-destination', 'target-position'])('rejects a changed native dependency: %s', async change => {
  const t = await fixture('<form id="owner"><input aria-label="Target"><input aria-label="Sibling" value="10"></form><input form="owner" aria-label="External" value="10">');
  try {
    if (change === 'sibling-value') await pageOf(t.engine).getByLabel('Sibling').fill('20');
    if (change === 'external-associated-field') await pageOf(t.engine).getByLabel('External').fill('20');
    if (change === 'form-destination') await pageOf(t.engine).locator('form').evaluate(el => { el.setAttribute('action', '/different'); });
    if (change === 'target-position') await pageOf(t.engine).getByLabel('Target').evaluate(el => { (el as HTMLElement).style.marginLeft = '20px'; });
    await expect(act(t.engine, t.sessionId, 'Target', 'fill', 'ok')).rejects.toMatchObject({ code: 'STALE_OBSERVATION' });
    expect(t.engine.session(t.sessionId).actionCount).toBe(0);
  } finally { await t.close(); }
});

it('keeps cross-form relationships and submission validation global', async () => {
  const t = await fixture('<form><input aria-label="Target" aria-controls="other"><button>Submit</button></form><form><input id="other" aria-label="Other" value="10"></form>');
  try {
    await pageOf(t.engine).getByLabel('Other').fill('20');
    await expect(act(t.engine, t.sessionId, 'Target', 'fill', 'ok')).rejects.toMatchObject({ code: 'STALE_OBSERVATION' });
    await pageOf(t.engine).getByLabel('Other').fill('30');
    await expect(act(t.engine, t.sessionId, 'Submit')).rejects.toMatchObject({ code: 'STALE_OBSERVATION' });
    expect(t.engine.session(t.sessionId).validationFailures).toBeUndefined();
  } finally { await t.close(); }
});

it('continues stable form operations while another form never settles and reports the remaining gap', async () => {
  const t = await fixture(`<form><label><input type="checkbox">Ready</label></form><form><input aria-label="Live" value="10"></form>
<script>window.ticks=0;setInterval(()=>{document.querySelector('[aria-label=Live]').value=String(++window.ticks)},10)</script>`, { observeTimeoutMs: 450 });
  try {
    const initial = t.engine.observation(t.sessionId);
    expect(initial.gaps.some(g => g.critical)).toBe(false);
    expect(initial.gaps.some(g => g.code === 'PARTIAL_INTERACTION_READY')).toBe(true);
    expect(initial.controls.find(c => c.name === 'Ready')!.readiness).toBeUndefined();
    expect(initial.controls.find(c => c.name === 'Live')!.readiness?.status).toBe('unstable');
    await t.engine.explore(t.sessionId); await t.engine.waitForIdle();
    const attempts = t.engine.list<ActionAttempt>(t.sessionId, 'attempt');
    expect(attempts.length).toBeGreaterThan(0);
    expect(attempts.every(a => a.action.label === 'Ready' && a.status === 'succeeded')).toBe(true);
    expect(t.engine.session(t.sessionId).stopReason).toBe('ACTION_DEPENDENCIES_BLOCKED');
    expect(t.engine.session(t.sessionId).observationFailures).toBeUndefined();
    expect(t.engine.getFrontier(t.sessionId).filter(f => f.action.label === 'Live').every(f => f.status === 'blocked' && f.reason === 'interaction_unstable')).toBe(true);
    expect(await pageOf(t.engine).evaluate(() => (window as any).ticks)).toBeGreaterThan(10);
  } finally { await t.close(); }
});

it('budgets stale form dependencies independently, keeps the failure across resume, and clears only verified recovery', async () => {
  const t = await fixture('<form id="bad"><label><input type="checkbox">Changing</label><input aria-label="Version" value="0" readonly></form><form><label><input type="checkbox">Independent</label></form>');
  try {
    const driver = (t.engine as any).driver;
    const read = driver.preflight.bind(driver); let failures = 0;
    const spy = vi.spyOn(driver, 'preflight').mockImplementation(async (o: any, action: any) => {
      if (action.label === 'Changing') {
        failures++;
        // Change enabled state: read-only display values alone are not a dependency.
        await pageOf(t.engine).getByLabel('Changing').evaluate(el => { (el as HTMLInputElement).checked = !(el as HTMLInputElement).checked; });
      }
      return read(o, action);
    });
    await t.engine.explore(t.sessionId); await t.engine.waitForIdle();
    expect(failures).toBe(3);
    expect(t.engine.session(t.sessionId)).toMatchObject({ stopReason: 'ACTION_DEPENDENCIES_BLOCKED', validationFailures: [{ count: 3 }] });
    const attempts = t.engine.list<ActionAttempt>(t.sessionId, 'attempt');
    expect(attempts.length).toBeGreaterThan(0);
    expect(attempts.every(a => a.action.label === 'Independent' && a.status === 'succeeded')).toBe(true);
    await t.engine.explore(t.sessionId); await t.engine.waitForIdle();
    expect(failures).toBe(3);
    spy.mockRestore();
    expect((await act(t.engine, t.sessionId, 'Changing', 'check')).status).toBe('succeeded');
    expect(t.engine.session(t.sessionId).validationFailures).toEqual([]);
    await t.engine.explore(t.sessionId); await t.engine.waitForIdle();
    expect(t.engine.session(t.sessionId).stopReason).toBe('known_frontier_exhausted');
  } finally { vi.restoreAllMocks(); await t.close(); }
});

it('does not call an action successful just because an unrelated form settled afterward', async () => {
  const t = await fixture(`<form><label><input type="checkbox" onchange="window.timer=setInterval(()=>{this.checked=!this.checked},10)">Starts changing</label></form><form><input aria-label="Stable"></form>`);
  try {
    const attempt = await act(t.engine, t.sessionId, 'Starts changing', 'check');
    expect(attempt.status).toBe('unknown');
    expect(attempt.reason).toBe('Post-action dependencies did not settle');
    expect(t.engine.observation(t.sessionId).gaps.some(g => g.critical)).toBe(false);
    expect(t.engine.getFrontier(t.sessionId).find(f => f.attempts.includes(attempt.id))!.status).toBe('unknown');
  } finally { await t.close(); }
});

it('does not localize a declared business-context change or a newly opened modal', async () => {
  const t = await fixture('<span id="version">10</span><form><input aria-label="Target"></form><dialog><button>Dismiss</button></dialog>', { contextRules: [{ key: 'version', selector: '#version' }] });
  try {
    await pageOf(t.engine).locator('#version').evaluate(el => { el.textContent = '20'; });
    await expect(act(t.engine, t.sessionId, 'Target', 'fill', 'ok')).rejects.toMatchObject({ code: 'PRECONDITIONS_CHANGED' });
    await pageOf(t.engine).locator('dialog').evaluate(el => { (el as HTMLDialogElement).showModal(); });
    await expect(act(t.engine, t.sessionId, 'Target', 'fill', 'ok')).rejects.toMatchObject({ code: 'STALE_OBSERVATION' });
    expect(t.engine.session(t.sessionId).validationFailures).toBeUndefined();
    expect(t.engine.session(t.sessionId).observationFailures?.count).toBe(2);
    expect(t.engine.session(t.sessionId).actionCount).toBe(0);
  } finally { await t.close(); }
});

it('cannot reset the retry budget by rebuilding the form before every preflight', async () => {
  const t = await fixture('<form><label><input type="checkbox">Rebuilt</label></form>');
  try {
    const driver = (t.engine as any).driver, read = driver.preflight.bind(driver);
    const spy = vi.spyOn(driver, 'preflight').mockImplementation(async (o: any, action: any) => {
      await pageOf(t.engine).locator('form').evaluate(el => { el.replaceWith(el.cloneNode(true)); });
      return read(o, action);
    });
    await t.engine.explore(t.sessionId); await t.engine.waitForIdle();
    expect(spy).toHaveBeenCalledTimes(3);
    expect(t.engine.session(t.sessionId)).toMatchObject({ stopReason: 'OBSERVATION_NO_PROGRESS', actionCount: 0, observationFailures: { count: 3 } });
    expect(t.engine.session(t.sessionId).validationFailures).toBeUndefined();
  } finally { vi.restoreAllMocks(); await t.close(); }
});

it('does not ignore incoming relationships from controls outside the form', async () => {
  const t = await fixture('<form id="owner"><input id="target" aria-label="Target"></form><input aria-label="Controller" aria-controls="target" value="10">');
  try {
    expect(t.engine.observation(t.sessionId).controls.find(c => c.name === 'Target')!.formOwner?.isolated).toBe(false);
    await pageOf(t.engine).getByLabel('Controller').fill('20');
    await expect(act(t.engine, t.sessionId, 'Target', 'fill', 'ok')).rejects.toMatchObject({ code: 'STALE_OBSERVATION' });
    expect(t.engine.session(t.sessionId).actionCount).toBe(0);
  } finally { await t.close(); }
});
