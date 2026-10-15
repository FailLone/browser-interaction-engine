import { createServer } from 'node:http';
import { expect, it } from 'vitest';
import { act, pageOf, testEngine } from './helpers.js';
import type { ActionAttempt } from '@interaction/browser';

async function fixture(semantic: boolean | 'css') {
  const server = createServer((_req, res) => res.end(`<style>
    li {position:relative;width:180px;height:60px} #panel {position:absolute;left:200px;top:0;width:250px;height:200px}
    </style><ul aria-label="Services"><li><a id="destination" href="/service">Service</a>
    <button id="open" aria-expanded="false">Open menu</button>
    <div id="panel" ${semantic === true ? 'role="tabpanel"' : ''} ${semantic === 'css' ? 'style="display:none"' : 'hidden'}>
      <button role="tab" id="a">Group A</button><button role="tab" id="b">Group B</button><div id="results"></div>
    </div></li></ul><button aria-pressed="false">Independent</button>
    <script>
    const opener=document.querySelector('#open'),panel=document.querySelector('#panel'),results=document.querySelector('#results');
    opener.onclick=()=>{const open=opener.getAttribute('aria-expanded')!=='true';${semantic === 'css' ? "panel.style.display=open?'block':'none';" : 'panel.hidden=!open;'}opener.setAttribute('aria-expanded',String(open));};
    const show=n=>{results.innerHTML='<a href="/result/'+n+'">Result '+n+'</a>';};
    document.querySelector('#a').onclick=()=>show('a');document.querySelector('#b').onclick=()=>show('b');show('a');
    </script>`));
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const t = await testEngine(`http://127.0.0.1:${(server.address() as { port: number }).port}`, {
    contextRules: [], exploration: 'controls', maxActions: 15, maxDepth: 30, observeTimeoutMs: 1500,
  }, { actions: actions => actions.map(a => a.basis?.evidence.some(e => e.rule === 'hyperlink/v1') ? { ...a, excluded: true, exclusionReason: 'test_navigation_out_of_scope' } : a) });
  return { ...t, close: async () => { await t.close(); await new Promise<void>(resolve => server.close(() => resolve())); } };
}

it.each([false, true, 'css'] as const)('keeps parent record binding independent of nested panel destinations (semantic=%s)', async semantic => {
  const t = await fixture(semantic);
  try {
    const read = () => t.engine.observation(t.sessionId).controls.find(c => c.name === 'Open menu')!;
    const original = read();
    await act(t.engine, t.sessionId, 'Open menu');
    for (const name of ['Group B', 'Group A', 'Group B']) {
      await act(t.engine, t.sessionId, name);
      expect(read().identityId).toBe(original.identityId);
      expect(read().stableKey).toBe(original.stableKey);
    }
    await act(t.engine, t.sessionId, 'Open menu');
    expect(read().identityId).toBe(original.identityId);
    await act(t.engine, t.sessionId, 'Open menu');
    expect(read().identityId).toBe(original.identityId);
    // The parent record's own destination remains a real binding change.
    await pageOf(t.engine).locator('#destination').evaluate(el => el.setAttribute('href', '/another-service'));
    await t.engine.observe(t.sessionId);
    expect(read().identityId).not.toBe(original.identityId);
    expect(read().stableKey).not.toBe(original.stableKey);
  } finally { await t.close(); }
});

it('finishes DFS instead of reopening the same menu when child destinations change', async () => {
  const t = await fixture(false);
  try {
    await t.engine.explore(t.sessionId); await t.engine.waitForIdle();
    expect(t.engine.session(t.sessionId).stopReason).toBe('known_frontier_exhausted_with_gaps');
    const attempts = t.engine.list<ActionAttempt>(t.sessionId, 'attempt');
    expect(attempts.filter(a => a.action.label === 'Open menu' && a.purpose !== 'recovery')).toHaveLength(1);
    for (const name of ['Group A', 'Group B', 'Independent']) expect(attempts.some(a => a.action.label === name && a.status === 'succeeded')).toBe(true);
    expect(attempts.length).toBeLessThan(10);
  } finally { await t.close(); }
});
