import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { SampledCrawler, maskVolatile, stateKey, type CrawlEvent } from '@interaction/crawler';

// One page with: a blocking modal on load, a long list of identical rows, a
// tab panel, a live price, an in-scope second page and an out-of-scope link.
const page = (price: string) => `<!doctype html><html><head><title>Rate ${price}</title></head><body>
<header><nav aria-label="Main"><a href="/other">Other page</a><a href="https://example.invalid/away">Away</a></nav></header>
<main>
  <p id="price">BTC ${price}</p>
  <div role="tablist"><button role="tab" aria-selected="true" aria-controls="p1" onclick="show(1)">Overview</button><button role="tab" aria-selected="false" aria-controls="p2" onclick="show(2)">Details</button></div>
  <section id="p1">Overview panel</section><section id="p2" hidden><button onclick="this.textContent='Done'">Inner action</button></section>
  <ul>${Array.from({ length: 30 }, (_, i) => `<li><button onclick="document.getElementById('picked').textContent='row ${i}'">Pair ${i}</button></li>`).join('')}</ul>
  <p id="picked"></p>
  <img src="/missing.png" alt="Broken logo" width="40" height="40">
  <button style="width:40px;overflow:hidden;white-space:nowrap">A very long clipped label</button>
</main>
<div id="backdrop" style="position:fixed;inset:0;background:#0006"></div>
<div role="dialog" aria-modal="true" aria-label="Notice" id="modal" style="position:fixed;top:30%;left:30%;background:#fff;padding:20px">
  <p>Regional notice</p><button onclick="document.getElementById('modal').remove();document.getElementById('backdrop').remove()">Close</button>
</div>
<script>function show(n){for(const i of [1,2]){document.getElementById('p'+i).hidden=i!==n;}document.querySelectorAll('[role=tab]').forEach((t,i)=>t.setAttribute('aria-selected',String(i+1===n)));}</script>
</body></html>`;

let server: Server, base = '';
let tick = 0;
beforeAll(async () => {
  server = createServer((req, res) => {
    res.setHeader('content-type', 'text/html');
    if (req.url === '/missing.png') { res.statusCode = 404; res.end(); return; }
    if (req.url === '/other') res.end('<!doctype html><title>Other</title><main><a href="/">Back home</a></main>');
    else res.end(page(`${60000 + tick++}.12`));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;
});
afterAll(() => new Promise<void>(resolve => server.close(() => resolve())));

test('live values do not change component or state identity', () => {
  expect(maskVolatile('BTC 60,001.12 (+1.3%)')).toBe(maskVolatile('BTC 59,870.40 (-0.2%)'));
  const control = (name: string) => ({ localId: name, visible: true, actions: ['click'], name, label: '', role: 'button', tag: 'button', displayedText: '' });
  const a = stateKey({ url: base, title: '', controls: [control('Pay 1.20 USD')] as never });
  const b = stateKey({ url: base, title: '', controls: [control('Pay 3.75 USD')] as never });
  expect(a).toBe(b);
});

test('crawls the entry page: modal first, lists sampled, out-of-scope links skipped', async () => {
  const events: CrawlEvent[] = [];
  const crawler = new SampledCrawler({ url: base, durationMs: 60000, settleMs: 100, log: e => events.push(e) });
  const summary = await crawler.run();
  const actions = events.filter((e): e is Extract<CrawlEvent, { type: 'action' }> => e.type === 'action');
  const labels = actions.map(a => a.step.label);

  // The blocking modal is handled before anything beneath it.
  expect(actions[0].overlay).toBeTruthy();
  expect(labels[0]).toBe('Close');
  // Thirty identical rows are one class: at most two samples.
  expect(labels.filter(l => /^Pair \d+$/.test(l)).length).toBeLessThanOrEqual(2);
  expect(labels.filter(l => /^Pair \d+$/.test(l)).length).toBeGreaterThanOrEqual(1);
  // Tabs are explored and reveal their panel's action.
  expect(labels).toContain('Details');
  expect(labels).toContain('Inner action');
  // Never leaves scope: neither the other page (not allowed by default) nor the external link.
  expect(labels).not.toContain('Away');
  expect(labels).not.toContain('Other page');
  expect(actions.every(a => a.url.startsWith(base))).toBe(true);
  expect(summary.onEntryPage).toBe(summary.actions);
  // UI checks run on each new state and report each issue once.
  const findings = [...crawler.findings.values()];
  expect(findings.filter(f => f.rule === 'broken-image')).toHaveLength(1);
  expect(findings.filter(f => f.rule === 'clipped-text' && f.text.includes('clipped label'))).toHaveLength(1);
}, 120000);
