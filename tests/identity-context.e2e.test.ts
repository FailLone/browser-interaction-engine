import { afterAll, beforeAll, expect, it } from 'vitest';
import { fixtureServer, pageOf, testEngine } from './helpers.js';
import type { Control } from '@interaction/browser';
import { createServer } from '../apps/server/src/server.js';
import { InteractionClient, prepareIdentityReview, identityDecisionCommand } from '@interaction/client';

let fixture: Awaited<ReturnType<typeof fixtureServer>>;
beforeAll(async () => { fixture = await fixtureServer(); });
afterAll(async () => { await fixture.server.close(); });
const amounts = (controls: Control[]) => controls.filter(c => c.tag === 'input' && c.name === '0');

it('uses distinct FAQ semantics, field descriptions and link destinations across reorder and rebuild', async () => {
  const t = await testEngine(`${fixture.url}/identity-context.html`, { contextRules: [] });
  try {
    const first = t.engine.observation(t.sessionId);
    const faq = first.controls.filter(c => c.stableKey === 'testid:accordion');
    const fields = amounts(first.controls);
    const links = first.controls.filter(c => c.name === 'Details');
    const cities = first.controls.filter(c => c.name === 'City');
    const wrappers = first.controls.filter(c => c.identityContext?.evidence.includes('unique-labelled-child/v1'));
    expect(wrappers).toHaveLength(2);
    expect([...faq, ...fields, ...links, ...cities, ...wrappers].every(c => !c.hypothesisId)).toBe(true);
    expect(fields.map(c => c.identityContext?.binding)).toEqual(expect.arrayContaining([expect.stringContaining('BTC'), expect.stringContaining('USD')]));
    const before = new Map([...faq, ...fields, ...links, ...cities, ...wrappers].map(c => [JSON.stringify([c.stableKey, c.name, c.identityContext]), c.identityId]));
    await pageOf(t.engine).evaluate(() => {
      for (const selector of ['[data-fixture=fields]', '[data-fixture=faq]']) {
        const parent = document.querySelector(selector)!;
        const children = Array.from(parent.children).filter(c => c.tagName !== 'H2');
        children.reverse().forEach(c => parent.append(c.cloneNode(true)));
        children.forEach(c => c.remove());
      }
      document.querySelectorAll('a').forEach(a => a.replaceWith(a.cloneNode(true)));
      document.querySelectorAll('nav > div').forEach(div => div.replaceWith(div.cloneNode(true)));
      document.querySelectorAll('input').forEach(input => { input.value = '777'; });
    });
    const next = await t.engine.observe(t.sessionId);
    const relevant = next.controls.filter(c => c.stableKey === 'testid:accordion' || c.name === '0' || c.name === 'Details' || c.name === 'City' || c.identityContext?.evidence.includes('unique-labelled-child/v1'));
    expect(relevant).toHaveLength(before.size);
    for (const c of relevant) {
      expect(c.hypothesisId).toBeUndefined();
      expect(c.identityId).toBe(before.get(JSON.stringify([c.stableKey, c.name, c.identityContext])));
    }
    // Identical anonymous/labelled siblings remain uncertain; position is no key.
    for (const c of next.controls.filter(c => c.tag === 'button' && (!c.name || c.name === 'Same'))) expect(c.hypothesisId).toBeDefined();
  } finally { await t.close(); }
});

it('invalidates changed currency and link bindings on the same DOM instance', async () => {
  const t = await testEngine(`${fixture.url}/identity-context.html`, { contextRules: [] });
  try {
    const first = t.engine.observation(t.sessionId);
    const btc = amounts(first.controls).find(c => c.identityContext?.binding?.includes('BTC'))!;
    const link = first.controls.find(c => c.name === 'Details')!;
    await pageOf(t.engine).evaluate(() => {
      document.querySelector('[data-fixture=btc] > span')!.textContent = 'ETH';
      document.querySelector('a')!.setAttribute('href', '/products/c');
    });
    const next = await t.engine.observe(t.sessionId);
    for (const old of [btc, link]) {
      const changed = next.controls.find(c => c.instanceId === old.instanceId)!;
      expect(changed.identityId).not.toBe(old.identityId);
      expect(changed.hypothesisId).toBeUndefined();
    }
  } finally { await t.close(); }
});

it('does not use truncated text, hidden popup options, input values or ordinal position as identity', async () => {
  const t = await testEngine(`${fixture.url}/identity-context.html`, { contextRules: [] });
  try {
    await pageOf(t.engine).evaluate(() => {
      document.querySelectorAll('[data-fixture=fields] > div > span').forEach(span => { span.textContent = 'X'.repeat(201); });
      document.querySelectorAll('[data-fixture=fields] input').forEach((input, i) => { (input as HTMLInputElement).value = String(i); });
    });
    const next = await t.engine.observe(t.sessionId);
    expect(amounts(next.controls).every(c => !c.identityContext?.binding && c.hypothesisId)).toBe(true);
  } finally { await t.close(); }
});

it('keeps field and owned search identities when semantic or custom popup contents become visible', async () => {
  const t = await testEngine(`${fixture.url}/identity-context.html`, { contextRules: [] });
  try {
    const first = t.engine.observation(t.sessionId);
    const fields = first.controls.filter(c => c.tag === 'input' && ['0', 'Search'].includes(c.name));
    expect(fields).toHaveLength(4);
    expect(fields.every(c => !c.hypothesisId)).toBe(true);
    await pageOf(t.engine).evaluate(() => {
      document.querySelectorAll('[data-fixture=fields] [hidden]').forEach(popup => popup.removeAttribute('hidden'));
      document.querySelectorAll('[data-fixture=fields] > div > div > span').forEach(option => { option.textContent = 'Filtered result'; });
    });
    const next = await t.engine.observe(t.sessionId);
    for (const old of fields) {
      const current = next.controls.find(c => c.localId === old.localId)!;
      expect(current.identityContext).toEqual(old.identityContext);
      expect(current.identityId).toBe(old.identityId);
      expect(current.hypothesisId).toBeUndefined();
    }
  } finally { await t.close(); }
});

it('blocks applying an old review when a contextual binding changes without changing input attributes', async () => {
  const t = await testEngine(`${fixture.url}/identity-context.html`, { contextRules: [] });
  const app = await createServer(t.engine); await app.listen({ host: '127.0.0.1', port: 0 });
  try {
    await pageOf(t.engine).evaluate(() => {
      document.querySelector('[data-fixture=usd] > span')!.textContent = 'BTC';
    });
    const ambiguous = await t.engine.observe(t.sessionId);
    const target = amounts(ambiguous.controls).find(c => c.hypothesisId)!;
    expect(target).toBeDefined();
    await pageOf(t.engine).locator(target.selector).evaluate(el => { el.parentElement!.querySelector('span')!.textContent = 'ETH'; });
    await t.engine.observe(t.sessionId);
    const api = new InteractionClient(`http://127.0.0.1:${(app.server.address() as { port: number }).port}`);
    const review = await prepareIdentityReview(api, t.sessionId, target.hypothesisId!);
    expect(review.current.targetPresent).toBe(true);
    expect(review.current.bindingChanged).toBe(true);
    expect(() => identityDecisionCommand(review, { decision: 'independent', reason: 'old binding', evidenceRefs: ['target'] }, 'test')).toThrow('目标已变化');
  } finally { await app.close(); await t.close(); }
});

it('does not promote descriptive slot IDs inside a collection without row semantics into record identity', async () => {
  const t = await testEngine(`${fixture.url}/identity-context.html`, { contextRules: [] });
  try {
    await pageOf(t.engine).evaluate(() => {
      const list = document.createElement('div'); list.setAttribute('role', 'list');
      list.innerHTML = '<div id="slot-alpha"><button>Unbound item</button></div><div id="slot-beta"><button>Unbound item</button></div>';
      document.body.append(list);
    });
    const o = await t.engine.observe(t.sessionId);
    const buttons = o.controls.filter(c => c.name === 'Unbound item');
    expect(buttons).toHaveLength(2);
    expect(buttons.every(c => !c.identityContext?.scope && c.hypothesisId)).toBe(true);
  } finally { await t.close(); }
});
