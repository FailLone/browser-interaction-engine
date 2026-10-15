import { expect, it } from 'vitest';
import { createServer } from 'node:http';
import type { ActionAttempt, Observation } from '@interaction/browser';
import { pageOf, testEngine } from './helpers.js';

it.each(['page', 'vertical-container', 'horizontal-container'] as const)('traverses both ends from the middle of a %s without abandoning the reverse sweep', async kind => {
  const isPage = kind === 'page', horizontal = kind === 'horizontal-container';
  const html = isPage
    ? '<style>body{margin:0;height:4200px}</style>'
    : `<style>body{margin:0}#view{width:200px;height:120px;overflow:auto}#content{width:${horizontal ? 941 : 100}px;height:${horizontal ? 50 : 911}px}</style>
      <div id="view" aria-label="Records"><div id="content">Records</div></div>`;
  const server = createServer((_req, res) => { res.setHeader('Content-Type', 'text/html'); res.end(html); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const t = await testEngine(`http://127.0.0.1:${(server.address() as { port: number }).port}`, {
    exploration: 'controls', contextRules: [], viewport: { width: 900, height: 600 }, maxActions: 40, maxDepth: 50,
  });
  try {
    await pageOf(t.engine).evaluate(({ isPage, horizontal }) => {
      if (isPage) scrollTo(0, 1370);
      else { const view = document.getElementById('view')!; if (horizontal) view.scrollLeft = 317; else view.scrollTop = 331; }
    }, { isPage, horizontal });
    await t.engine.observe(t.sessionId);
    const startIndex = t.engine.list(t.sessionId, 'observation').length - 1;
    const viewport = (o: Observation) => isPage ? o.scroll : o.controls.find(c => c.name === 'Records')!.scroll!;
    const position = (o: Observation) => horizontal ? viewport(o).x : viewport(o).y;
    const first = t.engine.observation(t.sessionId);
    expect(position(first)).toBe(isPage ? 1370 : horizontal ? 317 : 331);
    await t.engine.explore(t.sessionId); await t.engine.waitForIdle();
    const observations = t.engine.list<Observation>(t.sessionId, 'observation').slice(startIndex);
    const attempts = t.engine.list<ActionAttempt>(t.sessionId, 'attempt');
    const positions = observations.map(position);
    expect(Math.min(...positions), JSON.stringify(positions)).toBe(0);
    expect(Math.max(...positions)).toBe(horizontal ? 741 : isPage ? 3600 : 791);
    expect(attempts.length).toBeLessThan(40);
    expect(attempts.every(a => a.status === 'succeeded' && a.action.kind === 'scroll')).toBe(true);
    expect(t.engine.list(t.sessionId, 'reach')).toHaveLength(0);
    // Every interval of this static viewport was actually observed, not inferred
    // from having seen a control in the DOM or merely reaching the far edge.
    const size = isPage ? 600 : horizontal ? 200 : 120;
    const sorted = [...new Set(positions)].sort((a, b) => a - b);
    expect(sorted.slice(1).every((p, i) => p <= sorted[i] + size)).toBe(true);
  } finally { await t.close(); await new Promise<void>(resolve => server.close(() => resolve())); }
}, 60000);
