import { createServer } from 'node:http';
import { expect, it } from 'vitest';
import { act, pageOf, testEngine } from './helpers.js';

async function fixture(html: string) {
  const server = createServer((_req, res) => { res.setHeader('Content-Type', 'text/html'); res.end(html); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const t = await testEngine(`http://127.0.0.1:${(server.address() as { port: number }).port}`, {
      contextRules: [], exploration: 'controls', regionExploration: 'review', settleMs: 40, observeTimeoutMs: 1000,
    });
    return { ...t, close: async () => { await t.close(); await new Promise<void>(resolve => server.close(() => resolve())); } };
  } catch (error) { server.close(); throw error; }
}

it.each(['table', 'grid'] as const)('does not infer repeated records from %s cells with inherited pointer cursors', async kind => {
  const cells = (name: string) => [name, '$10', '2.0%', 'record-id'];
  const rows = ['North', 'South'].map(name => kind === 'table'
    ? `<tr style="cursor:pointer">${cells(name).map(value => `<td>${value}</td>`).join('')}</tr>`
    : `<div role="row" style="cursor:pointer;display:flex">${cells(name).map(value => `<div role="gridcell"><span>${value}</span></div>`).join('')}</div>`).join('');
  const t = await fixture(`<style>td,[role=gridcell]{width:150px}</style>${kind === 'table' ? `<table>${rows}</table>` : `<div role="grid">${rows}</div>`}<button type="button">Settings</button>`);
  try {
    const before = t.engine.observation(t.sessionId);
    const button = before.controls.find(c => c.name === 'Settings')!;
    const anchor = before.regionCandidates!.find(c => c.controlIds.includes(button.localId))!;
    await t.engine.reviewRegions(t.sessionId, { observationId: before.id, source: 'test', evidence: ['Observed settings control'],
      regions: [{ key: 'settings', label: 'Settings', candidateIds: [anchor.id], controlIds: [button.localId], pageTraversal: false }], rejectedCandidateIds: [] });
    await pageOf(t.engine).evaluate(() => {
      for (const el of document.querySelectorAll('td,[role=gridcell] span')) {
        if (el.textContent === '$10') el.textContent = '$12';
        if (el.textContent === '2.0%') el.textContent = '3.0%';
      }
    });
    expect((await act(t.engine, t.sessionId, 'Settings')).status).toBe('succeeded');
    expect(before.controls.filter(c => c.tag === 'td' || c.role === 'gridcell')).toEqual([]);
    // A real record discriminator must still invalidate the observation.
    await pageOf(t.engine).locator(kind === 'table' ? 'td' : '[role=gridcell]').first().evaluate(el => { el.textContent = 'Replacement'; });
    await expect(act(t.engine, t.sessionId, 'Settings')).rejects.toMatchObject({ code: 'STALE_OBSERVATION' });
    expect(t.engine.session(t.sessionId).actionCount).toBe(1);
  } finally { await t.close(); }
});

it('retains explicit cell controls and independent nested lists inside a row', async () => {
  const t = await fixture(`<table><tr style="cursor:pointer"><td><button type="button">First</button></td><td><button type="button">Second</button></td><td><button type="button">Third</button></td><td onclick="window.direct=true">Direct cell</td><td>
    <ul aria-label="Attachments"><li data-key="a"><button type="button">Open</button></li><li data-key="b"><button type="button">Open</button></li></ul>
    </td></tr></table>`);
  try {
    const o = t.engine.observation(t.sessionId);
    expect(o.controls.filter(c => c.role === 'button').map(c => c.name)).toEqual(['First', 'Second', 'Third', 'Open', 'Open']);
    expect(o.controls.find(c => c.name === 'Direct cell')?.actions).toContain('click');
    expect(o.structuralLists?.filter(g => g.members.length).map(g => g.members.map(m => o.controls.find(c => c.localId === m.localId)!.name))).toEqual([['Open', 'Open']]);
  } finally { await t.close(); }
});
