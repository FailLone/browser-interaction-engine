import { expect, it } from 'vitest';
import { createServer } from 'node:http';
import type { ActionAttempt, EngineHooks, ReachResult } from '@interaction/browser';
import { pageOf, testEngine } from './helpers.js';

async function page(body: string, hooks: EngineHooks = {}) {
  const server = createServer((_req, res) => { res.setHeader('Content-Type', 'text/html'); res.end(body); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const t = await testEngine(`http://127.0.0.1:${(server.address() as { port: number }).port}`, { exploration: 'controls', contextRules: [], maxActions: 100 }, hooks);
  return { ...t, close: async () => { await t.close(); await new Promise<void>(resolve => server.close(() => resolve())); } };
}

it('finishes newly revealed nonmodal controls before sibling actions dismiss them', async () => {
  const t = await page(`<button id="open" aria-expanded="false" onclick="panel.hidden=false;this.setAttribute('aria-expanded','true')">Open</button>
    <button id="sibling" aria-expanded="false" onclick="panel.hidden=true;document.querySelector('#open').setAttribute('aria-expanded','false')">Sibling</button>
    <div id="panel" hidden><input id="first" aria-label="New first"><input id="second" aria-label="New second"></div>`);
  try {
    await t.engine.explore(t.sessionId); await t.engine.waitForIdle();
    const attempts = t.engine.list<ActionAttempt>(t.sessionId, 'attempt');
    expect(attempts.map(a => a.action.label)).toEqual(['Open', 'New first', 'New second', 'Sibling']);
    expect(attempts.every(a => a.status === 'succeeded')).toBe(true);
    expect(t.engine.list(t.sessionId, 'reach')).toEqual([]);
    expect(t.engine.controlCoverage(t.sessionId).counts).toMatchObject({ actionable: 4, covered: 4, incomplete: 0 });
    expect(t.engine.observation(t.sessionId).boundaries).toEqual([]);
  } finally { await t.close(); }
});

it('shares a failed reach across sibling work and revalidates it when the controls return', async () => {
  const t = await page(`<button id="open" aria-expanded="false" onclick="panel.hidden=false;this.setAttribute('aria-expanded','true')">Open</button>
    <button id="hide" onclick="panel.hidden=true;document.querySelector('#open').setAttribute('aria-expanded','false');document.querySelector('#version').value='after'">Hide</button>
    <input id="version" aria-label="Version" readonly value="before">
    <div id="panel" hidden><input aria-label="One"><input aria-label="Two"><input aria-label="Three"></div>`, {
    choose: (items, ctx) => (ctx.session.actionCount === 0 ? items.find(f => f.action.label === 'Open') : ctx.session.actionCount === 1 ? items.find(f => f.action.label === 'Hide') : items[0])?.id || null,
  });
  try {
    await t.engine.explore(t.sessionId); await t.engine.waitForIdle();
    const failed = t.engine.list<ReachResult>(t.sessionId, 'reach');
    expect(failed).toHaveLength(1);
    expect(failed[0].status).toBe('UNREACHABLE');
    const children = t.engine.getFrontier(t.sessionId).filter(f => f.action.kind === 'fill');
    expect(children).toHaveLength(3);
    expect(children.every(f => f.status === 'blocked' && f.recovery?.resultId === failed[0].id && !f.attempts.length)).toBe(true);
    await pageOf(t.engine).evaluate(() => { document.querySelector<HTMLElement>('#panel')!.hidden = false; document.querySelector('#open')!.setAttribute('aria-expanded', 'true'); });
    await t.engine.observe(t.sessionId);
    expect(t.engine.getFrontier(t.sessionId).filter(f => f.action.kind === 'fill').every(f => f.status === 'pending' && !f.recovery)).toBe(true);
    await t.engine.explore(t.sessionId); await t.engine.waitForIdle();
    expect(t.engine.getFrontier(t.sessionId).filter(f => f.action.kind === 'fill').every(f => f.status === 'executed')).toBe(true);
    expect(t.engine.list(t.sessionId, 'reach')).toHaveLength(1);
  } finally { await t.close(); }
});

it('retires an unattempted synthetic exit after closing the boundary without reopening it', async () => {
  const t = await page(`<dialog open><button onclick="this.closest('dialog').close()">Close</button></dialog><input aria-label="Draft">`);
  try {
    await t.engine.explore(t.sessionId); await t.engine.waitForIdle();
    const exit = t.engine.getFrontier(t.sessionId).find(f => f.action.kind === 'press')!;
    expect(exit).toMatchObject({ status: 'superseded', reason: 'boundary_already_exited', attempts: [], coverage: { executionStatus: 'not_attempted' } });
    expect(t.engine.list<ActionAttempt>(t.sessionId, 'attempt').map(a => a.action.label)).toEqual(['Close', 'Draft']);
    expect(t.engine.list(t.sessionId, 'reach')).toEqual([]);
    expect(t.engine.session(t.sessionId).stopReason).toBe('known_frontier_exhausted');
  } finally { await t.close(); }
});

it('names unnamed controls by role without inventing a close operation', async () => {
  const t = await page('<input><button></button>');
  try {
    expect(t.engine.actions(t.sessionId).map(a => a.label)).toEqual(['Unnamed textbox', 'Unnamed button']);
    expect(t.engine.actions(t.sessionId).every(a => !a.boundary)).toBe(true);
  } finally { await t.close(); }
});
