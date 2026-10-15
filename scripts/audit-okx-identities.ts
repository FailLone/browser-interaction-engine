// Opt-in public-page regression. Never imported by the engine or normal test suite.
import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';
import type { Page } from 'playwright';
import { BrowserEngine, type Control, type Observation, type ControlIdentity, type IdentityHypothesis } from '@interaction/browser';
import { MemoryStore } from '@interaction/storage-memory';
import { canonical, matchIdentities } from '@interaction/core';
import { signature } from '../packages/adapter-playwright/src/util.js';

const args = process.argv.slice(2);
const option = (name: string) => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : undefined; };
const output = option('--output');
if (!output) throw new Error('Usage: node --import tsx --conditions=development scripts/audit-okx-identities.ts --output work/audit [--input saved-observations.json] [--interact]');
mkdirSync(output, { recursive: true });
const baseline = option('--baseline') || '722a8c7';
const source = execFileSync('git', ['show', `${baseline}:packages/core/src/identity.ts`], { encoding: 'utf8' });
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText
  .replace("'./util.js'", JSON.stringify(pathToFileURL(resolve('packages/core/src/util.ts')).href));
const legacy = (await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`)).matchIdentities as typeof matchIdentities;
// Signature from the frozen baseline. Newly collected context is the only
// projection removed; the original controls, names, keys and actions all remain.
const legacySignature = (c: Control) => canonical({ role: c.role, label: c.label || c.name, region: c.region, form: c.form, actions: c.actions, type: c.constraints.type });
const observations: Observation[] = [];
const phases: string[] = [];
const checks: string[] = [];
let failure: string | undefined;

function compare(old: boolean) {
  const identities: ControlIdentity[] = [], hypotheses: IdentityHypothesis[] = [];
  return observations.map((raw, index) => {
    const o = structuredClone(raw);
    if (old) for (const c of o.controls) delete c.identityContext;
    hypotheses.push(...(old ? legacy : matchIdentities)(o, identities, hypotheses, old ? legacySignature : signature).hypotheses);
    assert.equal(new Set(o.controls.map(c => c.identityId)).size, o.controls.length);
    const pending = o.controls.filter(c => c.hypothesisId);
    return { phase: phases[index], observationId: o.id, controls: o.controls.length,
      currentPending: pending.length, cumulativePending: hypotheses.length, actionablePending: pending.filter(c => c.actions.length).length,
      remaining: pending.map(c => ({ role: c.role, name: c.name, actions: c.actions, visible: c.visible, identityContext: c.identityContext })) };
  });
}

const input = option('--input');
if (input) {
  observations.push(...JSON.parse(readFileSync(input, 'utf8')));
  phases.push(...observations.map((_, i) => `saved-${i + 1}`));
} else {
  const engine = new BrowserEngine({ persistence: new MemoryStore() });
  try {
    const session = await engine.createSession({ url: 'https://www.okx.com/zh-hans/convert/btc-to-usd', headless: true,
      settleMs: 400, observeTimeoutMs: 5000, actionTimeoutMs: 20000, evidence: { enabled: true }, contextRules: [] });
    const record = (phase: string) => { const o = engine.observation(session.id); observations.push(o); phases.push(phase); return o; };
    record('initial');
    for (let i = 1; i <= 2; i++) { await engine.observe(session.id); record(`repeat-${i}`); }
    if (args.includes('--interact')) {
      const perform = async (control: Control, kind: string, phase: string, value?: string) => {
        const action = engine.actions(session.id).find(a => a.localId === control.localId && a.kind === kind);
        assert.ok(action, `Missing ${kind} action for ${control.name}`);
        const attempt = await engine.execute(session.id, action.id, crypto.randomUUID(), value);
        assert.equal(attempt.status, 'succeeded', attempt.reason); record(phase);
      };
      const close = engine.observation(session.id).controls.find(c => c.name === '关闭' && c.visible && c.role === 'button');
      if (close) await perform(close, 'click', 'close-region-notice');
      const amounts = engine.observation(session.id).controls.filter(c => c.tag === 'input' && c.name === '0');
      assert.equal(amounts.length, 2); assert.ok(amounts.every(c => !c.hypothesisId));
      const btc = amounts.find(c => c.identityContext?.binding?.includes('BTC'));
      const usd = amounts.find(c => c.identityContext?.binding?.includes('USD'));
      assert.ok(btc); assert.ok(usd);
      await perform(btc, 'fill', 'btc-2', '2'); await perform(usd, 'fill', 'usd-100', '100');
      const faq = engine.observation(session.id).controls.find(c => c.stableKey === 'testid:okd-accordion-header');
      assert.ok(faq && !faq.hypothesisId);
      await perform(faq, 'click', 'faq-open'); await perform(faq, 'click', 'faq-close');
      // Explicit external observation probes: custom selector discovery and the
      // listbox/search boundary are separate engine limitations, not waived here.
      const page = (engine as unknown as { driver: { page: Page } }).driver.page;
      const opener = page.locator(btc.selector).locator('..').locator(':scope > div');
      assert.equal(await opener.count(), 1); await opener.click();
      await engine.observe(session.id); record('external-currency-open');
      const search = engine.observation(session.id).controls.find(c => c.tag === 'input' && c.name === '搜索' && c.visible);
      assert.ok(search && !search.hypothesisId);
      await page.locator(search.selector).fill('ETH'); await engine.observe(session.id); record('external-search-ETH');
      const searched = engine.observation(session.id).controls.find(c => c.instanceId === search.instanceId);
      assert.equal(searched?.identityId, search.identityId); assert.ok(!searched?.hypothesisId);
      await opener.click(); await engine.observe(session.id); record('external-currency-close');
      for (const field of amounts) {
        const current = engine.observation(session.id).controls.find(c => c.instanceId === field.instanceId);
        assert.equal(current?.identityId, field.identityId); assert.ok(!current?.hypothesisId);
      }
      checks.push('Engine numeric fills and FAQ toggles succeeded; amount and search identities persisted through popup filtering.');
      const stable = engine.observation(session.id).controls.filter(c => c.stableKey === 'testid:okd-accordion-header' || c.tag === 'input' && c.name === '0');
      await page.reload({ waitUntil: 'domcontentloaded' }); await engine.observe(session.id); record('reload');
      for (const control of stable) {
        const matches = engine.observation(session.id).controls.filter(c => c.name === control.name && c.identityContext?.binding === control.identityContext?.binding && c.stableKey === control.stableKey);
        assert.equal(matches.length, 1); assert.equal(matches[0].identityId, control.identityId); assert.ok(!matches[0].hypothesisId);
      }
      checks.push('All FAQ and amount identities persisted across a real document reload.');
    }
    const details = await engine.observationDetails(session.id, engine.observation(session.id).id);
    writeFileSync(resolve(output, 'details.json'), JSON.stringify(details.snapshot));
  } catch (error) { failure = String(error); process.exitCode = 1; }
  finally { await engine.close(); }
}
const serialized = JSON.stringify(observations);
writeFileSync(resolve(output, 'observations.json'), serialized);
const report = { url: observations[0]?.url, baseline, inputSha256: createHash('sha256').update(serialized).digest('hex'),
  method: 'Same captured controls; frozen baseline matcher/signature compared with current matcher plus observed contextual evidence.',
  checks, failure, before: compare(true), after: compare(false) };
writeFileSync(resolve(output, 'comparison.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify({ checks, failure, before: report.before.map(({ remaining, ...r }) => r), after: report.after.map(({ remaining, ...r }) => r) }, null, 2));
